/* Stockfish (versão browser) rodando via Web Worker.
 *
 * O backend decide qual versão servir (SF16 NNUE single-threaded de preferência,
 * fallback pra SF18 asm.js) e expõe via /api/health.stockfish_wasm_url.
 *
 * API pública:
 *   const eng = new BrowserEngine();
 *   await eng.ready();
 *   await eng.analyzeOnce(fen, { depth: 14, multipv: 2 });
 *   eng.cancelAll();   // limpar fila ao trocar de partida
 *
 * Bug fixes (2026-05):
 *  - Fila serial de análises (eliminou race que travava analyzeOnce).
 *  - Split de linhas coladas em uma só mensagem.
 *  - Timeout duplo (30s + 3s fallback) pra não travar nunca.
 *  - URL dinâmica via /api/health (suporta troca de versão pelo backend).
 *  - Logs prefixados [sf]; window.SF_DEBUG = true ativa rastreio do UCI.
 */

(function () {
  const READY_TIMEOUT_MS = 90000;   // download + boot pode demorar
  const ANALYZE_TIMEOUT_MS = 30000;

  function log(...args) {
    if (window.SF_DEBUG) console.log("[sf]", ...args);
  }
  function warn(...args) {
    console.warn("[sf]", ...args);
  }

  async function resolveEngineUrl() {
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      if (j.stockfish_wasm_url) {
        log("backend reporta engine:", j.stockfish_filename);
        return j.stockfish_wasm_url;
      }
    } catch (e) {
      warn("falha ao consultar /api/health:", e.message);
    }
    return "/sf/stockfish-nnue-16-single.js";
  }

  class BrowserEngine {
    constructor(opts) {
      this._hashMb = (opts && opts.hashMb) || 64;
      this.worker = null;
      this.ready_ = false;
      this._readyPromise = null;
      this._queue = [];
      this._running = false;
      this._currentReqId = 0;
      this._currentHandler = null;
      this._currentDone = null;
      this._currentTimeout = null;
      this._lastInfo = {};
    }

    ready() {
      if (this.ready_) return Promise.resolve();
      if (this._readyPromise) return this._readyPromise;

      this._readyPromise = (async () => {
        const engineUrl = await resolveEngineUrl();
        log("URL do engine resolvida:", engineUrl);

        return new Promise((resolve, reject) => {
          let worker;
          try {
            log("criando Worker em", engineUrl);
            worker = new Worker(engineUrl);
          } catch (e) {
            reject(new Error("falha ao criar Worker: " + e.message));
            return;
          }

          let uciOk = false;
          let readyOk = false;
          const timeout = setTimeout(() => {
            if (!uciOk || !readyOk) {
              try { worker.terminate(); } catch {}
              reject(new Error(
                "timeout aguardando engine inicializar (uci=" + uciOk + ", ready=" + readyOk + "). " +
                "Verifique Network no DevTools."
              ));
            }
          }, READY_TIMEOUT_MS);

          worker.onerror = (e) => {
            clearTimeout(timeout);
            warn("worker.onerror", e);
            reject(new Error("worker.onerror: " + (e.message || (e.filename + ":" + e.lineno) || "?")));
          };
          worker.onmessageerror = (e) => warn("worker.onmessageerror", e);

          const bootHandler = (e) => {
            const raw = e.data;
            const text = typeof raw === "string" ? raw : (raw && raw.data) || "";
            if (!text) return;
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
              if (!line) continue;
              log("<<", line);
              if (!uciOk) {
                if (line.includes("uciok")) {
                  uciOk = true;
                  log("uciok recebido, configurando opções");
                  worker.postMessage(`setoption name Hash value ${this._hashMb}`);
                  worker.postMessage("setoption name MultiPV value 1");
                  worker.postMessage("ucinewgame");
                  worker.postMessage("isready");
                }
              } else if (!readyOk) {
                if (line.includes("readyok")) {
                  readyOk = true;
                  clearTimeout(timeout);
                  this.worker = worker;
                  this.ready_ = true;
                  worker.onmessage = this._mainHandler.bind(this);
                  log("engine pronta");
                  resolve();
                  return;
                }
              }
            }
          };

          worker.onmessage = bootHandler;
          log(">> uci");
          worker.postMessage("uci");
        });
      })();

      return this._readyPromise;
    }

    _mainHandler(e) {
      const raw = e.data;
      const text = typeof raw === "string" ? raw : (raw && raw.data) || "";
      if (!text) return;
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (line) this._onLine(line);
      }
    }

    _onLine(line) {
      if (!line) return;
      if (window.SF_DEBUG && (window.SF_DEBUG_INFO || !line.startsWith("info"))) {
        log("<<", line);
      }
      if (line.startsWith("info ")) {
        const info = this._parseInfo(line);
        if (info && this._currentHandler) {
          this._lastInfo[info.multipv || 1] = info;
          try { this._currentHandler(info, this._lastInfo); } catch (e) { warn(e); }
        }
      } else if (line.startsWith("bestmove")) {
        const handler = this._currentDone;
        const lastInfo = this._lastInfo;
        this._currentDone = null;
        this._currentHandler = null;
        if (this._currentTimeout) {
          clearTimeout(this._currentTimeout);
          this._currentTimeout = null;
        }
        if (handler) {
          try { handler(lastInfo, line); } catch (e) { warn(e); }
        }
      }
    }

    _parseInfo(line) {
      const tokens = line.split(/\s+/);
      const out = { depth: 0, multipv: 1, score: null, pv: [], nodes: 0, nps: 0, time: 0 };
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "depth")        out.depth = parseInt(tokens[++i], 10);
        else if (t === "multipv") out.multipv = parseInt(tokens[++i], 10);
        else if (t === "nodes")   out.nodes = parseInt(tokens[++i], 10);
        else if (t === "nps")     out.nps = parseInt(tokens[++i], 10);
        else if (t === "time")    out.time = parseInt(tokens[++i], 10);
        else if (t === "score") {
          const type = tokens[++i];
          const val = parseInt(tokens[++i], 10);
          out.score = { type, value: val };
        } else if (t === "pv") {
          out.pv = tokens.slice(i + 1);
          break;
        }
      }
      return out.score ? out : null;
    }

    analyze(fen, opts, onInfo, onDone) {
      const job = () => new Promise((resolve) => {
        if (!this.worker) {
          warn("analyze chamada sem worker pronto");
          resolve({});
          return;
        }
        this._lastInfo = {};
        this._currentHandler = onInfo || (() => {});
        this._currentReqId++;
        const reqId = this._currentReqId;

        const finish = (info, line) => {
          if (onDone) { try { onDone(info, line); } catch (e) { warn(e); } }
          resolve(info);
        };
        this._currentDone = finish;

        this._currentTimeout = setTimeout(() => {
          if (this._currentReqId === reqId && this._currentDone === finish) {
            warn("analyze timeout, abortando", { fen, opts });
            try { this.worker.postMessage("stop"); } catch {}
            this._currentTimeout = setTimeout(() => {
              if (this._currentDone === finish) {
                warn("analyze timeout duplo, forçando resolve");
                this._currentDone = null;
                this._currentHandler = null;
                resolve(this._lastInfo);
              }
            }, 3000);
          }
        }, ANALYZE_TIMEOUT_MS);

        const multipv = opts.multipv || 1;
        log(">> setoption MultiPV", multipv);
        this.worker.postMessage(`setoption name MultiPV value ${multipv}`);
        this.worker.postMessage(`position fen ${fen}`);
        if (opts.nodes)         this.worker.postMessage(`go nodes ${opts.nodes}`);
        else if (opts.depth)    this.worker.postMessage(`go depth ${opts.depth}`);
        else if (opts.movetime) this.worker.postMessage(`go movetime ${opts.movetime}`);
        else                    this.worker.postMessage("go infinite");
      });

      return this._enqueue(job);
    }

    _enqueue(job) {
      return new Promise((resolve, reject) => {
        this._queue.push({ job, resolve, reject });
        this._drainQueue();
      });
    }

    async _drainQueue() {
      if (this._running) return;
      this._running = true;
      while (this._queue.length > 0) {
        const { job, resolve, reject } = this._queue.shift();
        try {
          const result = await job();
          resolve(result);
        } catch (e) {
          reject(e);
        }
      }
      this._running = false;
    }

    analyzeOnce(fen, opts) {
      return this.analyze(fen, opts, null, null);
    }

    stop() {
      if (!this.worker) return;
      try {
        log(">> stop");
        this.worker.postMessage("stop");
      } catch {}
    }

    cancelAll() {
      for (const item of this._queue) {
        try { item.resolve({}); } catch {}
      }
      this._queue = [];
      this.stop();
    }

    quit() {
      if (this.worker) {
        try { this.worker.postMessage("quit"); } catch {}
        try { this.worker.terminate(); } catch {}
      }
      this.worker = null;
      this.ready_ = false;
      this._readyPromise = null;
      this._queue = [];
    }
  }

  /* Pool de engines paralelos.
   *
   * Cada BrowserEngine roda em seu próprio Web Worker (thread separada), então
   * N engines analisam N posições simultaneamente — perto de escalar com o número
   * de núcleos, SEM precisar de SharedArrayBuffer/COOP-COEP. Usado pela análise
   * em lote da partida (cada posição é independente).
   */
  class EnginePool {
    constructor(size, engineOpts) {
      this.size = Math.max(1, size | 0);
      this.engineOpts = engineOpts || {};
      this.engines = [];
      this._readyPromise = null;
      this._batchId = 0;
    }

    ready() {
      if (this._readyPromise) return this._readyPromise;
      this._readyPromise = (async () => {
        this.engines = [];
        for (let i = 0; i < this.size; i++) {
          this.engines.push(new BrowserEngine(this.engineOpts));
        }
        await Promise.all(this.engines.map((e) => e.ready()));
      })();
      return this._readyPromise;
    }

    /**
     * Analisa cada FEN de `positions` exatamente uma vez, distribuindo o trabalho
     * entre os workers do pool. `optsFor(index)` devolve { depth, multipv } por
     * posição. `onResult(index, info)` é chamado conforme cada análise termina —
     * FORA DE ORDEM (quem terminar primeiro reporta primeiro).
     */
    async analyzeAll(positions, optsFor, onResult) {
      await this.ready();
      const myBatch = ++this._batchId;
      let next = 0;
      const runOn = async (engine) => {
        while (true) {
          if (myBatch !== this._batchId) return; // cancelado por um novo batch
          const i = next++;
          if (i >= positions.length) return;
          const info = await engine.analyzeOnce(positions[i], optsFor(i));
          if (myBatch !== this._batchId) return;
          onResult(i, info);
        }
      };
      await Promise.all(this.engines.map(runOn));
    }

    cancelAll() {
      this._batchId++; // invalida o batch em andamento (os loops param)
      this.engines.forEach((e) => { try { e.cancelAll(); } catch {} });
    }

    quit() {
      this.engines.forEach((e) => { try { e.quit(); } catch {} });
      this.engines = [];
      this._readyPromise = null;
    }
  }

  window.BrowserEngine = BrowserEngine;
  window.EnginePool = EnginePool;
})();
