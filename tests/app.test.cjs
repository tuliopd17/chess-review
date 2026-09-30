/* Regressões do app real, carregado em um browser mínimo isolado por teste.
 * A UI não faz boot; apenas os renders são substituídos onde o teste observa
 * o estado da aplicação ou as chamadas da engine, sem simular sua lógica.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_SOURCE = fs.readFileSync(path.join(__dirname, "..", "frontend", "app.js"), "utf8");
const BLACK_FEN_42 = "4k3/8/8/8/8/8/8/4K3 b - - 0 42";
const WHITE_FEN_43 = "8/3k4/8/8/8/8/8/4K3 w - - 1 43";

function loadApp(preferences = null) {
  const elements = new Map();
  const documentListeners = new Map();
  const timers = new Map();
  let timerId = 0;
  function createElement(tagName) {
    const attributes = new Map();
    return {
      tagName: tagName.toUpperCase(), value: "", style: {}, hidden: true,
      dataset: new Proxy({}, { set(target, key, value) { target[key] = String(value); return true; } }),
      children: [], listeners: new Map(),
      get lastElementChild() { return this.children.at(-1) || null; },
      appendChild(child) { this.children.push(child); return child; },
      replaceChild(child, oldChild) {
        const index = this.children.indexOf(oldChild);
        assert.notEqual(index, -1, "replaceChild exige um filho existente");
        this.children[index] = child;
        return oldChild;
      },
      setAttribute(key, value) { attributes.set(key, String(value)); },
      getAttribute(key) { return attributes.get(key) ?? null; },
      removeAttribute(key) { attributes.delete(key); },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      querySelectorAll() { return []; },
      focus() {},
    };
  }
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, createElement("div"));
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    console, AbortController, TextEncoder, TextDecoder,
    document: {
      addEventListener(name, listener) {
        if (!documentListeners.has(name)) documentListeners.set(name, []);
        documentListeners.get(name).push(listener);
      },
      createElement,
      getElementById: element,
      querySelector: element,
      querySelectorAll() { return []; },
      body: { dataset: {} },
    },
    navigator: {},
    localStorage: { getItem() { return preferences; }, setItem() {} },
    // Não agenda boot nem trabalho de UI durante testes de lógica.
    addEventListener() {},
    matchMedia() { return { matches: false, addEventListener() {} }; },
    requestAnimationFrame() {},
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    CLASS_ICONS: {},
    fetch() { throw new Error("Requisição de rede inesperada no teste"); },
  });
  context.window = context;
  vm.runInContext(APP_SOURCE + `\n globalThis.app = {
    state, START_FEN, currentFen, reviewPoolOptions, loadPrefs, moveNumber,
    buildAnnotatedPgn, analyzePgnStreaming, startLiveAnalysis, cancelReview,
    appendMoveToList, initControls
  };`, context, { filename: "frontend/app.js" });
  return { app: context.app, context, elements, element, documentListeners, timers };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("currentFen preserva a posição inicial de PGN SetUp/FEN e a exploração", () => {
  const { app } = loadApp();
  app.state.initialFen = BLACK_FEN_42;
  assert.equal(app.currentFen(), BLACK_FEN_42);
  app.state.partialMoves = [{ fen_after: WHITE_FEN_43 }];
  app.state.currentPly = 1;
  assert.equal(app.currentFen(), WHITE_FEN_43);
  app.state.exploring = true;
  app.state.exploreChess = { fen() { return BLACK_FEN_42; } };
  assert.equal(app.currentFen(), BLACK_FEN_42);
});

test("pool de review protege celular, pouca memória e CPUs com dois núcleos", () => {
  const { app } = loadApp();
  const cases = [
    [{ hardwareConcurrency: 8, deviceMemory: 8 }, true, { size: 2, hashMb: 16 }],
    [{ hardwareConcurrency: 8, deviceMemory: 2 }, false, { size: 1, hashMb: 8 }],
    [{ hardwareConcurrency: 2, deviceMemory: 8 }, false, { size: 1, hashMb: 16 }],
    [{ hardwareConcurrency: 8, deviceMemory: 4 }, false, { size: 2, hashMb: 16 }],
    [{ hardwareConcurrency: 16, deviceMemory: 8 }, false, { size: 4, hashMb: 16 }],
  ];
  for (const [device, mobile, expected] of cases) {
    assert.deepEqual({ ...app.reviewPoolOptions(device, mobile) }, expected);
  }
});

test("preferências nulas ou corrompidas não impedem carregar o app", () => {
  for (const raw of ["null", "[]", '"antigo"', "{"]) {
    const { app, element } = loadApp(raw);
    assert.doesNotThrow(() => app.loadPrefs(), raw);
    assert.equal(element("engine-multipv").value, "3");
    assert.equal(element("engine-depth-sel").value, "22");
    assert.equal(element("review-depth-sel").value, "15");
  }
});

test("preferências rejeitam opções de engine inválidas e preservam profundidade infinita", () => {
  const invalid = loadApp(JSON.stringify({ engineMultiPV: -1, engineDepth: "infinita", reviewDepth: 999 }));
  invalid.app.loadPrefs();
  assert.equal(invalid.app.state.engineMultiPV, 3);
  assert.equal(invalid.app.state.engineDepth, 22);
  assert.equal(invalid.app.state.reviewDepth, 15);

  const valid = loadApp(JSON.stringify({ engineMultiPV: 1, engineDepth: 0, reviewDepth: 12 }));
  valid.app.loadPrefs();
  assert.equal(valid.app.state.engineMultiPV, 1);
  assert.equal(valid.app.state.engineDepth, 0);
  assert.equal(valid.app.state.reviewDepth, 12);
});

test("número do lance usa o fullmove do FEN em partidas iniciadas no lance 42", () => {
  const { app } = loadApp();
  assert.equal(app.moveNumber({ fen_before: BLACK_FEN_42, move_number: 1 }), 42);
  assert.equal(app.moveNumber({ fen_before: WHITE_FEN_43, move_number: 1 }), 43);
  assert.equal(app.moveNumber({ move_number: 7 }), 7);
});

test("PGN exportado mantém 42... no primeiro lance de pretas e o FEN inicial", () => {
  const { app } = loadApp();
  const pgn = app.buildAnnotatedPgn({
    headers: { SetUp: "1", FEN: BLACK_FEN_42, Result: "*" },
    moves: [
      { color: "black", san: "Kd7", move_number: 1, fen_before: BLACK_FEN_42 },
      { color: "white", san: "Kf2", move_number: 1, fen_before: WHITE_FEN_43 },
    ],
  });
  assert.ok(pgn.includes(`[FEN "${BLACK_FEN_42}"]`));
  assert.match(pgn.split("\n\n")[1], /^42\.\.\. Kd7\s+43\. Kf2\s+\*/);
});

