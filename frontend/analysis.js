/* Análise completa da partida no navegador.
 *
 * Antes era feita pelo backend Python via Stockfish nativo. Agora roda toda
 * em JS, usando o Stockfish WASM (BrowserEngine). O fluxo é:
 *
 *   1. Backend dá os metadados do PGN (FEN, SAN, UCI, opening por lance).
 *   2. Cada posição única é analisada uma vez (depth base, MultiPV 2) e
 *      coletamos: best_eval, best_move, best_pv, second_best_eval, wdl.
 *   3. Eval after = -eval(fen_after) (do ponto de vista do jogador da vez).
 *   4. Classificação Chess.com V2 (expected points dependentes do rating do
 *      jogador) + Brilliant/Great/Miss (framework wintrchess).
 *   5. Fase de refinamento: lances críticos (blunder/mistake/miss/great/
 *      brilliant) re-analisados em profundidade maior e reclassificados.
 *   6. Acurácia CAPS2 (fórmula aberta do Lichess) + Elo por posterior
 *      bayesiano (curvas acurácia↔rating por ritmo, prior no rating do PGN,
 *      escala lichess↔chess.com) + resumo do coach.
 *
 * Reporta progresso lance-a-lance via callback `onMove`; a fase de
 * refinamento reporta via opts.onRefineProgress(feitas, total).
 *
 * Exporta:
 *   - analyzeGame(parsedPgn, engine, opts, onMove) -> Promise<resultado>
 *   - CLASS_LABELS, CLASS_ORDER, classifyMove (também usados pela UI ao vivo)
 *   - estimateEloDetailed, sfWdlFromCp, winGradientForRating etc. (ver fim)
 */

