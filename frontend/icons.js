/* Ícones das classificações de lances, inspirados no chess.com.
 * Cada função retorna um SVG string. Usamos isso tanto na lista de lances
 * quanto como overlay no tabuleiro (canto superior direito da casa de destino).
 */

const CLASS_ICONS = {
  brilliant: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#1baca6"/>
      <text x="12" y="16" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" fill="white">!!</text>
    </svg>`,
  great: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#5c8bb0"/>
      <text x="12" y="16" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" fill="white">!</text>
    </svg>`,
  best: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#81b64c"/>
      <path d="M7 12.5l3 3 7-7" stroke="white" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  excellent: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#9bbf6a"/>
      <path d="M7 12.5l3 3 7-7" stroke="white" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  good: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#b5c98c"/>
      <circle cx="12" cy="12" r="3" fill="white"/>
    </svg>`,
  book: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#a88865"/>
      <rect x="7" y="7" width="10" height="10" rx="1" fill="white"/>
      <line x1="12" y1="7" x2="12" y2="17" stroke="#a88865" stroke-width="1"/>
    </svg>`,
  inaccuracy: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#f7c252"/>
      <text x="12" y="16" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="bold" fill="white">?!</text>
    </svg>`,
  mistake: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#f29e3a"/>
      <text x="12" y="16" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="white">?</text>
    </svg>`,
  blunder: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#ca3431"/>
      <text x="12" y="16" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="white">??</text>
    </svg>`,
  miss: (size = 20) => `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="11" fill="#ee7268"/>
      <text x="12" y="16" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="bold" fill="white">X</text>
    </svg>`,
};

/* Converte SVG string em data URL pra usar como background-image. */
function svgIconDataUrl(classification, size = 32) {
  const fn = CLASS_ICONS[classification];
  if (!fn) return null;
  return "data:image/svg+xml;utf8," + encodeURIComponent(fn(size));
}

window.CLASS_ICONS = CLASS_ICONS;
window.svgIconDataUrl = svgIconDataUrl;
