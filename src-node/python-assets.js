import { IFCOPENSHELL_BUILD } from "./constants.js";

export async function verifyWheel(bytes, build = IFCOPENSHELL_BUILD) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== build.sha256) throw new Error(`IfcOpenShell wheel checksum mismatch: ${actual}`);
  return bytes;
}

export async function downloadWheel(build = IFCOPENSHELL_BUILD) {
  const response = await fetch(build.url);
  if (!response.ok) throw new Error(`Could not download IfcOpenShell WASM: ${response.status} ${response.statusText}`);
  return verifyWheel(new Uint8Array(await response.arrayBuffer()), build);
}
