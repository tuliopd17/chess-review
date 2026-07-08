/* Chess Review — frontend
 * Vanilla JS + chessboard.js + Chart.js.
 * Comunica com o backend FastAPI em /api/*.
 * Suporta streaming SSE, eval bar, overlays no tabuleiro, histórico local.
 */

// ============================================================
// Estado global
// ============================================================
const state = {
  board: null,
  analysis: null,          // payload final (após "done")
  partialMoves: [],        // lances recebidos enquanto stream tá rodando
  partialHeaders: null,
  partialOpening: null,
  currentPly: 0,
  evalChart: null,
  orientation: "white",
  totalPlies: 0,
  streaming: false,
  currentPgn: null,        // PGN da análise atual

  // ----- Engine WASM ao vivo -----
  engine: null,            // BrowserEngine (instância única, painel ao vivo + exploração)
  engineReady: false,
  liveInfo: {},            // último info por multipv: { 1: {...}, 2: {...}, 3: {...} }
  liveFen: null,           // FEN que a análise ao vivo está de fato avaliando
  liveToken: 0,            // invalida callbacks de análises ao vivo antigas
  engineMultiPV: 3,
  engineDepth: 22,

  // ----- Pool de engines (análise da partida em paralelo) -----
  enginePool: null,        // EnginePool (criado sob demanda na 1ª análise)
  analysisRunId: 0,        // invalida análises antigas se uma nova começar

  // ----- Modo exploração -----
  exploring: false,
  exploreChess: null,      // instância chess.js representando a posição
  exploreStartFen: null,   // FEN da posição quando começou a explorar
  exploreStartPly: 0,      // ply original em que a exploração começou
};

const CLASS_LABELS = {
  brilliant:  "Lance Brilhante",
  great:      "Ótimo Lance",
  best:       "Melhor Lance",
  excellent:  "Excelente",
  good:       "Bom",
  book:       "Abertura",
  forced:     "Forçado",
  inaccuracy: "Imprecisão",
  mistake:    "Erro",
  blunder:    "Capivarada",
  miss:       "Oportunidade Perdida",
};

const CLASS_ORDER = [
  "brilliant", "great", "best", "excellent", "good",
  "book", "forced", "inaccuracy", "mistake", "blunder", "miss"
];

const HISTORY_KEY = "chess_review_history_v1";
const HISTORY_MAX = 30;

// Logs do engine WASM (linhas UCI) DESLIGADOS por padrão — com o pool de vários
// workers, logar cada linha UCI custa caro (centenas de console.log por análise)
// e deixava a análise bem mais lenta. Pra depurar: window.SF_DEBUG = true
// (e window.SF_DEBUG_INFO = true pra incluir as linhas "info", bem barulhentas).
window.SF_DEBUG = false;

// ============================================================
// Init
// ============================================================
// Esperamos o board (cm-chessboard ES module) montar antes de inicializar.
// Se o evento já disparou antes do listener ser registrado, fallback após delay.
let _bootStarted = false;
function bootApp() {
  if (_bootStarted) return;
  _bootStarted = true;
  initBoard();
  initTabs();
  initControls();
  initImportButtons();
  initHistory();
  initLiveEngine();
  initBrandHome();
  loadFromHash();
}

// Clique no logo do header recarrega a página (mesmo se já estiver em "/")
// — funciona como um F5, descarta a análise atual e volta pro estado limpo.
function initBrandHome() {
  const link = document.getElementById("brand-home");
  if (!link) return;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    window.location.assign("/");
  });
}
document.addEventListener("crBoardReady", bootApp);
window.addEventListener("DOMContentLoaded", () => {
  // se cm-chessboard demorar, ainda inicializamos o resto após 800ms
  setTimeout(() => { if (window.crBoard) bootApp(); }, 800);
});

function initBoard() {
  // crBoard já foi inicializado pelo board_init.js (ES module).
  state.board = window.crBoard;

  // Habilita move input — usado pra entrar em modo exploração.
  state.board.enableMoveInput(handleMoveInput);

  document.getElementById("btn-back-to-game").onclick = exitExploreMode;
}

/* ===== Move input do cm-chessboard: ativa modo exploração ao mover ===== */

function handleMoveInput(event) {
  const T = state.board.INPUT_EVENT_TYPE;

  if (event.type === T.moveInputStarted) {
    // Bloqueia durante a análise da partida — evita atropelar a engine.
    if (state.streaming) return false;
    // Só permite arrastar se já temos análise carregada.
    if (!state.partialMoves.length) return false;
    // Verifica se a peça é da cor do lado a mover.
    const fen = currentFen();
    const turn = fen.split(" ")[1]; // "w" ou "b"
    const piece = state.board.api.getPiece(event.squareFrom);
    if (!piece) return false;
    const pieceColor = piece[0]; // "w" ou "b"
    if (pieceColor !== turn) return false;
    return true;
  }

  if (event.type === T.validateMoveInput) {
    // Inicia ou continua exploração.
    if (!state.exploring) enterExploreMode();
    const chess = state.exploreChess;
    let move = null;
    try {
      move = chess.move({ from: event.squareFrom, to: event.squareTo, promotion: "q" });
    } catch (e) { move = null; }
    if (!move) return false;
    // Lance válido — agenda render e análise ao vivo.
    setTimeout(() => {
      renderExploreUI();
      startLiveAnalysis(chess.fen());
    }, 50);
    return true;
  }

  return true;
}

function currentFen() {
  if (state.exploring && state.exploreChess) return state.exploreChess.fen();
  const ply = state.currentPly;
  if (ply === 0) return "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  return state.partialMoves[ply - 1].fen_after;
}

function enterExploreMode() {
  state.exploring = true;
  state.exploreStartPly = state.currentPly;
  state.exploreStartFen = currentFen();
  state.exploreChess = new Chess(state.exploreStartFen);
  document.getElementById("explore-banner").style.display = "flex";
}

function exitExploreMode() {
  state.exploring = false;
  state.exploreChess = null;
  document.getElementById("explore-banner").style.display = "none";
  goToPly(state.exploreStartPly);
  startLiveAnalysis(currentFen());
}

function renderExploreUI() {
  if (state.exploreChess) {
    state.board.setPosition(state.exploreChess.fen(), true);
  }
  // Limpa highlights/setas — exploração não tem "lance jogado" da partida.
  state.board.clearHighlights();
  const cls = document.getElementById("move-classification");
  const cmt = document.getElementById("move-comment");
  const pv  = document.getElementById("move-pv");
  cls.innerHTML = `<span style="color: var(--c-brilliant);">🔎 Variante explorada</span>`;
  cls.className = "";
  const history = state.exploreChess.history();
  cmt.textContent = "Sequência da variante: " + history.join(" ");
  pv.innerHTML = "";
}

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    });
  });
}

