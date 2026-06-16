import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { tokenUrlSafe } from "./utils.js";

let configuredDesktopViewer = null;

export function configureDesktopViewer(config = null) {
  if (!config) {
    configuredDesktopViewer = null;
    return;
  }

  const exePath = cleanString(config.exePath);
  if (!exePath) {
    throw new Error("Desktop viewer config requires exePath.");
  }
  const clearArg = cleanString(config.clearArg);
  if (!clearArg) {
    throw new Error("Desktop viewer config requires clearArg.");
  }

  configuredDesktopViewer = {
    exePath,
    argsPrefix: normalizeStringArray(config.argsPrefix),
    clearArg,
    spawnEnv: normalizeEnvObject(config.spawnEnv),
  };
}

export function isDesktopViewerMode() {
  return Boolean(configuredDesktopViewer);
}

export async function launchDesktopViewer({
  filePaths = [],
  clearViewer = false,
} = {}) {
  const config = desktopViewerConfig();
  const args = [...config.argsPrefix];
  if (clearViewer) {
    args.push(config.clearArg);
  }
  args.push(...filePaths);

  const child = spawn(config.exePath, args, {
    detached: true,
    env: config.spawnEnv,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  return {
    exe_path: config.exePath,
    args,
    pid: child.pid || null,
    request_path: null,
  };
}

export async function materializeDesktopViewerFile({ filename, path: sourcePath, bytes }) {
  if (!bytes) {
    return sourcePath;
  }

  const root = path.join(os.tmpdir(), "ifc-mcp-desktop-viewer", String(process.pid));
  await fs.mkdir(root, { recursive: true });

  const name = safeLeaf(filename || sourcePath, "workflow-file");
  const target = path.join(root, `${Date.now()}-${tokenUrlSafe(6)}-${name}`);
  await fs.writeFile(target, Buffer.from(bytes));
  return target;
}

export async function openWithDesktopViewer({ view, activeModel }) {
  if (!isDesktopViewerMode()) {
    return null;
  }
  const launch = await launchDesktopViewer();
  return {
    ...desktopViewerResponse(view, {
      addedModel: false,
      activeModel,
      launch,
    }),
    opened_viewer: true,
  };
}

export async function loadFileWithDesktopViewer({ view, model, added }) {
  if (!isDesktopViewerMode()) {
    return null;
  }
  const desktopPath = await materializeDesktopViewerFile(model);
  model.desktopPath = desktopPath;
  const launch = await launchDesktopViewer({
    filePaths: [desktopPath],
  });
  return {
    ...desktopViewerResponse(view, {
      addedModel: added,
      activeModel: model,
      launch,
      desktopFilePaths: [desktopPath],
    }),
    loaded_ifc_file: true,
  };
}

export async function clearWithDesktopViewer({ view }) {
  if (!isDesktopViewerMode()) {
    return null;
  }
  const launch = await launchDesktopViewer({
    clearViewer: true,
  });
  return {
    ...desktopViewerResponse(view, {
      addedModel: false,
      activeModel: null,
      launch,
    }),
    cleared_viewer: true,
  };
}

export async function applyBcfStateWithDesktopViewer({
  view,
  activeModel,
  bcfSource = null,
  bcfBytes = null,
  bcfFilename = "viewpoint.bcfzip",
  bcfTopicGuid = null,
}) {
  if (!isDesktopViewerMode()) {
    return null;
  }
  const desktopModelPaths = await materializeDesktopModelPaths(view);
  const desktopBcfPath = await materializeDesktopViewerFile({
    path: bcfSource?.path || null,
    filename: bcfFilename,
    bytes: bcfBytes,
  });
  const desktopFilePaths = [...desktopModelPaths, desktopBcfPath].filter(Boolean);
  const launch = await launchDesktopViewer({
    filePaths: desktopFilePaths,
  });

  return {
    ...desktopViewerResponse(view, {
      addedModel: false,
      activeModel,
      launch,
      desktopFilePaths,
    }),
    applied_to_open_viewer: true,
    bcf_version: view.bcfVersion,
    bcf_topic_guid: bcfTopicGuid || topicGuid(view),
    applied_bcf_path: bcfSource?.path || null,
    note:
      "The Open IFC Viewer desktop app was launched or updated with this BCF state. Use show IFC file for model display and set BCF view only for BCF viewpoint files.",
  };
}

function desktopViewerConfig() {
  if (!configuredDesktopViewer) {
    throw new Error("Desktop viewer mode is not configured.");
  }

  return configuredDesktopViewer;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string" && item.trim());
}

function normalizeEnvObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop viewer config requires spawnEnv.");
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => typeof entry[1] === "string"),
  );
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeLeaf(value, fallback) {
  const name = String(value || fallback || "workflow-file").replace(/\\/g, "/").split("/").pop();
  return (name || fallback || "workflow-file").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

async function materializeDesktopModelPaths(view) {
  const paths = [];
  for (const model of view.models) {
    if (model.desktopPath) {
      paths.push(model.desktopPath);
      continue;
    }
    if (!model.bytes) {
      paths.push(model.path);
      continue;
    }
    model.desktopPath = await materializeDesktopViewerFile(model);
    paths.push(model.desktopPath);
  }
  return paths;
}

function desktopViewerResponse(view, {
  addedModel,
  activeModel,
  launch,
  desktopFilePaths = [],
}) {
  return {
    url: null,
    desktop_viewer: true,
    desktop_app_exe: launch?.exe_path || null,
    desktop_app_pid: launch?.pid || null,
    desktop_request_path: launch?.request_path || null,
    desktop_file_paths: desktopFilePaths,
    active_model_path: activeModel?.path || null,
    active_model_filename: activeModel?.filename || null,
    model_paths: view.models.map((model) => model.path),
    models: view.models.map(publicDesktopModel),
    model_count: view.models.length,
    added_model: addedModel,
    has_bcf: Boolean(view.bcfPath || view.bcfBytes),
    bcf_version: view.bcfVersion,
    bcf_topic_guid: topicGuid(view),
    viewer_instruction:
      "Open IFC Viewer desktop app was launched or updated. Use show IFC file to add models to this desktop viewer, and set BCF view to apply a BCF viewpoint file.",
    note:
      "The installed Open IFC Viewer desktop app is used for IFC display in this MCP mode.",
  };
}

function publicDesktopModel(model) {
  return {
    id: model.id,
    filename: model.filename,
    path: model.path,
    desktop_path: model.desktopPath || null,
    added_at: model.addedAt,
  };
}

function topicGuid(view) {
  if (!view?.bcfMetadata) {
    return null;
  }
  return String(view.bcfMetadata.topic_guid || view.bcfMetadata.guid || "") || null;
}
