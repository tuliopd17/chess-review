/* Fixtures de classificação de lances — a "régua" que trava o comportamento do
 * classifyMove contra regressão.
 *
 * Cada caso é um `move` enriquecido (mesmos campos que analysis.js monta em
 * analyzeGame) + o `prevMove` opcional, e a classificação chess.com esperada.
 * Os valores de eval foram escolhidos pra cair EXATAMENTE em cada banda do
 * Chess.com Classification V2 (expected points, sigmóide Lichess 0.00368208/cp):
 *
 *   Best <0.005 · Excellent <0.02 · Good <0.05 · Inaccuracy <0.10 ·
 *   Mistake <0.20 · Blunder ≥0.20
 *
 * (Help center oficial chess.com, fev/2026.) As posições de sacrifício
 * (brilliant/great) são linhas reais verificadas (Mate de Legall etc.).
 *
 * Pra ADICIONAR um caso de partida real do chess.com: pegue fen_before,
 * fen_after, os evals do engine e o rótulo que o chess.com mostrou, e some aqui.
 * Quanto mais casos reais, mais fiel a validação.
 */
const { Chess } = require("./harness.cjs");

const MATE = 10000;

// FEN quieta (Giuoco Piano) usada pros casos de faixa por win-prob: qualquer
// lance não-melhor aqui não dispara brilliant/great (nada pendura de propósito).
const QUIET = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 4";

function quiet(prev, after, extra = {}) {
  return Object.assign(
    {
      color: "white",
      san: "Qe2",
      uci: "d1e2",
      best_move_san: "Ng5", // != san => não é "best" => cai nas faixas
      fen_before: QUIET,
      fen_after: QUIET,
      best_eval_cp: prev,
      eval_after_cp: after,
      second_best_eval_cp: null,
      is_capture: false,
      to: "e2",
      net_material: 0,
    },
    extra,
  );
}

// Replay de uma linha SAN e devolve { fen_before, fen_after, uci, to } do último lance.
function line(moves) {
  const c = new Chess();
  for (let i = 0; i < moves.length - 1; i++) {
    if (!c.move(moves[i])) throw new Error("lance ilegal na fixture: " + moves[i]);
  }
  const fen_before = c.fen();
  const mv = c.move(moves[moves.length - 1]);
  if (!mv) throw new Error("lance final ilegal: " + moves[moves.length - 1]);
  return { fen_before, fen_after: c.fen(), uci: mv.from + mv.to, to: mv.to, san: mv.san };
}

// ----- Brilliant: Mate de Legall. 5.Nxe5 larga a dama (Bg4 mira d1) e é o melhor. -----
const legall = line(["e4", "e5", "Nf3", "Nc6", "Bc4", "d6", "Nc3", "Bg4", "Nxe5"]);
const brilliantMove = {
  color: "white",
  san: "Nxe5",
  uci: legall.uci,
  fen_before: legall.fen_before,
  fen_after: legall.fen_after,
  best_move_san: "Nxe5", // é o melhor => elegível a upgrade brilliant
  best_eval_cp: 150,
  eval_after_cp: 150, // segue melhor depois do sac
  second_best_eval_cp: 40, // 2ª opção não é um ganho trivial (>=700) => sac necessário
  is_capture: true,
  to: legall.to,
  net_material: 1,
};

// ----- Great: único lance à altura (2º melhor joga fora >=10% de exp. points). -----
const greatLine = line(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "d3", "Bc5", "O-O", "d6", "Nc3"]);
const greatMove = {
  color: "white",
  san: "Nc3",
  uci: greatLine.uci,
  fen_before: greatLine.fen_before,
  fen_after: greatLine.fen_after,
  best_move_san: "Nc3", // é o melhor => elegível
  best_eval_cp: 120,
  eval_after_cp: 120,
  second_best_eval_cp: -150, // 2º melhor perde ~24% de expected points
  is_capture: false,
  to: greatLine.to,
  net_material: 0,
};

// Evals calibrados com WIN_PCT_GRADIENT = 0.00368208 (Lichess).
// quiet(before, after) → expected points loss nas bandas V2 oficiais.
const CLASSIFICATION_CASES = [
  { name: "book move", move: quiet(20, 20, { in_book: true }), prev: null, expected: "book" },
  { name: "forced (único legal)", move: quiet(0, -300, { is_only_move: true }), prev: null, expected: "forced" },
  { name: "best (san === best)", move: quiet(30, 30, { san: "Ng5", best_move_san: "Ng5", uci: "f3g5", to: "g5" }), prev: null, expected: "best" },
  // loss ~0.0046 < 0.005
  { name: "best por point-loss (loss ~0.005, san != best)", move: quiet(30, 25), prev: null, expected: "best" },
  // loss ~0.0138 ∈ [0.005, 0.02)
  { name: "excellent (loss ~0.014)", move: quiet(30, 15), prev: null, expected: "excellent" },
  // loss ~0.046 ∈ [0.02, 0.05)
  { name: "good (loss ~0.046)", move: quiet(30, -20), prev: null, expected: "good" },
  // loss ~0.096 ∈ [0.05, 0.10)
  { name: "inaccuracy (loss ~0.096)", move: quiet(30, -75), prev: null, expected: "inaccuracy" },
  // loss ~0.155 ∈ [0.10, 0.20)
  { name: "mistake (loss ~0.155)", move: quiet(50, -120), prev: null, expected: "mistake" },
  // loss ~0.45 ≥ 0.20
  { name: "blunder (larga tudo)", move: quiet(50, -600), prev: null, expected: "blunder" },
  { name: "allowed mate-in-1", move: quiet(50, -(MATE - 1)), prev: null, expected: "blunder" },
  // tinha +400 (ep≈0.81) e virou +50 (ep≈0.55) → miss
  { name: "miss (tinha +400, virou +50)", move: quiet(400, 50), prev: null, expected: "miss" },
  { name: "brilliant (sac de Legall)", move: brilliantMove, prev: null, expected: "brilliant" },
  { name: "great (única jogada à altura)", move: greatMove, prev: null, expected: "great" },
];

module.exports = { CLASSIFICATION_CASES, MATE };
