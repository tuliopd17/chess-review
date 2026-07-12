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

test("estimateElo: monotônica e em faixa plausível", () => {
  const elos = [40, 55, 65, 75, 85, 95, 100].map((a) => A.estimateElo(a));
  for (let i = 1; i < elos.length; i++) assert.ok(elos[i] >= elos[i - 1], "ELO não-monotônico");
  assert.ok(elos[0] >= 100 && elos[elos.length - 1] <= 3200, `ELO fora de faixa: ${elos}`);
});

test("estimateElo: fit da comunidade (acc>=80: (acc-64)*100)", () => {
  assert.equal(A.estimateElo(80), 1600);
  assert.equal(A.estimateElo(90), 2600);
  assert.equal(A.estimateElo(100), 3200); // (100-64)*100=3600, capado em 3200
});

test("estimateElo: âncora de rating puxa a estimativa pro meio", () => {
  // acc 90 => 2600 puro; ancorado em 1200 => (2600+1200)/2 = 1900
  assert.equal(A.estimateElo(90, 1200), 1900);
  // âncora inválida é ignorada
  assert.equal(A.estimateElo(90, NaN), 2600);
});

test("computeGameAccuracies: partida perfeita ~100, com capivarada cai", () => {
  // Série "perfeita": todo lance é o melhor (eval_after == best_eval).
  const perfect = [];
  for (let i = 0; i < 10; i++) {
    perfect.push({ color: i % 2 === 0 ? "white" : "black", best_eval_cp: 20, eval_after_cp: 20 });
  }
  const accP = A.computeGameAccuracies(perfect);
  assert.ok(accP.white > 95 && accP.black > 95, `esperava ~100, veio ${JSON.stringify(accP)}`);

  // Mesma série, mas branco larga a dama num lance.
  const withBlunder = perfect.map((m) => ({ ...m }));
  withBlunder[4] = { color: "white", best_eval_cp: 30, eval_after_cp: -800 };
  const accB = A.computeGameAccuracies(withBlunder);
  assert.ok(accB.white < accP.white, "capivarada deveria derrubar a acurácia das brancas");
  assert.ok(Math.abs(accB.black - accP.black) < 1e-6, "acurácia das pretas não deveria mudar");
});

test("computeGameAccuracies: lista vazia não quebra", () => {
  assert.deepEqual(A.computeGameAccuracies([]), { white: 0, black: 0 });
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