function initControls() {
  // Liga os controles a "pointerdown" em vez de "click". No mobile (iOS Safari
  // principalmente), o pipeline touchstart→touchend→click pode falhar de várias
  // formas: focus stuck, tap highlight bloqueando o próximo toque, 300ms de
  // delay residual mesmo com touch-action:manipulation, etc. pointerdown dispara
  // ASSIM que o dedo encosta — sem esperar liberar, sem esperar o navegador
  // decidir se é tap ou scroll. Dedup de 80ms evita disparo duplicado pelo
  // click subsequente.
  // Padrão lichess (ui/lib/src/pointer.ts): dispara em POINTERUP com
  // { passive: false } + preventDefault. O preventDefault no pointerup faz o
  // navegador NÃO emitir o click sintético — assim não tem como disparar duas
  // vezes. pointerdown só serve pra "armar" (e poder cancelar se o usuário
  // arrastar pra fora). Nada de listener no click — flag-based suppress
  // falhava no iOS porque o pointerdown default é passive (preventDefault vira
  // no-op) e re-renders entre pointerdown e click invalidam o estado.
  function bindNav(btnId, action) {
    const btn = document.getElementById(btnId);
    let armed = false;
    btn.addEventListener("pointerdown", (e) => {
      if (e.isPrimary === false) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      armed = true;
    }, { passive: true });
    btn.addEventListener("pointerup", (e) => {
      if (!armed) return;
      armed = false;
      action();
      e.preventDefault(); // suprime o ghost click; precisa de passive:false
    }, { passive: false });
    btn.addEventListener("pointercancel", () => { armed = false; }, { passive: true });
    btn.addEventListener("pointerleave",  () => { armed = false; }, { passive: true });
    // Acessibilidade por teclado (Enter / Espaço no botão focado).
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        action();
      }
    });
  }
  // Actions centralizadas pra serem chamadas tanto pelos botões quanto pelo
  // teclado. (Antes o keyboard fazia .click() no botão, mas como removemos o
  // listener de click ao migrar pra pointerup do lichess, .click() virou no-op.)
  const navActions = {
    start: () => goToPly(0),
    end:   () => goToPly(currentMoves().length),
    prev:  () => goToPly(state.currentPly - 1),
    next:  () => goToPly(state.currentPly + 1),
    flip:  () => {
      state.orientation = state.orientation === "white" ? "black" : "white";
      state.board.setOrientation(state.orientation, true);
      renderPlayerBars();
    },
  };
  bindNav("btn-start", navActions.start);
  bindNav("btn-end",   navActions.end);
  bindNav("btn-prev",  navActions.prev);
  bindNav("btn-next",  navActions.next);
  bindNav("btn-flip",  navActions.flip);

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
    if (e.key === "ArrowLeft")  navActions.prev();
    if (e.key === "ArrowRight") navActions.next();
    if (e.key === "Home")       navActions.start();
    if (e.key === "End")        navActions.end();
    if (e.key === "f" || e.key === "F") navActions.flip();
  });
}

function initImportButtons() {
  document.getElementById("analyze-pgn-btn").onclick = () => {
    const pgn = document.getElementById("pgn-input").value.trim();
    if (!pgn) { alert("Cole um PGN primeiro."); return; }
    // Tenta detectar o username do jogador a partir dos campos de busca
    // preenchidos (chess.com ou Lichess) — assim o PGN colado também
    // auto-detecta o lado certo.
    const chesscomUser = document.getElementById("chesscom-user").value.trim();
    const lichessUser = document.getElementById("lichess-user").value.trim();
    const playerUsername = chesscomUser || lichessUser || null;
    analyzePgnStreaming(pgn, playerUsername);
  };

  document.getElementById("pgn-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { document.getElementById("pgn-input").value = ev.target.result; };
    reader.readAsText(file);
  });

  document.getElementById("fetch-chesscom-btn").onclick = () => {
    const u = document.getElementById("chesscom-user").value.trim();
    if (u) fetchGames("chesscom", u, "chesscom-games");
  };
  document.getElementById("fetch-lichess-btn").onclick = () => {
    const u = document.getElementById("lichess-user").value.trim();
    if (u) fetchGames("lichess", u, "lichess-games");
  };
  document.getElementById("chesscom-user").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("fetch-chesscom-btn").click();
  });
  document.getElementById("lichess-user").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("fetch-lichess-btn").click();
  });

  document.getElementById("clear-history-btn").onclick = async () => {
    if (!confirm("Apagar todas as análises do histórico?")) return;
    await HistoryStore.clear();
    await renderHistory();
  };
}

function initHistory() {
  renderHistory();
}

/* ============================================================
   Link compartilhável (permalink)
   ============================================================
   Codifica o PGN da análise no hash da URL — nada vai pro servidor, o link
   carrega a partida direto. Usa gzip nativo (CompressionStream) quando
   disponível pra caber PGNs longos em URLs curtas; senão, base64 puro.
   Prefixo do hash indica o formato: "#g=" gzip+base64url, "#p=" base64url cru. */

function _b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function _b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function encodePgnToHash(pgn) {
  const raw = new TextEncoder().encode(pgn);
  if (typeof CompressionStream === "function") {
    const cs = new CompressionStream("gzip");
    const w = cs.writable.getWriter();
    w.write(raw); w.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return "g=" + _b64urlEncode(new Uint8Array(buf));
  }
  return "p=" + _b64urlEncode(raw);
}

