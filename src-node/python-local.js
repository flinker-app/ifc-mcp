import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPythonSession } from "./python-session.js";
import { startPosixSandbox } from "./python-sandbox-posix.js";

const dist = new URL("../dist/", import.meta.url);
const MAX_REPLY_BYTES = 128 * 1024 * 1024;
const windowsLauncher = process.platform === "win32" ? fileURLToPath(new URL("sandbox/windows.exe", dist)) : null;

export function createLocalPythonRuntime() {
  const session = createPythonSession(openSandbox);
  const approvals = new Set();
  let keepWarmForChat = false;
  function reset() {
    approvals.clear();
    return session.reset();
  }
  return {
    readsLocalFiles: true,
    keepWarmForChat() { keepWarmForChat = true; },
    reset,
    revoke(id) {
      if (id === undefined || approvals.has(id)) return reset();
    },
    runPythonInWorker(code, files = [], options = {}) {
      let scope;
      if (!keepWarmForChat) {
        // Clients with no known chat boundary reuse only for the same inputs.
        scope = files.every(file => file.approval)
          ? JSON.stringify(files.map(({ name, approval }) => JSON.stringify([name, approval])).sort())
          : Symbol();
        approvals.clear();
      }
      for (const file of files) if (file.approval) approvals.add(file.approval);
      return session.runPythonInWorker(code, files, { ...options, scope });
    },
  };
}

export async function runPythonInWorker(code, files, options) {
  const runtime = createLocalPythonRuntime();
  try { return await runtime.runPythonInWorker(code, files, options); }
  finally { await runtime.reset(); }
}

async function openSandbox(signal) {
  const temp = await fs.realpath(os.tmpdir());
  const stage = await fs.mkdtemp(path.join(temp, "ifc-mcp-sandbox-"));
  const id = randomUUID();
  let worker;
  async function close(reason) {
    if (worker) await worker.close(reason);
    if (windowsLauncher && worker) await promisify(execFile)(windowsLauncher, ["clean", id], { windowsHide: true }).catch(() => {});
    await fs.rm(stage, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  }

  try {
    // Wait for both copies before cleaning up on failure.
    const copies = await Promise.allSettled([
      fs.copyFile(new URL("python-worker-node.mjs", dist), path.join(stage, "python-worker-node.mjs")),
      fs.cp(new URL("python/", dist), path.join(stage, "python"), { recursive: true, dereference: true }),
    ]);
    for (const copy of copies) if (copy.status === "rejected") throw copy.reason;
    const sandbox = windowsLauncher ? await startWindowsSandbox(stage, id) : await startPosixSandbox(dist, stage);
    signal.throwIfAborted();
    return {
      get closed() { return worker?.closed ?? false; },
      close,
      async run({ code, files, options }, onProgress, requestSignal) {
        const directory = await fs.mkdtemp(path.join(stage, "inputs-"));
        try {
          const stagedFiles = [];
          for (const { name, localPath, buffer } of files) {
            requestSignal.throwIfAborted();
            const target = path.join(directory, String(stagedFiles.length));
            if (localPath) await fs.copyFile(localPath, target, fs.constants.COPYFILE_FICLONE);
            else await fs.writeFile(target, Buffer.from(buffer));
            stagedFiles.push({ name });
          }
          requestSignal.throwIfAborted();
          worker ??= spawnSandbox(sandbox);
          return await worker.run({ code, files: stagedFiles, options, directory: path.basename(directory) }, onProgress, requestSignal);
        } finally {
          await fs.rm(directory, { recursive: true, force: true, maxRetries: 4 });
        }
      },
    };
  } catch (error) {
    await close(error);
    throw error;
  }
}

async function startWindowsSandbox(stage, id) {
  await fs.access(windowsLauncher);
  await fs.copyFile(process.execPath, path.join(stage, "node.exe"));
  return { launcher: windowsLauncher, args: [stage, id], options: { windowsHide: true } };
}

function spawnSandbox({ launcher, args, options }) {
  const child = spawn(launcher, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false;
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let pending;
  let failure;

  function stop(reason) {
    failure ??= reason;
    if (!closed) child.kill("SIGKILL");
  }

  const stopped = new Promise(resolve => {
    child.on("error", error => { failure ??= error; });
    child.on("close", (code, exitSignal) => {
      closed = true;
      pending?.reject(failure ?? new Error(stderr.trim() || `Python sandbox exited (${exitSignal ?? code}).`));
      resolve();
    });
  });
  child.stdin.on("error", stop);
  child.stderr.setEncoding("utf8").on("data", text => { stderr = (stderr + text).slice(-16_384); });
  child.stdout.setEncoding("utf8").on("data", text => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_REPLY_BYTES) return stop(new Error("Python sandbox result is too large."));
    stdout += text;
    let end;
    while ((end = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, end);
      stdout = stdout.slice(end + 1);
      try {
        if (!pending) throw new Error("Unexpected Python sandbox output.");
        const message = JSON.parse(line);
        if (message.progress) pending.onProgress?.(message.progress);
        else if (message.error) stop(new Error(String(message.error)));
        else pending.resolve(decodeOutput(message.output));
      } catch (error) {
        stop(new Error("Invalid Python sandbox output.", { cause: error }));
      }
    }
  });

  return {
    get closed() { return closed || Boolean(failure); },
    close(reason) { stop(reason); return stopped; },
    async run(input, onProgress, signal) {
      signal.throwIfAborted();
      if (closed || failure) throw failure ?? new Error("Python sandbox is closed.");
      bytes = 0;
      const cancel = () => stop(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const output = await new Promise((resolve, reject) => {
          pending = { resolve, reject, onProgress };
          child.stdin.write(`${JSON.stringify(input)}\n`);
        });
        if (failure) throw failure;
        return output;
      } finally {
        pending = undefined;
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}

function decodeOutput(output) {
  if (!output || !Array.isArray(output.files)) throw new Error("Invalid Python sandbox output.");
  const files = output.files.map(({ path, type, bytes }) => {
    if (typeof path !== "string" || typeof type !== "string" || typeof bytes !== "string") {
      throw new Error("Invalid Python sandbox file.");
    }
    return { path, blob: new Blob([Buffer.from(bytes, "base64")], { type }) };
  });
  return { ...output, files };
}