test("lista agrupa PGN começando de pretas no lance 42 na coluna e número corretos", () => {
  const { app, context } = loadApp();
  const container = context.document.createElement("div");
  app.appendMoveToList(container, { color: "black", san: "Kd7", ply: 1, classification: "best", fen_before: BLACK_FEN_42 });
  app.appendMoveToList(container, { color: "white", san: "Kf2", ply: 2, classification: "best", fen_before: WHITE_FEN_43 });
  app.appendMoveToList(container, { color: "black", san: "Kc6", ply: 3, classification: "best", fen_before: WHITE_FEN_43.replace(" w ", " b ") });
  assert.equal(container.children.length, 2);
  const [first, second] = container.children;
  assert.equal(first.children[0].textContent, "42.");
  assert.equal(first.children[1].tagName, "SPAN");
  assert.equal(first.children[2].children[0].textContent, "Kd7");
  assert.equal(first.children[2].getAttribute("aria-label"), "42... Kd7, Melhor Lance");
  assert.equal(second.children[0].textContent, "43.");
  assert.equal(second.children[1].children[0].textContent, "Kf2");
  assert.equal(second.children[2].children[0].textContent, "Kc6");
  assert.equal(second.children[1].tagName, "BUTTON");
  assert.equal(second.children[1].type, "button");
});

test("atalhos preservam selects, edição e modificadores; navegação impede scroll padrão", () => {
  const { app, context, documentListeners } = loadApp();
  const visited = [];
  app.state.currentPly = 3;
  app.state.partialMoves = Array(6).fill({});
  app.state.board = { setOrientation() {} };
  context.goToPly = (ply) => visited.push(ply);
  context.renderPlayerBars = () => {};
  app.initControls();
  const onKey = documentListeners.get("keydown").at(-1);
  const event = (options = {}) => ({
    key: "ArrowRight", defaultPrevented: false,
    target: { closest() { return null; } },
    preventDefault() { this.defaultPrevented = true; },
    ...options,
  });
  for (const options of [
    { target: { closest() { return { tagName: "SELECT" }; } } },
    { target: { closest() { return { isContentEditable: true }; } } },
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { defaultPrevented: true },
  ]) onKey(event(options));
  app.state.promoPending = {};
  onKey(event());
  app.state.promoPending = null;
  assert.deepEqual(visited, []);

  for (const [key, ply] of [["ArrowRight", 4], ["ArrowLeft", 2], ["Home", 0], ["End", 6]]) {
    const e = event({ key });
    onKey(e);
    assert.equal(e.defaultPrevented, true, key);
    assert.equal(visited.at(-1), ply, key);
  }
  const ordinary = event({ key: "a" });
  onKey(ordinary);
  assert.equal(ordinary.defaultPrevented, false);
});