async function decodePgnFromHash(hash) {
  const raw = hash.replace(/^#/, "");
  const eq = raw.indexOf("=");
  if (eq < 0) return null;
  const key = raw.slice(0, eq);
  const val = raw.slice(eq + 1);
  if (!val) return null;
  let bytes;
  try { bytes = _b64urlDecode(val); } catch { return null; }
  if (key === "g") {
    if (typeof DecompressionStream !== "function") return null;
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter();
    w.write(bytes); w.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(buf);
  }
  if (key === "p") return new TextDecoder().decode(bytes);
  return null;
}

// No boot: se a URL trouxer um PGN no hash, carrega e analisa direto.
async function loadFromHash() {
  if (!location.hash || location.hash.length < 3) return;
  let pgn;
  try { pgn = await decodePgnFromHash(location.hash); } catch { pgn = null; }
  if (!pgn || !pgn.trim()) return;
  const input = document.getElementById("pgn-input");
  if (input) input.value = pgn;
  document.querySelector(".tab-btn[data-tab='pgn']")?.click();
  analyzePgnStreaming(pgn);
}

/* ============================================================
   Engine WASM ao vivo
   ============================================================ */

async function initLiveEngine() {
  const mpvSel = document.getElementById("engine-multipv");
  const dSel = document.getElementById("engine-depth-sel");

  mpvSel.value = state.engineMultiPV;
  dSel.value = state.engineDepth;

  mpvSel.onchange = () => {
    state.engineMultiPV = parseInt(mpvSel.value, 10);
    if (state.engineReady) startLiveAnalysis(currentFen());
  };
  dSel.onchange = () => {
    state.engineDepth = parseInt(dSel.value, 10);
    if (state.engineReady) startLiveAnalysis(currentFen());
  };

  setEngineStatus("loading");
  try {
    state.engine = new BrowserEngine();
    await state.engine.ready();
    state.engineReady = true;
    setEngineStatus("ready");
  } catch (e) {
    console.warn("Engine WASM falhou:", e);
    setEngineStatus("error");
  }
}

// Atualiza o chip de status da engine (carregando / pronta / erro) e a dica
// dentro do card. Deixa a espera dos ~10MB do WASM legível em vez de uma tela
// muda (princípio "make the wait legible" do skill de UX).
function setEngineStatus(status) {
  const chip = document.getElementById("engine-status");
  const linesEl = document.getElementById("engine-lines");
  if (chip) {
    chip.classList.remove("loading", "ready", "error");
    chip.classList.add(status);
    const txt = chip.querySelector(".engine-status-text");
    if (txt) {
      txt.textContent =
        status === "ready" ? "pronta" :
        status === "error" ? "indisponível" : "carregando engine…";
    }
  }
  // Só mexe nas linhas se ainda não há análise rolando (não atropela a PV ao vivo).
  if (linesEl && Object.keys(state.liveInfo).length === 0) {
    linesEl.innerHTML =
      status === "error"
        ? "<div class='engine-hint'>Engine indisponível. Recarregue a página ou verifique a conexão.</div>"
        : status === "ready"
        ? "<div class='engine-hint'>Engine pronta. Importe uma partida para analisar.</div>"
        : "<div class='engine-hint'>Baixando o Stockfish (~10&nbsp;MB, só na primeira vez). Fica em cache depois.</div>";
  }
}

// Pool de engines pra análise da partida (separado da engine ao vivo pra não
// competirem). Criado sob demanda na primeira análise e reutilizado depois.
async function getEnginePool() {
  if (state.enginePool) {
    await state.enginePool.ready();
    return state.enginePool;
  }
  // 1 worker por núcleo, deixando ~2 livres pra UI/engine ao vivo. Cap em 6 pra
  // limitar memória (cada instância tem sua própria Hash table).
  const hc = navigator.hardwareConcurrency || 4;
  const size = Math.min(6, Math.max(2, hc - 2));
  console.log(`[pool] criando ${size} engines (hardwareConcurrency=${hc})`);
  state.enginePool = new EnginePool(size, { hashMb: 16 });
  await state.enginePool.ready();
  return state.enginePool;
}

function startLiveAnalysis(fen) {
  if (!state.engineReady) return;
  if (state.streaming) return; // não interrompe análise da partida

  // Cancela a análise ao vivo anterior pra engine começar JÁ na nova posição.
  // Sem isso, a análise nova fica na fila atrás da antiga, que continua emitindo
  // info da posição ANTIGA — e o painel acaba tentando mostrar a PV antiga em
  // cima do tabuleiro novo (a sequência de lances "some", só o eval aparece).
  try { state.engine.cancelAll(); } catch {}

  const token = ++state.liveToken;
  state.liveFen = fen;
  state.liveInfo = {};
  renderLivePanel(); // limpa
  const depth = state.engineDepth;
  state.engine.analyze(
    fen,
    {
      multipv: state.engineMultiPV,
      depth: depth > 0 ? depth : undefined,
    },
    (info, all) => {
      if (token !== state.liveToken) return; // callback de análise obsoleta
      state.liveInfo = { ...all };
      // Throttle render — atualiza no máximo 10x/s.
      if (!state._liveRenderPending) {
        state._liveRenderPending = true;
        setTimeout(() => {
          state._liveRenderPending = false;
          renderLivePanel();
        }, 100);
      }
    },
    (final) => {
      if (token !== state.liveToken) return;
      state.liveInfo = { ...final };
      renderLivePanel();
    }
  );
}

function renderLivePanel() {
  const linesEl = document.getElementById("engine-lines");
  const depthEl = document.getElementById("engine-depth");
  const npsEl = document.getElementById("engine-nps");
  const nodesEl = document.getElementById("engine-nodes");

  const keys = Object.keys(state.liveInfo).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  if (keys.length === 0) {
    linesEl.innerHTML = "<div style='color:var(--text-muted);font-size:0.85rem;'>aguardando…</div>";
    depthEl.textContent = "depth —";
    npsEl.textContent = "— knps";
    nodesEl.textContent = "— nodes";
    return;
  }
  // Meta vem da linha principal.
  const main = state.liveInfo[keys[0]];
  depthEl.textContent = `depth ${main.depth || "—"}`;
  npsEl.textContent = main.nps ? `${(main.nps/1000).toFixed(0)} knps` : "— knps";
  nodesEl.textContent = main.nodes ? `${(main.nodes/1000).toFixed(0)}k nodes` : "— nodes";

  // Render linhas.
  // Eval é do ponto de vista do lado de quem joga; ajusta pra brancas.
  // Usa a FEN que a engine REALMENTE analisou (liveFen) — assim a PV sempre
  // bate com as avaliações mostradas, mesmo se o tabuleiro já mudou.
  const fen = state.liveFen || currentFen();
  const sideToMove = fen.split(" ")[1]; // "w" ou "b"
  linesEl.innerHTML = keys.map(k => {
    const info = state.liveInfo[k];
    if (!info?.score) return "";
    const fromWhite = sideToMove === "w" ? info.score.value : -info.score.value;
    let evalText, evalCls = "";
    if (info.score.type === "mate") {
      const mateForWhite = sideToMove === "w" ? info.score.value : -info.score.value;
      evalText = (mateForWhite > 0 ? "+M" : "-M") + Math.abs(info.score.value);
      evalCls = "mate";
    } else {
      evalText = (fromWhite >= 0 ? "+" : "") + (fromWhite/100).toFixed(2);
      evalCls = fromWhite < 0 ? "negative" : "";
    }
    // PV: converte UCI pra SAN visualmente — fazemos com chess.js.
    const sanPv = uciPvToSan(fen, info.pv);
    return `
      <div class="engine-line" data-uci="${info.pv[0] || ""}" title="depth ${info.depth}">
        <span class="eval ${evalCls}">${evalText}</span>
        <span class="pv-text">${escapeHtml(sanPv.join(" "))}</span>
      </div>
    `;
  }).join("");

  // Clique numa linha = aplica o primeiro lance dela (entra em modo exploração).
  linesEl.querySelectorAll(".engine-line").forEach(el => {
    const uci = el.dataset.uci;
    if (!uci) return;
    el.onclick = () => {
      if (!state.exploring) enterExploreMode();
      const from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci.slice(4) || undefined;
      const mv = state.exploreChess.move({ from, to, promotion: promo || "q" });
      if (mv) {
        state.board.setPosition(state.exploreChess.fen(), true);
        renderExploreUI();
        startLiveAnalysis(state.exploreChess.fen());
      }
    };
  });

  // Atualiza seta no tabuleiro com melhor lance da posição atual.
  renderEngineArrow(main);
}

function uciPvToSan(fen, pv) {
  if (!pv || !pv.length) return [];
  try {
    const c = new Chess(fen);
    const sans = [];
    for (const u of pv.slice(0, 8)) {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || "q" });
      if (!m) break;
      sans.push(m.san);
    }
    return sans;
  } catch (e) {
    return pv.slice(0, 8);
  }
}

function renderEngineArrow(info) {
  // Desenha seta turquesa no melhor lance da posição atual sugerido pela engine
  // ao vivo. Só aparece no modo exploração ou na posição inicial, pra não competir
  // com as setas de "melhor lance" da análise da partida.
  if (!state.board) return;
  if (!info?.pv?.length) {
    state.board.clearEngineArrow();
    return;
  }
  if (!state.exploring && state.currentPly !== 0) {
    state.board.clearEngineArrow();
    return;
  }
  const uci = info.pv[0];
  state.board.drawEngineArrow(uci.slice(0, 2), uci.slice(2, 4));
}

