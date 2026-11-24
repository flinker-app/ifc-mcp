import { IFCOPENSHELL_BUILD } from "./constants.js";
import { verifyWheel } from "./python-assets.js";
import { abortable } from "./operations.js";
import { createPythonSession } from "./python-session.js";

const sandboxSource = `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<script>
  addEventListener("message", event => {
    if (event.source !== parent || event.ports.length !== 1) return;
    const port = event.ports[0];
    const { scripts, ...assets } = event.data;
    try {
      const url = URL.createObjectURL(new Blob(scripts, { type: "text/javascript" }));
      const worker = new Worker(url);
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = ({ data }) => port.postMessage(data);
      port1.onmessageerror = () => port.postMessage({ error: "Could not read Python worker output." });
      worker.onerror = event => port.postMessage({ error: event.message || "Python worker failed" });
      worker.onmessageerror = () => port.postMessage({ error: "Could not read Python worker input." });
      port.onmessage = ({ data }) => port1.postMessage(data);
      worker.postMessage(assets, [port2]);
    } catch (error) {
      port.postMessage({ error: error.message || "Could not start the Python worker." });
    }
  }, { once: true });
</script>`;

async function asset(name, format, signal) {
  const response = await fetch(new URL(name, import.meta.url), { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`Could not load Python runtime asset ${name}: ${response.status}`);
  return response[format]();
}

async function loadAssets(signal) {
  const [lock, scripts, wheel, sources] = await Promise.all([
    asset("./python/runtime/pyodide-lock.json", "json", signal),
    Promise.all(["pyodide.asm.js", "pyodide.js"].map(name => asset(`./python/runtime/${name}`, "text", signal))
      .concat(asset("./python-worker-browser.js", "text", signal))),
    asset("./python/ifcopenshell.whl", "blob", signal).then(async blob => {
      await verifyWheel(await blob.arrayBuffer(), { sha256: IFCOPENSHELL_BUILD.packagedSha256 });
      return blob;
    }),
    Promise.all(["display.py", "execution.py", "ifcopenshell_compat.py"].map(async name =>
      [name, await asset(`./python/${name}`, "text", signal)])),
  ]);
  const names = ["pyodide.asm.wasm", "python_stdlib.zip", ...Object.values(lock.packages).map(item => item.file_name)];
  const binaries = await Promise.all(names.map(async name => [name, await asset(`./python/runtime/${name}`, "blob", signal)]));
  return { lock, scripts: scripts.map(script => `${script}\n`), wheel, sources: Object.fromEntries(sources), binaries };
}

function createSandbox(assets) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.srcdoc = sandboxSource;
  const { port1, port2 } = new MessageChannel();
  const lifetime = new AbortController();
  let receive;
  let timer;
  let launched = false;

  function close(reason) {
    if (lifetime.signal.aborted) return;
    lifetime.abort(reason);
    clearTimeout(timer);
    frame.onload = null;
    frame.remove();
    port1.close();
    port2.close();
  }

  port1.onmessage = ({ data }) => {
    clearTimeout(timer);
    if (!data || typeof data !== "object") close(new Error("Invalid Python sandbox message."));
    else if (data.error) close(Object.assign(new Error(data.error), { stderr: data.stderr }));
    else receive?.(data);
  };
  port1.onmessageerror = () => close(new Error("Could not read Python sandbox output."));

  return {
    close,
    get closed() { return lifetime.signal.aborted; },
    run(input, onProgress) {
      lifetime.signal.throwIfAborted();
      return abortable(new Promise(resolve => {
        receive = ({ progress, output }) => {
          if (progress) {
            onProgress?.(progress);
          } else if (output && Array.isArray(output.files)) {
            receive = undefined;
            // Only pass output bytes from Python across the sandbox boundary.
            resolve({ result: output.result, stdout: output.stdout, stderr: output.stderr,
              files: output.files.filter(file => file && typeof file.path === "string" && file.blob instanceof Blob)
                .map(({ path, blob }) => ({ path, blob })) });
          } else {
            close(new Error("Invalid Python sandbox output."));
          }
        };
        if (launched) {
          port1.postMessage(input);
        } else {
          launched = true;
          timer = setTimeout(() => close(new Error("Could not start the browser Python sandbox.")), 15_000);
          frame.onload = () => {
            frame.onload = null;
            try {
              frame.contentWindow.postMessage({ ...assets, input }, "*", [port2]);
            } catch (error) {
              close(error);
            }
          };
          document.body.append(frame);
        }
      }), lifetime.signal);
    },
  };
}

export function createBrowserPythonRuntime() {
  const session = createPythonSession(async signal => {
    globalThis.addEventListener("pagehide", session.reset);
    try {
      const sandbox = createSandbox(await abortable(loadAssets(signal), signal));
      return {
        get closed() { return sandbox.closed; },
        run(input, onProgress, requestSignal) {
          return abortable(sandbox.run(input, onProgress), requestSignal);
        },
        close(reason) {
          globalThis.removeEventListener("pagehide", session.reset);
          sandbox.close(reason);
        },
      };
    } catch (error) {
      globalThis.removeEventListener("pagehide", session.reset);
      throw error;
    }
  });
  return { ...session, acceptsFileBlobs: true };
}
