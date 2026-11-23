import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePythonOptions } from "./python-environment.js";
import { startPosixSandbox } from "./python-sandbox-posix.js";

const dist = new URL("../dist/", import.meta.url);
const MAX_REPLY_BYTES = 128 * 1024 * 1024;
let active;

export async function runPythonInWorker(code, files = [], options = {}) {
  options.signal?.throwIfAborted();
  if (active) throw new Error("The previous Python call is still running. Wait for it to finish.");
  const windowsLauncher = process.platform === "win32" ? fileURLToPath(new URL("sandbox/windows.exe", dist)) : null;
  const controller = new AbortController();
  active = controller;
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  let stage;
  const id = randomUUID();
  try {
    const temp = await fs.realpath(os.tmpdir());
    stage = await fs.mkdtemp(path.join(temp, "ifc-mcp-sandbox-"));
    await Promise.all([
      fs.copyFile(new URL("python-worker-node.mjs", dist), path.join(stage, "python-worker-node.mjs")),
      fs.cp(new URL("python/", dist), path.join(stage, "python"), { recursive: true, dereference: true }),
    ]);
    const inputs = path.join(stage, "inputs");
    await fs.mkdir(inputs);
    const stagedFiles = [];
    for (const { name, localPath, buffer } of files) {
      controller.signal.throwIfAborted();
      const target = path.join(inputs, String(stagedFiles.length));
      if (localPath) await fs.copyFile(localPath, target, fs.constants.COPYFILE_FICLONE);
      else await fs.writeFile(target, Buffer.from(buffer));
      stagedFiles.push({ name });
    }
    const sandbox = windowsLauncher ? await startWindowsSandbox(windowsLauncher, stage, id) : await startPosixSandbox(dist, stage);
    controller.signal.throwIfAborted();
    const input = JSON.stringify({ code, options: normalizePythonOptions(options), files: stagedFiles });
    return await runSandbox(sandbox, input, controller.signal, options.onProgress);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (stage) {
      if (windowsLauncher) await promisify(execFile)(windowsLauncher, ["clean", id], { windowsHide: true }).catch(() => {});
      await fs.rm(stage, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
    }
    if (active === controller) active = undefined;
  }
}

async function startWindowsSandbox(launcher, stage, id) {
  await fs.access(launcher);
  await fs.copyFile(process.execPath, path.join(stage, "node.exe"));
  return { launcher, args: [stage, id], options: { windowsHide: true } };
}

function runSandbox({ launcher, args, options }, input, signal, onProgress) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(launcher, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    const cancel = () => child.kill("SIGKILL");
    signal.addEventListener("abort", cancel, { once: true });
    child.stdin.on("error", () => {});
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let reply;
    let failure;
    child.stderr.setEncoding("utf8").on("data", text => { stderr = (stderr + text).slice(-16_384); });
    child.stdout.setEncoding("utf8").on("data", text => {
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_REPLY_BYTES) {
        failure = new Error("Python sandbox result is too large.");
        cancel();
        return;
      }
      stdout += text;
      let end;
      while ((end = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, end);
        stdout = stdout.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.progress) onProgress?.(message.progress);
          else if (!reply) reply = message;
        } catch (error) {
          failure = new Error("Invalid Python sandbox output.", { cause: error });
          cancel();
        }
      }
    });
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code || !reply) reject(new Error(stderr.trim() || `Python sandbox exited (${code}).`));
      else if (reply.error) reject(new Error(String(reply.error)));
      else {
        try { resolve(decodeOutput(reply.output)); } catch (error) { reject(error); }
      }
    });
    child.stdin.end(input);
  });
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

export function closePythonRuntime() {
  active?.abort(new Error("Python runtime closed"));
}
