import path from "node:path";

import { tokenUrlSafe } from "./utils.js";

const DOWNLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_DOWNLOAD_BYTES = 100 * 1024 * 1024;

const downloads = new Map();

export function addDownload({ name, bytes, type = "application/octet-stream", sdkPath = null }) {
  pruneExpiredDownloads();

  const buffer = Buffer.from(bytes || []);
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Generated file is too large for download: ${buffer.byteLength} bytes. Maximum is ${MAX_DOWNLOAD_BYTES} bytes.`,
    );
  }

  pruneDownloadsForBytes(buffer.byteLength);

  const id = tokenUrlSafe(24);
  const safeName = safeLeaf(name, "download");
  const createdAt = Date.now();
  const expiresAt = createdAt + DOWNLOAD_TTL_MS;
  downloads.set(id, {
    id,
    name: safeName,
    bytes: buffer,
    type: safeContentType(type),
    sdkPath,
    createdAt,
    expiresAt,
  });

  return publicDownload(downloads.get(id));
}

export function getDownload(id) {
  pruneExpiredDownloads();
  const download = downloads.get(String(id || ""));
  if (!download) {
    return null;
  }
  return download;
}

export function resetDownloadsForTests() {
  downloads.clear();
}

function publicDownload(download) {
  return {
    id: download.id,
    name: download.name,
    size_bytes: download.bytes.byteLength,
    type: download.type,
    download_path: `/downloads/${download.id}`,
    expires_at: new Date(download.expiresAt).toISOString(),
    sdk_path: download.sdkPath,
    created_at: new Date(download.createdAt).toISOString(),
  };
}

function pruneExpiredDownloads() {
  const now = Date.now();
  for (const [id, download] of downloads.entries()) {
    if (download.expiresAt <= now) {
      downloads.delete(id);
    }
  }
}

function pruneDownloadsForBytes(newBytes) {
  while (totalDownloadBytes() + newBytes > MAX_TOTAL_DOWNLOAD_BYTES && downloads.size > 0) {
    const oldest = [...downloads.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    downloads.delete(oldest.id);
  }
  if (totalDownloadBytes() + newBytes > MAX_TOTAL_DOWNLOAD_BYTES) {
    throw new Error("Generated download storage is full. Try again after restarting the MCP server.");
  }
}

function totalDownloadBytes() {
  let total = 0;
  for (const download of downloads.values()) {
    total += download.bytes.byteLength;
  }
  return total;
}

function safeLeaf(value, fallback) {
  const name = String(value || fallback || "download").replace(/\\/g, "/").split("/").pop();
  return (name || fallback || "download").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

function safeContentType(value) {
  const contentType = String(value || "application/octet-stream").trim();
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/.test(
    contentType,
  )
    ? contentType
    : "application/octet-stream";
}
