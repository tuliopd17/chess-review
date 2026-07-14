/* Stockfish (versão browser) rodando via Web Worker.
 *
 * O backend decide qual versão servir (SF18 lite-single de preferência, com
 * fallback pra SF16 NNUE e asm.js) e expõe via /api/health.stockfish_wasm_url.
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
    // Caminho rápido: o backend injeta a URL do engine no HTML
    // (window.__CR_ENGINE_URL__), então não precisamos do roundtrip /api/health
    // antes de subir o worker — o download dos ~10MB começa imediatamente.
    if (window.__CR_ENGINE_URL__) {
      log("engine via window.__CR_ENGINE_URL__:", window.__CR_ENGINE_URL__);
      return window.__CR_ENGINE_URL__;
    }
    // Fallback (HTML servido sem injeção, ex.: dev estático): consulta o health.
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
    return "/sf/stockfish-18-lite-single.js";
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
                  // WDL nativo do Stockfish (modelo interno ajustado por eval e
                  // material). Builds sem a opção só imprimem "No such option"
                  // — inofensivo.
                  worker.postMessage("setoption name UCI_ShowWDL value true");
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
      const out = { depth: 0, multipv: 1, score: null, pv: [], nodes: 0, nps: 0, time: 0, wdl: null };
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "depth")        out.depth = parseInt(tokens[++i], 10);
        else if (t === "multipv") out.multipv = parseInt(tokens[++i], 10);
        else if (t === "nodes")   out.nodes = parseInt(tokens[++i], 10);
        else if (t === "nps")     out.nps = parseInt(tokens[++i], 10);
        else if (t === "time")    out.time = parseInt(tokens[++i], 10);
        else if (t === "wdl") {
          // "wdl W D L" em per-mille, POV do lado a mover (UCI_ShowWDL).
          const w = parseInt(tokens[++i], 10);
          const d = parseInt(tokens[++i], 10);
          const l = parseInt(tokens[++i], 10);
          if (isFinite(w) && isFinite(d) && isFinite(l)) out.wdl = { w, d, l };
        }
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
        if (opts.depth)         this.worker.postMessage(`go depth ${opts.depth}`);
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
     *
     * Resiliência: um worker WASM pode travar ou estourar o timeout e devolver um
     * resultado VAZIO (sem score). Sem tratar isso, aquela posição ficaria com
     * eval 0 silenciosamente e contaminaria a classificação. Então validamos cada
     * resultado; se vier inválido, RECICLAMOS o engine daquele slot (novo Worker)
     * e re-enfileiramos a posição, até MAX_ATTEMPTS. Só depois disso desistimos e
     * reportamos o que veio — o pior caso é uma posição neutra, nunca um travamento.
     */
    async analyzeAll(positions, optsFor, onResult) {
      await this.ready();
      const myBatch = ++this._batchId;
      const MAX_ATTEMPTS = 3;
      const attempts = new Array(positions.length).fill(0);
      const retry = [];        // índices a re-tentar (prioridade sobre os novos)
      let next = 0;

      const takeIndex = () => {
        if (retry.length) return retry.pop();
        if (next < positions.length) return next++;
        return -1;
      };
      // Um resultado é utilizável se a linha principal (multipv 1) tem score.
      const isValid = (info) => !!(info && info[1] && info[1].score);

      const runSlot = async (slot) => {
        while (true) {
          if (myBatch !== this._batchId) return; // cancelado por um novo batch
          const i = takeIndex();
          if (i === -1) return;
          attempts[i]++;
          let info = null;
          try {
            info = await this.engines[slot].analyzeOnce(positions[i], optsFor(i));
          } catch (e) {
            info = null;
          }
          if (myBatch !== this._batchId) return;

          if (isValid(info)) {
            onResult(i, info);
            continue;
          }
          if (attempts[i] < MAX_ATTEMPTS) {
            // Engine provavelmente travou: troca por um Worker novo e re-tenta.
            console.warn(`[pool] slot ${slot}: resultado inválido na posição ${i} (tentativa ${attempts[i]}); reciclando engine`);
            retry.push(i);
            try { this.engines[slot].quit(); } catch {}
            const ne = new BrowserEngine(this.engineOpts);
            try { await ne.ready(); } catch (e) { console.warn("[pool] falha ao reiniciar engine:", e); }
            this.engines[slot] = ne;
          } else {
            // Esgotou as tentativas: reporta o que houver (posição neutra) e segue.
            console.warn(`[pool] posição ${i} falhou após ${MAX_ATTEMPTS} tentativas; reportando resultado parcial`);
            onResult(i, info || {});
          }
        }
      };
      await Promise.all(this.engines.map((_, slot) => runSlot(slot)));
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
