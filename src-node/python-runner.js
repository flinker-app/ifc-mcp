import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_MAX_OUTPUT_CHARS,
  IFC_SUFFIXES,
} from "./constants.js";
import { resolvePath } from "./paths.js";
import { tokenUrlSafe, trimText } from "./utils.js";
import { createDownloadUrl } from "./viewer.js";
import * as localPython from "./python-local.js";

const runningRuntimes = new WeakSet();

export async function executeIfcPython({
  code,
  files = [],
  workingDirectory = null,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  runtime = localPython,
  signal,
}) {
  signal?.throwIfAborted();
  if (!String(code || "").trim()) {
    throw new Error("code must not be empty");
  }

  const cwd = resolveWorkingDirectory(workingDirectory);
  const inputFiles = resolveInputFiles(files);

  try {
    const output = await runRuntime({ code, inputFiles, runtime, signal });
    const streams = extractStreams(output);
    return {
      ok: output.runtimeStatus !== "error",
      exit_code: output.runtimeStatus === "error" ? 1 : 0,
      result: output.result,
      stdout: trimText(streams.stdout, maxOutputChars),
      stderr: trimText(streams.stderr, maxOutputChars),
      uploaded_files: output.filesUsed || inputFileMetas(inputFiles),
      working_directory: cwd,
      saved_files: output.savedFiles || [],
      runtime_status: output.runtimeStatus || null,
      runner: "node_pyodide",
      runtime_output: output,
      note:
        "Generated Python executed by the repository's local Pyodide worker runtime.",
    };
  } catch (error) {
    const output = serializeError(error);
    const streams = extractStreams(output);
    return {
      ok: false,
      exit_code: 1,
      result: null,
      stdout: trimText(streams.stdout, maxOutputChars),
      stderr: trimText(streams.stderr, maxOutputChars),
      uploaded_files: inputFileMetas(inputFiles),
      working_directory: cwd,
      saved_files: [],
      runtime_status: "error",
      runner: "node_pyodide",
      runtime_output: output,
    };
  }
}

async function runRuntime({ code, inputFiles, runtime, signal }) {
  const files = await buildRuntimeInputFiles(inputFiles);
  signal?.throwIfAborted();
  if (runningRuntimes.has(runtime)) throw new Error("The previous Python call is still running. Wait for it to finish.");
  runningRuntimes.add(runtime);
  let output;
  try {
    const requestId = tokenUrlSafe(12);
    if (typeof runtime.runPythonInWorker === "function") {
      output = await runtime.runPythonInWorker(code, files, { requestId, signal });
      signal?.throwIfAborted();
      return await formatWorkerOutput(output, files);
    }
    throw new Error("Python runtime does not expose runPythonInWorker.");
  } finally {
    runningRuntimes.delete(runtime);
    for (const file of [...(output?.files ?? []), ...(output?.displayFiles ?? [])]) {
      if (file.url?.startsWith("blob:")) URL.revokeObjectURL(file.url);
    }
  }
}

async function formatWorkerOutput(worker, files) {
  const rawResult = worker?.result;
  const output =
    rawResult && typeof rawResult === "object" && !Array.isArray(rawResult)
      ? { ...rawResult }
      : rawResult == null
        ? {}
        : { value: rawResult };

  if (typeof output.runtimeStatus !== "string") {
    output.runtimeStatus = "completed";
  }
  if (!Object.hasOwn(output, "result") && typeof rawResult !== "undefined") {
    output.result = rawResult;
  }
  const uploadedFiles = uploadedFileMetas(files);
  output.file = uploadedFiles[0] || null;
  output.filesUsed = uploadedFiles;
  output.savedFiles = await exposeRuntimeFiles(Array.isArray(worker?.files) ? worker.files : []);
  output.files = output.savedFiles;

  const outputs = buildOutputs({
    stdout: typeof worker?.stdout === "string" ? worker.stdout : "",
    stderr: typeof worker?.stderr === "string" ? worker.stderr : "",
    result: Object.hasOwn(output, "result") ? output.result : rawResult,
  });
  if (outputs.length > 0) {
    output.outputs = outputs;
  }
  return output;
}

function resolveWorkingDirectory(workingDirectory) {
  if (workingDirectory) {
    const cwd = resolvePath(workingDirectory, { description: "working directory" });
    return assertDirectory(cwd, "working_directory");
  }

  const cwd = fsRealpathOrResolve(process.cwd());
  return assertDirectory(cwd, "working_directory");
}

function assertDirectory(value, description) {
  const stat = fsStatSync(value);
  if (!stat?.isDirectory()) {
    throw new Error(`${description} must be a directory: ${value}`);
  }
  return value;
}

function resolveInputFiles(files) {
  if (files == null) {
    return [];
  }
  if (!Array.isArray(files)) {
    throw new Error("files must be an array of local IFC/IFCZIP paths");
  }

  const usedNames = new Set();
  return files.map((file, index) => {
    if (!file || typeof file !== "string") {
      throw new Error(`files[${index}] must be a non-empty string`);
    }
    const sourcePath = resolvePath(file, {
      suffixes: IFC_SUFFIXES,
      description: `files[${index}]`,
    });
    return {
      path: sourcePath,
      name: uniqueInputFileName(path.basename(sourcePath), usedNames, index + 1),
    };
  });
}