// ============================================================
// Buscar partidas
// ============================================================
async function fetchGames(source, username, containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = "<p class='placeholder'>Buscando…</p>";
  try {
    const r = await fetch(`/api/${source}/${encodeURIComponent(username)}?limit=20`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      container.innerHTML = `<p class='placeholder'>Erro: ${err.detail || r.statusText}</p>`;
      return;
    }
    const data = await r.json();
    if (!data.games?.length) {
      container.innerHTML = "<p class='placeholder'>Nenhuma partida encontrada.</p>";
      return;
    }
    container.innerHTML = "";
    data.games.forEach(g => {
      const el = document.createElement("div");
      el.className = "game-item";
      const date = g.end_time ? new Date(g.end_time).toLocaleString("pt-BR") : "";
      el.innerHTML = `
        <div class="players">
          <span>${escapeHtml(g.white)} ${g.white_rating ? `(${g.white_rating})` : ""}
            <span class="result">${g.result.split("-")[0]}</span>
          </span>
          <span>${escapeHtml(g.black)} ${g.black_rating ? `(${g.black_rating})` : ""}
            <span class="result">${g.result.split("-")[1]}</span>
          </span>
        </div>
        <div class="meta">${g.time_class} · ${date}</div>
      `;
      el.onclick = () => {
        document.getElementById("pgn-input").value = g.pgn;
        document.querySelector(".tab-btn[data-tab='pgn']").click();
        // Passa o username pra auto-detectar o lado do jogador.
        analyzePgnStreaming(g.pgn, username);
      };
      container.appendChild(el);
    });
  } catch (e) {
    container.innerHTML = `<p class='placeholder'>Erro: ${e.message}</p>`;
  }
}

// ============================================================
// Análise da partida (Stockfish WASM no browser)
// ============================================================
async function analyzePgnStreaming(pgn, playerUsername = null) {
  // Toda nova chamada invalida a análise anterior (evita corrida se o usuário
  // clicar em outra partida no meio de uma análise) e cancela trabalho pendente.
  const runId = ++state.analysisRunId;
  state.currentPgn = pgn;
  try { state.enginePool?.cancelAll(); } catch {}
  try { state.engine?.cancelAll(); } catch {}

  // Cache local: se já temos essa análise salva, abre direto.
  const cached = await getHistoryEntry(pgn);
  if (cached) {
    state.analysis = cached.analysis;
    state.partialMoves = cached.analysis.moves.slice();
    state.partialHeaders = cached.analysis.headers;
    state.partialOpening = cached.analysis.opening;
    state.totalPlies = cached.analysis.moves.length;
    // Auto-detecta orientação mesmo do cache (se tiver username)
    autoDetectOrientation(cached.analysis.headers, playerUsername);
    showProgress(false);
    renderAll(true);
    return;
  }

  resetForNewAnalysis();
  showProgress(true, 0, 0);

  // 1. Backend faz o parse do PGN e devolve a lista de lances + FENs + abertura.
  let parsed;
  try {
    const r = await fetch("/api/pgn/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pgn }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert("Erro no parse do PGN: " + (err.detail || r.statusText));
      showProgress(false);
      return;
    }
    parsed = await r.json();
  } catch (e) {
    alert("Erro ao falar com o backend: " + e.message);
    showProgress(false);
    return;
  }

  if (runId !== state.analysisRunId) return; // outra análise começou

  // Render imediato dos headers e da abertura.
  state.partialHeaders = parsed.headers;
  state.partialOpening = parsed.opening;
  state.totalPlies = parsed.moves.length;
  // Auto-detecta orientação do tabuleiro: se o jogador está de pretas,
  // vira o tabuleiro pra ele ver da perspectiva dele.
  autoDetectOrientation(parsed.headers, playerUsername);
  renderOpening(parsed.opening);
  renderPlayerBars();
  showProgress(true, 0, state.totalPlies);

  // 2. Stockfish WASM analisa as posições em paralelo (pool de workers).
  state.streaming = true;
  try {
    // Boot do pool (sob demanda na 1ª vez). A engine ao vivo já tá cancelada.
    let pool;
    try {
      pool = await getEnginePool();
    } catch (e) {
      alert("Falha ao carregar o Stockfish WASM: " + e.message);
      showProgress(false);
      return;
    }
    if (runId !== state.analysisRunId) return;
    pool.cancelAll(); // limpa qualquer batch anterior antes de começar

    // A análise da partida usa depth menor (e roda em paralelo); o painel ao
    // vivo é que usa a profundidade cheia escolhida no seletor.
    // Depth 15: com o SF18 lite-single (bem mais rápido que o SF16) dá pra subir
    // de 14 pra 15 ganhando precisão sem dobrar o tempo (16 fica ~2,2x mais lento
    // e pesa em máquinas de 4 núcleos). Quem quiser mais rápido escolhe 14 no seletor.
    const depthSel = parseInt(document.getElementById("engine-depth-sel").value, 10);
    const depth = depthSel > 0 ? Math.min(depthSel, 15) : 15;
    const result = await ChessReviewAnalysis.analyzeGame(
      parsed,
      pool,
      { depth },
      (moveData, idx, total) => {
        if (runId !== state.analysisRunId) return; // descarta callbacks de análise antiga
        state.partialMoves.push(moveData);
        renderMovesListIncremental(moveData);
        showProgress(true, idx + 1, total);
      },
    );
    if (runId !== state.analysisRunId) return; // resultado obsoleto — descarta
    state.analysis = result;
    state.partialMoves = result.moves;
    showProgress(false);
    renderAll(false);
    // Persiste sem bloquear nem contaminar o caminho de sucesso: se o save
    // falhar, apenas loga (a análise em si já está na tela).
    saveToHistory(pgn, result).catch((err) => console.warn("[history] falha ao salvar:", err));
  } catch (e) {
    console.error(e);
    if (runId === state.analysisRunId) {
      alert("Erro durante análise: " + e.message);
      showProgress(false);
    }
  } finally {
    if (runId === state.analysisRunId) state.streaming = false;
  }
}

function resetForNewAnalysis() {
  state.analysis = null;
  state.partialMoves = [];
  state.partialHeaders = null;
  state.partialOpening = null;
  state.totalPlies = 0;
  state.currentPly = 0;
  // Reseta orientação pra "white" — autoDetectOrientation redefine depois
  // se o jogador for as pretas.
  state.orientation = "white";
  state.board.setOrientation("white", false);
  document.getElementById("moves-container").innerHTML = "";
  document.getElementById("opening-card").style.display = "none";
  document.getElementById("summary-card").style.display = "none";
  document.getElementById("coach-card").style.display = "none";
  document.getElementById("player-top").style.display = "none";
  document.getElementById("player-bottom").style.display = "none";
  if (state.evalChart) { state.evalChart.destroy(); state.evalChart = null; }
  // Esconde o gráfico até a nova análise gerar dados (renderEvalChart revela).
  document.querySelector(".chart-wrapper").style.display = "none";
  goToPly(0);
}

function showProgress(visible, current = 0, total = 0) {
  const bar = document.getElementById("progress-bar");
  const fill = document.getElementById("progress-fill");
  const txt = document.getElementById("progress-text");
  bar.style.display = visible ? "block" : "none";
  if (visible) {
    const pct = total > 0 ? (current / total) * 100 : 0;
    fill.style.width = pct + "%";
    txt.textContent = `${current} / ${total}`;
  }
}

// ============================================================
// Rendering
// ============================================================
function currentMoves() {
  return state.partialMoves;
}

function renderAll(fromCache) {
  renderMovesListFull();
  renderOpening(state.partialOpening || state.analysis?.opening);
  renderPlayerBars();
  renderSummary();
  renderCoach();
  renderEvalChart();
  goToPly(0);
}

