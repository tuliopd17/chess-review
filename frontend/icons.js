/* Ícones das classificações de lances, no estilo "badge" do Game Review do
 * chess.com. Cada função retorna um SVG string (usado na lista de lances, no
 * card de resumo e no card do coach).
 *
 * Design: disco colorido sólido + um brilho branco sutil no topo (profundidade)
 * + glifo branco nítido. Sem <defs>/gradientes com id (evita colisão quando
 * vários ícones são injetados como innerHTML na mesma página).
 */

const CLS_COLORS = {
  brilliant:  "#26c2a3",
  great:      "#5c8bb0",
  best:       "#81b64c",
  excellent:  "#95bb5a",
  good:       "#b0c98c",
  book:       "#a88865",
  forced:     "#9b9b95",
  inaccuracy: "#f4bf3f",
  mistake:    "#ef9234",
  blunder:    "#ca3431",
  miss:       "#e0688a",
};

// Disco com brilho — base de todos os ícones.
function disc(color) {
  return `<circle cx="12" cy="12" r="11" fill="${color}"/>` +
         `<circle cx="12" cy="9.5" r="8" fill="#ffffff" opacity="0.16"/>`;
}

// Texto branco centralizado (para ! ? etc.).
// font-weight 900 + letter-spacing comprimido pra dobrar símbolos (!!, ??)
// caberem grandes dentro do disco — igual ao chess.com Game Review.
function glyphText(txt, fontSize, letterSpacing = 0) {
  const ls = letterSpacing ? ` letter-spacing="${letterSpacing}"` : "";
  return `<text x="12" y="12" text-anchor="middle" dominant-baseline="central" ` +
         `font-family="-apple-system, 'Segoe UI', Roboto, sans-serif" ` +
         `font-size="${fontSize}" font-weight="900"${ls} fill="#ffffff">${txt}</text>`;
}

// Checkmark branco (espessura ajustável).
function glyphCheck(width) {
  return `<path d="M7 12.3l3.1 3.1L17 8.4" fill="none" stroke="#ffffff" ` +
         `stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function svg(inner, size) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ` +
         `xmlns="http://www.w3.org/2000/svg" style="display:block">${inner}</svg>`;
}

const CLASS_ICONS = {
  brilliant: (size = 20) => svg(disc(CLS_COLORS.brilliant) + glyphText("!!", 14, -1.5), size),
  great:     (size = 20) => svg(disc(CLS_COLORS.great)     + glyphText("!", 17), size),
  best:      (size = 20) => svg(disc(CLS_COLORS.best)      + glyphCheck(3.0), size),
  excellent: (size = 20) => svg(disc(CLS_COLORS.excellent) + glyphCheck(2.6), size),
  good: (size = 20) => svg(
    disc(CLS_COLORS.good) +
    `<circle cx="12" cy="12" r="3.1" fill="#ffffff"/>`, size),
  book: (size = 20) => svg(
    disc(CLS_COLORS.book) +
    // Livro aberto (duas páginas) branco com vinco central.
    `<path d="M12 8.1C10.5 7.2 8.8 6.9 7 6.9v9c1.8 0 3.5.3 5 1.2 1.5-.9 3.2-1.2 5-1.2v-9c-1.8 0-3.5.3-5 1.2z" fill="#ffffff"/>` +
    `<line x1="12" y1="8.1" x2="12" y2="17.1" stroke="${CLS_COLORS.book}" stroke-width="1.1"/>`, size),
  forced: (size = 20) => svg(
    disc(CLS_COLORS.forced) +
    // Engrenagem/corrente estilizada → "obrigatório": seta dupla pra direita.
    `<path d="M7 8.5l3.2 3.5L7 15.5M12 8.5l3.2 3.5L12 15.5" fill="none" stroke="#ffffff" ` +
    `stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`, size),
  inaccuracy: (size = 20) => svg(disc(CLS_COLORS.inaccuracy) + glyphText("?!", 13, -1.5), size),
  mistake:    (size = 20) => svg(disc(CLS_COLORS.mistake)    + glyphText("?", 17), size),
  blunder:    (size = 20) => svg(disc(CLS_COLORS.blunder)    + glyphText("??", 14, -1.5), size),
  miss: (size = 20) => svg(
    disc(CLS_COLORS.miss) +
    // "X" desenhado (mais nítido que texto).
    `<path d="M8.3 8.3l7.4 7.4M15.7 8.3l-7.4 7.4" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>`, size),
};

/* Converte SVG string em data URL pra usar como background-image. */
function svgIconDataUrl(classification, size = 32) {
  const fn = CLASS_ICONS[classification];
  if (!fn) return null;
  return "data:image/svg+xml;utf8," + encodeURIComponent(fn(size));
}

window.CLASS_ICONS = CLASS_ICONS;
window.svgIconDataUrl = svgIconDataUrl;