(function () {
  const MATE_SCORE_CP = 10000;

  // ===== Conversões eval =====
  //
  // Modelo de expected points / Win% em duas camadas:
  //
  // 1. CURVA FIXA (WIN_PCT_GRADIENT, coeficiente do Lichess 0.00368208, PR
  //    lichess#11148, fit em partidas rapid 2300+): usada pela ACURÁCIA e pelo
  //    ACPL/gráficos. Fixa de propósito — mantém os números comparáveis com o
  //    que lichess/chess.com exibem e consistentes com a calibração
  //    acurácia↔rating do estimador de Elo (dados Kaufman/hissha).
  //
  // 2. CURVA POR RATING (winGradientForRating): usada pela CLASSIFICAÇÃO.
  //    É o desenho do Expected Points Model oficial do chess.com
  //    (Classification V2: "winning chances based on their rating and the
  //    engine evaluation"). Âncoras públicas da inclinação k:
  //      - o autor do fit do Lichess mediu k≈0.002 em ratings baixos e
  //        ~0.0037 em 2300+ (discussão do PR #11148);
  //      - desde o SF 15.1 o eval exibido é NORMALIZADO (+1.00 = 50% de
  //        vitória em self-play LTC; docs do WDL model) — a escala encolheu
  //        ~1.6x vs. o eval de 2022 em que o Lichess fez o fit, então o
  //        equivalente do anchor 2300+ na escala normalizada é ~0.0058;
  //      - limite de jogo perfeito (self-play LTC do SF): EP(+100cp)=0.75,
  //        ou seja k≈0.011 — humanos ficam bem abaixo (conversão imperfeita).
  //    Um erro de -1.00 custa pouco a um 800 (posição segue jogável nesse
  //    nível) e muito a um 2600 — as classificações refletem isso.

  const WIN_PCT_GRADIENT = 0.00368208;

  // k(R) — inclinação da sigmóide de expected points por rating (escala
  // chess.com-equivalente). Âncora em 1200 = curva default/histórica do app,
  // então partidas sem rating classificam exatamente como antes.
  const K_BY_RATING = [
    [400, 0.0028],
    [800, 0.0032],
    [1200, WIN_PCT_GRADIENT],
    [1800, 0.0047],
    [2300, 0.0058],
    [2800, 0.0067],
    [3400, 0.0075],
  ];

  // Interpolação linear por partes com clamp nas pontas.
  function interpTable(table, x) {
    if (!isFinite(x) || x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      if (x <= table[i][0]) {
        const [x0, y0] = table[i - 1];
        const [x1, y1] = table[i];
        return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return table[table.length - 1][1];
  }

  // Como interpTable, mas extrapola com a inclinação do segmento da ponta
  // (necessário nas conversões de escala de rating, que não devem "achatar").
  function interpTableExtrap(table, x) {
    const n = table.length;
    let i0;
    if (x <= table[0][0]) i0 = 0;
    else if (x >= table[n - 1][0]) i0 = n - 2;
    else {
      i0 = 0;
      while (i0 < n - 2 && x > table[i0 + 1][0]) i0++;
    }
    const [x0, y0] = table[i0];
    const [x1, y1] = table[i0 + 1];
    return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }

  function winGradientForRating(rating) {
    if (rating == null || !isFinite(rating) || rating <= 0) return WIN_PCT_GRADIENT;
    return interpTable(K_BY_RATING, rating);
  }

  function cpToWinrate(cp, gradient) {
    const k = gradient || WIN_PCT_GRADIENT;
    if (cp == null || !isFinite(cp)) return 0.5;
    if (cp >= MATE_SCORE_CP - 1000) return 1.0;
    if (cp <= -(MATE_SCORE_CP - 1000)) return 0.0;
    cp = Math.max(-1500, Math.min(1500, cp));
    return 1.0 / (1.0 + Math.exp(-k * cp));
  }

  // ===== WDL do Stockfish (port exato do win_rate_model do SF 18) =====
  //
  // O SF 15.1+ publica probabilidades Win/Draw/Loss (UCI_ShowWDL) de um modelo
  // ajustado em self-play LTC do fishtest, dependente do eval E do material em
  // jogo. O engine_wasm habilita a opção e repassa o wdl quando o build
  // suporta; este port (coeficientes do src/uci.cpp da tag sf_18) cobre o
  // fallback e usos síncronos (UI). POV: lado do cp.
  const SF_WDL_AS = [-72.32565836, 185.93832038, -144.58862193, 416.44950446];
  const SF_WDL_BS = [83.86794042, -136.06112997, 69.98820887, 47.62901433];

  function sfWinRateParams(material) {
    const m = Math.max(17, Math.min(78, material == null ? 78 : material)) / 58.0;
    const a = ((SF_WDL_AS[0] * m + SF_WDL_AS[1]) * m + SF_WDL_AS[2]) * m + SF_WDL_AS[3];
    const b = ((SF_WDL_BS[0] * m + SF_WDL_BS[1]) * m + SF_WDL_BS[2]) * m + SF_WDL_BS[3];
    return { a, b };
  }

  // Material total (peões-equivalentes, ambos os lados) a partir do FEN —
  // mesma contagem do SF: P + 3N + 3B + 5R + 9Q.
  const MATERIAL_WEIGHT = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  function materialFromFen(fen) {
    const placement = String(fen || "").split(" ")[0];
    let mat = 0;
    for (const ch of placement) {
      const w = MATERIAL_WEIGHT[ch.toLowerCase()];
      if (w) mat += w;
    }
    return mat;
  }

  // {w,d,l} em per-mille a partir do cp NORMALIZADO exibido pelo SF (inverte o
  // to_cp: v_interno = cp/100 * a(material)).
  function sfWdlFromCp(cp, material) {
    if (cp == null || !isFinite(cp)) return { w: 0, d: 1000, l: 0 };
    if (cp >= MATE_SCORE_CP - 1000) return { w: 1000, d: 0, l: 0 };
    if (cp <= -(MATE_SCORE_CP - 1000)) return { w: 0, d: 0, l: 1000 };
    const { a, b } = sfWinRateParams(material);
    const v = (Math.max(-2000, Math.min(2000, cp)) / 100) * a;
    const w = Math.round(1000 / (1 + Math.exp((a - v) / b)));
    const l = Math.round(1000 / (1 + Math.exp((a + v) / b)));
    return { w, d: Math.max(0, 1000 - w - l), l };
  }

  function expectedPointsFromWdl(wdl) {
    if (!wdl) return 0.5;
    return (wdl.w + wdl.d / 2) / 1000;
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

  // Acurácia de UM lance (fórmula CAPS2 / Lichess), dadas as win% (0..100)
  // ANTES (melhor jogada possível) e DEPOIS (lance jogado), POV de quem moveu.
  // O "+1" é o bônus de incerteza do Lichess (análise imperfeita).
  // Fonte: https://lichess.org/page/accuracy e AccuracyPercent.scala
  function moveAccuracy(winBefore, winAfter) {
    if (winAfter >= winBefore) return 100;
    const winDiff = winBefore - winAfter;
    const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff)
                - 3.166924740191411;
    return Math.max(0.0, Math.min(100.0, raw + 1));
  }

  // Compat: acurácia a partir da perda de winrate (0..1).
  function accuracyFromLoss(loss) {
    const before = 100;
    const after = before - Math.max(0, loss) * 100;
    return moveAccuracy(before, after);
  }

  function _clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function _stddev(arr) {
    if (!arr || arr.length < 2) return 0;
    let mean = 0;
    for (const v of arr) mean += v;
    mean /= arr.length;
    let varSum = 0;
    for (const v of arr) varSum += (v - mean) * (v - mean);
    return Math.sqrt(varSum / arr.length);
  }

  // Média harmônica — pune capivaradas bem mais que a aritmética (um 0% entre
  // vários 100% derruba o total). Floor 0.1 evita divisão por zero.
  function _harmonicMean(values) {
    if (!values.length) return 0;
    let inv = 0;
    for (const v of values) inv += 1 / Math.max(v, 0.1);
    return values.length / inv;
  }

  /**
   * Acurácia da partida por cor — CAPS2 do Lichess (código aberto, documentado):
   *   gameAccuracy = média( média ponderada por volatilidade , média harmônica )
   *
   * Por que não média aritmética simples (wintrchess/chess.com legado)?
   * - Um único blunder entre 40 lances perfeitos só derruba ~2.5 pts na
   *   aritmética, mas o "sentimento" humano é bem pior — a harmônica corrige.
   * - Volatilidade: lances em posições calmas (abertura) pesam menos que lances
   *   em posições táticas; assim a acurácia reflete melhor a qualidade real.
   *
   * Book e forced contam como 100% (não há escolha real / teoria).
   * Fonte: AccuracyPercent.scala (lila) e https://lichess.org/page/accuracy
   */
  function computeGameAccuracies(collected) {
    const out = { white: 0, black: 0 };
    if (!collected.length) return out;

    // Sequência de Win% do ponto de vista das brancas (posição inicial = 50)
    // + acurácia por lance. Usada pra janelas de volatilidade.
    const winWhiteSeq = [50];
    const moveData = [];
    for (const m of collected) {
      const isBookOrForced = m.classification === "book"
        || m.classification === "forced"
        || m.in_book
        || m.is_only_move;
      const winBefore = cpToWinPercent(m.best_eval_cp);
      const winAfter = cpToWinPercent(m.eval_after_cp);
      const acc = isBookOrForced ? 100 : moveAccuracy(winBefore, winAfter);
      // Win% "depois" do lance no POV das brancas.
      const winWhite = m.color === "white" ? winAfter : 100 - winAfter;
      winWhiteSeq.push(winWhite);
      moveData.push({ color: m.color, acc });
    }

    // Tamanho da janela de volatilidade: clamp(n/10, 2, 8) — igual ao Lichess.
    const windowSize = _clamp(Math.floor(collected.length / 10), 2, 8);

    const byColor = { white: [], black: [] };
    for (let i = 0; i < moveData.length; i++) {
      // Janela terminando no Win% pós-lance i (índice i+1 em winWhiteSeq).
      const end = i + 1;
      const start = Math.max(0, end - windowSize + 1);
      const slice = winWhiteSeq.slice(start, end + 1);
      const weight = _clamp(_stddev(slice) || 0.5, 0.5, 12);
      byColor[moveData[i].color].push({ acc: moveData[i].acc, weight });
    }

    function colorAccuracy(items) {
      if (!items.length) return 0;
      let wSum = 0, aSum = 0;
      const accs = [];
      for (const it of items) {
        wSum += it.weight;
        aSum += it.acc * it.weight;
        accs.push(it.acc);
      }
      const weighted = aSum / wSum;
      const harmonic = _harmonicMean(accs);
      return (weighted + harmonic) / 2;
    }

    out.white = colorAccuracy(byColor.white);
    out.black = colorAccuracy(byColor.black);
    return out;
  }

  /**
   * ACPL (Average Centipawn Loss) de um lado — sinal secundário de performance.
   * Cada lance é clampado em 1000 cp (prática padrão: um mate perdido não
   * explode a média).
   */
  function averageCentipawnLoss(collected, color) {
    let sum = 0, n = 0;
    for (const m of collected) {
      if (m.color !== color) continue;
      if (m.classification === "book" || m.classification === "forced"
          || m.in_book || m.is_only_move) continue;
      const loss = Math.max(0, (m.best_eval_cp || 0) - (m.eval_after_cp || 0));
      sum += Math.min(1000, loss);
      n++;
    }
    return n ? sum / n : null;
  }

  // ===== Estimativa de Elo — posterior bayesiano sobre a performance =====
  //
  // Estado da arte acessível (2026), em ordem de fidelidade:
  //  - Regan & Haworth (AAAI'11, "Intrinsic Chess Ratings"): MLE sobre a
  //    qualidade de CADA lance com MultiPV completo; precisa de ~1500 lances
  //    pra barras de erro de ~±100 Elo. Corolário honesto: UMA partida carrega
  //    ±300–500 Elo de incerteza — então reportamos INTERVALO, não só ponto.
  //  - Maia-2 (NeurIPS'24): rede que prediz o lance humano condicionada ao
  //    rating; ótima pra estimar força, inviável no browser (modelo pesado).
  //  - chess.com "Game Rating": "compara a qualidade dos seus lances com o
  //    esperado de um jogador do seu rating", por ritmo (help center) — ou
  //    seja, um posterior com prior no rating do jogador. É o desenho daqui:
  //
  //      P(R | partida) ∝ P(acurácia | R, ritmo) · P(R | rating no PGN)
  //
  //  - Verossimilhança: acurácia ~ Normal(A(R, ritmo), σ(n)). A(R, ritmo) são
  //    as médias medidas por GM Larry Kaufman/hissha (chess.com, ago/2023;
  //    buckets de 60–80+ jogos por rating em 3+0, 5+0, 3+2 e 10+0), com o
  //    linear "Accuracy ≈ Elo/100 + 64" (rapid ≥1600) prolongando o topo.
  //  - σ(n): dispersão partida-a-partida (~4.5 pts em 35 lances, escala 1/√n)
  //    + ruído de medição da análise (~2 pts). ACPL NÃO entra: é quase
  //    colinear com a acurácia e só inflaria a confiança do posterior.
  //  - Prior: Normal(rating do jogador no PGN, σ=300); sem rating, prior
  //    largo. Ratings lichess são convertidos pra escala chess.com antes
  //    (tabelas ChessGoals, jul/2025) e o resultado volta pra escala do site.

  // Acurácia média por rating (escala chess.com) e ritmo — dados hissha/Kaufman.
  // blitz = média dos buckets 3+0 e 5+0; acima do último bucket medido, segue
  // a inclinação publicada (~100 Elo/ponto rapid, ~128 blitz).
  const ACC_BY_RATING = {
    rapid: [
      [250, 66.5], [400, 68.8], [1000, 75.7], [1600, 80.6], [1900, 82.6],
      [2200, 85.6], [2400, 88.0], [2800, 92.0], [3200, 96.0], [3500, 99.0],
    ],
    blitz: [
      [250, 66.6], [400, 68.9], [1000, 76.5], [1600, 79.5], [1900, 81.6],
      [2200, 83.4], [2400, 85.9], [2800, 89.0], [3200, 92.1], [3500, 94.4],
    ],
  };

  // bullet não tem tabela pública dedicada (≈ blitz − 2 pts, precisão menor);
  // classical/daily ≈ rapid + 1 pt (mais tempo, mais acurácia no mesmo rating).
  function expectedAccuracyAt(ccRating, timeClass) {
    const base = (timeClass === "blitz" || timeClass === "bullet")
      ? ACC_BY_RATING.blitz
      : ACC_BY_RATING.rapid;
    const shift = timeClass === "bullet" ? -2.0
      : (timeClass === "classical" || timeClass === "daily") ? 1.0
      : 0;
    return _clamp(interpTable(base, ccRating) + shift, 50, 99.5);
  }

  // Ritmo a partir do header TimeControl ("600", "180+2", "1/86400"...).
  // Convenção lichess: tempo estimado = base + 40·incremento.
  function timeClassFromHeaders(headers) {
    const tc = headers && headers.TimeControl;
    if (!tc || tc === "-" || tc === "?") return "rapid";
    if (/^\d+\/\d+/.test(String(tc))) return "daily"; // correspondência
    const m = String(tc).match(/^(\d+)(?:\+(\d+))?/);
    if (!m) return "rapid";
    const est = parseInt(m[1], 10) + 40 * parseInt(m[2] || "0", 10);
    if (est < 180) return "bullet";
    if (est < 480) return "blitz";
    if (est < 1500) return "rapid";
    return "classical";
  }

  function siteFromHeaders(headers) {
    const s = String((headers && (headers.Site || headers.Link)) || "").toLowerCase();
    if (s.includes("lichess")) return "lichess";
    if (s.includes("chess.com")) return "chesscom";
    return "unknown";
  }

  // Conversão de escala: rating lichess (por pool) ↔ chess.com blitz.
  // Medianas ChessGoals (jul/2025, contas ativas com RD<150).
  const LICHESS_TO_CC_BLITZ = {
    bullet:    [[1295, 1000], [1770, 1500], [2195, 2000], [2560, 2500]],
    blitz:     [[1420, 1000], [1780, 1500], [2100, 2000], [2445, 2500]],
    rapid:     [[1615, 1000], [1930, 1500], [2185, 2000], [2445, 2500]],
    classical: [[1715, 1000], [1935, 1500], [2100, 2000], [2360, 2500]],
  };

  function _liTableFor(timeClass) {
    if (timeClass === "daily" || timeClass === "classical") return LICHESS_TO_CC_BLITZ.classical;
    return LICHESS_TO_CC_BLITZ[timeClass] || LICHESS_TO_CC_BLITZ.rapid;
  }

  // Os pools do chess.com também diferem entre si (rapid ≈ blitz + ~120 no
  // nível de clube, convergindo no topo; bullet ≈ blitz − ~60). Ajuste
  // aproximado — o prior (σ=300) absorve o erro residual.
  function ccBlitzToPool(cc, timeClass) {
    if (timeClass === "bullet") return cc - 60;
    if (timeClass === "blitz") return cc;
    return cc + Math.max(0, Math.min(120, (2400 - cc) * 0.2));
  }
  function ccPoolToBlitz(cc, timeClass) {
    if (timeClass === "bullet") return cc + 60;
    if (timeClass === "blitz") return cc;
    let x = cc; // inverte cc_blitz + bonus(cc_blitz) = cc por ponto-fixo
    for (let i = 0; i < 4; i++) x = cc - Math.max(0, Math.min(120, (2400 - x) * 0.2));
    return x;
  }

  function toCcScale(rating, site, timeClass) {
    if (rating == null || !isFinite(rating) || rating <= 0) return null;
    if (site !== "lichess") return rating;
    const ccBlitz = interpTableExtrap(_liTableFor(timeClass), rating);
    return _clamp(ccBlitzToPool(ccBlitz, timeClass), 100, 3300);
  }
  function fromCcScale(cc, site, timeClass) {
    if (cc == null || !isFinite(cc)) return null;
    if (site !== "lichess") return cc;
    const inv = _liTableFor(timeClass).map((row) => [row[1], row[0]]);
    return interpTableExtrap(inv, ccPoolToBlitz(cc, timeClass));
  }

  /**
   * Posterior de rating da performance nesta partida.
   *
   * @param {number} accuracy  acurácia CAPS2 da partida (0..100, curva fixa)
   * @param {object} opts      { anchorElo, moveCount, timeClass, site }
   * @returns {{elo:number, lo:number, hi:number, timeClass:string, site:string}}
   *          elo = média do posterior; [lo, hi] = intervalo de credibilidade
   *          de 80% (quantis 10%–90%) — tudo na escala do site da partida.
   */
  function estimateEloDetailed(accuracy, opts) {
    opts = opts || {};
    const acc = _clamp(accuracy != null && isFinite(accuracy) ? accuracy : 0, 0, 100);
    const n = opts.moveCount != null && opts.moveCount > 0 ? opts.moveCount : 30;
    const timeClass = opts.timeClass || "rapid";
    const site = opts.site || "unknown";
    const anchorCc = toCcScale(opts.anchorElo, site, timeClass);

    // Dispersão da acurácia de UMA partida em torno da média do rating.
    const sigma = Math.sqrt(2 * 2 + 4.5 * 4.5 * (35 / Math.max(8, n)));

    const STEP = 25, LO = 100, HI = 3400;
    const SIG_PRIOR = 300;   // com rating no PGN
    const MU0 = 1300, SIG0 = 1100; // prior fraco sem rating (regulariza pontas)

    const rows = [];
    let maxLog = -Infinity;
    for (let r = LO; r <= HI; r += STEP) {
      const mu = expectedAccuracyAt(r, timeClass);
      let logw = -((acc - mu) * (acc - mu)) / (2 * sigma * sigma);
      if (anchorCc != null) {
        logw -= ((r - anchorCc) * (r - anchorCc)) / (2 * SIG_PRIOR * SIG_PRIOR);
      } else {
        logw -= ((r - MU0) * (r - MU0)) / (2 * SIG0 * SIG0);
      }
      rows.push([r, logw]);
      if (logw > maxLog) maxLog = logw;
    }

    let wSum = 0, mSum = 0;
    const cdf = [];
    for (const [r, logw] of rows) {
      const w = Math.exp(logw - maxLog);
      wSum += w;
      mSum += r * w;
      cdf.push([r, wSum]);
    }
    const mean = mSum / wSum;
    const quantile = (p) => {
      const target = p * wSum;
      for (const [r, c] of cdf) if (c >= target) return r;
      return HI;
    };

    const toSite = (cc) => _clamp(fromCcScale(cc, site, timeClass), 100, 3500);
    const round10 = (x) => Math.round(x / 10) * 10;
    return {
      elo: Math.round(toSite(mean)),
      lo: round10(toSite(quantile(0.10))),
      hi: round10(toSite(quantile(0.90))),
      timeClass,
      site,
    };
  }

  /**
   * Compat: estimateElo(accuracy), estimateElo(accuracy, anchor) e
   * estimateElo(accuracy, opts) devolvem só o ponto (média do posterior).
   * opts = { anchorElo, moveCount, timeClass, site }.
   */
  function estimateElo(accuracy, anchorOrOpts, maybeOpts) {
    let opts = {};
    if (anchorOrOpts != null && typeof anchorOrOpts === "object") {
      opts = anchorOrOpts;
    } else {
      opts = maybeOpts && typeof maybeOpts === "object" ? { ...maybeOpts } : {};
      if (anchorOrOpts != null) opts.anchorElo = anchorOrOpts;
    }
    return estimateEloDetailed(accuracy, opts).elo;
  }

  // ---- Fits legados (mantidos por compat de API; NÃO usados no estimador) ----

  /** @deprecated Fit pontual Kaufman; hoje é só um atalho de referência. */
  function eloFromAccuracy(accuracy) {
    const a = _clamp(accuracy, 0, 100);
    if (a >= 80) return (a - 64) * 100;
    if (a >= 70) return 1150 + (a - 70) * 45;
    if (a >= 50) return 450 + (a - 50) * 35;
    return 180 + (a - 30) * 13.5;
  }

  /** @deprecated Fit comunitário Elo ≈ 3100·e^(−0.01·ACPL); colinear com a
   * acurácia, então ficou fora do posterior. */
  function eloFromAcpl(acpl) {
    if (acpl == null || !isFinite(acpl)) return null;
    const a = _clamp(acpl, 0, 300);
    return 3100 * Math.exp(-0.01 * a);
  }

  // Ratings por lado a partir dos headers do PGN (ignora "?" / não-numéricos).
  function ratingsFromHeaders(headers) {
    const parse = (k) => {
      const n = parseInt(headers && headers[k], 10);
      return isFinite(n) && n > 0 ? n : null;
    };
    return { white: parse("WhiteElo"), black: parse("BlackElo") };
  }

  // Compat: âncora única = média dos dois lados (API legada).
  function ratingAnchorFromHeaders(headers) {
    const r = ratingsFromHeaders(headers);
    const vals = [r.white, r.black].filter((v) => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  // ===== Segurança de peças / sacrifício (port do WintrCat/wintrchess) =====
  //
  // Base das classificações Brilliant e Great: o framework de "peças inseguras"
  // do wintrchess (sucessor do freechess; réplica aberta mais fiel do Game
  // Review do chess.com). Adaptado ao chess.js 0.10.3: `.move()` devolve null
  // em vez de lançar exceção, `in_check()` é snake_case, não existe
  // `.attackers()` (o rei atacante é detectado por adjacência) e `.board()`
  // não inclui o campo `square`.

  const FILES = "abcdefgh";

  // Valores em peões; rei = Infinity (nunca conta como peça "insegura").
  const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: Infinity };

  // Casa (ex.: "e4") a partir dos índices de board(): row 0 = 8ª fileira.
  function sqFromRC(r, f) { return FILES[f] + (8 - r); }

  // Recoloca o FEN com o lado a mover trocado para `color` e sem alvo de en
  // passant — truque pra gerar os lances de captura do lado que NÃO está na vez.
  function fenToMove(fen, color) {
    return fen
      .replace(/ (w|b) /, ` ${color} `)
      .replace(/ ([a-h][36]) /, " - ");
  }

  // Casa onde a captura acontece (difere de `to` só no en passant).
  function getCaptureSquare(mv) {
    if (mv.flags && mv.flags.indexOf("e") !== -1) return mv.to[0] + mv.from[1];
    return mv.to;
  }

  function toRawMove(mv) {
    return { piece: mv.piece, color: mv.color, from: mv.from, to: mv.to, promotion: mv.promotion };
  }
  function rawKey(mv) { return mv.piece + mv.color + mv.from + mv.to + (mv.promotion || ""); }

  function findKingSquare(board, color) {
    const bd = board.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = bd[r][f];
        if (p && p.type === "k" && p.color === color) return sqFromRC(r, f);
      }
    }
    return null;
  }

  function isAdjacent(a, b) {
    return a !== b &&
      Math.abs(FILES.indexOf(a[0]) - FILES.indexOf(b[0])) <= 1 &&
      Math.abs(+a[1] - +b[1]) <= 1;
  }

  // Replay do lance jogado, devolvendo o move VERBOSE do chess.js (captured,
  // flags, promotion...) ou null.
  function replayMove(move) {
    try {
      const c = new Chess(move.fen_before);
      return c.move({
        from: move.uci.slice(0, 2),
        to: move.uci.slice(2, 4),
        promotion: move.uci.slice(4) || undefined,
      }) || null;
    } catch (e) {
      return null;
    }
  }

  // Lances que CAPTURAM a peça em `piece.square` (diretos, sem baterias).
  // Inclui o rei inimigo adjacente mesmo quando a captura seria ilegal (peça
  // defendida) — equivalente ao `.attackers()` do chess.js moderno.
  function directAttackingMoves(fen, piece) {
    const oppColor = piece.color === "w" ? "b" : "w";
    let b;
    try { b = new Chess(fenToMove(fen, oppColor)); } catch (e) { return []; }
    const attacks = [];
    for (const mv of b.moves({ verbose: true })) {
      if (getCaptureSquare(mv) === piece.square) attacks.push(toRawMove(mv));
    }
    if (!attacks.some((a) => a.piece === "k")) {
      const kingSq = findKingSquare(b, oppColor);
      if (kingSq && isAdjacent(kingSq, piece.square)) {
        attacks.push({ piece: "k", color: oppColor, from: kingSq, to: piece.square });
      }
    }
    return attacks;
  }

  // Todos os lances que atacam a peça, expandindo BATERIAS (ataques por raio-X:
  // remove a peça da frente da bateria e vê que atacantes são revelados).
  function getAttackingMoves(fen, piece, transitive = true) {
    const attacks = directAttackingMoves(fen, piece);
    if (!transitive) return attacks;

    const frontier = attacks.map((a) => ({ directFen: fen, square: a.from, type: a.piece }));
    let guard = 0; // trava de segurança contra expansão patológica
    while (frontier.length > 0 && guard++ < 64) {
      const front = frontier.pop();
      if (front.type === "k") continue; // rei não pode estar na frente de bateria

      let tb;
      try { tb = new Chess(front.directFen); } catch (e) { continue; }
      const oldAttacks = directAttackingMoves(front.directFen, piece)
        .filter((a) => a.from !== front.square);
      tb.remove(front.square);
      const newFen = tb.fen();
      const newAttacks = directAttackingMoves(newFen, piece);

      // XOR: revelados = os que só existem numa das duas listas.
      const oldKeys = new Set(oldAttacks.map(rawKey));
      const newKeys = new Set(newAttacks.map(rawKey));
      const revealed = oldAttacks.filter((a) => !newKeys.has(rawKey(a)))
        .concat(newAttacks.filter((a) => !oldKeys.has(rawKey(a))));

      for (const a of revealed) {
        attacks.push(a);
        frontier.push({ directFen: newFen, square: a.from, type: a.piece });
      }
    }
    return attacks;
  }

  // Quem recaptura se a peça for tomada: simula cada atacante capturando e
  // conta os atacantes do capturador; devolve o MENOR conjunto. Sem atacantes,
  // inverte a cor da peça e conta quem mira a casa.
  function getDefendingMoves(fen, piece, transitive = true) {
    const attacking = getAttackingMoves(fen, piece, false);
    let smallest = null;
    for (const atk of attacking) {
      let cb;
      try { cb = new Chess(fenToMove(fen, atk.color)); } catch (e) { continue; }
      if (!cb.move({ from: atk.from, to: atk.to, promotion: atk.promotion })) continue;
      const recap = getAttackingMoves(
        cb.fen(), { type: atk.piece, color: atk.color, square: atk.to }, transitive
      );
      if (!smallest || recap.length < smallest.length) smallest = recap;
    }
    if (smallest) return smallest;

    let db;
    try { db = new Chess(fen); } catch (e) { return []; }
    const flippedColor = piece.color === "w" ? "b" : "w";
    db.remove(piece.square);
    if (!db.put({ type: piece.type, color: flippedColor }, piece.square)) return [];
    return getAttackingMoves(
      db.fen(), { type: piece.type, color: flippedColor, square: piece.square }, transitive
    );
  }

  // A peça está segura? (heurística de trocas do wintrchess)
  function isPieceSafe(fen, piece, playedMove) {
    const direct = directAttackingMoves(fen, piece);
    const attackers = getAttackingMoves(fen, piece);
    const defenders = getDefendingMoves(fen, piece);

    // Sacrifício "decimal" favorável (torre por peça menor defendida por outra
    // menor etc.) é seguro.
    if (
      playedMove && playedMove.captured &&
      piece.type === "r" &&
      PIECE_VAL[playedMove.captured] === 3 &&
      attackers.length === 1 &&
      defenders.length > 0 &&
      PIECE_VAL[attackers[0].piece] === 3
    ) return true;

    // Atacante direto mais barato que a peça => insegura.
    if (direct.some((a) => PIECE_VAL[a.piece] < PIECE_VAL[piece.type])) return false;

    // Não tem mais atacantes que defensores => segura.
    if (attackers.length <= defenders.length) return true;

    // Mais barata que qualquer atacante direto e com defensor mais barato que
    // todos os atacantes diretos => capturar seria sacrifício do oponente.
    let lowest = null;
    for (const a of direct) if (!lowest || PIECE_VAL[a.piece] < PIECE_VAL[lowest.piece]) lowest = a;
    if (!lowest) return true;
    if (
      PIECE_VAL[piece.type] < PIECE_VAL[lowest.piece] &&
      defenders.some((d) => PIECE_VAL[d.piece] < PIECE_VAL[lowest.piece])
    ) return true;

    // Defendida por peão, a esta altura, é segura.
    if (defenders.some((d) => d.piece === "p")) return true;

    return false;
  }

  // Peças (não peão/rei) de `color` que NÃO estão seguras. `playedMove` (o
  // lance verbose que acabou de ser jogado) desconta o material capturado:
  // peça de valor <= ao capturado não conta como sacrifício.
  function getUnsafePieces(fen, color, playedMove) {
    let board;
    try { board = new Chess(fen); } catch (e) { return []; }
    const capturedVal = playedMove && playedMove.captured ? PIECE_VAL[playedMove.captured] : 0;
    const out = [];
    const bd = board.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = bd[r][f];
        if (!p || p.color !== color || p.type === "p" || p.type === "k") continue;
        if (PIECE_VAL[p.type] <= capturedVal) continue;
        const piece = { type: p.type, color: p.color, square: sqFromRC(r, f) };
        if (!isPieceSafe(fen, piece, playedMove)) out.push(piece);
      }
    }
    return out;
  }

  // Ataques (diretos) a peças INSEGURAS de `color` com valor >= ao da peça
  // ameaçada — a "moeda de troca" que justifica deixar a ameaça no ar.
  function relativeUnsafePieceAttacks(fen, threatened, color, playedMove) {
    const out = [];
    for (const u of getUnsafePieces(fen, color, playedMove)) {
      if (u.square === threatened.square) continue;
      if (PIECE_VAL[u.type] < PIECE_VAL[threatened.type]) continue;
      out.push(...directAttackingMoves(fen, u));
    }
    return out;
  }

  // Sacrifício menor que, se aceito, permite mate em 1 => ameaça "protegida".
  function lowValueCheckmatePin(board, threatened) {
    return PIECE_VAL[threatened.type] < PIECE_VAL.q &&
      board.moves().some((m) => m.indexOf("#") !== -1);
  }

  // Jogar `actingMove` (ex.: capturar a peça ameaçada, ou fugir com ela) CRIA
  // uma contra-ameaça nova de valor >= ao da peça ameaçada?
  function moveCreatesGreaterThreat(fen, threatened, actingMove) {
    const before = relativeUnsafePieceAttacks(fen, threatened, actingMove.color);
    let board;
    try { board = new Chess(fen); } catch (e) { return false; }
    const baked = board.move({ from: actingMove.from, to: actingMove.to, promotion: actingMove.promotion });
    if (!baked) return false;
    const after = relativeUnsafePieceAttacks(board.fen(), threatened, actingMove.color, baked);
    const beforeKeys = new Set(before.map(rawKey));
    if (after.some((a) => !beforeKeys.has(rawKey(a)))) return true;
    return lowValueCheckmatePin(board, threatened);
  }

  // Depois de `actingMove`, SOBRA alguma contra-ameaça de valor >= (nova ou não)?
  function moveLeavesGreaterThreat(fen, threatened, actingMove) {
    let board;
    try { board = new Chess(fen); } catch (e) { return false; }
    if (!board.move({ from: actingMove.from, to: actingMove.to, promotion: actingMove.promotion })) return false;
    if (relativeUnsafePieceAttacks(board.fen(), threatened, actingMove.color).length > 0) return true;
    return lowValueCheckmatePin(board, threatened);
  }

  // Todas as reações à ameaça deixam/criam contra-ameaça maior?
  function hasDangerLevels(fen, threatened, actingMoves, strategy = "leaves") {
    return actingMoves.every((mv) => (strategy === "creates"
      ? moveCreatesGreaterThreat(fen, threatened, mv)
      : moveLeavesGreaterThreat(fen, threatened, mv)));
  }

  // Peça presa: insegura onde está E em toda casa pra onde pode ir (ou fugir
  // permite contra-ameaça maior do oponente).
  function isPieceTrapped(fen, piece) {
    const calibrated = fenToMove(fen, piece.color);
    let cb;
    try { cb = new Chess(calibrated); } catch (e) { return false; }
    const calibratedFen = cb.fen();
    const standingSafe = isPieceSafe(calibratedFen, piece);
    const escapes = cb.moves({ square: piece.square, verbose: true });
    const allUnsafe = escapes.every((mv) => {
      if (moveCreatesGreaterThreat(calibratedFen, piece, toRawMove(mv))) return true;
      let eb;
      try { eb = new Chess(calibratedFen); } catch (e) { return false; }
      const em = eb.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      if (!em) return false;
      return !isPieceSafe(eb.fen(), { type: piece.type, color: piece.color, square: em.to }, em);
    });
    return !standingSafe && allUnsafe;
  }

  // Pré-condição de Great/Brilliant (isMoveCriticalCandidate do wintrchess):
  // lances fáceis de achar ou obrigatórios não podem ser críticos.
  function isMoveCriticalCandidate(move) {
    // Ganhava de qualquer jeito: o 2º melhor lance já era completamente ganho.
    const second = move.second_best_eval_cp;
    if (second != null) {
      if (!isMateCp(second) && second >= 700) return false;
    } else if (!isMateCp(move.eval_after_cp) && move.eval_after_cp >= 700) {
      return false;
    }
    // Lances em posição perdida não podem ser críticos.
    if (move.eval_after_cp < 0) return false;
    // Promoção a dama não conta.
    if ((move.uci || "").length > 4 && move.uci[4] === "q") return false;
    // Estava em xeque => lance "obrigatório".
    let before;
    try { before = new Chess(move.fen_before); } catch (e) { return false; }
    if (before.in_check()) return false;
    return true;
  }

  // "Ótimo Lance" (Great / critical no wintrchess): o melhor lance foi jogado
  // num momento em que o 2º melhor já jogava fora >= 10% de expected points —
  // isto é, só havia UMA jogada à altura.
  function considerCritical(move) {
    if (!isMoveCriticalCandidate(move)) return false;
    // Achar lances quando você TEM mate forçado não é crítico.
    if (isMateCp(move.eval_after_cp) && move.eval_after_cp > 0) return false;

    const played = replayMove(move);
    if (!played) return false;
    // Capturar material de graça não é crítico.
    if (played.captured) {
      const capSq = getCaptureSquare(played);
      const capPiece = {
        type: played.captured,
        color: played.color === "w" ? "b" : "w",
        square: capSq,
      };
      if (!isPieceSafe(move.fen_before, capPiece)) return false;
    }

    if (move.second_best_eval_cp == null) return false;
    return expectedPointsLoss(
      move.best_eval_cp,
      move.second_best_eval_cp,
      winGradientForRating(move.player_rating_cc)
    ) >= 0.1;
  }

  // "Lance Brilhante": sacrifício real — o lance deixa (de propósito) peça de
  // valor insegura, sem contra-ameaça equivalente que "proteja" o sacrifício e
  // sem ser só o caso de uma peça que já estava presa de qualquer jeito.
  function considerBrilliant(move) {
    if (!isMoveCriticalCandidate(move)) return false;

    const played = replayMove(move);
    if (!played) return false;
    if (played.promotion) return false; // promoção não pode ser brilhante

    const mover = played.color;
    const prevUnsafe = getUnsafePieces(move.fen_before, mover);
    const unsafe = getUnsafePieces(move.fen_after, mover, played);

    let curBoard;
    try { curBoard = new Chess(move.fen_after); } catch (e) { return false; }
    // Mover peça pra SEGURANÇA (menos peças inseguras que antes) não é sac.
    if (!curBoard.in_check() && unsafe.length < prevUnsafe.length) return false;

    // Toda peça insegura tem contra-ameaça >= se for capturada => não é sac.
    const allProtected = unsafe.every((u) =>
      hasDangerLevels(move.fen_after, u, directAttackingMoves(move.fen_after, u))
    );
    if (allProtected) return false;

    const prevTrapped = prevUnsafe.filter((u) => isPieceTrapped(move.fen_before, u));
    const trapped = unsafe.filter((u) => isPieceTrapped(move.fen_after, u));
    const movedWasTrapped = prevTrapped.some((t) => t.square === move.uci.slice(0, 2));

    // Peça que já estava presa (ou continua presa) não é sacrifício genuíno.
    if (
      trapped.length === unsafe.length ||
      movedWasTrapped ||
      trapped.length < prevTrapped.length
    ) return false;

    return unsafe.length > 0;
  }

  // ===== Classificação =====
  //
  // Expected Points Model — Chess.com Classification V2 (help center oficial,
  // fev/2026) + transições de mate / especiais do wintrchess (Brilliant, Great,
  // Miss). Sigmóide unificada com a acurácia (WIN_PCT_GRADIENT do Lichess).
  //
  // Bandas oficiais de expected points perdidos (0..1):
  //   Best ≈0 · Excellent <0.02 · Good <0.05 · Inaccuracy <0.10 ·
  //   Mistake <0.20 · Blunder ≥0.20
  //
  // "Best" tolera perda <0.005 (ruído de profundidade / lances equivalentes).
  // Um lance pode ser Best sem ser o nº1 do engine se a perda é ~zero — igual
  // ao chess.com. Sobre isso: Brilliant, Great, Book, Forced, Miss.

  const MATE_CP_THRESHOLD = MATE_SCORE_CP - 1000; // 9000

  // Chess.com Classification V2 — cutoffs de expected points perdidos.
  const EP_BEST = 0.005;
  const EP_EXCELLENT = 0.02;
  const EP_GOOD = 0.05;
  const EP_INACCURACY = 0.10;
  const EP_MISTAKE = 0.20;

  function isMateCp(cp) {
    return cp != null && Math.abs(cp) >= MATE_CP_THRESHOLD;
  }

  // Distância de mate COM SINAL (POV de quem moveu): +N = você dá mate em N,
  // -N = você leva mate em N. Só faz sentido quando isMateCp(cp).
  function mateSigned(cp) {
    const n = MATE_SCORE_CP - Math.abs(cp);
    return (cp >= 0 ? 1 : -1) * n;
  }

  // Expected points (0..1). `gradient` opcional: sem ele é a curva fixa da
  // acurácia; a classificação passa o k(rating) do jogador.
  function expectedPointsFromCp(cp, gradient) {
    return cpToWinrate(cp, gradient);
  }

  function expectedPointsLoss(beforeCp, afterCp, gradient) {
    return Math.max(
      0,
      expectedPointsFromCp(beforeCp, gradient) - expectedPointsFromCp(afterCp, gradient)
    );
  }

  // Classificação pela perda de expected points, com as quatro combinações de
  // tipo de eval (cp/mate). Transições de mate: tabela própria (mate em 5 e
  // mate em 1 têm ambos ~100% de win-prob, mas largar mate forçado é erro).
  // A curva de EP usa o rating do jogador (player_rating_cc) quando conhecido —
  // Chess.com Classification V2 é rating-dependente por definição.
  function pointLossClassify(move) {
    const prevEval = move.best_eval_cp;     // melhor avaliação ANTES (POV do jogador)
    const evalAfter = move.eval_after_cp;   // avaliação DEPOIS (POV do jogador)
    const prevMate = isMateCp(prevEval);
    const afterMate = isMateCp(evalAfter);

    // Mate antes e depois.
    if (prevMate && afterMate) {
      const prevM = mateSigned(prevEval);
      const curM = mateSigned(evalAfter);
      // Tinha mate e agora LEVA mate.
      if (prevM > 0 && curM < 0) return curM < -3 ? "mistake" : "blunder";
      // Quem dá mate espera "perder" 1 de distância por lance (-1 = best); pra
      // quem leva mate, manter a distância é o melhor que há.
      const mateLoss = curM - prevM;
      if (mateLoss < 0 || (mateLoss === 0 && curM < 0)) return "best";
      if (mateLoss < 2) return "excellent";
      if (mateLoss < 7) return "good";
      return "inaccuracy";
    }

    // Tinha mate forçado e o lance dissolveu — gravidade pelo que sobrou.
    if (prevMate && !afterMate) {
      if (evalAfter >= 800) return "excellent";
      if (evalAfter >= 400) return "good";
      if (evalAfter >= 200) return "inaccuracy";
      if (evalAfter >= 0) return "mistake";
      return "blunder";
    }

    // Não havia mate; agora há. Seu => o melhor que existia; contra você =>
    // gravidade pela proximidade do mate.
    if (!prevMate && afterMate) {
      const curM = mateSigned(evalAfter);
      if (curM > 0) return "best";
      if (curM >= -2) return "blunder";
      if (curM >= -5) return "mistake";
      return "inaccuracy";
    }

    // Caminho comum (cp → cp): Chess.com Classification V2.
    const loss = expectedPointsLoss(
      prevEval, evalAfter, winGradientForRating(move.player_rating_cc)
    );
    if (loss < EP_BEST) return "best";
    if (loss < EP_EXCELLENT) return "excellent";
    if (loss < EP_GOOD) return "good";
    if (loss < EP_INACCURACY) return "inaccuracy";
    if (loss < EP_MISTAKE) return "mistake";
    return "blunder";
  }

  function classifyMove(move, prevMove) { // prevMove mantido por compat de API
    if (move.in_book) return "book";
    if (move.is_only_move) return "forced";
    if (move.is_checkmate) return "best"; // deu mate: melhor por definição

    const topMovePlayed = !!move.best_move_san && move.san === move.best_move_san;
    let cls = topMovePlayed ? "best" : pointLossClassify(move);

    // Great: momento crítico em que SÓ o melhor lance segurava a posição.
    if (topMovePlayed && considerCritical(move)) cls = "great";

    // Brilliant: sacrifício real (peça de valor deixada insegura de propósito).
    if ((cls === "best" || cls === "great") && considerBrilliant(move)) cls = "brilliant";

    // ---- Miss: falhou em capitalizar erro do oponente / converter ganho. ----
    // Chess.com: "fail to capitalize on opponent's mistake" → posição vencedora
    // escapa pra igualdade ou pior. Limiares em expected points (~0.75 win ≈
    // +300 cp; manter ≥0.60 win ≈ +100 cp) em vez de cp fixos soltos.
    if (cls === "inaccuracy" || cls === "mistake" || cls === "blunder") {
      const kRating = winGradientForRating(move.player_rating_cc);
      const prevMate = isMateCp(move.best_eval_cp);
      const afterMate = isMateCp(move.eval_after_cp);
      const epBefore = expectedPointsFromCp(move.best_eval_cp, kRating);
      const epAfter = expectedPointsFromCp(move.eval_after_cp, kRating);
      const hadWin = prevMate ? move.best_eval_cp > 0 : epBefore >= 0.75;
      const keptWin = afterMate ? move.eval_after_cp > 0 : epAfter >= 0.60;
      if (hadWin && !keptWin) cls = "miss";
    }

    return cls;
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
    const depth = opts.depth || 15;
    const multipv = 2; // precisamos do 2º melhor pra detectar Great
    const moves = parsed.moves;
    const opening = parsed.opening;
    const N = moves.length;

    const headers = parsed.headers || {};
    const site = siteFromHeaders(headers);
    const timeClass = timeClassFromHeaders(headers);
    const ratings = ratingsFromHeaders(headers);
    // Ratings na escala chess.com-equivalente — a classificação V2 (curva de
    // expected points por rating) e as curvas acurácia↔rating do Elo são
    // calibradas nessa escala.
    const ccRatings = {
      white: toCcScale(ratings.white, site, timeClass),
      black: toCcScale(ratings.black, site, timeClass),
    };

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
          wdl: best?.wdl || null, // per-mille, POV do lado a mover (UCI_ShowWDL)
        };
      }

      const posResult = new Array(N + 1).fill(undefined);
      let flushed = 0;

      // Monta o lance enriquecido i a partir do posResult ATUAL. Determinístico
      // e sem efeitos colaterais — usado pelo flush da fase 1 e re-executado
      // pela fase de refinamento quando as posições ganham eval mais fundo.
      function buildEnriched(i) {
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

        // WDL da posição resultante, POV das brancas. Vem do engine quando o
        // build reporta (UCI_ShowWDL); senão, do port JS do modelo do SF18.
        // O wdl bruto da posição i+1 está no POV do lado a mover lá (= o
        // oponente de quem jogou o lance i), então inverte conforme a cor.
        let wdlAfter;
        if (mv.is_checkmate) {
          wdlAfter = mv.color === "white" ? { w: 1000, d: 0, l: 0 } : { w: 0, d: 0, l: 1000 };
        } else {
          const opp = posResult[i + 1].wdl
            || sfWdlFromCp(posResult[i + 1].bestEvalCp, materialFromFen(mv.fen_after));
          wdlAfter = mv.color === "white"
            ? { w: opp.l, d: opp.d, l: opp.w }
            : { w: opp.w, d: opp.d, l: opp.l };
        }

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
          wdl_after: wdlAfter,
          player_rating_cc: mv.color === "white" ? ccRatings.white : ccRatings.black,
        };
        // Acurácia do lance (curva fixa — a mesma da acurácia da partida).
        enriched.accuracy = (mv.in_book || isOnlyMove) ? 100 : Math.round(10 *
          moveAccuracy(cpToWinPercent(pr.bestEvalCp), cpToWinPercent(evalAfterCp))
        ) / 10;
        return enriched;
      }

      // Emite os lances EM ORDEM conforme as posições de que dependem ficam
      // prontas (a posição i e a i+1). As posições podem terminar fora de ordem
      // por causa do pool; o flush mantém a UI em ordem.
      function flush() {
        while (flushed < N && posResult[flushed] && posResult[flushed + 1]) {
          const i = flushed;
          const enriched = buildEnriched(i);
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

      // ---- Fase 2: confirmação em profundidade dos lances críticos ----
      //
      // Rótulos fortes decididos em depth baixo são a maior fonte de erro de
      // game review (o clássico "falso blunder" por efeito de horizonte). Só as
      // posições envolvidas nos lances marcados são re-analisadas mais fundo e
      // os lances afetados reclassificados — mesma ideia do chess.com, que
      // revisa classificações após análise adicional (help center: "Why did my
      // move classification change in Game Review?"). Custo: ~10-20 posições
      // extras, longe de dobrar o tempo da análise.
      const REFINE_CLASSES = new Set(["blunder", "mistake", "miss", "great", "brilliant"]);
      const MAX_REFINE_MOVES = 20;
      const REFINE_EXTRA_DEPTH = 3;
      if (opts.refine !== false && N > 1) {
        const flagged = [];
        for (let i = 0; i < collected.length; i++) {
          if (REFINE_CLASSES.has(collected[i].classification)) {
            flagged.push({
              i,
              loss: expectedPointsLoss(collected[i].best_eval_cp, collected[i].eval_after_cp),
            });
          }
        }
        // Piores primeiro (great/brilliant têm loss ~0 e entram por último,
        // mas quase sempre cabem no cap).
        flagged.sort((a, b) => b.loss - a.loss);

        const posSet = new Set();
        for (const f of flagged.slice(0, MAX_REFINE_MOVES)) {
          posSet.add(f.i);
          posSet.add(f.i + 1);
        }
        if (posSet.size > 0) {
          const posIdx = Array.from(posSet).sort((a, b) => a - b);
          const subset = posIdx.map((i) => positions[i]);
          const deepOptsFor = (j) => ({
            depth: depth + REFINE_EXTRA_DEPTH,
            multipv: posIdx[j] < N ? multipv : 1,
          });
          let refined = 0;
          const onDeep = (j, info) => {
            // Só substitui se a análise funda veio válida; senão fica a rasa.
            if (info && info[1] && info[1].score) posResult[posIdx[j]] = parsePosInfo(info);
            refined++;
            if (opts.onRefineProgress) {
              try { opts.onRefineProgress(refined, posIdx.length); } catch (e) {}
            }
          };
          if (typeof pool.analyzeAll === "function") {
            await pool.analyzeAll(subset, deepOptsFor, onDeep);
          } else {
            for (let j = 0; j < subset.length; j++) {
              onDeep(j, await pool.analyzeOnce(subset[j], deepOptsFor(j)));
            }
          }

          // Reconstrói todo lance cuja posição "antes" OU "depois" mudou.
          for (let i = 0; i < N; i++) {
            if (!posSet.has(i) && !posSet.has(i + 1)) continue;
            const enriched = buildEnriched(i);
            enriched.classification = classifyMove(enriched, collected[i - 1] || null);
            enriched.comment = generateComment(enriched, opening);
            collected[i] = enriched;
          }
        }
      }
    }

    // Contagens por classificação.
    const counts = { white: {}, black: {} };
    for (const m of collected) {
      counts[m.color][m.classification] = (counts[m.color][m.classification] || 0) + 1;
    }
    // Acurácia da partida (CAPS2 / Lichess) + posterior de Elo (curvas
    // acurácia↔rating por ritmo + prior no rating do próprio lado no PGN,
    // com conversão de escala quando a partida é do lichess).
    const acc = computeGameAccuracies(collected);
    const accW = acc.white;
    const accB = acc.black;
    const nW = collected.filter((m) => m.color === "white").length;
    const nB = collected.filter((m) => m.color === "black").length;
    const acplW = averageCentipawnLoss(collected, "white");
    const acplB = averageCentipawnLoss(collected, "black");
    const eloW = estimateEloDetailed(accW, {
      anchorElo: ratings.white, moveCount: nW, timeClass, site,
    });
    const eloB = estimateEloDetailed(accB, {
      anchorElo: ratings.black, moveCount: nB, timeClass, site,
    });

    const result = {
      headers: parsed.headers,
      moves: collected,
      accuracy_white: Math.round(accW * 10) / 10,
      accuracy_black: Math.round(accB * 10) / 10,
      elo_white: eloW.elo,
      elo_black: eloB.elo,
      elo_white_range: [eloW.lo, eloW.hi],
      elo_black_range: [eloB.lo, eloB.hi],
      time_class: timeClass,
      site: site,
      acpl_white: acplW != null ? Math.round(acplW * 10) / 10 : null,
      acpl_black: acplB != null ? Math.round(acplB * 10) / 10 : null,
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
    const rng = (r) => (r && r.length === 2 ? `, faixa ${r[0]}–${r[1]}` : "");
    bullets.push(
      `Acurácia — Brancas: **${result.accuracy_white}** (ELO est. ~${result.elo_white}${rng(result.elo_white_range)}); ` +
      `Pretas: **${result.accuracy_black}** (ELO est. ~${result.elo_black}${rng(result.elo_black_range)}).`
    );

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
    averageCentipawnLoss,
    estimateElo,
    estimateEloDetailed,
    expectedAccuracyAt,
    timeClassFromHeaders,
    siteFromHeaders,
    toCcScale,
    fromCcScale,
    winGradientForRating,
    sfWinRateParams,
    sfWdlFromCp,
    materialFromFen,
    expectedPointsFromWdl,
    eloFromAccuracy,
    eloFromAcpl,
    expectedPointsFromCp,
    expectedPointsLoss,
    ratingsFromHeaders,
    ratingAnchorFromHeaders,
    pvUciToSan,
    MATE_SCORE_CP,
  };
})();
