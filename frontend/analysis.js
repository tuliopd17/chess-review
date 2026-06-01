/* Análise completa da partida no navegador.
 *
 * Antes era feita pelo backend Python via Stockfish nativo. Agora roda toda
 * em JS, usando o Stockfish WASM (BrowserEngine). O fluxo é:
 *
 *   1. Backend dá os metadados do PGN (FEN, SAN, UCI, opening por lance).
 *   2. Para cada posição "fen_before", chamamos engine.analyzeOnce(fen, ...)
 *      e coletamos: best_eval, best_move, best_pv, second_best_eval.
 *   3. Eval after = -eval(fen_after) (do ponto de vista do jogador da vez).
 *   4. Classificamos cada lance (lógica de classificação portada pra cá; era
 *      feita em Python no backend e foi reescrita em JS neste arquivo).
 *   5. Geramos resumo do coach.
 *
 * Reporta progresso lance-a-lance via callback `onMove`.
 *
 * Exporta:
 *   - analyzeGame(parsedPgn, engine, opts, onMove) -> Promise<resultado>
 *   - CLASS_LABELS, CLASS_ORDER, classifyMove (também usados pela UI ao vivo)
 */

(function () {
  const MATE_SCORE_CP = 10000;

  // ===== Conversões eval =====

  function cpToWinrate(cp) {
    if (cp >= MATE_SCORE_CP - 1000) return 1.0;
    if (cp <= -(MATE_SCORE_CP - 1000)) return 0.0;
    cp = Math.max(-1500, Math.min(1500, cp));
    return 1.0 / (1.0 + Math.exp(-0.00368208 * cp));
  }

  function scoreToCp(score) {
    // score: { type: "cp"|"mate", value: int } do ponto de vista do lado a mover.
    if (!score) return 0;
    if (score.type === "mate") {
      if (score.value === 0) return 0;
      const sign = score.value > 0 ? 1 : -1;
      return sign * (MATE_SCORE_CP - Math.abs(score.value));
    }
    return Math.max(-MATE_SCORE_CP, Math.min(MATE_SCORE_CP, score.value));
  }

  // Win% (0..100) a partir de centipawns.
  function cpToWinPercent(cp) {
    return 100 * cpToWinrate(cp);
  }

  // Acurácia de UM lance (fórmula do Lichess), dadas as win% (0..100) ANTES
  // (melhor jogada possível na posição) e DEPOIS (lance efetivamente jogado),
  // ambas do ponto de vista de quem moveu. O "+1" é o bônus de incerteza que o
  // Lichess aplica (análise imperfeita).
  function moveAccuracy(winBefore, winAfter) {
    if (winAfter >= winBefore) return 100;
    const winDiff = winBefore - winAfter;
    const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff)
                - 3.166924740191411;
    return Math.max(0.0, Math.min(100.0, raw + 1));
  }

  // Compat: acurácia a partir da perda de winrate (0..1). Mantida pra quem
  // importa do escopo global; internamente usamos moveAccuracy().
  function accuracyFromLoss(loss) {
    const before = 100;
    const after = before - Math.max(0, loss) * 100;
    return moveAccuracy(before, after);
  }

  function _stdDev(xs) {
    const n = xs.length;
    if (n === 0) return 0;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const v = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    return Math.sqrt(v);
  }

  function _clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /**
   * Acurácia da partida por cor, no método do Lichess (que aproxima de perto o
   * chess.com): para cada cor, a acurácia é a MÉDIA entre
   *   - a média harmônica das acurácias dos lances (pune outliers: uma capivarada
   *     derruba a nota), e
   *   - a média ponderada pela VOLATILIDADE (lances em posições mais "afiadas"
   *     pesam mais; peso = desvio-padrão das win% numa janela deslizante).
   * Bem mais fiel que a média aritmética simples.
   */
  function computeGameAccuracies(collected) {
    const N = collected.length;
    const out = { white: 0, black: 0 };
    if (N === 0) return out;

    // Série de win% do ponto de vista das BRANCAS, uma por posição (N+1).
    const first = collected[0];
    const initWhiteCp = first.color === "white" ? first.best_eval_cp : -first.best_eval_cp;
    const winWhite = [cpToWinPercent(initWhiteCp)];
    for (const m of collected) {
      const whiteCp = m.color === "white" ? m.eval_after_cp : -m.eval_after_cp;
      winWhite.push(cpToWinPercent(whiteCp));
    }

    // Acurácia de cada lance (POV de quem moveu).
    const perMove = collected.map((m) =>
      moveAccuracy(cpToWinPercent(m.best_eval_cp), cpToWinPercent(m.eval_after_cp))
    );

    // Pesos por volatilidade (janelas deslizantes das win%, igual ao Lichess).
    const windowSize = _clamp(Math.floor((N + 1) / 10), 2, 8);
    const windows = [];
    const firstWindow = winWhite.slice(0, windowSize);
    const padCount = Math.min(windowSize, winWhite.length) - 2;
    for (let i = 0; i < padCount; i++) windows.push(firstWindow);
    for (let i = 0; i + windowSize <= winWhite.length; i++) {
      windows.push(winWhite.slice(i, i + windowSize));
    }
    const weights = windows.map((w) => _clamp(_stdDev(w), 0.5, 12));

    for (const color of ["white", "black"]) {
      const accs = [];
      const ws = [];
      for (let i = 0; i < N; i++) {
        if (collected[i].color === color) {
          accs.push(perMove[i]);
          ws.push(weights[i] != null ? weights[i] : 1);
        }
      }
      if (accs.length === 0) { out[color] = 0; continue; }
      const wSum = ws.reduce((a, b) => a + b, 0) || 1;
      const weightedMean = accs.reduce((a, acc, i) => a + acc * ws[i], 0) / wSum;
      const harmonicMean = accs.length /
        accs.reduce((a, acc) => a + 1 / Math.max(acc, 0.01), 0);
      out[color] = (weightedMean + harmonicMean) / 2;
    }
    return out;
  }

  function estimateElo(accuracy) {
    let elo;
    if (accuracy < 50) elo = 400 + (accuracy / 50) * 200;
    else if (accuracy < 70) elo = 600 + ((accuracy - 50) / 20) * 600;
    else if (accuracy < 80) elo = 1200 + ((accuracy - 70) / 10) * 500;
    else if (accuracy < 90) elo = 1700 + ((accuracy - 80) / 10) * 600;
    else elo = 2300 + ((accuracy - 90) / 10) * 400;
    return Math.round(elo);
  }

  // ===== Análise de peças penduradas / sacrifício (estilo chess.com) =====
  //
  // Para classificar "Lance Brilhante" de forma fiel ao chess.com precisamos
  // saber se o lance DEIXA uma peça de valor pendurada de propósito (um
  // sacrifício REAL), não só uma troca. Portamos os três helpers da
  // implementação de referência (WintrCat/freechess), que por sua vez replica o
  // Game Review do chess.com, e adaptamos ao chess.js 0.10.3 (cujo `.move()`
  // devolve null em vez de lançar exceção, usa `in_check()` em snake_case e cujo
  // `.board()` NÃO inclui o campo `square`).

  const FILES = "abcdefgh";

  // Valores em peões. `k` = Infinity (rei nunca "pendura"), `m` = 0 (casa vazia,
  // usado como sentinela quando não houve captura).
  const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: Infinity, m: 0 };
  const PROMOS = [undefined, "b", "n", "r", "q"];

  // Casa (ex.: "e4") a partir dos índices de board(): row 0 = 8ª fileira.
  function sqFromRC(r, f) { return FILES[f] + (8 - r); }

  // Recoloca o FEN com o lado a mover trocado para `color` e sem alvo de en
  // passant — truque pra gerar os lances de captura do lado que NÃO está na vez.
  function fenToMove(fen, color) {
    return fen
      .replace(/ (w|b) /, ` ${color} `)
      .replace(/ ([a-h][36]) /, " - ");
  }

  // Todas as peças que podem CAPTURAR a peça em `square` (mais o rei inimigo, se
  // a captura dele for legal). Devolve [{square, color, type}].
  function getAttackers(fen, square) {
    const attackers = [];
    let probe;
    try { probe = new Chess(fen); } catch (e) { return attackers; }
    const piece = probe.get(square);
    if (!piece) return attackers;
    const oppColor = piece.color === "w" ? "b" : "w";

    let board;
    try { board = new Chess(fenToMove(fen, oppColor)); } catch (e) { return attackers; }
    for (const mv of board.moves({ verbose: true })) {
      if (mv.to === square) attackers.push({ square: mv.from, color: mv.color, type: mv.piece });
    }

    // O rei inimigo adjacente também é um atacante — desde que haja outro
    // atacante (ele não está sozinho contra a peça defendida) ou que capturar
    // seja de fato legal pra ele.
    const bd = board.board();
    let king = null;
    const fIdx = FILES.indexOf(square[0]);
    const rIdx = 8 - parseInt(square[1], 10);
    for (let df = -1; df <= 1 && !king; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const f = Math.min(Math.max(fIdx + df, 0), 7);
        const r = Math.min(Math.max(rIdx + dr, 0), 7);
        const p = bd[r][f];
        if (p && p.color === oppColor && p.type === "k") { king = sqFromRC(r, f); break; }
      }
    }
    if (!king) return attackers;

    let kingCaptureLegal = false;
    try {
      const kb = new Chess(fenToMove(fen, oppColor));
      kingCaptureLegal = !!kb.move({ from: king, to: square });
    } catch (e) { /* ignore */ }
    if (attackers.length > 0 || kingCaptureLegal) {
      attackers.push({ square: king, color: oppColor, type: "k" });
    }
    return attackers;
  }

  // Peças que DEFENDEM a peça em `square` (quem recaptura se ela for tomada).
  function getDefenders(fen, square) {
    let probe;
    try { probe = new Chess(fen); } catch (e) { return []; }
    const piece = probe.get(square);
    if (!piece) return [];

    const testAttacker = getAttackers(fen, square)[0];
    if (testAttacker) {
      let b;
      try { b = new Chess(fenToMove(fen, testAttacker.color)); } catch (e) { return []; }
      for (const promo of PROMOS) {
        const res = b.move({ from: testAttacker.square, to: square, promotion: promo });
        if (res) return getAttackers(b.fen(), square);
      }
      return [];
    }
    // Sem atacantes: coloca uma dama inimiga na casa e vê quem a ataca — esses
    // são os defensores da peça original.
    let b;
    try { b = new Chess(fenToMove(fen, piece.color)); } catch (e) { return []; }
    b.remove(square);
    b.put({ color: piece.color === "w" ? "b" : "w", type: "q" }, square);
    return getAttackers(b.fen(), square);
  }

  // A peça em `square` está pendurada (perde material se o oponente capturar)?
  // `lastFen` é a posição ANTES do lance e `fen` a posição depois — usado pra
  // distinguir trocas justas de peças realmente largadas.
  function isPieceHanging(lastFen, fen, square) {
    let lastBoard, board;
    try { lastBoard = new Chess(lastFen); board = new Chess(fen); } catch (e) { return false; }
    const lastPiece = lastBoard.get(square) || { type: "m", color: "" };
    const piece = board.get(square);
    if (!piece) return false;

    const attackers = getAttackers(fen, square);
    const defenders = getDefenders(fen, square);

    // Acabou de ser trocada por algo de valor igual ou maior → não pendurada.
    if (PIECE_VAL[lastPiece.type] >= PIECE_VAL[piece.type] && lastPiece.color !== piece.color) {
      return false;
    }
    // Torre que tomou uma peça menor defendida por uma única outra menor: troca
    // favorável de torre, não está pendurada.
    if (
      piece.type === "r" &&
      PIECE_VAL[lastPiece.type] === 3 &&
      attackers.length === 1 &&
      attackers.every((a) => PIECE_VAL[a.type] === 3)
    ) {
      return false;
    }
    // Tem atacante mais barato que ela → pendurada.
    if (attackers.some((a) => PIECE_VAL[a.type] < PIECE_VAL[piece.type])) return true;

    if (attackers.length > defenders.length) {
      let minAtk = Infinity;
      for (const a of attackers) minAtk = Math.min(minAtk, PIECE_VAL[a.type]);
      // Se tomar a peça (mesmo com mais atacantes que defensores) já seria um
      // sacrifício do próprio oponente, não está pendurada.
      if (PIECE_VAL[piece.type] < minAtk && defenders.some((d) => PIECE_VAL[d.type] < minAtk)) {
        return false;
      }
      // Se algum defensor é peão, o "sacrificado" de fato é esse peão.
      if (defenders.some((d) => PIECE_VAL[d.type] === 1)) return false;
      return true;
    }
    return false;
  }

  // Detecta "Lance Brilhante" no estilo chess.com: o lance é o melhor (ou quase)
  // E deixa de propósito uma peça de valor pendurada, que o oponente pode
  // realmente capturar, sem que o jogador fique pior nem já estivesse ganhando à
  // toa. Recebe um `move` já enriquecido (fen_before/after, evals POV de quem
  // moveu, second_best). Retorna boolean.
  function detectBrilliant(move) {
    const mover = move.color === "white" ? "w" : "b";
    const evalAfter = move.eval_after_cp;
    const secondCp = move.second_best_eval_cp;
    const afterMate = isMateCp(evalAfter);
    const secondMate = secondCp != null && isMateCp(secondCp);

    // "Ganhava de qualquer jeito": já existe um 2º lance que também ganha fácil
    // (≥ +7) ou ambos os top lances dão mate → o sacrifício não era necessário.
    if ((secondCp != null && secondCp >= 700 && !afterMate) || (afterMate && secondMate)) return false;
    if (evalAfter < 0) return false;            // não pode ficar pior depois
    if (/=/.test(move.san)) return false;       // promoção não conta como sacrifício

    let lastBoard, curBoard;
    try { lastBoard = new Chess(move.fen_before); curBoard = new Chess(move.fen_after); }
    catch (e) { return false; }
    if (lastBoard.in_check()) return false;     // estava em xeque → lance é "obrigatório"

    const toSq = move.uci.slice(2, 4);
    const captured = lastBoard.get(toSq) || { type: "m" };

    // Peças do jogador (não peão/rei) que ficaram penduradas após o lance.
    const sacrificed = [];
    const bd = curBoard.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = bd[r][f];
        if (!p || p.color !== mover || p.type === "k" || p.type === "p") continue;
        // Se o que foi capturado vale igual/mais que essa peça, a "troca boa" tá
        // em outro lugar — essa peça não é o sacrifício.
        if (PIECE_VAL[captured.type] >= PIECE_VAL[p.type]) continue;
        const sq = sqFromRC(r, f);
        if (isPieceHanging(move.fen_before, move.fen_after, sq)) {
          sacrificed.push({ square: sq, type: p.type });
        }
      }
    }
    if (sacrificed.length === 0) return false;

    // Confirma que o sacrifício é REAL: o oponente precisa conseguir capturar a
    // peça de forma viável (sem que isso, por sua vez, pendure uma peça dele de
    // valor ≥ ao sacrificado, ou — pra peças < torre — permita mate em 1).
    const maxSac = Math.max(...sacrificed.map((s) => PIECE_VAL[s.type]));
    for (const sac of sacrificed) {
      for (const atk of getAttackers(move.fen_after, sac.square)) {
        for (const promo of PROMOS) {
          let test;
          try { test = new Chess(move.fen_after); } catch (e) { continue; }
          if (!test.move({ from: atk.square, to: sac.square, promotion: promo })) continue;
          // O atacante fica "preso" (capturar penduraria uma peça do oponente
          // de valor ≥ ao sacrificado)?
          let attackerPinned = false;
          const tb = test.board();
          for (let r = 0; r < 8 && !attackerPinned; r++) {
            for (let f = 0; f < 8; f++) {
              const ep = tb[r][f];
              if (!ep || ep.color === test.turn() || ep.type === "k" || ep.type === "p") continue;
              const esq = sqFromRC(r, f);
              if (PIECE_VAL[ep.type] >= maxSac && isPieceHanging(move.fen_after, test.fen(), esq)) {
                attackerPinned = true; break;
              }
            }
          }
          if (PIECE_VAL[sac.type] >= 5) {
            if (!attackerPinned) return true;
          } else if (!attackerPinned && !test.moves().some((mv) => mv.endsWith("#"))) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // ===== Classificação =====
  //
  // Modelo do chess.com (pesquisado a partir do "Expected Points Model" oficial e
  // da implementação de referência WintrCat/freechess): o lance é classificado
  // pela QUEDA de probabilidade de vitória entre a melhor jogada da posição e a
  // jogada efetivamente feita, ambas do ponto de vista de quem moveu. Os limiares
  // (em pontos de win-prob 0..1) são exatamente os publicados pelo chess.com:
  //
  //   Best 0 · Excellent ≤0.02 · Good ≤0.05 · Inaccuracy ≤0.10 · Mistake ≤0.20 ·
  //   Blunder >0.20
  //
  // Sobre isso vêm as classificações "especiais" (Brilliant, Great, Book, Forced,
  // Miss) e as transições envolvendo MATE, que não podem ser medidas só por
  // win-prob (mate em 5 e mate em 1 têm ambos ~100% — mas largar um mate forçado
  // é um erro grave, não um lance "excelente").

  const THRESHOLDS = {
    excellent: 0.02,
    good:      0.05,
    inaccuracy:0.10,
    mistake:   0.20,
  };

  // Limites (em cp, POV de quem moveu) acima/abaixo dos quais a posição é
  // considerada "completamente ganha" / "completamente perdida". Usados nas
  // guardas de leniência do chess.com (não é capivarada se você já estava
  // ganhando de lavada, nem se já estava perdido de lavada).
  const WINNING_CP = 600;

  const MATE_CP_THRESHOLD = MATE_SCORE_CP - 1000; // 9000

  function isMateCp(cp) {
    return cp != null && Math.abs(cp) >= MATE_CP_THRESHOLD;
  }

  // Distância de mate COM SINAL (POV de quem moveu): +N = você dá mate em N,
  // -N = você leva mate em N. Só faz sentido quando isMateCp(cp).
  function mateSigned(cp) {
    const n = MATE_SCORE_CP - Math.abs(cp);
    return (cp >= 0 ? 1 : -1) * n;
  }

  function classifyMove(move, prevMove) {
    if (move.in_book) return "book";
    if (move.is_only_move) return "forced";

    const prevEval = move.best_eval_cp;     // melhor avaliação ANTES (POV do jogador)
    const evalAfter = move.eval_after_cp;   // avaliação DEPOIS (POV do jogador)
    const prevMate = isMateCp(prevEval);
    const afterMate = isMateCp(evalAfter);
    const noMate = !prevMate && !afterMate;

    const loss = cpToWinrate(prevEval) - cpToWinrate(evalAfter);
    const isBest = !!move.best_move_san && move.san === move.best_move_san;

    let cls;
    if (isBest) {
      cls = "best";
    } else if (noMate) {
      // Caminho comum: queda de win-prob contra os limiares do chess.com.
      if (loss <= THRESHOLDS.excellent) cls = "excellent";
      else if (loss <= THRESHOLDS.good) cls = "good";
      else if (loss <= THRESHOLDS.inaccuracy) cls = "inaccuracy";
      else if (loss <= THRESHOLDS.mistake) cls = "mistake";
      else cls = "blunder";
    } else if (!prevMate && afterMate) {
      // Não havia mate; agora há. Se VOCÊ passou a ter mate forçado, é o melhor
      // que existia; se você PERMITIU mate, a gravidade depende de quão próximo.
      const aev = mateSigned(evalAfter);
      if (aev > 0) cls = "best";
      else if (aev >= -2) cls = "blunder";      // levou mate em 1–2
      else if (aev >= -5) cls = "mistake";      // mate em 3–5
      else cls = "inaccuracy";                  // mate distante (6+)
    } else if (prevMate && !afterMate) {
      // Você tinha mate forçado (ou estava sendo mateado) e o lance dissolveu o
      // mate. Largar um mate ganho é erro proporcional ao que sobrou no placar.
      const paev = mateSigned(prevEval);
      if (paev < 0 && evalAfter < 0) cls = "best";   // estava sendo mateado e segue pior: defesa correta
      else if (evalAfter >= 400) cls = "good";       // largou o mate mas segue ganhando fácil
      else if (evalAfter >= 150) cls = "inaccuracy";
      else if (evalAfter >= -100) cls = "mistake";
      else cls = "blunder";                          // tinha mate, agora está perdendo
    } else {
      // Mate dos dois lados (antes e depois).
      const paev = mateSigned(prevEval);
      const aev = mateSigned(evalAfter);
      if (paev > 0) {                 // você tinha o mate
        if (aev <= -4) cls = "mistake";
        else if (aev < 0) cls = "blunder";          // transformou seu mate em levar mate
        else if (aev < paev) cls = "best";          // mate ainda mais rápido
        else if (aev <= paev + 2) cls = "excellent";
        else cls = "good";
      } else {                        // você estava sendo mateado
        cls = (aev === paev) ? "best" : "good";
      }
    }

    // ---- Upgrades a partir de "Melhor Lance": Brilhante e Ótimo. ----
    if (cls === "best") {
      if (detectBrilliant(move)) cls = "brilliant";
      else if (noMate && isGreat(move, prevMove)) cls = "great";
    }

    // ---- Miss: tinha um GANHO claro nas mãos e deixou escapar. ----
    // O chess.com mostra "Oportunidade Perdida" quando você estava ganhando (ou
    // tinha mate) e, em vez de converter, o lance leva a posição de volta pra
    // igualdade ou pior. Sobrepõe os tons negativos (inaccuracy/mistake/blunder).
    const hadWin = prevMate ? prevEval > 0 : prevEval >= 300;
    const keptWin = afterMate ? evalAfter > 0 : evalAfter >= 100;
    if (!isBest && hadWin && !keptWin && loss > THRESHOLDS.good &&
        (cls === "inaccuracy" || cls === "mistake" || cls === "blunder")) {
      cls = "miss";
    }

    // ---- Guardas de leniência do chess.com (só sobre "capivarada"). ----
    if (cls === "blunder") {
      // Ainda completamente ganho após o lance → no máximo "bom".
      if (!afterMate && evalAfter >= WINNING_CP) cls = "good";
      // Já estava completamente perdido antes → não foi ESSE lance que perdeu.
      else if (noMate && prevEval <= -WINNING_CP) cls = "good";
    }

    return cls;
  }

  // "Ótimo Lance" (Great) = momento crítico em que havia UMA só jogada à altura.
  // No chess.com isso aparece quando você pune um deslize do oponente ou acha a
  // única continuação que segura/ganha a posição. Critério (sem mate envolvido):
  // folga grande pro 2º melhor lance, a peça movida não fica pendurada, e não é
  // uma recaptura óbvia. Aceita uma folga menor quando o oponente acabou de errar.
  function isGreat(move, prevMove) {
    if (move.second_best_eval_cp == null) return false;
    if (isMateCp(move.best_eval_cp) || isMateCp(move.second_best_eval_cp)) return false;

    const gap = move.best_eval_cp - move.second_best_eval_cp;
    const toSq = move.uci.slice(2, 4);
    let movedHanging = false;
    try { movedHanging = isPieceHanging(move.fen_before, move.fen_after, toSq); } catch (e) {}
    if (movedHanging) return false;

    const oppErred = !!prevMove &&
      (prevMove.classification === "blunder" || prevMove.classification === "mistake" ||
       prevMove.classification === "miss");

    // Puniu o erro do oponente com a resposta claramente melhor.
    if (oppErred && gap >= 150) { move._opp_erred = true; return true; }

    // Única jogada boa num momento ainda em disputa (posição não decidida).
    if (Math.abs(move.best_eval_cp) <= WINNING_CP && gap >= 250) {
      // Recaptura óbvia na mesma casa não é "ótimo".
      if (prevMove && prevMove.is_capture && prevMove.to === move.to) return false;
      // Captura que não arrisca material: a folga só reflete "tem que recapturar".
      if (move.is_capture && move.net_material != null && move.net_material >= -0.5) return false;
      return true;
    }
    return false;
  }

  // ===== Comentários por lance =====
  //
  // Filosofia (pesquisada a partir do Game Review do chess.com e da análise do
  // Lichess): um bom comentário NÃO rotula o lance, ele EXPLICA a consequência
  // concreta — "perde o cavalo", "deixa passar o mate em 2", "ganhava a dama".
  // O chess.com chama isso de traduzir a linha do engine em linguagem humana
  // (as opções "Show Lost Piece", "Show Checkmate", "Show Fork" do coach). Como
  // rodamos 100% no browser (sem LLM), fazemos detecção de motivos por REGRAS,
  // usando o que já temos em mãos:
  //   - classificação + evals  -> tem mate? quanto de win% se perdeu?
  //   - melhor lance / melhor PV -> o que se deveria ter feito;
  //   - a REFUTAÇÃO -> a melhor resposta do oponente DEPOIS do lance jogado.
  //     Sai de graça: a posição "depois" do lance N é a posição "antes" do N+1,
  //     que já analisamos, então sua melhor PV é exatamente como o oponente pune.
  // Tudo é função pura (lance -> texto), portanto determinístico — bom pro cache.

  const PIECE_PAWNS = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const PIECE_PT = { p: "peão", n: "cavalo", b: "bispo", r: "torre", q: "dama" };
  const PIECE_PT_DEF = { p: "o peão", n: "o cavalo", b: "o bispo", r: "a torre", q: "a dama" };

  // Distância até o mate a partir do cp codificado (scoreToCp usa MATE - |n|).
  // Devolve o nº de lances (estilo python-chess Mate(n)) ou null se não é mate.
  function mateInFromCp(cp) {
    const a = Math.abs(cp);
    if (a < MATE_SCORE_CP - 1000) return null;
    return MATE_SCORE_CP - a;
  }

  // Simula uma PV e mede o saldo material (em peões) do ponto de vista de `pov`
  // ('w'|'b'), mais a peça mais valiosa que cada lado capturou. Serve pros dois
  // lados da moeda: "esse lance perde X" (PV = refutação do oponente) e "o certo
  // ganhava X" (PV = melhor linha do jogador). Só capturas líquidas importam.
  function lineMaterial(fenStart, pvUci, pov) {
    try {
      const c = new Chess(fenStart);
      const povCaps = [], oppCaps = [];
      for (const u of (pvUci || []).slice(0, 10)) {
        const mover = c.turn();
        const res = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || "q" });
        if (!res) break;
        if (res.captured) {
          (mover === pov ? povCaps : oppCaps).push({ type: res.captured, square: res.to });
        }
      }
      const sum = (arr) => arr.reduce((a, r) => a + (PIECE_PAWNS[r.type] || 0), 0);
      const biggest = (arr) =>
        arr.slice().sort((a, b) => PIECE_PAWNS[b.type] - PIECE_PAWNS[a.type])[0] || null;
      return { delta: sum(povCaps) - sum(oppCaps), won: biggest(povCaps), lost: biggest(oppCaps) };
    } catch (e) {
      return { delta: 0, won: null, lost: null };
    }
  }

  // Nome (com artigo) da peça que efetivamente se moveu — usado pra nomear o
  // sacrifício num lance brilhante.
  function movedPieceName(move) {
    try {
      const p = new Chess(move.fen_before).get(move.uci.slice(0, 2));
      return p ? PIECE_PT_DEF[p.type] : null;
    } catch (e) {
      return null;
    }
  }


  // Casas iniciais das peças menores, pra detectar desenvolvimento na abertura.
  const MINOR_START = {
    N: ["b1", "g1", "b8", "g8"],
    B: ["c1", "f1", "c8", "f8"],
  };

  // O lance ataca a dama inimiga? (a peça que parou em `to` mira a casa da dama
  // adversária). Usa o truque de trocar o lado a mover, como em getAttackers.
  function attacksEnemyQueen(move) {
    try {
      const c = new Chess(move.fen_after);
      const my = move.color === "white" ? "w" : "b";
      const board = c.board();
      let qSq = null;
      for (let r = 0; r < 8 && !qSq; r++) {
        for (let f = 0; f < 8; f++) {
          const p = board[r][f];
          if (p && p.type === "q" && p.color !== my) { qSq = "abcdefgh"[f] + (8 - r); break; }
        }
      }
      if (!qSq) return false;
      const parts = c.fen().split(" ");
      parts[1] = my; parts[3] = "-"; // lado a mover = quem jogou; sem en passant
      return new Chess(parts.join(" "))
        .moves({ square: move.to, verbose: true })
        .some((m) => m.to === qSq);
    } catch (e) {
      return false;
    }
  }

  // Frase curta do que o lance FAZ na posição (ação concreta), pra enriquecer os
  // comentários de lances bons. Devolve null quando não há nada de notável.
  function describeAction(move) {
    const t = move.san.replace(/[+#!?]/g, "");
    if (t === "O-O") return "leva o rei pra segurança do roque";
    if (t === "O-O-O") return "faz o roque grande e ativa a torre";
    if (t.includes("=")) {
      const promo = (t.split("=")[1] || "")[0];
      return `promove ${PIECE_PT_DEF[(promo || "").toLowerCase()] || "a peça"}`;
    }
    const parts = [];
    if (move.is_capture && PIECE_PT_DEF[move.captured_piece]) {
      parts.push(`captura ${PIECE_PT_DEF[move.captured_piece]}`);
    }
    if ((move.ply || 99) <= 20) {
      const from = (move.uci || "").slice(0, 2);
      if (/^N/.test(t) && MINOR_START.N.includes(from)) parts.push("desenvolve o cavalo");
      else if (/^B/.test(t) && MINOR_START.B.includes(from)) parts.push("desenvolve o bispo");
      else if (!/^[NBRQK]/.test(t) && ["e4", "d4", "e5", "d5"].includes(t.slice(-2))) {
        parts.push("finca um peão no centro");
      }
    } else if (/^K/.test(t) && !move.is_capture && !move.is_check) {
      // No final, o rei vira peça ativa — bom de mencionar nos vários lances de
      // rei que senão ficariam todos com o mesmo texto.
      parts.push("ativa o rei");
    }
    if (attacksEnemyQueen(move)) parts.push("ataca a dama");
    if (move.is_check && !parts.some((p) => p.includes("xeque"))) parts.push("dá xeque");
    return parts.length ? parts.slice(0, 2).join(" e ") : null;
  }

  // Substantivo do material por valor aproximado (em peões) — usado quando a
  // perda/ganho vem de uma sequência e nomear UMA peça seria enganoso.
  function materialNoun(pawns) {
    const d = Math.round(Math.abs(pawns));
    if (d >= 8) return "a dama";
    if (d >= 5) return "uma torre";
    if (d === 4) return "material pesado";
    if (d === 3) return "uma peça";
    if (d === 2) return "a qualidade";
    if (d === 1) return "um peão";
    return "material";
  }

  // Nome (com artigo) da peça que está numa casa, numa dada FEN.
  function pieceAt(fen, sq) {
    try {
      const p = new Chess(fen).get(sq);
      return p ? PIECE_PT_DEF[p.type] : null;
    } catch (e) {
      return null;
    }
  }

  function generateComment(move, opening) {
    const cls = move.classification;
    const san = move.san;
    const best = move.best_move_san;
    const hasBest = best && best !== san;
    // Variação determinística (bom pro cache): mistura ply + 1ª letra do SAN pra
    // não cair sempre na mesma frase em lances vizinhos do mesmo tipo.
    const seed = (move.ply || 0) + (san ? san.charCodeAt(0) : 0);
    const pick = (arr) => arr[seed % arr.length];
    const pov = move.color === "white" ? "w" : "b";

    // --- Clímax: xeque-mate dado. ---
    if (move.is_checkmate) {
      return pick([
        `${san} é xeque-mate. Fim de jogo!`,
        `${san} crava o mate — acabou!`,
        `${san}# encerra a partida. Belo final!`,
      ]);
    }

    // --- Abertura conhecida. ---
    if (cls === "book") {
      return opening && opening.name
        ? pick([
            `${san} faz parte da ${opening.name}, ainda na teoria.`,
            `${san} segue a ${opening.name} — lance de livro.`,
          ])
        : pick([`${san} é um lance de abertura conhecido.`, `${san} segue a teoria de abertura.`]);
    }

    // --- Único lance legal. ---
    if (cls === "forced") {
      return pick([
        `${san} é forçado — era o único lance legal na posição.`,
        `${san} é a única jogada possível aqui; não havia escolha.`,
        `Sem alternativas: ${san} era obrigatório.`,
      ]);
    }

    // Fatos concretos: mate (a favor/contra), material entregue (refutação) e
    // material que se deixou de ganhar (melhor linha).
    const mateDist = mateInFromCp(move.eval_after_cp);
    const mateBestDist = mateInFromCp(move.best_eval_cp);
    const playerHasMate = mateDist != null && move.eval_after_cp > 0;
    const oppHasMate = mateDist != null && move.eval_after_cp < 0;
    const bestWasMate = mateBestDist != null && move.best_eval_cp > 0;

    const refMat = lineMaterial(move.fen_after, move.refutation_pv_uci, pov);   // o que entrega
    const bestMat = lineMaterial(move.fen_before, move.best_pv_uci, pov);       // o que ganhava

    // Substância dos lances bons: o que o lance FAZ na posição (a avaliação em
    // si fica por conta da barra/gráfico de eval — não repetimos "você fica
    // melhor" no texto).
    const action = describeAction(move);

    // ---------- Lances POSITIVOS ----------
    if (cls === "brilliant") {
      const sac = movedPieceName(move) || "material";
      if (playerHasMate) {
        return `${san} é brilhante!! Entrega ${sac} e força o mate em ${mateDist} — difícil de achar no tabuleiro.`;
      }
      return pick([
        `${san} é brilhante!! Sacrifica ${sac}, mas a compensação vale muito mais — lance de craque.`,
        `${san}!! Larga ${sac} de propósito: aceitar a peça leva a posição do adversário ao colapso.`,
        `${san} é um sacrifício brilhante!! Entregar ${sac} aqui é mais forte do que parece — pegar a isca só piora tudo pro adversário.`,
      ]);
    }
    if (cls === "great") {
      if (playerHasMate) return `${san} é o lance da posição: conduz ao mate forçado em ${mateDist}.`;
      const oppErred = move._opp_erred;
      if (oppErred) {
        return pick([
          `${san} é ótimo! Pune o deslize do adversário e era a resposta certa.`,
          `${san} é o lance preciso pra aproveitar a chance que apareceu.`,
        ]);
      }
      return pick([
        `${san} é ótimo — era praticamente a única jogada que segura a posição.`,
        `${san} é o lance da posição: qualquer outro estragava tudo.`,
        `${san} acha o caminho estreito; era a única continuação à altura.`,
      ]);
    }
    if (cls === "best" || cls === "excellent") {
      if (playerHasMate) return `${san} encaminha o mate forçado em ${mateDist}; siga a linha indicada e não há defesa.`;
      const lead = cls === "best"
        ? pick([
            `${san} é a melhor jogada da posição`,
            `${san} era o lance certo aqui`,
            `${san} é exatamente o que o engine recomenda`,
            `Nada superava ${san}`,
            `${san} é a escolha mais precisa`,
          ])
        : pick([
            `${san} é excelente, quase tão bom quanto o melhor lance`,
            `${san} é uma escolha excelente`,
            `${san} é praticamente o melhor que havia`,
            `${san} é muito forte`,
          ]);
      return action ? `${lead}: ${action}.` : `${lead}.`;
    }
    if (cls === "good") {
      const lead = pick([
        `${san} é um bom lance`,
        `${san} é uma jogada sólida`,
        `${san} mantém o controle`,
        `${san} é razoável e não compromete nada`,
      ]);
      return action ? `${lead}: ${action}.` : `${lead}.`;
    }

    // ---------- Lances NEGATIVOS ----------
    // Tenta uma explicação CONCRETA da consequência (a parte "precisa"); só cai
    // no texto genérico quando nenhum fato forte foi detectado — e aí usa a
    // queda de chance de vitória, que ainda é informação real da posição.
    let why = null;
    const punish = move.refutation_pv_san && move.refutation_pv_san[0];
    const netLoss = move.net_material != null ? move.net_material : refMat.delta;
    // O oponente captura JÁ a peça que você acabou de mover (na casa de destino)?
    // Aí dá pra nomear exatamente a peça perdida ("perde o cavalo após gxf6").
    // Senão, a perda vem de uma sequência e cravar UMA peça engana (pode ser
    // uma troca lá na frente da linha) — usamos a magnitude do saldo líquido.
    const refTo = move.refutation_pv_uci && move.refutation_pv_uci[0]
                  && move.refutation_pv_uci[0].slice(2, 4);
    const tookMovedPiece = refTo && refTo === move.to && punish && punish.includes("x");

    if (oppHasMate) {
      why = `permite mate forçado em ${mateDist}` + (punish ? `, começando por ${punish}` : "");
    } else if (cls === "miss" && bestWasMate) {
      why = `havia mate forçado em ${mateBestDist} jogando ${best}`;
    } else if (cls === "miss" && bestMat.delta >= 2) {
      why = `${best} ganhava ${materialNoun(bestMat.delta)} e a chance passou batido`;
    } else if (tookMovedPiece && netLoss <= -1) {
      why = `perde ${pieceAt(move.fen_after, move.to) || "a peça"}` + (punish ? ` após ${punish}` : "");
    } else if (netLoss <= -2 && move.eval_after_cp <= 30) {
      // Perda via sequência: só afirma quando você NÃO segue à frente (senão é
      // só devolver parte da vantagem, e dizer "perde a torre" soa contraditório).
      why = `perde ${materialNoun(netLoss)}` + (punish ? ` após ${punish}` : "");
    } else if (cls === "blunder" && bestMat.delta >= 2) {
      why = `${best} ganhava ${materialNoun(bestMat.delta)} e você deixou passar`;
    }

    const winDrop = Math.round(cpToWinPercent(move.best_eval_cp) - cpToWinPercent(move.eval_after_cp));
    const dropTxt = winDrop >= 4 ? ` (perde ~${winDrop}% de chance de vitória)` : "";
    // Sugestão do lance certo, quando não foi nomeada dentro do "why".
    const altTxt = (txt) => (hasBest && (!why || !why.includes(best)) ? txt : "");

    switch (cls) {
      case "inaccuracy":
        return why
          ? `${san} é impreciso: ${why}.`
          : `${san} é uma imprecisão${dropTxt}${altTxt(`; ${best} mantinha as rédeas`)}.`;
      case "mistake":
        return why
          ? `${san} é um erro — ${why}.`
          : `${san} é um erro${dropTxt}${altTxt(`; ${best} era a melhor pedida`)}.`;
      case "blunder":
        return why
          ? `Capivarada! ${san} ${why}.`
          : `Capivarada! ${san} entrega a posição${dropTxt}${altTxt(` — ${best} era necessário`)}.`;
      case "miss":
        return why
          ? `${san} deixa a vitória escapar: ${why}.`
          : `${san} desperdiça a oportunidade${altTxt(` — ${best} aproveitava`)}.`;
      default:
        return `${san}.`;
    }
  }

  // ===== UCI -> SAN da PV (usa chess.js) =====

  function pvUciToSan(fenBefore, pvUci) {
    if (!pvUci || !pvUci.length) return [];
    try {
      const c = new Chess(fenBefore);
      const sans = [];
      for (const u of pvUci.slice(0, 8)) {
        const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || "q" });
        if (!m) break;
        sans.push(m.san);
      }
      return sans;
    } catch (e) {
      return [];
    }
  }

  // ===== Loop principal =====

  /**
   * Analisa a partida completa.
   *
   * Otimizações de performance:
   *  1. Dedup de posições. A "posição depois" do lance N é IDÊNTICA à "posição
   *     antes" do lance N+1, então analisamos cada posição uma única vez (N+1 no
   *     total em vez de 2N). Vale a identidade:
   *         eval_after[i] = -eval_before[i+1]   (POVs opostos, mesma posição)
   *  2. Paralelismo. Se `pool` for um EnginePool, as posições (independentes) são
   *     distribuídas entre vários workers — perto de escalar com o nº de núcleos.
   *     Também aceita um BrowserEngine único (cai pro modo serial).
   *
   * @param {object} parsed              - resposta do /api/pgn/parse
   * @param {EnginePool|BrowserEngine} pool
   * @param {object} opts                - { depth, multipv }
   * @param {function} onMove            - onMove(moveData, idx, total) por lance pronto
   * @returns {Promise<object>} payload completo com stats
   */
  async function analyzeGame(parsed, pool, opts, onMove) {
    const depth = opts.depth || 14;
    const multipv = 2; // precisamos do 2º melhor pra detectar Great
    const moves = parsed.moves;
    const opening = parsed.opening;
    const N = moves.length;

    const collected = [];

    if (N > 0) {
      // Lista de posições ÚNICAS: fen_before[0..N-1] + fen_after do último lance.
      // Como fen_before[i+1] === fen_after[i], cobre tudo sem repetir.
      const positions = new Array(N + 1);
      for (let i = 0; i < N; i++) positions[i] = moves[i].fen_before;
      positions[N] = moves[N - 1].fen_after;

      // Só as posições "antes" precisam de MultiPV 2 (pra detectar Great); a
      // posição final só precisa do eval.
      const optsFor = (i) => ({ depth, multipv: i < N ? multipv : 1 });

      function parsePosInfo(info) {
        const best = info && info[1];
        const second = info && info[2];
        return {
          bestEvalCp: scoreToCp(best?.score),
          bestUci: best?.pv?.[0] || "",
          bestPvUci: (best?.pv || []).slice(0, 8),
          secondEvalCp: second ? scoreToCp(second.score) : null,
        };
      }

      const posResult = new Array(N + 1).fill(undefined);
      let flushed = 0;

      // Emite os lances EM ORDEM conforme as posições de que dependem ficam
      // prontas (a posição i e a i+1). As posições podem terminar fora de ordem
      // por causa do pool; o flush mantém a UI em ordem.
      function flush() {
        while (flushed < N && posResult[flushed] && posResult[flushed + 1]) {
          const i = flushed;
          const mv = moves[i];
          const pr = posResult[i];
          const bestPvSan = pvUciToSan(mv.fen_before, pr.bestPvUci);
          const bestSan = bestPvSan[0] || "";
          const evalAfterCp = mv.is_checkmate
            ? MATE_SCORE_CP - 1
            : -posResult[i + 1].bestEvalCp;
          // Refutação: a melhor PV da posição "depois" do lance é exatamente
          // como o oponente pune. Usada pra comentários precisos ("perde a dama
          // após Qxd8"). Vazia em xeque-mate (não há resposta).
          const refPvUci = mv.is_checkmate ? [] : (posResult[i + 1].bestPvUci || []);
          // Material LÍQUIDO do lance (em peões, POV de quem moveu): o que ele
          // captura de cara + o saldo da melhor resposta do oponente. ~0 numa
          // troca, bem negativo num sacrifício de verdade. É o sinal honesto
          // que separa "sacrifício brilhante" de "troquei peças".
          const pov = mv.color === "white" ? "w" : "b";
          const moveCaptureVal = mv.is_capture ? (PIECE_PAWNS[mv.captured_piece] || 0) : 0;
          const netMaterial = moveCaptureVal + lineMaterial(mv.fen_after, refPvUci, pov).delta;

          // Único lance legal na posição? (classificação "Forçado" do chess.com).
          let isOnlyMove = false;
          try { isOnlyMove = new Chess(mv.fen_before).moves().length === 1; } catch (e) {}

          const enriched = {
            ...mv,
            best_eval_cp: pr.bestEvalCp,
            eval_before_cp: pr.bestEvalCp,
            eval_after_cp: evalAfterCp,
            second_best_eval_cp: pr.secondEvalCp,
            best_move_san: bestSan,
            best_move_uci: pr.bestUci,
            best_pv_san: bestPvSan,
            best_pv_uci: pr.bestPvUci,
            refutation_pv_uci: refPvUci,
            refutation_pv_san: pvUciToSan(mv.fen_after, refPvUci),
            net_material: netMaterial,
            is_only_move: isOnlyMove,
          };
          enriched.classification = classifyMove(enriched, collected[collected.length - 1]);
          enriched.comment = generateComment(enriched, opening);
          collected.push(enriched);
          if (onMove) onMove(enriched, i, N);
          flushed++;
        }
      }

      const onResult = (i, info) => { posResult[i] = parsePosInfo(info); flush(); };

      if (typeof pool.analyzeAll === "function") {
        await pool.analyzeAll(positions, optsFor, onResult);
      } else {
        // Fallback serial (BrowserEngine único).
        for (let i = 0; i < positions.length; i++) {
          const info = await pool.analyzeOnce(positions[i], optsFor(i));
          onResult(i, info);
        }
      }
      flush(); // garante que tudo foi emitido
    }

    // Contagens por classificação.
    const counts = { white: {}, black: {} };
    for (const m of collected) {
      counts[m.color][m.classification] = (counts[m.color][m.classification] || 0) + 1;
    }
    // Acurácia da partida pelo método do Lichess (≈ chess.com): média entre
    // média harmônica e média ponderada por volatilidade.
    const acc = computeGameAccuracies(collected);
    const accW = acc.white;
    const accB = acc.black;

    const result = {
      headers: parsed.headers,
      moves: collected,
      accuracy_white: Math.round(accW * 10) / 10,
      accuracy_black: Math.round(accB * 10) / 10,
      elo_white: estimateElo(accW),
      elo_black: estimateElo(accB),
      counts_white: counts.white,
      counts_black: counts.black,
      opening: opening,
    };
    result.coach_summary = generateCoachSummary(result);
    return result;
  }

  function generateCoachSummary(result) {
    const moves = result.moves;
    const total = moves.length;
    const lastBookPly = result.opening?.last_book_ply || 0;
    const endOpening = Math.max(lastBookPly, Math.min(20, total));
    const endMiddle = Math.max(endOpening + 1, total - 20);

    const critical = moves.filter(m =>
      ["blunder","mistake","miss","brilliant","great"].includes(m.classification)
    ).map(m => ({
      ply: m.ply, move_number: m.move_number, color: m.color,
      san: m.san, classification: m.classification, comment: m.comment,
    })).slice(0, 10);

    const bullets = [];
    if (result.opening?.name) {
      bullets.push(`Abertura jogada: **${result.opening.name}** (${result.opening.eco || ""}). Saiu do livro no lance ${Math.floor(lastBookPly/2)+1}.`);
    }
    bullets.push(`Acurácia — Brancas: **${result.accuracy_white}** (ELO est. ~${result.elo_white}); Pretas: **${result.accuracy_black}** (ELO est. ~${result.elo_black}).`);

    const blW = moves.filter(m=>m.color==="white"&&m.classification==="blunder").length;
    const blB = moves.filter(m=>m.color==="black"&&m.classification==="blunder").length;
    const brW = moves.filter(m=>m.color==="white"&&m.classification==="brilliant").length;
    const brB = moves.filter(m=>m.color==="black"&&m.classification==="brilliant").length;
    if (blW || blB) bullets.push(`Capivaradas na partida — Brancas: ${blW}; Pretas: ${blB}.`);
    if (brW || brB) bullets.push(`Lances brilhantes — Brancas: ${brW}; Pretas: ${brB}.`);

    let worst = null, worstLoss = 0;
    for (const m of moves) {
      const loss = cpToWinrate(m.best_eval_cp) - cpToWinrate(m.eval_after_cp);
      if (loss > worstLoss) { worstLoss = loss; worst = m; }
    }
    if (worst && worstLoss > 0.15) {
      const fase = worst.ply <= endOpening ? "abertura"
                  : worst.ply <= endMiddle ? "meio-jogo" : "final";
      bullets.push(`Lance mais decisivo: ${worst.move_number}${worst.color==="white"?".":"..."} ${worst.san} (${fase}) — perdeu ~${Math.round(worstLoss*100)}% de chance de vitória.`);
    }

    return { bullets, critical_moves: critical };
  }

  // Exporta no escopo global
  window.ChessReviewAnalysis = {
    analyzeGame,
    classifyMove,
    cpToWinrate,
    cpToWinPercent,
    scoreToCp,
    accuracyFromLoss,
    moveAccuracy,
    computeGameAccuracies,
    estimateElo,
    pvUciToSan,
    MATE_SCORE_CP,
  };
})();