async function buildRuntimeInputFiles(inputFiles) {
  const files = [];
  for (const inputFile of inputFiles) {
    const fileBytes = await fs.readFile(inputFile.path);
    files.push({
      name: inputFile.name,
      buffer: fileBytes.buffer.slice(
        fileBytes.byteOffset,
        fileBytes.byteOffset + fileBytes.byteLength,
      ),
      size: fileBytes.byteLength,
      type: "application/octet-stream",
      sourcePath: inputFile.path,
    });
  }
  return files;
}

function uniqueInputFileName(baseName, usedNames, fallbackIndex) {
  const safeName = safeLeaf(baseName, `input-${fallbackIndex}.ifc`);
  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let name = safeName;
  let attempt = 1;
  while (usedNames.has(name)) {
    name = `${stem}-${attempt}${ext}`;
    attempt += 1;
  }
  usedNames.add(name);
  return name;
}

function extractStreams(output) {
  const streams = { stdout: "", stderr: "" };
  for (const item of output?.outputs || []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.output_type === "stream" && (item.name === "stdout" || item.name === "stderr")) {
      streams[item.name] += String(item.text || "");
    } else if (item.output_type === "error") {
      const traceback = Array.isArray(item.traceback) ? item.traceback.join("\n") : "";
      streams.stderr += traceback || String(item.evalue || item.ename || "Python run failed.");
      if (!streams.stderr.endsWith("\n")) {
        streams.stderr += "\n";
      }
    }
  }
  return streams;
}

function serializeError(error) {
  const message = error?.error || error?.message || String(error);
  return {
    runtimeStatus: "error",
    outputs: buildOutputs({
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : "",
      errorMessage: message,
    }),
  };
}

function buildOutputs({ stdout = "", stderr = "", result = undefined, errorMessage = undefined }) {
  const outputs = [];
  if (stdout) {
    outputs.push({ output_type: "stream", name: "stdout", text: stdout });
  }
  if (stderr) {
    outputs.push({ output_type: "stream", name: "stderr", text: stderr });
  }
  if (errorMessage) {
    outputs.push({
      output_type: "error",
      ename: "RuntimeError",
      evalue: errorMessage,
      traceback: [],
    });
    return outputs;
  }
  if (typeof result !== "undefined") {
    outputs.push({
      output_type: "execute_result",
      execution_count: null,
      data: { "text/plain": toPlainText(result) },
      metadata: {},
    });
  }
  return outputs;
}

function toPlainText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "undefined") {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function exposeRuntimeFiles(files) {
  const savedFiles = [];
  if (!Array.isArray(files) || files.length === 0) {
    return savedFiles;
  }

  const used = new Set();
  for (const file of files) {
    const baseName = safeLeaf(file?.name || file?.path, `output-${savedFiles.length + 1}`);
    let name = baseName;
    let attempt = 1;
    while (used.has(name.toLowerCase())) {
      const ext = path.extname(baseName);
      const stem = ext ? baseName.slice(0, -ext.length) : baseName;
      name = `${stem}-${attempt}${ext}`;
      attempt += 1;
    }
    used.add(name.toLowerCase());

    try {
      const bytes = await readRuntimeFileBytes(file);
      if (!bytes) {
        continue;
      }
      const download = await createDownloadUrl({
        name,
        bytes,
        type: file?.type || file?.blob?.type || "application/octet-stream",
        sdkPath: file?.path || null,
      });
      savedFiles.push({
        name,
        url: download.url,
        size_bytes: download.size_bytes,
        sdk_path: file?.path,
        type: download.type,
        expires_at: download.expires_at,
      });
    } catch (error) {
      savedFiles.push({
        name,
        sdk_path: file?.path,
        error: error?.message || String(error),
      });
    }
  }
  return savedFiles;
}

async function readRuntimeFileBytes(file) {
  if (file?.blob instanceof Blob) {
    return Buffer.from(await file.blob.arrayBuffer());
  }
  if (file?.buffer) {
    return Buffer.from(file.buffer);
  }
  if (typeof file?.url === "string" && file.url.length > 0) {
    const response = await fetch(file.url);
    if (!response.ok) {
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return null;
}

function safeLeaf(value, fallback) {
  const name = String(value || fallback || "output").replace(/\\/g, "/").split("/").pop();
  return (name || fallback || "output").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

function uploadedFileMetas(files) {
  return files.map((file) => ({
    name: file.name,
    path: file.sourcePath || file.path || null,
    size: file.size,
    type: file.type,
  }));
}

function inputFileMetas(files) {
  return files.map((file) => ({
    name: file.name,
    path: file.path,
    type: "application/octet-stream",
  }));
}

function fsRealpathOrResolve(value) {
  try {
    return fsSync.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function fsStatSync(value) {
  try {
    return fsSync.statSync(value);
  } catch {
    return null;
  }
}
