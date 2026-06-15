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
  filePath = null,
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
  const resolvedFile = filePath
    ? resolvePath(filePath, { suffixes: IFC_SUFFIXES, description: "IFC file" })
    : null;

  const timeout = timeoutAfter(timeoutSeconds);
  const started = runSdk({
    code,
    filePath: resolvedFile,
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
      file_path: resolvedFile,
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
        file_path: resolvedFile,
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
      file_path: resolvedFile,
      working_directory: cwd,
      saved_files: [],
      runtime_status: "error",
      runner: "node_copilot_cdn",
      sdk_url: sdkUrl,
      sdk_output: output,
    };
  }
}

async function runSdk({ code, filePath, sdkUrl }) {
  const sdk = await loadSdkModule(sdkUrl);
  const files = [];
  if (filePath) {
    const fileBytes = await fs.readFile(filePath);
    files.push({
      name: path.basename(filePath),
      buffer: fileBytes.buffer.slice(
        fileBytes.byteOffset,
        fileBytes.byteOffset + fileBytes.byteLength,
      ),
      size: fileBytes.byteLength,
      type: "application/octet-stream",
    });
  }

  const python = wrapUserCode(code, filePath ? path.basename(filePath) : null);
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
    size: file.size,
    type: file.type,
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

function wrapUserCode(code, ifcFilename) {
  const ifcFilenameLiteral = ifcFilename == null ? "None" : JSON.stringify(String(ifcFilename));
  return `
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import ifcopenshell
import ifcopenshell.util.element as element_util
import ifcopenshell.validate as ifc_validate

output_dir = Path("/home/pyodide")
_ifc_file_name = ${ifcFilenameLiteral}


def _resolve_ifc_file_path(file_name: str | None) -> str | None:
    if not file_name:
        return None
    candidates = [
        Path(file_name),
        output_dir / file_name,
        Path("/") / file_name,
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return file_name


ifc_file_path = _resolve_ifc_file_path(_ifc_file_name)
model = ifcopenshell.open(ifc_file_path) if ifc_file_path else None
result = None


def resolve_path(path: str, *, must_exist: bool = True, suffixes=None, description: str = "path") -> Path:
    candidate = Path(path).expanduser()
    if suffixes:
        suffix_set = {str(suffix).lower() for suffix in suffixes}
        if candidate.suffix.lower() not in suffix_set:
            expected = ", ".join(sorted(suffix_set))
            raise ValueError(f"{description} must have one of these suffixes: {expected}")
    if must_exist and not candidate.exists():
        raise FileNotFoundError(f"{description} does not exist: {candidate}")
    return candidate


def dump(value: Any) -> None:
    print(json.dumps(_jsonable(value), indent=2, ensure_ascii=False))


def _jsonable(value: Any, depth: int = 0) -> Any:
    if depth > 10:
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "is_a") and callable(value.is_a):
        return _entity_ref(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item, depth + 1) for item in value]
    if hasattr(value, "tolist"):
        try:
            return _jsonable(value.tolist(), depth + 1)
        except Exception:
            pass
    return str(value)


def _entity_ref(entity: Any) -> dict[str, Any]:
    data = {"step_id": entity.id(), "type": entity.is_a()}
    for name in ("GlobalId", "Name", "Description", "ObjectType", "Tag", "PredefinedType"):
        try:
            value = getattr(entity, name)
        except Exception:
            continue
        if value not in (None, ""):
            data[name] = _jsonable(value)
    return data


${code}

__assistant_result__ = {"result": _jsonable(result)}
`.trim();
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
