/* Exercita o UCI real do wrapper com Workers e relógio controlados. Não baixa
 * WASM: simula boot, respostas atrasadas, crashes e cancelamento determinístico.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "frontend", "engine_wasm.js"), "utf8");
const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function runtime(options = {}) {
  const workers = [];
  const timers = new Map();
  let now = 0, timerId = 0;
  class Worker {
    constructor(url) {
      if (options.createError && options.createError()) throw new Error("download falhou");
      this.url = url;
      this.commands = [];
      this.terminated = false;
      workers.push(this);
    }
    emit(text) { if (this.onmessage) this.onmessage({ data: text }); }
    postMessage(command) {
      if (this.terminated) throw new Error("worker encerrado");
      this.commands.push(command);
      if (options.boot !== false) {
        if (command === "uci") queueMicrotask(() => this.emit("id name Stockfish\nuciok"));
        if (command === "isready") queueMicrotask(() => this.emit("readyok"));
      }
      if (options.onCommand) options.onCommand(this, command, workers.length);
    }
    terminate() { this.terminated = true; }
  }
  const window = { __CR_ENGINE_URL__: "/sf/test.js" };
  vm.runInNewContext(SOURCE, {
    window, Worker,
    console: { log() {}, warn() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    ...window, workers, timers,
    async tick(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

test("engine: boot compartilhado, MultiPV e WDL configurados uma vez", async () => {
  const r = runtime();
  const engine = new r.BrowserEngine({ hashMb: 8 });
  const first = engine.ready();
  assert.equal(engine.ready(), first);
  await first;
  assert.equal(r.workers.length, 1);
  assert.ok(r.workers[0].commands.includes("setoption name Hash value 8"));
  assert.ok(r.workers[0].commands.includes("setoption name UCI_ShowWDL value true"));
  assert.equal(r.timers.size, 0);
  engine.quit();
});

test("engine: falha de boot permite tentar novamente", async () => {
  let fail = true;
  const r = runtime({ createError: () => { const result = fail; fail = false; return result; } });
  const engine = new r.BrowserEngine();
  await assert.rejects(engine.ready(), /falha ao criar Worker/);
  await engine.ready();
  assert.equal(engine.ready_, true);
  engine.quit();
});

test("engine: quit durante boot termina o worker e rejeita o boot pendente", async () => {
  const r = runtime({ boot: false });
  const engine = new r.BrowserEngine();
  const pending = assert.rejects(engine.ready(), /cancelada/);
  await flush();
  engine.quit();
  await pending;
  assert.equal(r.workers[0].terminated, true);
  assert.equal(r.timers.size, 0);
  assert.equal(engine.ready_, false);
});

test("engine: timeout de boot libera recursos e permite novo boot", async () => {
  const r = runtime({ boot: false });
  const engine = new r.BrowserEngine();
  const pending = assert.rejects(engine.ready(), /timeout/);
  await flush();
  await r.tick(90000);
  await pending;
  assert.equal(r.workers[0].terminated, true);
  const retry = engine.ready();
  await flush();
  r.workers[1].emit("uciok\nreadyok");
  await retry;
  engine.quit();
});

test("engine: fila serial separa posições e interpreta linhas UCI concatenadas", async () => {
  const r = runtime();
  const engine = new r.BrowserEngine();
  const first = engine.analyzeOnce(FEN, { depth: 15, multipv: 2 });
  const second = engine.analyzeOnce(FEN, { depth: 18 });
  await flush();
  const worker = r.workers[0];
  assert.equal(worker.commands.filter((command) => command.startsWith("go ")).length, 1);
  worker.emit("info depth 15 multipv 1 score cp 34 wdl 100 850 50 pv e2e4 e7e5\ninfo depth 15 multipv 2 score cp 10 pv d2d4\nbestmove e2e4");
  const result = await first;
  assert.equal(result[1].score.value, 34);
  assert.equal(result[1].wdl.d, 850);
  assert.equal(result[2].pv[0], "d2d4");
  await flush();
  assert.equal(worker.commands.filter((command) => command.startsWith("go ")).length, 2);
  worker.emit("info depth 18 score cp -10 pv e2e4\nbestmove e2e4");
  assert.equal((await second)[1].score.value, -10);
  engine.quit();
  assert.equal(r.timers.size, 0);
});

test("engine: quit resolve análise ativa e fila sem deixar timers pendentes", async () => {
  const r = runtime();
  const engine = new r.BrowserEngine();
  const first = engine.analyzeOnce(FEN, { depth: 15 });
  const second = engine.analyzeOnce(FEN, { depth: 15 });
  await flush();
  engine.quit();
  assert.equal(Object.keys(await first).length, 0);
  assert.equal(Object.keys(await second).length, 0);
  assert.equal(r.workers[0].terminated, true);
  assert.equal(r.timers.size, 0);
});

test("engine: cancelamento suprime callbacks antigos e reusa worker que responde stop", async () => {
  const r = runtime();
  const engine = new r.BrowserEngine();
  let callbacks = 0;
  const first = engine.analyze(FEN, { depth: 15 }, () => callbacks++, () => callbacks++);
  await flush();
  engine.cancelAll();
  const second = engine.analyzeOnce(FEN, { depth: 16 });
  r.workers[0].emit("info depth 15 score cp 500 pv e2e4\nbestmove e2e4");
  assert.equal(Object.keys(await first).length, 0);
  assert.equal(callbacks, 0);
  await flush();
  r.workers[0].emit("info depth 16 score cp 25 pv e2e4\nbestmove e2e4");
  assert.equal((await second)[1].score.value, 25);
  assert.equal(r.workers.length, 1);
  engine.quit();
});

test("engine: cancelamento de worker travado recicla em 3s e ignora resposta tardia", async () => {
  const r = runtime();
  const engine = new r.BrowserEngine();
  const first = engine.analyzeOnce(FEN, { depth: 15 });
  await flush();
  const staleHandler = r.workers[0].onmessage;
  engine.cancelAll();
  const second = engine.analyzeOnce(FEN, { depth: 16 });
  await r.tick(3000);
  assert.equal(Object.keys(await first).length, 0);
  assert.equal(r.workers.length, 2);
  staleHandler({ data: "info depth 15 score cp 999 pv e2e4\nbestmove e2e4" });
  r.workers[1].emit("info depth 16 score cp 25 pv e2e4\nbestmove e2e4");
  assert.equal((await second)[1].score.value, 25);
  engine.quit();
});

test("engine: timeout duplo descarta resultado incompleto e engine ainda buscando", async () => {
  const r = runtime();
  const engine = new r.BrowserEngine();
  const first = engine.analyzeOnce(FEN, { depth: 15 });
  const second = engine.analyzeOnce(FEN, { depth: 16 });
  await flush();
  r.workers[0].emit("info depth 8 score cp 800 pv e2e4");
  await r.tick(33000);
  assert.equal(Object.keys(await first).length, 0);
  assert.equal(r.workers[0].terminated, true);
  r.workers[1].emit("info depth 16 score cp 15 pv e2e4\nbestmove e2e4");
  assert.equal((await second)[1].score.value, 15);
  engine.quit();
});

test("engine: crash resolve imediatamente e próxima posição inicia worker novo", async () => {
  const r = runtime();
  const engine = new r.BrowserEngine();
  const first = engine.analyzeOnce(FEN, { depth: 15 });
  const second = engine.analyzeOnce(FEN, { depth: 16 });
  await flush();
  r.workers[0].onerror({ message: "WASM out of memory" });
  assert.equal(Object.keys(await first).length, 0);
  await flush();
  r.workers[1].emit("info depth 16 score cp 20 pv e2e4\nbestmove e2e4");
  assert.equal((await second)[1].score.value, 20);
  engine.quit();
});

test("engine: análise infinita continua até stop/cancelamento explícito", async () => {
  const r = runtime();
  const engine = new r.BrowserEngine();
  const pending = engine.analyzeOnce(FEN, { multipv: 3 });
  await flush();
  await r.tick(60000);
  assert.ok(r.workers[0].commands.includes("go infinite"));
  assert.equal(r.workers[0].commands.includes("stop"), false);
  engine.quit();
  assert.equal(Object.keys(await pending).length, 0);
  assert.equal(r.timers.size, 0);
});

test("engine: score UCI inválido não contamina avaliações", () => {
  const r = runtime();
  const engine = new r.BrowserEngine();
  assert.equal(engine._parseInfo("info depth 15 score cp NaN pv e2e4"), null);
  assert.equal(engine._parseInfo("info depth 15 score wat 12 pv e2e4"), null);
  assert.equal(engine._parseInfo("info depth 15 score cp 12 multipv 0 pv e2e4"), null);
});

test("pool: boot parcialmente falho termina todos os workers e permite retry", async () => {
  let creations = 0;
  const r = runtime({ createError: () => ++creations === 2 });
  const pool = new r.EnginePool(2);
  await assert.rejects(pool.ready(), /falha ao criar Worker/);
  assert.ok(r.workers.every((worker) => worker.terminated));
  await pool.ready();
  assert.equal(pool.engines.length, 2);
  pool.quit();
  assert.equal(r.timers.size, 0);
});

test("pool: resultado inválido é repetido em worker novo antes de reportar", async () => {
  const r = runtime({ onCommand(worker, command, number) {
    if (!command.startsWith("go ")) return;
    queueMicrotask(() => worker.emit(number === 1 ? "bestmove e2e4"
      : "info depth 15 score cp 35 pv e2e4\nbestmove e2e4"));
  } });
  const pool = new r.EnginePool(1);
  const results = [];
  await pool.analyzeAll([FEN], () => ({ depth: 15 }), (i, info) => results.push(info[1].score.value));
  assert.deepEqual(results, [35]);
  assert.equal(r.workers.length, 2);
  assert.equal(r.workers[0].terminated, true);
  pool.quit();
});

test("pool: esgotar retries falha explicitamente sem reportar eval zero", async () => {
  const r = runtime({ onCommand(worker, command) {
    if (command.startsWith("go ")) queueMicrotask(() => worker.emit("bestmove e2e4"));
  } });
  const pool = new r.EnginePool(1);
  const results = [];
  await assert.rejects(pool.analyzeAll([FEN], () => ({ depth: 15 }), (i, info) => results.push(info)), /3 tentativas/);
  assert.equal(r.workers.length, 3);
  assert.equal(results.length, 0);
  pool.quit();
});

test("pool: cancelar durante boot impede iniciar posições daquele batch", async () => {
  const r = runtime({ boot: false });
  const pool = new r.EnginePool(1);
  const pending = assert.rejects(pool.analyzeAll([FEN], () => ({ depth: 15 }), () => assert.fail("batch cancelado reportou resultado")), { name: "AbortError" });
  await flush();
  pool.cancelAll();
  r.workers[0].emit("uciok\nreadyok");
  await pending;
  assert.equal(r.workers[0].commands.some((command) => command.startsWith("go ")), false);
  pool.quit();
});
