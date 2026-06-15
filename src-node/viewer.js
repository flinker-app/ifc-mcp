import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BCF_SUFFIXES, DEFAULT_VIEWER_PORT, DEFAULT_VIEWER_URL, IFC_SUFFIXES } from "./constants.js";
import { createBcfBytes, readBcfTopics, readBcfTopicsFromBytes } from "./bcf.js";
import { addDownload, getDownload, resetDownloadsForTests } from "./downloads.js";
import { resolvePath } from "./paths.js";
import { nowIso, tokenUrlSafe } from "./utils.js";

let activeView = null;
let viewerServer = null;
let viewerPort = null;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const viewerHtmlPath = path.join(moduleDir, "static", "viewer.html");
const VIEWER_TITLE = "IFC MCP Viewer";
const VIEWPOINT_TITLE = "IFC MCP Viewpoint";

export async function openViewer() {
  const view = ensureActiveView();
  view.title = VIEWER_TITLE;
  view.updatedAt = nowIso();
  await ensureViewerServer();

  const response = viewerResponse(view, {
    addedModel: false,
    activeModel: activeModel(view),
  });
  return {
    ...response,
    opened_viewer: true,
  };
}

export async function loadIfcFile({
  filePath,
}) {
  const modelSource = resolveIfcModelSource(filePath);

  const view = ensureActiveView();
  view.title = VIEWER_TITLE;
  const { model, added } = addModelToView(view, modelSource);

  view.activeModelId = model.id;
  view.updatedAt = nowIso();

  await ensureViewerServer();
  const response = viewerResponse(view, {
    addedModel: added,
    activeModel: model,
  });
  return {
    ...response,
    loaded_ifc_file: true,
  };
}

export async function clearViewer() {
  const view = ensureActiveView();
  view.title = VIEWER_TITLE;
  view.models = [];
  view.activeModelId = null;
  view.bcfPath = null;
  view.bcfBytes = null;
  view.bcfFilename = null;
  view.bcfMetadata = null;
  view.bcfVersion += 1;
  view.updatedAt = nowIso();

  await ensureViewerServer();
  return {
    ...viewerResponse(view, {
      addedModel: false,
      activeModel: null,
    }),
    cleared_viewer: true,
  };
}

export async function setViewerBcfState({
  bcfPath = null,
  selectedGlobalIds = null,
  isolatedGlobalIds = null,
  hiddenGlobalIds = null,
  coloredComponents = null,
}) {
  const view = ensureActiveView();
  const targetModel = activeModel(view);
  if (!targetModel) {
    throw new Error("Load an IFC file in the viewer before applying viewer state.");
  }

  const bcfSource = bcfPath ? resolveBcfSource(bcfPath) : null;

  let bcfBytes = null;
  let bcfFilename = null;
  let bcfMetadata = null;
  if (bcfSource) {
    bcfFilename = bcfSource.filename;
    bcfMetadata = bcfSource.bytes
      ? await metadataFromBcfBytes(bcfSource.bytes, bcfSource.path)
      : await metadataFromBcfFile(bcfSource.path);
    bcfBytes = bcfSource.bytes;
  } else {
    const created = await createBcfBytes({
      title: VIEWPOINT_TITLE,
      selectedGlobalIds,
      isolatedGlobalIds,
      hiddenGlobalIds,
      coloredComponents,
      ifcFilename: targetModel.filename,
    });
    bcfBytes = created.bytes;
    bcfMetadata = created.metadata;
    bcfFilename = `ifc-mcp-viewpoint-${view.bcfVersion + 1}.bcfzip`;
  }

  view.bcfPath = bcfSource?.bytes ? null : bcfSource?.path || null;
  view.bcfBytes = bcfBytes;
  view.bcfFilename = bcfFilename;
  view.bcfMetadata = bcfMetadata;
  view.bcfVersion += 1;
  view.updatedAt = nowIso();

  return {
    ...viewerResponse(view, {
      addedModel: false,
      activeModel: targetModel,
    }),
    applied_to_open_viewer: true,
    bcf_version: view.bcfVersion,
    bcf_topic_guid: topicGuid(view),
    applied_bcf_path: bcfSource?.path || null,
    note:
      "The already-open viewer polls the active view and applies this BCF state. Use show IFC file for model display and set BCF view only for BCF viewpoint files.",
  };
}

