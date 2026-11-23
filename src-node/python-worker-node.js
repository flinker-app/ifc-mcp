import { parentPort } from "node:worker_threads";
import { createNodePythonExecutor } from "./python-node-environment.js";

const execute = createNodePythonExecutor();
parentPort.on("message", async ({ id, code, files, options }) => {
  try {
    const onProgress = progress => parentPort.postMessage({ ...progress, id, type: "progress" });
    parentPort.postMessage({ id, output: await execute(code, files, { ...options, onProgress }) });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message || String(error), stdout: error.stdout || "", stderr: error.stderr || "", fatal: Boolean(error.pyodide_fatal_error) } });
  }
});
