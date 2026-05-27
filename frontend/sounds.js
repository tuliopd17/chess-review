/* Sistema de sons — usa o pacote padrão do Lichess (MIT) via jsdelivr CDN.
 * Toca o som apropriado pra cada lance ao navegar pela partida.
 *
 * Sons: move, capture, check, castle, promote, end.
 * Toggle persistido em localStorage. Falhas (CDN fora, autoplay bloqueado) são
 * silenciosas — som é nice-to-have, não pode quebrar a navegação.
 */
(function () {
  const SOUND_BASE = "https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/sound/standard/";

  const SOUND_FILES = {
    move:    "Move.mp3",
    capture: "Capture.mp3",
    check:   "Check.mp3",
    castle:  "Move.mp3",        // Lichess não tem Castle.mp3 no standard; reutiliza Move
    promote: "GenericNotify.mp3",
    end:     "GenericNotify.mp3",
    start:   "GenericNotify.mp3",
  };

  const cache = {};
  let muted = localStorage.getItem("cr_muted") === "1";
  let volume = 0.45;

  function load(key) {
    if (cache[key]) return cache[key];
    const a = new Audio(SOUND_BASE + SOUND_FILES[key]);
    a.preload = "auto";
    a.volume = volume;
    cache[key] = a;
    return a;
  }

  function play(key) {
    if (muted) return;
    try {
      // Audio.play() pode ser bloqueado se o usuário ainda não interagiu com a
      // página, ou o arquivo pode não ter carregado. Em qualquer falha,
      // ignoramos silenciosamente.
      const original = load(key);
      // Cloneia pra permitir overlap (clicar em "Próximo" rápido). Senão
      // sons sobrepostos sobrescrevem o currentTime do mesmo elemento.
      const a = original.cloneNode();
      a.volume = volume;
      a.play().catch(() => {});
    } catch (e) {}
  }

  function pickSound(move) {
    if (!move) return null;
    if (/^O-O/.test(move.san)) return "castle";
    if (/=/.test(move.san))    return "promote";
    if (move.is_check || move.is_checkmate) return "check";
    if (move.is_capture)       return "capture";
    return "move";
  }

  function playMoveSound(move) {
    const key = pickSound(move);
    if (key) play(key);
  }

  function setMuted(m) {
    muted = !!m;
    localStorage.setItem("cr_muted", muted ? "1" : "0");
  }
  function isMuted() { return muted; }
  function toggle() { setMuted(!muted); return muted; }

  function preload() {
    Object.keys(SOUND_FILES).forEach(k => { try { load(k); } catch {} });
  }

  window.ChessReviewSounds = { play, playMoveSound, setMuted, isMuted, toggle, preload };
})();