export async function createDownloadUrl({ name, bytes, type = "application/octet-stream", sdkPath = null }) {
  await ensureViewerServer();
  const download = addDownload({
    name,
    bytes,
    type,
    sdkPath,
  });
  return {
    ...download,
    url: `${viewerUrl()}${download.download_path}`,
  };
}

export async function ensureViewerServer() {
  if (viewerServer) {
    return viewerPort;
  }

  const port = DEFAULT_VIEWER_PORT;
  try {
    viewerPort = await startHttpServer(port);
    return port;
  } catch (error) {
    if (isNpmTest() && isAddressInUse(error)) {
      viewerPort = await startHttpServer(0);
      return viewerPort;
    }
    throw new Error(
      `Could not start IFC viewer at ${DEFAULT_VIEWER_URL}. Close the process using that port and try again. ${error?.message || error}`,
    );
  }
}

export async function viewerCli(args) {
  const parsed = parseViewerArgs(args);
  if (!parsed.filePath) {
    console.error(
      "Usage: ifc-mcp-viewer <file.ifc> [--bcf file.bcfzip]",
    );
    return 2;
  }
  let result = await openViewer();
  result = await loadIfcFile({
    filePath: parsed.filePath,
  });
  if (parsed.bcfPath) {
    result = await setViewerBcfState({
      bcfPath: parsed.bcfPath,
    });
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function startHttpServer(port) {
  const server = http.createServer(handleViewerRequest);
  const actualPort = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
  server.unref();
  viewerServer = server;
  return actualPort;
}

async function handleViewerRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/health") {
      sendJson(response, { ok: true, model_count: activeView?.models.length || 0 });
      return;
    }

    if (url.pathname === "/") {
      sendBytes(response, await fs.readFile(viewerHtmlPath), {
        contentType: "text/html; charset=utf-8",
      });
      return;
    }

    if (url.pathname === "/metadata" || url.pathname === "/state") {
      sendJson(response, viewMetadata(activeView));
      return;
    }

    if (parts.length === 2 && parts[0] === "models") {
      const model = activeView?.models.find((item) => item.id === parts[1]);
      if (!model) {
        sendJson(response, { error: "Unknown model." }, 404);
        return;
      }
      sendBytes(response, model.bytes || await fs.readFile(model.path), {
        contentType: model.type || "application/octet-stream",
        filename: model.filename,
      });
      return;
    }

    if (parts.length === 2 && parts[0] === "downloads") {
      const download = getDownload(parts[1]);
      if (!download) {
        sendJson(response, { error: "Unknown or expired download." }, 404);
        return;
      }
      sendBytes(response, download.bytes, {
        contentType: download.type,
        filename: download.name,
        disposition: "attachment",
      });
      return;
    }

    if (url.pathname === "/bcf") {
      if (!activeView) {
        sendJson(response, { error: "No active view." }, 404);
        return;
      }
      if (activeView.bcfPath) {
        sendBytes(response, await fs.readFile(activeView.bcfPath), {
          contentType: "application/octet-stream",
          filename: activeView.bcfFilename,
        });
        return;
      }
      if (activeView.bcfBytes) {
        sendBytes(response, activeView.bcfBytes, {
          contentType: "application/octet-stream",
          filename: activeView.bcfFilename || "viewpoint.bcfzip",
        });
        return;
      }
      sendJson(response, { error: "The active view has no BCF file." }, 404);
      return;
    }

    sendJson(response, { error: "Not found." }, 404);
  } catch (error) {
    sendJson(response, { error: error?.message || String(error) }, 500);
  }
}

