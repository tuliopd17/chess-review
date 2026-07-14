/* Testes do motor de classificação/acurácia (frontend/analysis.js).
 * Roda com o test runner nativo do Node: `node --test`. Sem dependências.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { A } = require("./harness.cjs");
const { CLASSIFICATION_CASES, MATE } = require("./fixtures.cjs");

// ============================================================
// Conversões de eval
// ============================================================
test("cpToWinrate: 0cp = 50%", () => {
  assert.equal(A.cpToWinrate(0), 0.5);
});

test("cpToWinrate: monotônica e limitada em [0,1]", () => {
  let prev = -1;
  for (let cp = -2000; cp <= 2000; cp += 100) {
    const w = A.cpToWinrate(cp);
    assert.ok(w >= 0 && w <= 1, `winrate fora de [0,1] em ${cp}`);
    assert.ok(w >= prev, `não-monotônica em ${cp}`);
    prev = w;
  }
});

test("cpToWinrate: satura em mate", () => {
  assert.equal(A.cpToWinrate(MATE - 500), 1.0);
  assert.equal(A.cpToWinrate(-(MATE - 500)), 0.0);
});

test("cpToWinPercent = 100 * winrate", () => {
  assert.equal(A.cpToWinPercent(0), 50);
  assert.ok(Math.abs(A.cpToWinPercent(1000) - 100 * A.cpToWinrate(1000)) < 1e-9);
});

test("scoreToCp: cp passa direto, clampado", () => {
  assert.equal(A.scoreToCp({ type: "cp", value: 250 }), 250);
  assert.equal(A.scoreToCp({ type: "cp", value: 999999 }), MATE);
  assert.equal(A.scoreToCp(null), 0);
});

test("scoreToCp: mate vira cp perto do teto, com sinal", () => {
  assert.equal(A.scoreToCp({ type: "mate", value: 3 }), MATE - 3);
  assert.equal(A.scoreToCp({ type: "mate", value: -1 }), -(MATE - 1));
});

// ============================================================
// Expected points (modelo unificado)
// ============================================================
test("expectedPointsFromCp: alinhado com cpToWinrate", () => {
  for (const cp of [-500, -100, 0, 100, 300, 800]) {
    assert.ok(
      Math.abs(A.expectedPointsFromCp(cp) - A.cpToWinrate(cp)) < 1e-12,
      `EP != winrate em ${cp}`,
    );
  }
});

test("expectedPointsLoss: zero se não piora, positivo se piora", () => {
  assert.equal(A.expectedPointsLoss(50, 50), 0);
  assert.equal(A.expectedPointsLoss(50, 100), 0);
  assert.ok(A.expectedPointsLoss(50, -200) > 0.1);
});

// ============================================================
// Acurácia
// ============================================================
test("moveAccuracy: 100 quando não piora", () => {
  assert.equal(A.moveAccuracy(60, 60), 100);
  assert.equal(A.moveAccuracy(60, 80), 100);
});

test("moveAccuracy: cai com a perda de win%, limitada a [0,100]", () => {
  const big = A.moveAccuracy(90, 20);
  const small = A.moveAccuracy(90, 85);
  assert.ok(small > big, "perda maior deveria dar acurácia menor");
  assert.ok(big >= 0 && big <= 100);
  assert.ok(small >= 0 && small <= 100);
});

test("moveAccuracy: fórmula Lichess CAPS2 em pontos conhecidos", () => {
  // winDiff=0 → 100 (já coberto). winDiff=10 → ~63.5 + 1 bonus ≈ 64.5
  const a10 = A.moveAccuracy(60, 50);
  assert.ok(a10 > 60 && a10 < 70, `acc(diff=10) esperava ~64.5, veio ${a10}`);
  // winDiff=20 → ~42 + 1 ≈ 43
  const a20 = A.moveAccuracy(70, 50);
  assert.ok(a20 > 38 && a20 < 50, `acc(diff=20) esperava ~43, veio ${a20}`);
});

// ============================================================
// Elo — posterior bayesiano (curvas Kaufman/hissha por ritmo)
// ============================================================
test("estimateElo: monotônica na acurácia e em faixa plausível", () => {
  const elos = [40, 55, 65, 75, 85, 95, 100].map((a) => A.estimateElo(a));
  for (let i = 1; i < elos.length; i++) assert.ok(elos[i] >= elos[i - 1], "ELO não-monotônico");
  assert.ok(elos[0] >= 100 && elos[elos.length - 1] <= 3500, `ELO fora de faixa: ${elos}`);
});

test("estimateElo: âncoras da curva rapid (Kaufman) na faixa esperada", () => {
  // A(1600) = 80.6 na tabela rapid; sem âncora o prior fraco puxa pro centro.
  const e806 = A.estimateElo(80.6, { timeClass: "rapid", moveCount: 40 });
  assert.ok(e806 >= 1350 && e806 <= 1750, `acc 80.6 rapid → ${e806}`);
  // A(2600) = 90: mais alto, mas o prior fraco segura um pouco.
  const e90 = A.estimateElo(90, { timeClass: "rapid", moveCount: 40 });
  assert.ok(e90 >= 2150 && e90 <= 2700, `acc 90 rapid → ${e90}`);
  // Acurácia de iniciante não superestima.
  const e70 = A.estimateElo(70, { timeClass: "rapid", moveCount: 40 });
  assert.ok(e70 >= 300 && e70 <= 900, `acc 70 rapid → ${e70}`);
});

test("estimateElo: mesma acurácia vale mais Elo no blitz que no rapid", () => {
  const blitz = A.estimateElo(80, { timeClass: "blitz", moveCount: 40 });
  const rapid = A.estimateElo(80, { timeClass: "rapid", moveCount: 40 });
  assert.ok(blitz > rapid, `blitz=${blitz} deveria superar rapid=${rapid}`);
});

test("estimateElo: prior no rating do jogador puxa a estimativa", () => {
  const noAnchor = A.estimateElo(90, { timeClass: "rapid", moveCount: 40 });
  const withAnchor = A.estimateElo(90, { anchorElo: 1200, timeClass: "rapid", moveCount: 40 });
  assert.ok(withAnchor < noAnchor, "âncora 1200 deveria puxar pra baixo");
  assert.ok(withAnchor > 1200, "posterior deve ficar ACIMA da âncora (jogo foi melhor)");
  // Âncora inválida é ignorada (equivale a sem âncora).
  assert.equal(A.estimateElo(90, NaN), A.estimateElo(90));
  // Mais lances ⇒ verossimilhança mais estreita ⇒ confia mais na performance.
  const few = A.estimateElo(90, { anchorElo: 1200, moveCount: 12 });
  const many = A.estimateElo(90, { anchorElo: 1200, moveCount: 60 });
  assert.ok(many > few, `mais lances deveria subir: n12=${few} n60=${many}`);
});

test("estimateEloDetailed: intervalo de credibilidade coerente", () => {
  const d = A.estimateEloDetailed(85, { anchorElo: 1600, timeClass: "rapid", moveCount: 40 });
  assert.ok(d.lo <= d.elo && d.elo <= d.hi, `lo<=elo<=hi violado: ${JSON.stringify(d)}`);
  assert.ok(d.hi - d.lo >= 100, "uma partida só nunca dá certeza de ±50");
  // Partida mais longa ⇒ intervalo igual ou mais estreito.
  const short = A.estimateEloDetailed(85, { anchorElo: 1600, timeClass: "rapid", moveCount: 12 });
  const long = A.estimateEloDetailed(85, { anchorElo: 1600, timeClass: "rapid", moveCount: 60 });
  assert.ok(
    long.hi - long.lo <= short.hi - short.lo,
    `CI não estreitou: n12=${short.hi - short.lo} n60=${long.hi - long.lo}`,
  );
});

test("estimateEloDetailed: partida do lichess sai na escala lichess", () => {
  const cc = A.estimateEloDetailed(80.6, { timeClass: "rapid", moveCount: 40, site: "chesscom" });
  const li = A.estimateEloDetailed(80.6, { timeClass: "rapid", moveCount: 40, site: "lichess" });
  // Ratings lichess correm ~300+ acima dos equivalentes chess.com no clube.
  assert.ok(li.elo > cc.elo + 150, `esperava gap de escala: cc=${cc.elo} li=${li.elo}`);
});

test("toCcScale/fromCcScale: passthrough chess.com e roundtrip lichess", () => {
  assert.equal(A.toCcScale(1500, "chesscom", "rapid"), 1500);
  assert.equal(A.fromCcScale(1500, "unknown", "rapid"), 1500);
  const cc = A.toCcScale(1930, "lichess", "rapid");
  assert.ok(cc > 1400 && cc < 1800, `li 1930 rapid → cc ${cc}`);
  const back = A.fromCcScale(cc, "lichess", "rapid");
  assert.ok(Math.abs(back - 1930) < 30, `roundtrip 1930 → ${cc} → ${back}`);
});

test("expectedAccuracyAt: cresce com rating; rapid > blitz no mesmo rating alto", () => {
  let prev = 0;
  for (let r = 300; r <= 3200; r += 100) {
    const a = A.expectedAccuracyAt(r, "rapid");
    assert.ok(a >= prev, `A(R) não-monotônica em ${r}`);
    prev = a;
  }
  assert.ok(A.expectedAccuracyAt(2000, "rapid") > A.expectedAccuracyAt(2000, "blitz"));
  assert.ok(A.expectedAccuracyAt(2000, "blitz") > A.expectedAccuracyAt(2000, "bullet"));
});

test("timeClassFromHeaders: parse dos TimeControl comuns", () => {
  assert.equal(A.timeClassFromHeaders({ TimeControl: "600" }), "rapid");
  assert.equal(A.timeClassFromHeaders({ TimeControl: "180+2" }), "blitz");
  assert.equal(A.timeClassFromHeaders({ TimeControl: "300+3" }), "blitz");
  assert.equal(A.timeClassFromHeaders({ TimeControl: "60" }), "bullet");
  assert.equal(A.timeClassFromHeaders({ TimeControl: "1800" }), "classical");
  assert.equal(A.timeClassFromHeaders({ TimeControl: "1/86400" }), "daily");
  assert.equal(A.timeClassFromHeaders({}), "rapid");
  assert.equal(A.timeClassFromHeaders({ TimeControl: "-" }), "rapid");
});

test("siteFromHeaders: detecta lichess e chess.com", () => {
  assert.equal(A.siteFromHeaders({ Site: "https://lichess.org/AbCd1234" }), "lichess");
  assert.equal(A.siteFromHeaders({ Site: "Chess.com" }), "chesscom");
  assert.equal(A.siteFromHeaders({ Site: "FIDE World Ch" }), "unknown");
});

test("eloFromAcpl (legado): monotônica e razoável", () => {
  assert.ok(A.eloFromAcpl(10) > A.eloFromAcpl(50));
  assert.ok(A.eloFromAcpl(20) > 2000 && A.eloFromAcpl(20) < 2800);
});

// ============================================================
// Curva de Win% por rating (classificação V2) e WDL do SF18
// ============================================================
test("winGradientForRating: default preserva a curva histórica", () => {
  assert.equal(A.winGradientForRating(null), 0.00368208);
  assert.equal(A.winGradientForRating(undefined), 0.00368208);
  assert.equal(A.winGradientForRating(1200), 0.00368208); // âncora exata
});

test("winGradientForRating: monotônica no rating", () => {
  let prev = 0;
  for (let r = 300; r <= 3400; r += 100) {
    const k = A.winGradientForRating(r);
    assert.ok(k >= prev, `k(R) caiu em ${r}`);
    prev = k;
  }
  assert.ok(A.winGradientForRating(400) < A.winGradientForRating(2800));
});

test("classificação rating-dependente: mesmo lance é pior pra um GM", () => {
  // Perda fixa de eval: mais expected points perdidos com k maior.
  const low = A.expectedPointsLoss(50, -120, A.winGradientForRating(400));
  const high = A.expectedPointsLoss(50, -120, A.winGradientForRating(2800));
  assert.ok(high > low, `EP loss deveria crescer com rating: low=${low} high=${high}`);

  // Caso que muda de banda: +30 → -20 é "good" no default e "inaccuracy" a 2800.
  const base = {
    color: "white", san: "Qe2", uci: "d1e2", to: "e2",
    best_move_san: "Ng5", best_eval_cp: 30, eval_after_cp: -20,
    second_best_eval_cp: null, is_capture: false, net_material: 0,
    fen_before: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4",
    fen_after: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4",
  };
  assert.equal(A.classifyMove({ ...base }, null), "good");
  assert.equal(A.classifyMove({ ...base, player_rating_cc: 2800 }, null), "inaccuracy");
});

test("sfWdlFromCp: âncora exata do modelo (100cp = 50% de vitória)", () => {
  // Definição da normalização do SF: +1.00 ⇒ P(win)=50% em self-play LTC.
  const wdl = A.sfWdlFromCp(100, 78);
  assert.equal(wdl.w, 500);
  assert.ok(wdl.w + wdl.d + wdl.l === 1000);
});

test("sfWdlFromCp: simetria, empate no 0.00 e saturação em mate", () => {
  const eq = A.sfWdlFromCp(0, 78);
  assert.equal(eq.w, eq.l, "0.00 deve ser simétrico");
  assert.ok(eq.d > 900, "0.00 em self-play LTC é empate quase certo");
  assert.ok(Math.abs(A.expectedPointsFromWdl(eq) - 0.5) < 1e-9);

  const plus = A.sfWdlFromCp(250, 60);
  const minus = A.sfWdlFromCp(-250, 60);
  assert.equal(plus.w, minus.l);
  assert.equal(plus.l, minus.w);

  assert.deepEqual(A.sfWdlFromCp(9500, 78), { w: 1000, d: 0, l: 0 });
  assert.deepEqual(A.sfWdlFromCp(-9500, 78), { w: 0, d: 0, l: 1000 });
});

test("materialFromFen: posição inicial = 78 (contagem do SF)", () => {
  assert.equal(
    A.materialFromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
    78,
  );
  assert.equal(A.materialFromFen("8/8/4k3/8/8/4K3/8/8 w - - 0 1"), 0);
});

// ============================================================
// Acurácia da partida (CAPS2)
// ============================================================
test("computeGameAccuracies: partida perfeita ~100, com capivarada cai", () => {
  // Série "perfeita": todo lance é o melhor (eval_after == best_eval).
  const perfect = [];
  for (let i = 0; i < 20; i++) {
    perfect.push({
      color: i % 2 === 0 ? "white" : "black",
      best_eval_cp: 20,
      eval_after_cp: 20,
      classification: "best",
    });
  }
  const accP = A.computeGameAccuracies(perfect);
  assert.ok(accP.white > 95 && accP.black > 95, `esperava ~100, veio ${JSON.stringify(accP)}`);

  // Mesma série, mas branco larga a dama num lance.
  const withBlunder = perfect.map((m) => ({ ...m }));
  withBlunder[4] = {
    color: "white",
    best_eval_cp: 30,
    eval_after_cp: -800,
    classification: "blunder",
  };
  const accB = A.computeGameAccuracies(withBlunder);
  assert.ok(accB.white < accP.white, "capivarada deveria derrubar a acurácia das brancas");
  assert.ok(Math.abs(accB.black - accP.black) < 1e-6, "acurácia das pretas não deveria mudar");
  // CAPS2 (harmônica) pune blunder mais que média aritmética: 1 blunder de ~0%
  // em 10 lances de 100% daria ~90 na aritmética; harmônica fica bem abaixo.
  assert.ok(accB.white < 85, `CAPS2 deveria castigar blunder: ${accB.white}`);
});

test("computeGameAccuracies: book/forced contam como 100", () => {
  const moves = [
    { color: "white", best_eval_cp: 20, eval_after_cp: -50, classification: "book", in_book: true },
    { color: "black", best_eval_cp: 0, eval_after_cp: 0, classification: "best" },
    { color: "white", best_eval_cp: 10, eval_after_cp: 10, classification: "best" },
    { color: "black", best_eval_cp: 0, eval_after_cp: 0, classification: "best" },
  ];
  const acc = A.computeGameAccuracies(moves);
  // O lance book com piora de eval NÃO deve derrubar a acurácia das brancas.
  assert.ok(acc.white > 95, `book não deveria punir: ${acc.white}`);
});

test("computeGameAccuracies: lista vazia não quebra", () => {
  assert.deepEqual(A.computeGameAccuracies([]), { white: 0, black: 0 });
});

test("averageCentipawnLoss: ignora book e clampa", () => {
  const moves = [
    { color: "white", best_eval_cp: 50, eval_after_cp: 30, classification: "excellent" },
    { color: "white", best_eval_cp: 50, eval_after_cp: -5000, classification: "blunder" },
    { color: "white", best_eval_cp: 20, eval_after_cp: 0, classification: "book", in_book: true },
    { color: "black", best_eval_cp: 0, eval_after_cp: 0, classification: "best" },
  ];
  const acpl = A.averageCentipawnLoss(moves, "white");
  // (20 + 1000) / 2 = 510 — o -5000 clampa em 1000, book é ignorado
  assert.equal(acpl, 510);
});

// ============================================================
// PV UCI -> SAN
// ============================================================
test("pvUciToSan: converte a partir da posição inicial", () => {
  const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  assert.deepEqual(A.pvUciToSan(start, ["e2e4", "e7e5", "g1f3"]), ["e4", "e5", "Nf3"]);
});

test("pvUciToSan: PV vazia => []", () => {
  assert.deepEqual(A.pvUciToSan("8/8/8/8/8/8/8/8 w - - 0 1", []), []);
});

// ============================================================
// Classificação (fixtures — a régua anti-regressão)
// ============================================================
for (const c of CLASSIFICATION_CASES) {
  test(`classifyMove: ${c.name} => ${c.expected}`, () => {
    assert.equal(A.classifyMove(c.move, c.prev), c.expected);
  });
}

test("classifyMove: determinístico (mesma entrada, mesma saída)", () => {
  for (const c of CLASSIFICATION_CASES) {
    const a = A.classifyMove(c.move, c.prev);
    const b = A.classifyMove(c.move, c.prev);
    assert.equal(a, b, `não-determinístico em ${c.name}`);
  }
});

// ============================================================
// analyzeGame ponta a ponta (pool falso) — fase 1 + refinamento
// ============================================================

// Partida curta 1.e4 e5 2.Nf3 Nc6 com evals encenados: na fase 1 (depth base)
// o engine "acha" que 2.Nf3 despenca pra -320 (blunder); na fase 2 (depth
// maior) a avaliação corrige pra +25 — o refinamento deve reclassificar.
function fakeGame() {
  const { Chess } = require("./harness.cjs");
  const c = new Chess();
  const sans = ["e4", "e5", "Nf3", "Nc6"];
  const moves = [];
  let ply = 0;
  for (const san of sans) {
    const fen_before = c.fen();
    const mv = c.move(san);
    ply++;
    moves.push({
      ply,
      move_number: Math.ceil(ply / 2),
      color: mv.color === "w" ? "white" : "black",
      san: mv.san,
      uci: mv.from + mv.to,
      fen_before,
      fen_after: c.fen(),
      is_capture: !!mv.captured,
      captured_piece: mv.captured || null,
      is_check: false,
      is_checkmate: false,
      in_book: false,
    });
  }
  return {
    headers: {
      White: "Alice", Black: "Bob",
      WhiteElo: "1500", BlackElo: "1480",
      TimeControl: "600", Site: "Chess.com",
    },
    moves,
    opening: null,
  };
}

// Pool falso: devolve infos prontas por posição, com eval diferente quando a
// análise pede profundidade de refinamento (depth > base).
function fakePool(parsed, baseDepth) {
  const mkInfo = (cp, pvUci, secondCp) => ({
    1: { depth: 0, multipv: 1, score: { type: "cp", value: cp }, pv: [pvUci] },
    2: { depth: 0, multipv: 2, score: { type: "cp", value: secondCp }, pv: [pvUci] },
  });
  const positions = [];
  for (const m of parsed.moves) positions.push(m.fen_before);
  positions.push(parsed.moves[parsed.moves.length - 1].fen_after);

  // POV = lado a mover em cada posição. pos2 aponta d2d4 como melhor (pra
  // 2.Nf3 não contar como "lance do engine") e pos3 muda com a profundidade.
  const shallow = [
    mkInfo(30, "e2e4", 20),    // pos0 (w)
    mkInfo(-30, "e7e5", -45),  // pos1 (b)
    mkInfo(30, "d2d4", 15),    // pos2 (w)
    mkInfo(320, "b8c6", 200),  // pos3 (b): Nf3 parece blunder
    mkInfo(25, "d2d4", 10),    // pos4 (w)
  ];
  const deep = [...shallow];
  deep[2] = mkInfo(30, "d2d4", 15);
  deep[3] = mkInfo(-30, "b8c6", -60); // depth maior: Nf3 era normal

  const byFen = new Map(positions.map((fen, i) => [fen, i]));
  return {
    calls: [],
    async analyzeAll(fens, optsFor, onResult) {
      for (let j = 0; j < fens.length; j++) {
        const i = byFen.get(fens[j]);
        const d = optsFor(j).depth;
        this.calls.push({ pos: i, depth: d });
        onResult(j, d > baseDepth ? deep[i] : shallow[i]);
      }
    },
  };
}

test("analyzeGame: refinamento reclassifica falso blunder e popula os novos campos", async () => {
  const parsed = fakeGame();
  const pool = fakePool(parsed, 15);
  const phase1 = [];
  let refineCalls = 0;

  const result = await A.analyzeGame(
    parsed,
    pool,
    { depth: 15, onRefineProgress: () => { refineCalls++; } },
    (mv) => phase1.push(mv.classification),
  );

  // Fase 1 viu blunder no 2.Nf3 (idx 2); resultado final corrigiu.
  assert.equal(phase1[2], "blunder", `fase 1 deveria marcar blunder: ${phase1}`);
  assert.equal(result.moves[2].classification, "best",
    `refinamento deveria corrigir: ${result.moves[2].classification}`);
  assert.ok(refineCalls > 0, "onRefineProgress não foi chamado");
  // O refinamento pediu profundidade maior só nas posições do lance marcado.
  assert.ok(pool.calls.some((c) => c.depth > 15 && (c.pos === 2 || c.pos === 3)));

  // Novos campos por lance.
  const m = result.moves[2];
  assert.equal(m.player_rating_cc, 1500);
  assert.ok(m.wdl_after && m.wdl_after.w + m.wdl_after.d + m.wdl_after.l === 1000,
    `wdl_after inválido: ${JSON.stringify(m.wdl_after)}`);
  assert.ok(m.accuracy >= 0 && m.accuracy <= 100);

  // Novos campos agregados.
  assert.equal(result.time_class, "rapid");
  assert.equal(result.site, "chesscom");
  for (const key of ["white", "black"]) {
    const elo = result[`elo_${key}`];
    const range = result[`elo_${key}_range`];
    assert.ok(elo >= 100 && elo <= 3500, `elo_${key} fora de faixa: ${elo}`);
    assert.ok(Array.isArray(range) && range[0] <= elo && elo <= range[1],
      `range incoerente: ${elo} ∉ ${range}`);
  }
});

test("analyzeGame: opts.refine=false mantém a classificação da fase 1", async () => {
  const parsed = fakeGame();
  const pool = fakePool(parsed, 15);
  const result = await A.analyzeGame(parsed, pool, { depth: 15, refine: false }, null);
  assert.equal(result.moves[2].classification, "blunder");
  assert.ok(!pool.calls.some((c) => c.depth > 15), "não deveria haver análise funda");
});
