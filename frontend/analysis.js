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

  function accuracyFromLoss(loss) {
    loss = Math.max(0.0, loss);
    const lossPct = loss * 100;
    const acc = 103.1668 * Math.exp(-0.04354 * lossPct) - 3.1669;
    return Math.max(0.0, Math.min(100.0, acc));
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

    // Brilliant: sacrifício + lance bom + posição equilibrada
    if (move.is_sacrifice && loss < THRESHOLDS.excellent) {
      if (move.best_eval_cp > -300 && move.best_eval_cp < 900) {
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

  // ===== Comentários templates =====

  function generateComment(move, opening) {
    const cls = move.classification;
    const san = move.san;
    const best = move.best_move_san;
    if (cls === "book" && opening && opening.name) {
      return `${san} ainda é parte da ${opening.name}.`;
    }
    const base = {
      brilliant:  `Lance brilhante! ${san} é um sacrifício excepcional.`,
      great:      `Ótimo lance! ${san} era a única forma de manter a vantagem.`,
      best:       `Melhor lance. ${san} é exatamente o que o engine recomendava.`,
      excellent:  `Excelente. ${san} é praticamente tão bom quanto o melhor lance.`,
      good:       `Bom lance. ${san} mantém uma posição razoável.`,
      book:       `${san} é um lance de abertura conhecido.`,
      inaccuracy: `Imprecisão. ${san} entrega um pouco da vantagem — ${best} era mais preciso.`,
      mistake:    `Erro. ${san} piora sua posição — o engine preferia ${best}.`,
      blunder:    `Capote! ${san} é uma jogada ruim — o correto era ${best}.`,
      miss:       `Oportunidade perdida. Você poderia ter punido com ${best}.`,
    }[cls] || `${san}.`;

    const extras = [];
    if (move.is_checkmate) extras.push("Xeque-mate!");
    else if (move.is_check) extras.push("Dá xeque.");
    if (move.is_capture) {
      const names = { p: "peão", n: "cavalo", b: "bispo", r: "torre", q: "dama" };
      if (names[move.captured_piece]) extras.push(`Captura ${names[move.captured_piece]}.`);
    }
    return extras.length ? base + " " + extras.join(" ") : base;
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

    // Stats finais.
    const stats = { white: [], black: [] };
    const counts = { white: {}, black: {} };
    for (const m of collected) {
      const loss = Math.max(0, cpToWinrate(m.best_eval_cp) - cpToWinrate(m.eval_after_cp));
      const acc = accuracyFromLoss(loss);
      stats[m.color].push(acc);
      counts[m.color][m.classification] = (counts[m.color][m.classification] || 0) + 1;
    }
    const accW = stats.white.length ? stats.white.reduce((a,b)=>a+b,0)/stats.white.length : 0;
    const accB = stats.black.length ? stats.black.reduce((a,b)=>a+b,0)/stats.black.length : 0;

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
    if (blW || blB) bullets.push(`Capotes na partida — Brancas: ${blW}; Pretas: ${blB}.`);
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
    scoreToCp,
    accuracyFromLoss,
    estimateElo,
    pvUciToSan,
    MATE_SCORE_CP,
  };
})();
