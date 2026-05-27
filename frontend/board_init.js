/* Bootstrap do cm-chessboard.
 *
 * Esta é a única parte do código que usa ES modules (cm-chessboard é distribuído
 * apenas como ESM). Cria a instância do tabuleiro, registra extensões (Markers
 * e Arrows), e expõe uma API simplificada em window.crBoard pro app.js (que é
 * script global) consumir.
 *
 * API exposta:
 *   window.crBoard.api: instância do Chessboard
 *   window.crBoard.setPosition(fen, animated)
 *   window.crBoard.setOrientation(color, animated)
 *   window.crBoard.getOrientation()
 *   window.crBoard.highlightMove(from, to)  -> destaca lance (verde)
 *   window.crBoard.clearHighlights()        -> limpa marcadores e setas
 *   window.crBoard.drawBestArrow(from, to)  -> seta verde (melhor lance)
 *   window.crBoard.drawPlayedArrow(from, to) -> seta vermelha (lance ruim jogado)
 *   window.crBoard.drawEngineArrow(from, to) -> seta turquesa (engine ao vivo)
 *   window.crBoard.markClassification(square, classification) -> ícone na casa de destino
 *   window.crBoard.enableMoveInput(handler) -> drag-drop
 *   window.crBoard.disableMoveInput()
 *   window.crBoard.MARKER_TYPE_HIGHLIGHT, ARROW_TYPE_*  -> referências
 *
 * O bootstrap também dispara o evento "crBoardReady" no document quando estiver pronto.
 */

import {
  Chessboard,
  FEN,
  COLOR,
  INPUT_EVENT_TYPE,
  BORDER_TYPE,
} from "https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/Chessboard.js";

import { Markers, MARKER_TYPE } from "https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/extensions/markers/Markers.js";
import { Arrows, ARROW_TYPE } from "https://cdn.jsdelivr.net/npm/cm-chessboard@8/src/extensions/arrows/Arrows.js";

const ASSETS_URL = "https://cdn.jsdelivr.net/npm/cm-chessboard@8/assets/";

// Tipos customizados de marker pra highlight do lance.
// (Identidade por referência — cuidado pra reusar.)
const MARKER_LAST_FROM = { class: "marker-square-from", slice: "markerSquare" };
const MARKER_LAST_TO   = { class: "marker-square-to",   slice: "markerSquare" };
// Highlight da casa do rei em xeque — vermelho pulsante (estilo chess.com).
const MARKER_CHECK     = { class: "marker-square-check", slice: "markerSquare" };

// Tipos customizados de arrow.
const ARROW_BEST   = { class: "arrow-best",   slice: "arrowDefault", headSize: 7 };
const ARROW_PLAYED = { class: "arrow-played", slice: "arrowDefault", headSize: 7 };
const ARROW_ENGINE = { class: "arrow-engine", slice: "arrowDefault", headSize: 7 };

const containerEl = document.getElementById("board");

const board = new Chessboard(containerEl, {
  position: FEN.start,
  orientation: COLOR.white,
  responsive: true,
  assetsUrl: ASSETS_URL,
  style: {
    cssClass: "default",
    showCoordinates: true,
    borderType: BORDER_TYPE.none,
    aspectRatio: 1,
    pieces: {
      file: "pieces/standard.svg",
      tileSize: 40,
    },
    animationDuration: 200,
  },
  extensions: [
    { class: Markers, props: { sprite: "extensions/markers/markers.svg" } },
    { class: Arrows,  props: { sprite: "extensions/arrows/arrows.svg" } },
  ],
});

// ============================================================
// Badge da classificação — disco colorido com o ícone, posicionado
// no canto superior direito da casa de destino (estilo chess.com).
// É um overlay HTML separado sobre o SVG do cm-chessboard, posicionado
// em % da área do tabuleiro pra acompanhar resize/flip naturalmente.
// ============================================================
const overlayEl = document.createElement("div");
overlayEl.className = "board-overlays";
containerEl.appendChild(overlayEl);

let currentBadge = null; // { square, classification } | null

function squareCenterPercent(square) {
  // a..h → 0..7, 1..8 → 0..7. Orientação branca: a1 fica embaixo-esquerda.
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10) - 1;
  const whiteDown = board.getOrientation() === COLOR.white;
  const col = whiteDown ? file : 7 - file;
  const row = whiteDown ? 7 - rank : rank;
  return {
    cx: ((col + 0.5) / 8) * 100,
    cy: ((row + 0.5) / 8) * 100,
    cellSize: 100 / 8,
  };
}

