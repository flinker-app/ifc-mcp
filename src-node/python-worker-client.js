import { normalizePythonOptions } from "./python-environment.js";

// The protocol is shared by Web Workers and node:worker_threads. Only the
// factories import platform APIs; the browser entry never imports Node builtins.
export function createPythonWorkerClient(createWorker) {
  let worker;
  let active;
  let sequence = 0;

  function stop(error) {
    const previous = worker;
    worker = undefined;
    if (active) active.finish(error);
    previous?.terminate();
  }

  return {
    async runPythonInWorker(code, files = [], options = {}) {
      const { signal, onProgress } = options;
      const normalized = normalizePythonOptions(options);
      signal?.throwIfAborted();
      if (active) throw new Error("The previous Python call is still running. Wait for it to finish.");
      if (!worker) {
        const created = createWorker();
        worker = created;
        const receive = message => {
          if (worker !== created || message.id !== active?.id) return;
          if (message.type === "progress") { active.onProgress?.(message); return; }
          if (message.error?.fatal) stop(Object.assign(new Error(message.error.message), message.error));
          else if (message.error) active.finish(Object.assign(new Error(message.error.message), message.error));
          else active.finish(null, message.output);
        };
        const failure = error => { if (worker === created) stop(error instanceof Error ? error : new Error(error.message || "Python worker failed")); };
        if (typeof created.on === "function") {
          created.on("message", receive);
          created.on("error", failure);
          created.on("exit", code => failure(new Error(`Python worker exited (${code})`)));
        } else {
          created.addEventListener("message", event => receive(event.data));
          created.addEventListener("error", failure);
          created.addEventListener("messageerror", () => failure(new Error("Could not read Python worker output")));
        }
      }
      return new Promise((resolve, reject) => {
        const abort = () => stop(signal.reason ?? new Error("Python execution cancelled"));
        const id = ++sequence;
        active = { id, onProgress, finish(error, output) {
          active = undefined;
          signal?.removeEventListener("abort", abort);
          worker?.unref?.();
          if (error) reject(error); else resolve(output);
        } };
        worker.ref?.();
        signal?.addEventListener("abort", abort, { once: true });
        // Copy inputs: posting must never detach a viewer's buffers.
        try {
          worker.postMessage({ id, code, files, options: normalized });
        } catch (error) {
          stop(error);
        }
      });
    },
    dispose() { stop(new Error("Python runtime closed")); },
  };
}