/**
 * Auto-detecta de que lado o jogador está (brancas ou pretas) e orienta o
 * tabuleiro pra ele ver a partida da própria perspectiva.
 *
 * Compara `playerUsername` (case-insensitive) com os headers White/Black do PGN.
 * Se o jogador for as pretas, vira o tabuleiro (orientation = "black").
 * Se for as brancas ou se não for possível identificar, mantém "white".
 *
 * Também funciona quando o username aparece como parte do nome (ex.: no
 * chess.com o header White pode ser "GMHikaru (3250)" e o username "gmhikaru").
 */
function autoDetectOrientation(headers, playerUsername) {
  if (!playerUsername || !headers) return;

  const needle = playerUsername.toLowerCase().trim();
  if (!needle) return;

  const white = (headers.White || "").toLowerCase();
  const black = (headers.Black || "").toLowerCase();

  // Verifica se o username bate com o jogador de pretas.
  // Comparação exata primeiro, depois verifica se o nome contém o username
  // (chess.com costuma por rating entre parênteses no header, ex.: "Fulano (1800)").
  const isBlack =
    black === needle ||
    black.includes(needle) ||
    black.startsWith(needle + " ") ||
    black.includes("(" + needle + ")");

  // Só vira se o jogador realmente for as pretas (pra não virar sem necessidade
  // quando o username não bate com ninguém).
  if (isBlack) {
    state.orientation = "black";
    state.board.setOrientation("black", false); // sem animação pra não piscar na carga
    return;
  }

  // Jogador é as brancas — orientação já é "white" por padrão, mas garantimos.
  const isWhite =
    white === needle ||
    white.includes(needle) ||
    white.startsWith(needle + " ") ||
    white.includes("(" + needle + ")");

  if (isWhite) {
    state.orientation = "white";
    state.board.setOrientation("white", false);
  }
  // Se não bateu com ninguém, mantém o padrão (white).
}

// Mostra os nomes dos jogadores em barras acima/abaixo do tabuleiro,
// invertendo conforme a orientação. Estilo chess.com: disquinho da cor +
// nome + ELO (se houver) + chip do resultado se a partida acabou.
function renderPlayerBars() {
  const topEl    = document.getElementById("player-top");
  const bottomEl = document.getElementById("player-bottom");
  const headers  = state.partialHeaders || state.analysis?.headers;
  if (!headers) {
    topEl.style.display = "none";
    bottomEl.style.display = "none";
    return;
  }
  topEl.style.display = "";
  bottomEl.style.display = "";

  const whiteName = headers.White || "Brancas";
  const blackName = headers.Black || "Pretas";
  const whiteElo  = headers.WhiteElo;
  const blackElo  = headers.BlackElo;
  // Result: "1-0" branco ganhou, "0-1" preto ganhou, "1/2-1/2" empate.
  const res = (headers.Result || "*").trim();
  const resultFor = (color) => {
    if (res === "1/2-1/2") return { label: "½", cls: "draw" };
    if (res === "1-0") return color === "white" ? { label: "1", cls: "win" } : { label: "0", cls: "loss" };
    if (res === "0-1") return color === "white" ? { label: "0", cls: "loss" } : { label: "1", cls: "win" };
    return null;
  };

  // Quem fica embaixo depende da orientação. Padrão "white" = brancas embaixo.
  const whiteDown = state.orientation === "white";
  const top    = whiteDown ? { color: "black", name: blackName, elo: blackElo } : { color: "white", name: whiteName, elo: whiteElo };
  const bottom = whiteDown ? { color: "white", name: whiteName, elo: whiteElo } : { color: "black", name: blackName, elo: blackElo };

  const render = (p) => {
    const elo = p.elo ? `<span class="player-elo">(${escapeHtml(String(p.elo))})</span>` : "";
    const r = resultFor(p.color);
    const chip = r ? `<span class="player-result ${r.cls}">${r.label}</span>` : "";
    return `<span class="player-disc ${p.color}"></span>
            <span class="player-name">${escapeHtml(p.name)}</span>
            ${elo}
            ${chip}`;
  };
  topEl.innerHTML    = render(top);
  bottomEl.innerHTML = render(bottom);
}

function renderOpening(opening) {
  if (!opening || !opening.name) return;
  const card = document.getElementById("opening-card");
  card.style.display = "block";
  document.getElementById("opening-info").innerHTML = `
    <div class="eco">${escapeHtml(opening.eco || "")}</div>
    <div class="name">${escapeHtml(opening.name)}</div>
    <div class="book-info">Saiu do livro no lance ${Math.floor((opening.last_book_ply || 0) / 2) + 1}.</div>
  `;
}

function renderMovesListFull() {
  const container = document.getElementById("moves-container");
  container.innerHTML = "";
  const moves = currentMoves();
  for (let i = 0; i < moves.length; i += 2) {
    container.appendChild(buildMovePair(Math.floor(i / 2) + 1, moves[i], moves[i + 1]));
  }
  bindMoveCellClicks(container);
}

function renderMovesListIncremental(move) {
  const container = document.getElementById("moves-container");
  const moves = state.partialMoves;
  const idx = moves.length - 1;
  if (idx % 2 === 0) {
    // novo par (brancas)
    const pair = buildMovePair(Math.floor(idx / 2) + 1, move, null);
    container.appendChild(pair);
  } else {
    // completa par existente (pretas)
    const lastPair = container.lastElementChild;
    if (lastPair) {
      const black = buildMoveCell(move);
      lastPair.replaceChild(black, lastPair.children[2]);
    }
  }
  bindMoveCellClicks(container);
}

function buildMovePair(num, whiteMove, blackMove) {
  const row = document.createElement("div");
  row.className = "move-pair";
  const numEl = document.createElement("span");
  numEl.className = "num";
  numEl.textContent = num + ".";
  row.appendChild(numEl);
  row.appendChild(whiteMove ? buildMoveCell(whiteMove) : document.createElement("span"));
  row.appendChild(blackMove ? buildMoveCell(blackMove) : document.createElement("span"));
  return row;
}

function buildMoveCell(move) {
  const cell = document.createElement("span");
  cell.className = "move-cell";
  cell.dataset.ply = move.ply;
  const sanSpan = document.createElement("span");
  sanSpan.textContent = move.san;
  cell.appendChild(sanSpan);
  const icon = document.createElement("span");
  icon.className = "cls-icon";
  icon.innerHTML = (CLASS_ICONS[move.classification] || (() => ""))(16);
  icon.title = CLASS_LABELS[move.classification] || move.classification;
  cell.appendChild(icon);
  return cell;
}

function bindMoveCellClicks(container) {
  container.querySelectorAll(".move-cell").forEach(cell => {
    const ply = parseInt(cell.dataset.ply, 10);
    if (!isNaN(ply)) cell.onclick = () => goToPly(ply);
  });
}

