import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { IFC_SUFFIXES } from "./constants.js";
import { tokenUrlSafe } from "./utils.js";

const approved = new Map();
const revocationListeners = new Set();
const sandboxHeadroom = 256n * 1024n * 1024n;
let incomingBytes = 0n;
let storedBytes = 0n;

export async function addApprovedPythonFile(name, readable, sizeBytes, isSessionActive, expiresInMs) {
  if (!name || /[/\\\u0000-\u001f\u007f]/u.test(name) || !IFC_SUFFIXES.includes(path.extname(name).toLowerCase())) {
    throw new Error("Select an IFC or IFCZIP file.");
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new Error("Select a nonempty IFC or IFCZIP file.");

  const size = BigInt(sizeBytes);
  const temp = os.tmpdir();
  const { bavail, bsize } = await fs.statfs(temp, { bigint: true });
  // Leave room for concurrent uploads, a staging copy of the approved inputs,
  // and the sandbox runtime itself.
  if (bavail * bsize < sandboxHeadroom + storedBytes + 2n * (incomingBytes + size)) {
    throw new Error("Not enough temporary disk space for this IFC and its sandbox copy.");
  }
  if (!isSessionActive()) throw new Error("The file approval session ended.");
  incomingBytes += size;
  let localPath;
  try {
    const directory = await fs.mkdtemp(path.join(temp, "ifc-mcp-approval-"));
    localPath = path.join(directory, "model");
    const digest = expiresInMs === undefined ? null : createHash("sha256");
    let received = 0;
    await pipeline(readable, async function* (chunks) {
      for await (const chunk of chunks) {
        received += Buffer.byteLength(chunk);
        if (received > sizeBytes) throw new Error("The upload exceeded the selected file size.");
        digest?.update(chunk);
        yield chunk;
      }
    }, createWriteStream(localPath, { flags: "wx", mode: 0o600 }));
    if (received !== sizeBytes) throw new Error("The upload did not match the selected file size.");
    if (!isSessionActive()) throw new Error("The file approval session ended.");
    const tool_path = `ifc-file:${tokenUrlSafe(18)}`;
    const file = { name, localPath, size_bytes: sizeBytes, tool_path,
      approval: digest ? `handoff:${digest.digest("hex")}` : tool_path };
    if (expiresInMs !== undefined) {
      file.expiry = setTimeout(() => {
        void removeApprovedPythonFile(tool_path).catch(error => console.error(error.message));
      }, expiresInMs).unref();
    }
    approved.set(tool_path, file);
    storedBytes += size;
    return metadata(file);
  } catch (error) {
    if (localPath) await discard(localPath);
    throw error;
  } finally {
    incomingBytes -= size;
  }
}

export function getApprovedPythonFile(id) {
  return approved.get(id);
}

export function listApprovedPythonFiles() {
  return Array.from(approved.values(), metadata);
}

export function consumePythonFileHandoffs(files) {
  const handoffs = [...new Set(files)].filter(file => file.expiry);
  for (const file of handoffs) detach(file);
  return () => Promise.all(handoffs.map(discardApproved));
}

export function onPythonFileRevocation(listener) {
  revocationListeners.add(listener);
  return () => revocationListeners.delete(listener);
}

export async function removeApprovedPythonFile(id) {
  const file = approved.get(id);
  if (!file) return false;
  detach(file);
  await Promise.all([discardApproved(file), ...Array.from(revocationListeners, listener => listener(id))]);
  return true;
}

export async function clearApprovedPythonFiles() {
  const files = [...approved.values()];
  for (const file of files) detach(file);
  await Promise.all([...files.map(discardApproved), ...Array.from(revocationListeners, listener => listener())]);
}

function detach(file) {
  clearTimeout(file.expiry);
  approved.delete(file.tool_path);
}

async function discardApproved(file) {
  await discard(file.localPath);
  storedBytes -= BigInt(file.size_bytes);
}

function metadata({ name, tool_path, size_bytes }) {
  return { name, tool_path, size_bytes };
}

async function discard(localPath) {
  await fs.unlink(localPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  await fs.rmdir(path.dirname(localPath)).catch(error => { if (error.code !== "ENOENT") throw error; });
}
