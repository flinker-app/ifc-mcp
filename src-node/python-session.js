import { normalizePythonOptions } from "./python-environment.js";

export function createPythonSession(open) {
  let sandbox;
  let scope;
  let active;
  let cleanup;

  function discard(reason) {
    if (sandbox) {
      const previous = sandbox;
      sandbox = undefined;
      cleanup = Promise.resolve(previous.close(reason));
    }
    return cleanup;
  }

  return {
    reset() {
      const reason = new Error("Python session reset");
      if (active) {
        active.operation.abort(reason);
        return active.finished;
      }
      return discard(reason);
    },
    async runPythonInWorker(code, files = [], options = {}) {
      if (active) throw new Error("The previous Python call is still running. Wait for it to finish.");
      options.signal?.throwIfAborted();
      const input = { code, files, options: normalizePythonOptions(options) };
      const operation = new AbortController();
      const signal = operation.signal;
      const abort = () => operation.abort(options.signal.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      let finish;
      const finished = new Promise(resolve => { finish = resolve; });
      active = { operation, finished };
      try {
        if (sandbox?.closed || scope !== options.scope) await discard();
        await cleanup;
        signal.throwIfAborted();
        if (!sandbox) {
          sandbox = await open(signal);
          scope = options.scope;
        }
        signal.throwIfAborted();
        const output = await sandbox.run(input, options.onProgress, signal);
        signal.throwIfAborted();
        return output;
      } catch (error) {
        await discard(error);
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", abort);
        operation.abort();
        active = undefined;
        finish();
      }
    },
  };
}
