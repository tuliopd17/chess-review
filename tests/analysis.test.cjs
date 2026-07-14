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
// Elo
// ============================================================
test("estimateElo: monotônica e em faixa plausível", () => {
  const elos = [40, 55, 65, 75, 85, 95, 100].map((a) => A.estimateElo(a));
  for (let i = 1; i < elos.length; i++) assert.ok(elos[i] >= elos[i - 1], "ELO não-monotônico");
  assert.ok(elos[0] >= 100 && elos[elos.length - 1] <= 3200, `ELO fora de faixa: ${elos}`);
});

test("estimateElo: fit Kaufman (acc>=80: (acc-64)*100)", () => {
  assert.equal(A.estimateElo(80), 1600);
  assert.equal(A.estimateElo(90), 2600);
  assert.equal(A.estimateElo(100), 3200); // (100-64)*100=3600, capado em 3200
});

test("estimateElo: curva baixa não superestima (acc 50 ~450, não negativo)", () => {
  const e50 = A.estimateElo(50);
  const e70 = A.estimateElo(70);
  assert.ok(e50 >= 400 && e50 <= 600, `acc50 → ${e50}`);
  assert.ok(e70 >= 1100 && e70 <= 1250, `acc70 → ${e70}`);
});

test("estimateElo: âncora bayesiana puxa sem 50/50 rígido", () => {
  // acc 90 => 2600 puro; âncora 1200 com moveCount default (20) e n0=12:
  // priorW = min(0.45, 12/32) = 0.375 → 0.625*2600 + 0.375*1200 = 2075
  const withAnchor = A.estimateElo(90, 1200);
  assert.ok(withAnchor > 1900 && withAnchor < 2400, `âncora 1200 → ${withAnchor}`);
  assert.ok(withAnchor !== 1900, "não deve ser média 50/50 rígida (1900)");
  // âncora inválida é ignorada
  assert.equal(A.estimateElo(90, NaN), 2600);
  // com muitos lances, prior pesa menos
  const manyMoves = A.estimateElo(90, { anchorElo: 1200, moveCount: 60 });
  assert.ok(manyMoves > withAnchor, "mais lances => confia mais na performance");
});

test("estimateElo: ACPL puxa a estimativa", () => {
  // ACPL baixo (jogo limpo) eleva; ACPL alto rebaixa.
  const clean = A.estimateElo(85, { acpl: 15 });
  const dirty = A.estimateElo(85, { acpl: 80 });
  const plain = A.estimateElo(85);
  assert.ok(clean > plain, `ACPL baixo deveria elevar: clean=${clean} plain=${plain}`);
  assert.ok(dirty < plain, `ACPL alto deveria rebaixar: dirty=${dirty} plain=${plain}`);
});

test("eloFromAcpl: monotônica e razoável", () => {
  assert.ok(A.eloFromAcpl(10) > A.eloFromAcpl(50));
  assert.ok(A.eloFromAcpl(20) > 2000 && A.eloFromAcpl(20) < 2800);
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