function renderSummary() {
  const a = state.analysis;
  if (!a) return;
  document.getElementById("summary-card").style.display = "block";
  const h = a.headers || {};
  const whiteName = h.White || "Brancas";
  const blackName = h.Black || "Pretas";
  document.getElementById("players-summary").innerHTML = `
    <div class="player-acc">
      <div class="name">${escapeHtml(whiteName)}</div>
      <div class="acc">${a.accuracy_white}</div>
      <div class="acc-label">acurácia</div>
      <div class="elo">ELO est. ~${a.elo_white}</div>
    </div>
    <div class="player-acc">
      <div class="name">${escapeHtml(blackName)}</div>
      <div class="acc">${a.accuracy_black}</div>
      <div class="acc-label">acurácia</div>
      <div class="elo">ELO est. ~${a.elo_black}</div>
    </div>
  `;
  const cw = a.counts_white || {};
  const cb = a.counts_black || {};
  // Cabeçalho: nome das brancas (coluna da esquerda) e das pretas (direita),
  // alinhado com as colunas de contagem logo abaixo.
  const head = `
    <div class="count-row count-head">
      <span class="count-n w" title="${escapeHtml(whiteName)}">${escapeHtml(whiteName)}</span>
      <span class="count-label"></span>
      <span class="count-n b" title="${escapeHtml(blackName)}">${escapeHtml(blackName)}</span>
    </div>`;
  const rows = CLASS_ORDER
    .filter(c => (cw[c] || 0) + (cb[c] || 0) > 0)
    .map(c => `
      <div class="count-row">
        <span class="count-n w">${cw[c] || 0}</span>
        <span class="count-label">${CLASS_ICONS[c](14)} ${CLASS_LABELS[c]}</span>
        <span class="count-n b">${cb[c] || 0}</span>
      </div>
    `).join("");
  document.getElementById("counts-summary").innerHTML = head + rows;
}

function renderCoach() {
  const a = state.analysis;
  if (!a || !a.coach_summary) return;
  document.getElementById("coach-card").style.display = "block";
  const cs = a.coach_summary;
  document.getElementById("coach-bullets").innerHTML = cs.bullets
    .map(b => `<p>${renderMarkdownInline(b)}</p>`)
    .join("");
  if (cs.critical_moves?.length) {
    document.getElementById("coach-critical-title").textContent = "Pontos críticos";
    document.getElementById("coach-critical").innerHTML = cs.critical_moves.map(m => `
      <div class="critical-item" data-ply="${m.ply}">
        ${CLASS_ICONS[m.classification](16)}
        <span>${m.move_number}${m.color === "white" ? "." : "..."} ${escapeHtml(m.san)}</span>
        <span style="color: var(--text-muted); font-size: 0.8rem; margin-left:auto;">${CLASS_LABELS[m.classification]}</span>
      </div>
    `).join("");
    document.querySelectorAll("#coach-critical .critical-item").forEach(el => {
      el.onclick = () => {
        goToPly(parseInt(el.dataset.ply, 10));
        // Sobe pro tabuleiro pra ver o lance na hora (essencial no mobile, onde
        // os pontos críticos ficam bem abaixo do tabuleiro; inofensivo no PC).
        // Adiado em 2 frames: o goToPly mexe no scroll da lista de lances e isso
        // cancelava o scroll suave se disparado no mesmo tick (some no desktop).
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.querySelector(".board-section")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }));
      };
    });
  }
}

function renderMarkdownInline(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// Classificações com marcador no gráfico (5 mais relevantes, sem ruído).
const CHART_MARKER_COLOR = {
  brilliant:  "#26c2a3",
  great:      "#5c8bb0",
  inaccuracy: "#f4bf3f",
  mistake:    "#ef9234",
  blunder:    "#ca3431",
};

// Mapeamento logístico estilo Lichess: comprime evals altos e expande os baixos.
// Sem isso, 99% da partida (eval entre ±100cp) parece linha reta num eixo ±1000.
// Domínio: cp em centipeões. Imagem: y em [-1, 1].
function evalToY(cp) {
  const pawns = cp / 100;
  return 2 / (1 + Math.exp(-0.4 * pawns)) - 1;
}

// Carrega o Highcharts Stock sob demanda (1ª vez que um gráfico é montado).
// Mantém os ~374KB fora do caminho crítico do primeiro paint — o gráfico de eval
// só aparece depois da análise. Cacheia a Promise pra carregar uma única vez.
let _highchartsPromise = null;
function ensureHighcharts() {
  if (window.Highcharts) return Promise.resolve();
  if (_highchartsPromise) return _highchartsPromise;
  _highchartsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/static/vendor/highstock.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { _highchartsPromise = null; reject(new Error("falha ao carregar Highcharts")); };
    document.head.appendChild(s);
  });
  return _highchartsPromise;
}

async function renderEvalChart() {
  document.querySelector(".chart-wrapper").style.display = "";
  try {
    await ensureHighcharts();
  } catch (e) {
    console.warn(e);
    return;
  }
  if (state.evalChart) { state.evalChart.destroy(); state.evalChart = null; }

  const moves = currentMoves();
  const labels = ["início", ...moves.map(m => `${m.move_number}${m.color === "white" ? "" : "..."}`)];

  // Ponto 0 = posição inicial; depois um ponto por lance.
  // y = valor logístico em [-1,1]; rawCp guarda o cp original p/ tooltip.
  const data = [{ x: 0, y: 0, rawCp: 0, name: "início", ply: 0, marker: { enabled: false } }];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const fromWhite = m.color === "white" ? m.eval_after_cp : -m.eval_after_cp;
    const dotColor = CHART_MARKER_COLOR[m.classification];
    data.push({
      x: i + 1,
      y: evalToY(fromWhite),
      rawCp: fromWhite,
      name: labels[i + 1],
      ply: m.ply,
      classification: m.classification,
      marker: dotColor ? {
        enabled: true,
        radius: 5.5,
        fillColor: dotColor,
        lineColor: "rgba(255,255,255,0.92)",
        lineWidth: 2,
        symbol: "circle",
      } : { enabled: false },
    });
  }

  state.evalChart = Highcharts.stockChart("eval-chart", {
    chart: {
      backgroundColor: "#262421",
      margin: [8, 8, 8, 8],
      spacing: [0, 0, 0, 0],
      animation: { duration: 450 },
      style: { fontFamily: "inherit" },
    },
    title: { text: null },
    credits: { enabled: false },
    legend: { enabled: false },
    accessibility: { enabled: false },

    // Tira tudo que faz cara de gráfico financeiro corporativo.
    navigator: { enabled: false },
    scrollbar: { enabled: false },
    rangeSelector: { enabled: false, inputEnabled: false },

    xAxis: {
      type: "linear",
      ordinal: false,
      categories: labels,
      lineWidth: 0,
      tickWidth: 0,
      gridLineWidth: 0,
      minPadding: 0,
      maxPadding: 0,
      labels: { enabled: false },
      crosshair: {
        color: "rgba(255,255,255,0.18)",
        width: 1,
        dashStyle: "Solid",
        zIndex: 6,
      },
    },

    yAxis: {
      // Eixo no domínio logístico — [-1, 1] cobre toda a faixa de evals.
      min: -1,
      max: 1,
      startOnTick: false,
      endOnTick: false,
      lineWidth: 0,
      tickWidth: 0,
      gridLineWidth: 0,
      title: { text: null },
      labels: { enabled: false },
      opposite: false,
      // Linha do zero — dashed sutil, separa os dois campos.
      plotLines: [
        { value: 0, color: "rgba(180,170,160,0.22)", width: 1, dashStyle: "Dash", zIndex: 1 },
      ],
    },

    tooltip: {
      enabled: true,
      split: false,
      shared: false,
      useHTML: true,
      backgroundColor: "rgba(15,14,12,0.96)",
      borderColor: "rgba(129,182,76,0.35)",
      borderRadius: 8,
      borderWidth: 1,
      padding: 0,
      shadow: { color: "rgba(0,0,0,0.6)", offsetX: 0, offsetY: 4, opacity: 0.45, width: 10 },
      style: { color: "#e8e6e3", fontSize: "11px", pointerEvents: "none" },
      hideDelay: 80,
      formatter() {
        const cp = this.point.options.rawCp || 0;
        const sign = cp >= 0 ? "+" : "";
        const evalStr = `${sign}${(cp / 100).toFixed(2)}`;
        const evalColor = cp > 30 ? "#f0eee9" : cp < -30 ? "#8a8580" : "#c9c6c1";
        const cls = this.point.options.classification;
        const clsLabel = cls && CLASS_LABELS[cls] ? CLASS_LABELS[cls] : "";
        const dotColor = cls && CHART_MARKER_COLOR[cls] ? CHART_MARKER_COLOR[cls] : null;
        const clsTag = clsLabel ? `
          <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:6px">
            ${dotColor ? `<span style="width:8px;height:8px;border-radius:50%;background:${dotColor};display:inline-block;box-shadow:0 0 8px ${dotColor}99"></span>` : ""}
            <span style="color:#c9c6c1;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">${clsLabel}</span>
          </div>` : "";
        return `
          <div style="padding:8px 12px;min-width:120px">
            <div style="color:#7a7570;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px">${this.point.name}</div>
            <div style="font-size:18px;font-weight:700;color:${evalColor};font-variant-numeric:tabular-nums;line-height:1.1">${evalStr}</div>
            ${clsTag}
          </div>
        `;
      },
    },

    plotOptions: {
      series: {
        animation: { duration: 600 },
        states: {
          hover: { lineWidth: 2.5, halo: { size: 0 } },
          inactive: { opacity: 1 },
        },
        cursor: "pointer",
        point: {
          events: {
            click() { goToPly(this.options.ply); },
          },
        },
      },
      areaspline: {
        threshold: 0,
        lineWidth: 1.5,
        // Linha cinza médio — legível tanto sobre o branco quanto sobre o preto.
        color: "#7d7773",
        // Fills sólidos (off-white / near-black) que conversam com o bg #262421
        // sem agredir os olhos como branco puro / preto puro.
        fillColor: "rgba(237,235,231,0.92)",
        negativeFillColor: "rgba(16,14,12,0.92)",
        fillOpacity: 1,
        marker: {
          enabled: false,
          states: {
            hover: { enabled: true, radius: 4.5, lineWidth: 2, lineColor: "rgba(255,255,255,0.9)" },
          },
        },
      },
    },

    series: [{
      type: "areaspline",
      name: "eval",
      data,
      zIndex: 2,
    }],
  });
}

