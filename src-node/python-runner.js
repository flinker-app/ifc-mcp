import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_COPILOT_SDK_URL,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  IFC_SUFFIXES,
} from "./constants.js";
import { resolvePath } from "./paths.js";
import { tokenUrlSafe, trimText } from "./utils.js";
import { createDownloadUrl } from "./viewer.js";

const sdkModuleCache = new Map();

export async function executeIfcPython({
  code,
  files = [],
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  workingDirectory = null,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  sdkUrl = DEFAULT_COPILOT_SDK_URL,
}) {
  if (!String(code || "").trim()) {
    throw new Error("code must not be empty");
  }

  if (timeoutSeconds < 1 || timeoutSeconds > DEFAULT_MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds must be between 1 and ${DEFAULT_MAX_TIMEOUT_SECONDS}`);
  }

  const cwd = resolveWorkingDirectory(workingDirectory);
  const inputFiles = resolveInputFiles(files);

  const timeout = timeoutAfter(timeoutSeconds);
  const started = runSdk({
    code,
    inputFiles,
    sdkUrl,
  });

  try {
    const output = await Promise.race([started, timeout.promise]);
    timeout.cancel();
    const streams = extractStreams(output);
    return {
      ok: output.runtimeStatus !== "error",
      timed_out: false,
      timeout_seconds: timeoutSeconds,
      exit_code: 0,
      result: output.result,
      stdout: trimText(streams.stdout, maxOutputChars),
      stderr: trimText(streams.stderr, maxOutputChars),
      uploaded_files: output.filesUsed || inputFileMetas(inputFiles),
      working_directory: cwd,
      saved_files: output.savedFiles || [],
      runtime_status: output.runtimeStatus || null,
      runner: "node_copilot_cdn",
      sdk_url: sdkUrl,
      sdk_output: output,
      note:
        "Generated Python executed directly in Node through the Flinker Copilot SDK Pyodide runtime.",
    };
  } catch (error) {
    timeout.cancel();
    if (error?.code === "PYTHON_TIMEOUT") {
      return {
        ok: false,
        timed_out: true,
        timeout_seconds: timeoutSeconds,
        exit_code: null,
        result: null,
        stdout: "",
        stderr: "",
        uploaded_files: inputFileMetas(inputFiles),
        working_directory: cwd,
        runner: "node_copilot_cdn",
        sdk_url: sdkUrl,
      };
    }
    const output = serializeError(error);
    const streams = extractStreams(output);
    return {
      ok: false,
      timed_out: false,
      timeout_seconds: timeoutSeconds,
      exit_code: 1,
      result: null,
      stdout: trimText(streams.stdout, maxOutputChars),
      stderr: trimText(streams.stderr, maxOutputChars),
      uploaded_files: inputFileMetas(inputFiles),
      working_directory: cwd,
      saved_files: [],
      runtime_status: "error",
      runner: "node_copilot_cdn",
      sdk_url: sdkUrl,
      sdk_output: output,
    };
  }
}

async function runSdk({ code, inputFiles, sdkUrl }) {
  const sdk = await loadSdkModule(sdkUrl);
  const files = await buildSdkInputFiles(inputFiles);

  const python = code;
  if (typeof sdk.runPythonInWorker === "function") {
    return runWithWorker(sdk, {
      python,
      files,
      requestId: tokenUrlSafe(12),
    });
  }
  if (sdk.copilot && typeof sdk.copilot.runPython === "function") {
    return runWithCopilot(sdk, {
      python,
      files,
      requestId: tokenUrlSafe(12),
    });
  }
  throw new Error("Flinker Copilot SDK does not expose runPythonInWorker or copilot.runPython.");
}

async function runWithWorker(sdk, { python, files, requestId }) {
  const worker = await sdk.runPythonInWorker(python, files, { requestId });
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
  output.savedFiles = await exposeSdkFiles(Array.isArray(worker?.files) ? worker.files : []);
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

async function runWithCopilot(sdk, { python, files, requestId }) {
  const run = await sdk.copilot.runPython({
    python,
    files,
    preserveExistingFiles: false,
    requestId,
  });
  const output = run && typeof run.output === "object" ? run.output : {};
  const uploadedFiles = uploadedFileMetas(files);
  output.file = uploadedFiles[0] || null;
  output.filesUsed = uploadedFiles;
  output.savedFiles = await exposeSdkFiles(Array.isArray(output.files) ? output.files : []);
  output.files = output.savedFiles;
  return output;
}

async function loadSdkModule(sdkUrl) {
  if (!sdkModuleCache.has(sdkUrl)) {
    sdkModuleCache.set(sdkUrl, importSdkModule(sdkUrl));
  }
  return sdkModuleCache.get(sdkUrl);
}

async function importSdkModule(sdkUrl) {
  if (sdkUrl.startsWith("http://") || sdkUrl.startsWith("https://")) {
    const response = await fetch(sdkUrl);
    if (!response.ok) {
      throw new Error(`Could not load Flinker Copilot SDK: ${response.status} ${response.statusText}`);
    }
    const source = await response.text();
    const dataUrl = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
    return import(dataUrl);
  }
  if (path.isAbsolute(sdkUrl)) {
    return import(pathToFileURL(sdkUrl).href);
  }
  return import(sdkUrl);
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
    throw new Error("files must be an array of local IFC/IFCXML/IFCZIP paths");
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

async function buildSdkInputFiles(inputFiles) {
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

async function exposeSdkFiles(files) {
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
      const bytes = await readSdkFileBytes(file);
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

async function readSdkFileBytes(file) {
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

function timeoutAfter(timeoutSeconds) {
  let handle;
  const promise = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const error = new Error(`Timed out after ${timeoutSeconds} seconds`);
      error.code = "PYTHON_TIMEOUT";
      reject(error);
    }, timeoutSeconds * 1000);
  });
  return {
    promise,
    cancel: () => clearTimeout(handle),
  };
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
