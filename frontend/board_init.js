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
// Marker do "ícone de classificação" — usa marker tipo "frame"
// colorido conforme a classificação. Mais simples e robusto que tentar
// posicionar um SVG sobre o tabuleiro.
// ============================================================
const CLASSIFICATION_MARKER_TYPES = {};
function classMarkerType(classification) {
  if (!CLASSIFICATION_MARKER_TYPES[classification]) {
    CLASSIFICATION_MARKER_TYPES[classification] = {
      class: `cls-marker-${classification}`,
      slice: "markerFrame",
    };
  }
  return CLASSIFICATION_MARKER_TYPES[classification];
}

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

  markClassification(square, classification) {
    // Remove qualquer marcador de classificação anterior.
    Object.values(CLASSIFICATION_MARKER_TYPES).forEach(t => board.removeMarkers(t));
    if (!square || !classification) return;
    board.addMarker(classMarkerType(classification), square);
  },

  clearHighlights() {
    board.removeMarkers(MARKER_LAST_FROM);
    board.removeMarkers(MARKER_LAST_TO);
    Object.values(CLASSIFICATION_MARKER_TYPES).forEach(t => board.removeMarkers(t));
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
