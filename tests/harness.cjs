/* Carrega analysis.js (que roda no browser via IIFE) num contexto Node.
 *
 * analysis.js espera dois globais do browser: `window` (pra exportar
 * window.ChessReviewAnalysis) e `Chess` (chess.js 0.10.3, self-hosted em
 * frontend/vendor). Aqui damos os dois via globalThis e carregamos os arquivos
 * de verdade — nada de mock da lógica, é o MESMO código que roda em produção.
 */
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CHESS_PATH = path.join(ROOT, "frontend", "vendor", "chess-0.10.3.min.js");
const ANALYSIS_PATH = path.join(ROOT, "frontend", "analysis.js");

// Só carrega uma vez, mesmo se vários arquivos de teste importarem o harness.
if (!global.window) global.window = {};
if (!global.Chess) global.Chess = require(CHESS_PATH).Chess;
if (!global.window.ChessReviewAnalysis) require(ANALYSIS_PATH);

module.exports = {
  A: global.window.ChessReviewAnalysis,
  Chess: global.Chess,
};