function prepareCacheRace() {
  const fixture = loadApp();
  const { app, context } = fixture;
  const firstCache = deferred();
  const secondCache = deferred();
  const livePositions = [];
  app.state.board = {
    FEN: { start: app.START_FEN },
    setOrientation() {}, setPosition() {},
  };
  app.state.engineReady = true;
  app.state.engine = {
    cancelAll() {},
    analyze(fen) { livePositions.push(fen); return Promise.resolve({}); },
  };
  context.getHistoryEntry = (key) => key === "A" ? firstCache.promise : secondCache.promise;
  for (const name of ["renderMultiGamePicker", "autoDetectOrientation", "showProgress", "showMobileBoard", "renderLivePanel", "goToPly"]) {
    context[name] = () => {};
  }
  // Renders normalmente chamam goToPly e iniciam a engine. Mantemos a chamada
  // real da engine e observamos se o cache retirou o bloqueio de streaming.
  context.renderAll = () => app.startLiveAnalysis(app.currentFen());
  const cachedA = { analysis: { headers: { White: "A" }, moves: [{ fen_before: app.START_FEN }] } };
  const cachedB = { analysis: { headers: { White: "B" }, moves: [{ fen_before: BLACK_FEN_42 }] } };
  return { ...fixture, firstCache, secondCache, livePositions, cachedA, cachedB };
}

test("cache atrasado de A não sobrescreve B e cache de B retoma a engine ao vivo", async () => {
  const { app, firstCache, secondCache, livePositions, cachedA, cachedB } = prepareCacheRace();
  const first = app.analyzePgnStreaming("A");
  const firstController = app.state.analysisAbort;
  const second = app.analyzePgnStreaming("B");
  assert.equal(firstController.signal.aborted, true);
  assert.equal(app.state.streaming, true);

  secondCache.resolve(cachedB);
  await second;
  assert.equal(app.state.analysis, cachedB.analysis);
  assert.equal(app.state.currentPgn, "B");
  assert.equal(app.state.streaming, false);
  assert.deepEqual(livePositions, [BLACK_FEN_42]);

  firstCache.resolve(cachedA);
  await first;
  assert.equal(app.state.analysis, cachedB.analysis);
  assert.equal(app.currentFen(), BLACK_FEN_42);
  assert.deepEqual(livePositions, [BLACK_FEN_42]);
});

test("cache obsoleto de A não encerra streaming enquanto B ainda aguarda cache", async () => {
  const { app, firstCache, secondCache, livePositions, cachedA, cachedB } = prepareCacheRace();
  const first = app.analyzePgnStreaming("A");
  const second = app.analyzePgnStreaming("B");
  firstCache.resolve(cachedA);
  await first;
  assert.equal(app.state.streaming, true);
  assert.equal(app.state.analysis, null);
  assert.deepEqual(livePositions, []);
  secondCache.resolve(cachedB);
  await second;
  assert.equal(app.state.analysis, cachedB.analysis);
  assert.equal(app.state.streaming, false);
  assert.deepEqual(livePositions, [BLACK_FEN_42]);
});

