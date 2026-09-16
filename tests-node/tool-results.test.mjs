import assert from "node:assert/strict";
import test from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src-node/server.js";
import { createIfcMcpHost } from "../src-node/browser.js";
import { bcfToolResult, pythonToolResult, toolError, toolResult, toolResultText } from "../src-node/tool-results.js";

test("BCF results use standard success/error messages without public reports", () => {
  for (const [application, issues, isError] of [
    ["applied", [], false],
    ["applied", [{ severity: "warning", message: "Removed # from a color." }], false],
    ["applied", [{ severity: "error", message: "Camera could not be applied." }], true],
    ["partial", [{ severity: "warning", message: "One component was not found." }], true],
    ["pending", [], true], ["not-applied", [], true], ["failed", [], true], [undefined, [], true],
  ]) {
    const result = bcfToolResult({ application, issues });
    CallToolResultSchema.parse(result);
    assert.equal(result.isError, isError);
    assert.deepEqual(Object.keys(result).sort(), ["content", "isError"]);
    for (const issue of issues) assert.ok(toolResultText(result).includes(issue.message));
  }
  assert.equal(toolResultText(bcfToolResult({ application: "applied" })), "BCF applied.");
  assert.match(toolResultText(bcfToolResult()), /could not be confirmed/);
});

test("Python privacy filtering applies equally to text and structured content", () => {
  const result = pythonToolResult({ ok: false, stdout: "ISO-10303-21;SECRET", stderr: "Python failed",
    result: { count: 10, xml: "<ifcxml>SECRET</ifcxml>", bytes: [1], data: new Uint8Array([1]), blob: new Blob(["SECRET"]) },
    saved_files: [{ name: "report.csv", url: "blob:local" }] });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|"bytes"|"blob"|"data"|"ok"/);
  assert.equal(result.structuredContent.result.count, 10);
  assert.deepEqual(JSON.parse(toolResultText(result)), result.structuredContent);
  const large = pythonToolResult({ ok: false, stdout: "x".repeat(30000), saved_files: [{ name: "report.csv" }] });
  assert.equal(large.isError, true);
  assert.equal(large.structuredContent.output_truncated, true);
  assert.equal(large.structuredContent.saved_files[0].name, "report.csv");
  const error = toolError(Object.assign(new Error("Worker failed"), {
    stdout: "ISO-10303-21;SECRET",
  }));
  assert.doesNotMatch(JSON.stringify(error), /SECRET/);
  assert.match(toolResultText(error), /Worker failed/);
});

test("Node and browser preserve standard content, metadata and errors identically", async () => {
  let output;
  const handler = async () => { if (output instanceof Error) throw output; return output; };
  const viewer = { "open-ifc-viewer": handler };
  const host = createIfcMcpHost({ viewer });
  const server = createServer({ viewer });
  const client = new Client({ name: "result-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const value of [
      toolResult("Viewer ready."),
      toolResult({ count: 10 }),
      toolError(new Error("Load failed")),
      Object.assign(new Error("Worker failed"), { stderr: "Traceback details", _meta: { retryable: true } }),
      { isError: false, content: [
        { type: "text", text: "Preview" },
        { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "audio", data: "AA==", mimeType: "audio/wav" },
        { type: "resource_link", uri: "file:///report.csv", name: "report.csv" },
        { type: "resource", resource: { uri: "file:///summary.txt", mimeType: "text/plain", text: "Summary" } },
      ], structuredContent: { count: 10 }, _meta: { view: "preview" } },
      { ok: false, stderr: "Python failed" },
    ]) {
      output = value;
      const browser = await host.handleToolCall({ name: "open-ifc-viewer", input: {} });
      const node = await client.callTool({ name: "open-ifc-viewer", arguments: {} });
      CallToolResultSchema.parse(browser);
      assert.deepEqual(node, browser);
      if (Array.isArray(value?.content)) assert.equal(browser, value, "Standard results must pass through unchanged");
      if (value instanceof Error || value.ok === false) assert.equal(node.isError, true);
    }
  } finally { await client.close(); await server.close(); }
});