function renderBadge() {
  overlayEl.innerHTML = "";
  if (!currentBadge) return;
  const { square, classification } = currentBadge;
  if (!square || !classification || !window.CLASS_ICONS?.[classification]) return;
  const { cx, cy, cellSize } = squareCenterPercent(square);
  const badgeSize = cellSize * 0.46; // ~46% da casa, igual ao chess.com
  const el = document.createElement("div");
  el.className = `cls-badge cls-badge-${classification}`;
  // Posiciona no canto superior direito da casa: meio da casa + meio da célula
  // (menos um pouco pra ficar "mordendo" o canto, não pra fora).
  el.style.left = `${cx + cellSize * 0.42}%`;
  el.style.top  = `${cy - cellSize * 0.42}%`;
  el.style.width  = `${badgeSize}%`;
  el.style.height = `${badgeSize}%`;
  el.innerHTML = window.CLASS_ICONS[classification](100);
  overlayEl.appendChild(el);
}

// Reposiciona badge ao virar tabuleiro. setOrientation retorna Promise pq
// anima — precisamos esperar a animação terminar pra getOrientation() devolver
// a nova orientação. Chamamos renderBadge tanto após o tick (caso sync) quanto
// no .then (caso async).
const _origFlip = board.setOrientation.bind(board);
board.setOrientation = function (color, animated) {
  const r = _origFlip(color, animated);
  if (r && typeof r.then === "function") {
    r.then(() => renderBadge());
  }
  renderBadge();
  return r;
};

// ============================================================
// API exposta no window
// ============================================================
window.crBoard = {
  api: board,
  MARKER_TYPE,
  ARROW_TYPE,
  COLOR,
  INPUT_EVENT_TYPE,
  FEN,

  setPosition(fen, animated = true) {
    return board.setPosition(fen || FEN.start, animated);
  },
  setOrientation(color, animated = true) {
    return board.setOrientation(color === "black" ? COLOR.black : COLOR.white, animated);
  },
  getOrientation() {
    return board.getOrientation() === COLOR.white ? "white" : "black";
  },

  highlightMove(from, to) {
    // Limpa apenas os highlights do último lance, mantém arrows e classification markers.
    board.removeMarkers(MARKER_LAST_FROM);
    board.removeMarkers(MARKER_LAST_TO);
    if (from) board.addMarker(MARKER_LAST_FROM, from);
    if (to)   board.addMarker(MARKER_LAST_TO, to);
  },

  markCheck(square) {
    board.removeMarkers(MARKER_CHECK);
    if (square) board.addMarker(MARKER_CHECK, square);
  },
  clearCheck() {
    board.removeMarkers(MARKER_CHECK);
  },

  markClassification(square, classification) {
    currentBadge = (square && classification) ? { square, classification } : null;
    renderBadge();
  },

  clearHighlights() {
    board.removeMarkers(MARKER_LAST_FROM);
    board.removeMarkers(MARKER_LAST_TO);
    board.removeMarkers(MARKER_CHECK);
    currentBadge = null;
    renderBadge();
    board.removeArrows(ARROW_BEST);
    board.removeArrows(ARROW_PLAYED);
    board.removeArrows(ARROW_ENGINE);
  },

  drawBestArrow(from, to) {
    board.removeArrows(ARROW_BEST);
    if (from && to && from !== to) board.addArrow(ARROW_BEST, from, to);
  },
  drawPlayedArrow(from, to) {
    board.removeArrows(ARROW_PLAYED);
    if (from && to && from !== to) board.addArrow(ARROW_PLAYED, from, to);
  },
  drawEngineArrow(from, to) {
    board.removeArrows(ARROW_ENGINE);
    if (from && to && from !== to) board.addArrow(ARROW_ENGINE, from, to);
  },
  clearEngineArrow() {
    board.removeArrows(ARROW_ENGINE);
  },

  enableMoveInput(handler) {
    board.enableMoveInput(handler);
  },
  disableMoveInput() {
    board.disableMoveInput();
  },
};

// Notifica o app.js (que tá esperando isso pra inicializar).
document.dispatchEvent(new CustomEvent("crBoardReady"));