test("cancelar review mantém os lances parciais e nunca salva nem reutiliza resultado incompleto", async () => {
  const { app, context } = loadApp();
  const partial = {
    color: "black", san: "Kd7", ply: 1,
    fen_before: BLACK_FEN_42, fen_after: WHITE_FEN_43,
  };
  const parsed = { headers: { FEN: BLACK_FEN_42 }, moves: [partial] };
  const complete = { headers: parsed.headers, moves: [partial] };
  const cache = new Map();
  const saved = [];
  const jobs = [];
  let started = deferred();
  let fetches = 0;
  let cancellations = 0;
  const pool = { cancelAll() { cancellations++; } };
  app.state.enginePool = pool;
  app.state.board = { setOrientation() {} };
  context.getHistoryEntry = async (key) => cache.get(key) || null;
  context.saveToHistory = async (key, analysis) => {
    saved.push(analysis);
    cache.set(key, { analysis });
  };
  context.fetch = async () => { fetches++; return { ok: true, async json() { return parsed; } }; };
  context.getEnginePool = async () => pool;
  context.ChessReviewAnalysis = {
    analyzeGame(_parsed, _pool, options, onMove) {
      const pending = deferred();
      jobs.push({ pending, signal: options.signal });
      onMove(partial, 0, 1);
      started.resolve();
      return pending.promise;
    },
  };
  for (const name of ["renderMultiGamePicker", "autoDetectOrientation", "showMobileBoard", "renderOpening", "renderPlayerBars", "renderMovesListIncremental", "renderAll", "goToPly", "showToast"]) {
    context[name] = () => {};
  }

  const interrupted = app.analyzePgnStreaming("PGN");
  await started.promise;
  assert.equal(app.state.partialMoves.length, 1);
  const beforeCancel = cancellations;
  app.cancelReview();
  assert.equal(jobs[0].signal.aborted, true);
  assert.equal(cancellations, beforeCancel + 1);
  assert.equal(app.state.streaming, false);
  assert.equal(app.state.partialMoves[0], partial);
  // Até um resultado que chega depois do cancelamento deve ser descartado.
  jobs[0].pending.resolve(complete);
  await interrupted;
  assert.equal(app.state.analysis, null);
  assert.deepEqual(saved, []);
  assert.equal(cache.size, 0);

  started = deferred();
  const retried = app.analyzePgnStreaming("PGN");
  await started.promise;
  assert.equal(fetches, 2);
  assert.equal(jobs.length, 2);
  jobs[1].pending.resolve(complete);
  await retried;
  assert.equal(app.state.analysis, complete);
  assert.equal(saved.length, 1);
  // A mesma partida só pode ser reutilizada depois de terminar por completo.
  await app.analyzePgnStreaming("PGN");
  assert.equal(fetches, 2);
  assert.equal(jobs.length, 2);
  assert.equal(app.state.analysis, complete);
  assert.equal(app.state.streaming, false);
});

test("review mantém a profundidade e chave originais durante cache, parse e boot do pool", async () => {
  const { app, context } = loadApp();
  const cacheGate = deferred();
  const parseGate = deferred();
  const poolGate = deferred();
  const fetchStarted = deferred();
  const bootStarted = deferred();
  const cacheKeys = [];
  const saved = [];
  const reviewOptions = [];
  const pool = { cancelAll() {} };
  const parsed = {
    headers: { FEN: BLACK_FEN_42 }, game_index: 2,
    moves: [{ color: "black", fen_before: BLACK_FEN_42, fen_after: WHITE_FEN_43 }],
  };
  const result = { headers: parsed.headers, moves: parsed.moves };
  app.state.board = { setOrientation() {} };
  app.state.reviewDepth = 14;
  context.getHistoryEntry = (key) => { cacheKeys.push(key); return cacheGate.promise; };
  context.fetch = async () => {
    fetchStarted.resolve();
    return { ok: true, json() { return parseGate.promise; } };
  };
  context.getEnginePool = () => { bootStarted.resolve(); return poolGate.promise; };
  context.ChessReviewAnalysis = {
    async analyzeGame(_parsed, _pool, options) { reviewOptions.push(options); return result; },
  };
  context.saveToHistory = async (key, analysis, meta) => { saved.push({ key, analysis, meta }); };
  for (const name of ["renderMultiGamePicker", "autoDetectOrientation", "showMobileBoard", "renderOpening", "renderPlayerBars", "renderAll", "goToPly"]) {
    context[name] = () => {};
  }

  const review = app.analyzePgnStreaming("PGN", null, { gameIndex: 2 });
  app.state.reviewDepth = 12;
  cacheGate.resolve(null);
  await fetchStarted.promise;
  app.state.reviewDepth = 16;
  parseGate.resolve(parsed);
  await bootStarted.promise;
  app.state.reviewDepth = 15;
  poolGate.resolve(pool);
  await review;

  assert.deepEqual(cacheKeys, ["gi2|d14|PGN"]);
  assert.equal(reviewOptions.length, 1);
  assert.equal(reviewOptions[0].depth, 14);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, cacheKeys[0]);
  assert.equal(saved[0].meta.reviewDepth, 14);
  assert.equal(saved[0].meta.gameIndex, 2);
  assert.equal(saved[0].analysis, result);
  assert.equal(app.state.reviewDepth, 15);
});

test("análise ao vivo direta cancela o debounce antigo antes que ele troque a posição", () => {
  const { app, context, timers } = loadApp();
  const positions = [];
  app.state.engineReady = true;
  app.state.engine = {
    cancelAll() {},
    analyze(fen) { positions.push(fen); return Promise.resolve({}); },
  };
  context.renderLivePanel = () => {};
  const previousTimer = context.setTimeout(() => app.startLiveAnalysis(app.START_FEN), 120);
  app.state.liveTimer = previousTimer;
  app.startLiveAnalysis(BLACK_FEN_42);
  for (const callback of [...timers.values()]) callback();
  assert.equal(timers.has(previousTimer), false);
  assert.deepEqual(positions, [BLACK_FEN_42]);
  assert.equal(app.state.liveFen, BLACK_FEN_42);
});