// ============================================================
// Navegação (com overlays, eval bar, PV)
// ============================================================
function goToPly(ply) {
  // Sair de exploração ao navegar pela partida.
  if (state.exploring) {
    state.exploring = false;
    state.exploreChess = null;
    document.getElementById("explore-banner").style.display = "none";
  }
  const moves = currentMoves();
  ply = Math.max(0, Math.min(ply, moves.length));
  state.currentPly = ply;

  // Tabuleiro (cm-chessboard)
  if (ply === 0) {
    state.board.setPosition(state.board.FEN.start, true);
  } else {
    state.board.setPosition(moves[ply - 1].fen_after, true);
  }

  // Info — revela a caixa (fica escondida até existir partida pra mostrar).
  document.getElementById("move-info").style.display = "";
  const infoCls = document.getElementById("move-classification");
  const infoCmt = document.getElementById("move-comment");
  const infoPv  = document.getElementById("move-pv");
  if (ply === 0) {
    infoCls.innerHTML = "Posição inicial";
    infoCls.className = "";
    infoCmt.textContent = "Use ◀/▶ ou clique nos lances para navegar.";
    infoPv.innerHTML = "";
  } else {
    const m = moves[ply - 1];
    const iconHtml = CLASS_ICONS[m.classification] ? CLASS_ICONS[m.classification](22) : "";
    const label = CLASS_LABELS[m.classification] || m.classification;
    infoCls.innerHTML = `${iconHtml} <span class="cls-label ${m.classification}">${m.move_number}${m.color === "white" ? "." : "..."} ${escapeHtml(m.san)} — ${label}</span>`;
    infoCls.className = "";
    infoCmt.textContent = m.comment || "";
    // Linha sugerida pelo engine.
    if (m.best_pv_san?.length && m.classification !== "best" && m.classification !== "book") {
      const pvHtml = m.best_pv_san.map((s, i) => i === 0 ? `<strong>${escapeHtml(s)}</strong>` : escapeHtml(s)).join(" ");
      infoPv.innerHTML = `<span style="color:var(--accent);">Melhor linha:</span> ${pvHtml}`;
    } else {
      infoPv.innerHTML = "";
    }
  }

  // Lista de lances — destacar ativo.
  document.querySelectorAll(".move-cell").forEach(c => c.classList.remove("active"));
  if (ply > 0) {
    const active = document.querySelector(`.move-cell[data-ply="${ply}"]`);
    if (active) {
      active.classList.add("active");
      // Rola APENAS dentro da lista de lances, nunca a página. No mobile a lista
      // não tem scroll próprio (max-height:none), então não rola nada — evita a
      // tela "descer" ao passar os lances. (scrollIntoView mexia na página toda.)
      const list = document.querySelector(".moves-list");
      if (list && list.scrollHeight > list.clientHeight + 1) {
        const lr = list.getBoundingClientRect();
        const ar = active.getBoundingClientRect();
        if (ar.top < lr.top) {
          list.scrollTop -= (lr.top - ar.top) + 8;
        } else if (ar.bottom > lr.bottom) {
          list.scrollTop += (ar.bottom - lr.bottom) + 8;
        }
      }
    }
  }

  updateEvalBar(ply);
  renderBoardOverlays();

  // Dispara análise ao vivo da posição atual (se engine WASM tá pronta E não
  // estamos no meio da análise da partida).
  if (state.engineReady && !state.streaming) {
    startLiveAnalysis(currentFen());
  }
}

function updateEvalBar(ply) {
  const moves = currentMoves();
  let cpFromWhite = 0;
  if (ply > 0) {
    const m = moves[ply - 1];
    cpFromWhite = m.color === "white" ? m.eval_after_cp : -m.eval_after_cp;
  }
  // Cap em ±1000cp pra visualização (10 peões).
  const capped = Math.max(-1000, Math.min(1000, cpFromWhite));
  // Converte para % de altura do "preto" (que vem do topo).
  // 0cp = 50% preto. +1000cp (brancas) = 0% preto. -1000cp = 100% preto.
  const blackHeight = 50 - (capped / 1000) * 50;
  const bar = document.getElementById("eval-bar");
  const black = document.getElementById("eval-bar-black");
  const text = document.getElementById("eval-bar-text");
  black.style.height = blackHeight + "%";
  // Texto sempre do lado de quem tá vantagem (em cima se preto melhor, em baixo se branco).
  if (cpFromWhite >= 0) {
    bar.classList.remove("advantage-black");
    text.textContent = (cpFromWhite / 100).toFixed(1);
  } else {
    bar.classList.add("advantage-black");
    text.textContent = (-cpFromWhite / 100).toFixed(1);
  }
  // Em caso de mate, mostra M.
  if (ply > 0) {
    const m = moves[ply - 1];
    const absEval = Math.abs(m.eval_after_cp);
    if (absEval > 9000) {
      const matein = 10000 - absEval;
      text.textContent = "M" + matein;
    }
  }
}

/* Desenha highlights (casas do último lance) e setas (melhor lance vs jogado). */
/* Aplica visuais do lance atual usando a API do cm-chessboard:
   - highlight nas casas from/to
   - ícone da classificação no destino (via marker-frame colorido)
   - seta verde no melhor lance + seta vermelha no lance jogado (quando ruim) */
