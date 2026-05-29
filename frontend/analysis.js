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

  // ===== Detecção de sacrifício (proxy simples) =====
  // Critério: lance move peça mais cara pra casa atacada por peça mais barata
  // e o eval permanece favorável após o lance.
  // Usamos chess.js pra inspecionar atacantes/defensores.
  const PV = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

  function detectSacrifice(fenBefore, uci) {
    try {
      const c = new Chess(fenBefore);
      const from = uci.slice(0, 2), to = uci.slice(2, 4);
      const piece = c.get(from);
      if (!piece) return false;
      const myValue = PV[piece.type] || 0;
      const moveRes = c.move({ from, to, promotion: uci.slice(4) || "q" });
      if (!moveRes) return false;
      // attackers do oponente sobre a casa de destino, depois do lance.
      // chess.js 0.10.x não tem .attackers(), mas tem .moves({ square: to, verbose: true })
      // pra ver os lances que pegam a peça. Vamos contar quantos lances do oponente
      // capturam em `to`.
      const opp = piece.color === "w" ? "b" : "w";
      // Geramos lances do lado oposto via clonagem de FEN trocando o lado a mover.
      const fen = c.fen().split(" ");
      fen[1] = opp;
      const c2 = new Chess(fen.join(" "));
      const attackers = c2.moves({ verbose: true }).filter(m => m.to === to);
      if (!attackers.length) return false;
      // Menor valor do atacante.
      const cheapest = Math.min(...attackers.map(a => PV[a.piece] || 999));
      return cheapest < myValue && (myValue - cheapest) >= 200;
    } catch (e) {
      return false;
    }
  }

  // ===== Classificação =====

  const THRESHOLDS = {
    excellent: 0.02,
    good:      0.05,
    inaccuracy:0.10,
    mistake:   0.20,
  };

  function classifyMove(move, prevMove) {
    if (move.in_book) return "book";

    const wrBest = cpToWinrate(move.best_eval_cp);
    const wrAfter = cpToWinrate(move.eval_after_cp);
    const loss = wrBest - wrAfter;
    const isBest = move.san === move.best_move_san;

    // Brilliant: sacrifício + lance bom + posição não já vencida.
    // best_eval_cp aqui é a melhor avaliação ANTES do lance (POV de quem moveu).
    // Critério estilo chess.com: não pode estar já ganhando (< +2 ≈ 200cp) — se
    // já está crushing, sacrifício deixa de ser "brilhante", vira "óbvio".
    // Também não pode estar perdido (> -300cp): se está -3 e sacrifica, é a
    // única chance de jogo, não brilhantismo.
    if (move.is_sacrifice && loss < THRESHOLDS.excellent) {
      if (move.best_eval_cp > -300 && move.best_eval_cp < 200) {
        return "brilliant";
      }
    }

    if (isBest) {
      if (isGreat(move)) return "great";
      return "best";
    }

    // Miss: oponente acabou de blunderar/errar e o jogador não puniu.
    if (prevMove && (prevMove.classification === "blunder" || prevMove.classification === "mistake")) {
      if (move.best_eval_cp > 200 && move.eval_after_cp < move.best_eval_cp - 200) {
        return "miss";
      }
    }

    if (loss <= THRESHOLDS.excellent) return "excellent";
    if (loss <= THRESHOLDS.good) return "good";
    if (loss <= THRESHOLDS.inaccuracy) return "inaccuracy";
    if (loss <= THRESHOLDS.mistake) return "mistake";
    return "blunder";
  }

  function isGreat(move) {
    if (move.second_best_eval_cp == null) return false;
    if (Math.abs(move.best_eval_cp) > 800) return false;
    return (move.best_eval_cp - move.second_best_eval_cp) > 200;
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

  function generateComment(move, opening) {
    const cls = move.classification;
    const san = move.san;
    const best = move.best_move_san;
    const hasBest = best && best !== san;
    const pick = (arr) => arr[(move.ply || 0) % arr.length];
    const pov = move.color === "white" ? "w" : "b";

    // --- Clímax: xeque-mate dado. ---
    if (move.is_checkmate) {
      return pick([`${san} é xeque-mate. Fim de jogo!`, `${san} crava o mate — acabou!`]);
    }

    // --- Abertura conhecida. ---
    if (cls === "book") {
      return opening && opening.name
        ? `${san} faz parte da ${opening.name}, uma linha de livro.`
        : pick([`${san} é um lance de abertura conhecido.`, `${san} segue a teoria.`]);
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

    // ---------- Lances POSITIVOS ----------
    if (cls === "brilliant") {
      const sac = movedPieceName(move);
      const base = sac
        ? `${san} é brilhante — sacrifica ${sac} por algo bem maior.`
        : `${san} é brilhante! Um recurso difícil de enxergar.`;
      return playerHasMate ? `${base} Leva a mate forçado em ${mateDist}.` : base;
    }
    if (cls === "great") {
      return pick([
        `${san} é a jogada que segura tudo — era praticamente a única boa.`,
        `${san} é excepcional: qualquer outra coisa estragava a posição.`,
      ]);
    }
    if (cls === "best" || cls === "excellent") {
      if (playerHasMate) return `${san} encaminha o mate forçado em ${mateDist}.`;
      if (move.is_capture && PIECE_PT_DEF[move.captured_piece]) {
        return `${san} captura ${PIECE_PT_DEF[move.captured_piece]} e é o melhor da posição.`;
      }
      if (move.is_check) return `${san} dá xeque e é o lance mais preciso aqui.`;
      return cls === "best"
        ? pick([`${san} é a melhor jogada da posição.`, `${san} era o lance certo aqui.`])
        : pick([`${san} é excelente, quase no nível da melhor opção.`, `${san} é uma ótima escolha.`]);
    }
    if (cls === "good") {
      return pick([`${san} é um bom lance, mantém a posição saudável.`, `${san} é uma jogada sólida.`]);
    }

    // ---------- Lances NEGATIVOS ----------
    // Tenta uma explicação CONCRETA da consequência (a parte "preciso"); só cai
    // no texto genérico quando nenhum fato forte foi detectado.
    let why = null;
    const punish = move.refutation_pv_san && move.refutation_pv_san[0];
    if (oppHasMate) {
      why = `permite mate forçado em ${mateDist}` + (punish ? `, começando por ${punish}` : "");
    } else if (cls === "miss" && bestWasMate) {
      why = `havia mate forçado em ${mateBestDist} com ${best}`;
    } else if (cls === "miss" && bestMat.delta >= 2 && bestMat.won) {
      why = `${best} ganhava ${PIECE_PT_DEF[bestMat.won.type]}`;
    } else if (refMat.delta <= -2 && refMat.lost) {
      why = `perde ${PIECE_PT_DEF[refMat.lost.type]}` + (punish ? ` após ${punish}` : "");
    } else if (cls === "blunder" && bestMat.delta >= 2 && bestMat.won) {
      why = `${best} ganhava ${PIECE_PT_DEF[bestMat.won.type]} e você deixou passar`;
    }

    switch (cls) {
      case "inaccuracy":
        return why
          ? `${san} é impreciso: ${why}.`
          : hasBest ? `${san} é uma imprecisão; ${best} era mais preciso.`
                    : `${san} é uma imprecisão.`;
      case "mistake":
        return why
          ? `${san} é um erro — ${why}.`
          : hasBest ? `${san} é um erro; ${best} era a melhor pedida.`
                    : `${san} é um erro.`;
      case "blunder":
        return why
          ? `Capivarada! ${san} ${why}.`
          : hasBest ? `Capivarada! ${san} entrega a posição — ${best} era necessário.`
                    : `${san} é uma capivarada.`;
      case "miss":
        return why
          ? `${san} deixa passar a chance: ${why}.`
          : hasBest ? `${san} desperdiça a oportunidade — era ${best}.`
                    : `${san} deixa passar uma oportunidade.`;
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
            is_sacrifice: detectSacrifice(mv.fen_before, mv.uci),
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