function ensureActiveView() {
  if (!activeView) {
    activeView = {
      id: tokenUrlSafe(8),
      models: [],
      activeModelId: null,
      bcfPath: null,
      bcfBytes: null,
      bcfFilename: null,
      bcfMetadata: null,
      bcfVersion: 0,
      title: VIEWER_TITLE,
      updatedAt: nowIso(),
    };
  }
  return activeView;
}

function resolveIfcModelSource(filePath) {
  const downloadSource = resolveGeneratedIfcDownload(filePath);
  if (downloadSource) {
    return downloadSource;
  }

  const modelPath = resolvePath(filePath, {
    suffixes: IFC_SUFFIXES,
    description: "IFC file",
  });

  return {
    source: "file",
    path: modelPath,
    filename: path.basename(modelPath),
    bytes: null,
    type: "application/octet-stream",
  };
}

function resolveBcfSource(bcfPath) {
  const downloadSource = resolveGeneratedDownload(bcfPath, {
    suffixes: BCF_SUFFIXES,
    description: "BCF file",
  });
  if (downloadSource) {
    return downloadSource;
  }

  const resolvedPath = resolvePath(bcfPath, {
    suffixes: BCF_SUFFIXES,
    description: "BCF file",
  });
  return {
    source: "file",
    path: resolvedPath,
    filename: path.basename(resolvedPath),
    bytes: null,
    type: "application/octet-stream",
  };
}

function resolveGeneratedIfcDownload(filePath) {
  return resolveGeneratedDownload(filePath, {
    suffixes: IFC_SUFFIXES,
    description: "IFC file",
  });
}

function resolveGeneratedDownload(filePath, { suffixes, description }) {
  const value = String(filePath || "").trim();
  let url = null;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "downloads") {
    throw new Error(`${description} input only supports local paths or generated IFC MCP download URLs.`);
  }
  if (!isCurrentViewerUrl(url)) {
    throw new Error(`${description} input only supports download URLs from this running IFC MCP server.`);
  }

  const download = getDownload(parts[1]);
  if (!download) {
    throw new Error("Generated download is unknown or expired. Run Python again to recreate it.");
  }

  const suffix = path.extname(download.name).toLowerCase();
  if (!suffixes.includes(suffix)) {
    throw new Error(`Generated download is not a supported ${description}: ${download.name}`);
  }

  return {
    source: "download",
    path: `${url.origin}${url.pathname}`,
    filename: download.name,
    bytes: download.bytes,
    type: download.type || "application/octet-stream",
  };
}

function isCurrentViewerUrl(url) {
  const hostOk = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!hostOk) {
    return false;
  }
  const port = Number(url.port || "80");
  return viewerPort ? port === viewerPort : port === DEFAULT_VIEWER_PORT;
}

function addModelToView(view, modelSource) {
  const existing = view.models.find((model) => model.path === modelSource.path);
  if (existing) {
    return { model: existing, added: false };
  }
  const model = {
    id: tokenUrlSafe(8),
    source: modelSource.source,
    path: modelSource.path,
    filename: modelSource.filename,
    bytes: modelSource.bytes,
    type: modelSource.type,
    addedAt: nowIso(),
  };
  view.models.push(model);
  return { model, added: true };
}

function activeModel(view) {
  if (!view) {
    return null;
  }
  return view.models.find((model) => model.id === view.activeModelId) || view.models.at(-1) || null;
}

function viewerResponse(view, { addedModel, activeModel }) {
  const url = viewerUrl();
  return {
    url,
    active_model_path: activeModel?.path || null,
    active_model_filename: activeModel?.filename || null,
    model_paths: view.models.map((model) => model.path),
    models: view.models.map(publicModel),
    model_count: view.models.length,
    added_model: addedModel,
    has_bcf: Boolean(view.bcfPath || view.bcfBytes),
    bcf_version: view.bcfVersion,
    bcf_topic_guid: topicGuid(view),
    viewer_instruction:
      `Open ${url} in a browser or webview available in your MCP client. Use show IFC file to add models to this viewer, and set BCF view to apply a BCF viewpoint file.`,
    note:
      `Open ${url} to view the IFC model. The same local viewer is reused for added models and view-state changes.`,
  };
}