function renderBoardOverlays() {
  if (!state.board) return;
  // Limpa tudo (highlights, classification markers, arrows). Engine arrow é redesenhada depois pelo painel ao vivo.
  state.board.clearHighlights();

  const ply = state.currentPly;
  if (ply === 0) return;
  const moves = currentMoves();
  const m = moves[ply - 1];
  if (!m) return;

  state.board.highlightMove(m.from, m.to);
  state.board.markClassification(m.to, m.classification);

  // Xeque: marca a casa do rei do lado a mover em vermelho pulsante.
  if (m.is_check || m.is_checkmate) {
    const ks = findKingSquareInFen(m.fen_after);
    if (ks) state.board.markCheck(ks);
  }

  // Setas em caso de lance ruim.
  const bad = ["blunder", "mistake", "inaccuracy", "miss"];
  if (bad.includes(m.classification) && m.best_move_uci) {
    const bFrom = m.best_move_uci.slice(0, 2);
    const bTo   = m.best_move_uci.slice(2, 4);
    state.board.drawBestArrow(bFrom, bTo);
    state.board.drawPlayedArrow(m.from, m.to);
  }
}

// ============================================================
// Histórico local — IndexedDB (com LRU) + fallback localStorage
// ============================================================
// Antes o histórico inteiro (cada análise com TODAS as PVs) morava numa única
// chave do localStorage (~5MB de cota). Com dezenas de partidas isso estourava
// QuotaExceededError e o save falhava silenciosamente. Agora cada análise vai
// pro IndexedDB (cota de centenas de MB), com política LRU (mantém as
// HISTORY_MAX mais recentes). Browsers sem IDB (ou modo privado) caem num
// fallback localStorage que também descarta as mais antigas ao bater a cota.
const HistoryStore = (() => {
  const DB_NAME = "chess_review";
  const STORE = "history";
  const DB_VERSION = 1;
  let _dbPromise = null;
  let _useIdb = null; // null=indefinido; true/false após a 1ª tentativa

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window) || !window.indexedDB) { reject(new Error("sem IndexedDB")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("saved_at", "saved_at");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  const store = (db, mode) => db.transaction(STORE, mode).objectStore(STORE);
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  // ----- Fallback localStorage -----
  const ls = {
    all() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; } },
    write(list) {
      // Ordena por saved_at desc, corta em HISTORY_MAX e, se ainda estourar a
      // cota, vai descartando os mais antigos (o fim da lista) até caber.
      let arr = list.slice().sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || "")).slice(0, HISTORY_MAX);
      while (arr.length) {
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr)); return; }
        catch { arr = arr.slice(0, arr.length - 1); }
      }
      try { localStorage.removeItem(HISTORY_KEY); } catch {}
    },
  };

  async function withIdb(fn, fallback) {
    if (_useIdb === false) return fallback();
    try {
      const db = await openDB();
      _useIdb = true;
      return await fn(db);
    } catch (e) {
      _useIdb = false;
      console.warn("[history] IndexedDB indisponível; usando localStorage:", e.message);
      return fallback();
    }
  }

  // Migração única: IDB vazio + histórico velho no localStorage => importa e limpa.
  async function migrate(db) {
    if ((await reqP(store(db, "readonly").count())) > 0) return;
    let old = [];
    try { old = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch {}
    if (!old.length) return;
    const os = store(db, "readwrite");
    for (const e of old) os.put(e);
    try { localStorage.removeItem(HISTORY_KEY); } catch {}
  }

  // LRU: mantém só as HISTORY_MAX entradas mais recentes (apaga as mais antigas).
  async function enforceLru(db) {
    const count = await reqP(store(db, "readonly").count());
    let excess = count - HISTORY_MAX;
    if (excess <= 0) return;
    await new Promise((res, rej) => {
      const cur = store(db, "readwrite").index("saved_at").openCursor(); // saved_at asc
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || excess <= 0) { res(); return; }
        c.delete(); excess--; c.continue();
      };
      cur.onerror = () => rej(cur.error);
    });
  }

  return {
    async getAll() {
      return withIdb(async (db) => {
        await migrate(db);
        const list = await reqP(store(db, "readonly").getAll());
        return list.sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || ""));
      }, () => ls.all().sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || "")));
    },
    async get(id) {
      return withIdb(
        async (db) => (await reqP(store(db, "readonly").get(id))) || null,
        () => ls.all().find((e) => e.id === id) || null,
      );
    },
    async put(entry) {
      return withIdb(async (db) => {
        await reqP(store(db, "readwrite").put(entry));
        await enforceLru(db);
      }, () => {
        const list = ls.all().filter((e) => e.id !== entry.id);
        list.push(entry);
        ls.write(list);
      });
    },
    async clear() {
      return withIdb(
        async (db) => { await reqP(store(db, "readwrite").clear()); },
        () => { try { localStorage.removeItem(HISTORY_KEY); } catch {} },
      );
    },
  };
})();

function pgnHash(pgn) {
  // Hash simples FNV-like.
  let h = 2166136261;
  for (let i = 0; i < pgn.length; i++) {
    h ^= pgn.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}

async function getHistoryEntry(pgn) {
  return HistoryStore.get(pgnHash(pgn));
}

async function saveToHistory(pgn, analysis) {
  const id = pgnHash(pgn);
  const h = analysis.headers || {};
  await HistoryStore.put({
    id,
    pgn,
    analysis,
    saved_at: new Date().toISOString(),
    summary: {
      white: h.White || "Brancas",
      black: h.Black || "Pretas",
      result: h.Result || "*",
      date: h.Date || "",
      accuracy_white: analysis.accuracy_white,
      accuracy_black: analysis.accuracy_black,
      opening: analysis.opening?.name || "",
    },
  });
  await renderHistory();
}

async function renderHistory() {
  const list = await HistoryStore.getAll();
  const container = document.getElementById("history-list");
  if (!list.length) {
    container.innerHTML = "<p class='placeholder'>Sem análises salvas.</p>";
    return;
  }
  container.innerHTML = "";
  for (const e of list) {
    const el = document.createElement("div");
    el.className = "game-item";
    el.innerHTML = `
      <div class="players">
        <span>${escapeHtml(e.summary.white)}
          <span class="result">${e.summary.result.split("-")[0]}</span>
        </span>
        <span>${escapeHtml(e.summary.black)}
          <span class="result">${e.summary.result.split("-")[1]}</span>
        </span>
      </div>
      <div class="meta">${escapeHtml(e.summary.opening || "")} · ${e.summary.accuracy_white}/${e.summary.accuracy_black}</div>
    `;
    el.onclick = () => {
      document.getElementById("pgn-input").value = e.pgn;
      document.querySelector(".tab-btn[data-tab='pgn']").click();
      analyzePgnStreaming(e.pgn); // vai pegar do cache via getHistoryEntry
    };
    container.appendChild(el);
  }
}

// ============================================================
// Util
// ============================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Encontra a casa do rei do lado a mover, direto do FEN (evita instanciar chess.js).
function findKingSquareInFen(fen) {
  if (!fen) return null;
  const parts = fen.split(" ");
  const rows = parts[0].split("/");
  const sideToMove = parts[1] || "w";
  const kingChar = sideToMove === "w" ? "K" : "k";
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { f += parseInt(ch, 10); continue; }
      if (ch === kingChar) return String.fromCharCode(97 + f) + (8 - r);
      f++;
    }
  }
  return null;
}
