import crypto from "node:crypto";

export function tokenUrlSafe(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function trimText(value, maxChars) {
  const text = String(value || "");
  if (maxChars < 1 || text.length <= maxChars) {
    return text;
  }
  const suffix = `\n... truncated to ${maxChars} characters ...`;
  return text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

export function asArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
