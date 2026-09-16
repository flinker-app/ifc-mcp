// Standard MCP CallToolResult values, shared by every host.
export function toolResult(value, isError = false) {
  let result;
  if (value && typeof value === "object" && "content" in value) {
    result = isError ? { ...value, isError: true } : value;
  } else if (typeof value === "string") {
    result = { isError, content: [{ type: "text", text: value }] };
  } else {
    const { ok, ...data } = value ?? {};
    result = { isError: isError || ok === false, content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  }
  return result;
}

export function toolError(error) {
  const detail = error?.error ?? error?.message ?? String(error);
  const parts = JSON.parse(localResultJson([detail, error?.stdout, error?.stderr].filter(Boolean)));
  const text = [...new Set(parts.map(part => typeof part === "string" ? part : JSON.stringify(part)))].join("\n");
  return toolResult({ content: [{ type: "text", text }], isError: true,
    ...(error?._meta && typeof error._meta === "object" && !Array.isArray(error._meta) ? { _meta: error._meta } : {}) });
}

export function toolResultText(result) {
  return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
}

// Also accepts diagnostics from viewer versions released before MCP results.
export function bcfToolResult(report) {
  if (report && typeof report === "object" && "content" in report) return toolResult(report);
  const action = {
    applied: "BCF applied.", partial: "BCF partly applied.", failed: "BCF could not be applied.",
    pending: "BCF loaded; waiting to apply.",
    "not-applied": report?.loaded ? "BCF loaded; no viewpoint applied." : "BCF could not be loaded.",
  }[report?.application] || "BCF was sent to the viewer, but application could not be confirmed.";
  const issues = report?.issues ?? [];
  const messages = [...new Set(issues.map(issue => `${issue.severity === "warning" ? "Warning: " : ""}${issue.message}`))];
  return toolResult([action, ...messages].join("\n"), report?.application !== "applied" || report?.status === "error" || issues.some(issue => issue.severity === "error"));
}

// Keep worker file bytes and raw IFC out of both text and structured model input.
export function pythonToolResult(value) {
  const text = localResultJson(value);
  const safe = JSON.parse(text);
  return toolResult(text.length > 20000
    ? { ok: value.ok, output_truncated: true, preview: text.slice(0, 16000), saved_files: safe.saved_files }
    : safe, value.isError === true);
}

function localResultJson(value) {
  return JSON.stringify(value, (key, item) => {
    if (["buffer", "bytes", "blob", "file_data", "sdk_output"].includes(key)
      || item instanceof ArrayBuffer || ArrayBuffer.isView(item) || (typeof Blob !== "undefined" && item instanceof Blob)) return undefined;
    if (typeof item === "string" && /ISO-10303-21\s*;|<\s*(?:\w+:)?ifcxml\b/i.test(item)) return "[IFC file contents kept locally]";
    return item;
  });
}