function viewerUrl() {
  if (!viewerPort) {
    throw new Error("Viewer server is not started.");
  }
  return `http://127.0.0.1:${viewerPort}`;
}

function viewMetadata(view) {
  if (!view) {
    return {
      title: "IFC MCP Viewer",
      models: [],
      model_count: 0,
      has_bcf: false,
      bcf_filename: null,
      bcf_metadata: null,
      bcf_version: 0,
      bcf_topic_guid: null,
      updated_at: null,
    };
  }
  return {
    title: view.title,
    models: view.models.map(publicModel),
    model_count: view.models.length,
    active_model_id: view.activeModelId,
    has_bcf: Boolean(view.bcfPath || view.bcfBytes),
    bcf_filename: view.bcfFilename,
    bcf_metadata: view.bcfMetadata,
    bcf_version: view.bcfVersion,
    bcf_topic_guid: topicGuid(view),
    updated_at: view.updatedAt,
  };
}

function publicModel(model) {
  return {
    id: model.id,
    filename: model.filename,
    path: model.path,
    added_at: model.addedAt,
  };
}

async function metadataFromBcfFile(bcfPath) {
  const parsed = await readBcfTopics(bcfPath, { maxTopics: 1 });
  if (!parsed.topics.length) {
    return null;
  }
  const topic = parsed.topics[0];
  return {
    topic_guid: topic.guid,
    title: topic.title,
    viewpoints: topic.viewpoints,
    source_path: bcfPath,
  };
}

async function metadataFromBcfBytes(bytes, sourcePath) {
  const parsed = await readBcfTopicsFromBytes(bytes, {
    bcfPath: sourcePath,
    maxTopics: 1,
  });
  if (!parsed.topics.length) {
    return null;
  }
  const topic = parsed.topics[0];
  return {
    topic_guid: topic.guid,
    title: topic.title,
    viewpoints: topic.viewpoints,
    source_path: sourcePath,
  };
}

function topicGuid(view) {
  if (!view?.bcfMetadata) {
    return null;
  }
  return String(view.bcfMetadata.topic_guid || view.bcfMetadata.guid || "") || null;
}

function sendJson(response, payload, status = 200) {
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  sendBytes(response, data, {
    status,
    contentType: "application/json; charset=utf-8",
  });
}

function sendBytes(response, data, {
  status = 200,
  contentType,
  filename = null,
  disposition = "inline",
}) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(data),
    ...(filename ? { "Content-Disposition": contentDisposition(disposition, filename) } : {}),
    ...(disposition === "attachment" ? { "X-Content-Type-Options": "nosniff" } : {}),
  });
  response.end(data);
}

function contentDisposition(disposition, filename) {
  const safeDisposition = disposition === "attachment" ? "attachment" : "inline";
  const safeName = String(filename || "download").replace(/[\r\n"]/g, "_");
  return `${safeDisposition}; filename="${safeName}"`;
}

function parseViewerArgs(args) {
  const parsed = {
    filePath: null,
    bcfPath: null,
  };
  let current = null;
  for (const arg of args) {
    if (arg === "--bcf") {
      current = "bcfPath";
      continue;
    }
    if (current === "bcfPath") {
      parsed.bcfPath = arg;
      current = null;
    } else if (!parsed.filePath) {
      parsed.filePath = arg;
    }
  }
  return parsed;
}

export function resetViewerForTests() {
  activeView = null;
  resetDownloadsForTests();
}

function isNpmTest() {
  return process.env.npm_lifecycle_event === "test";
}

function isAddressInUse(error) {
  return error?.code === "EADDRINUSE";
}
