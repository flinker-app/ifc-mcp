import assert from "node:assert/strict";
import test from "node:test";

import { createIfcMcpHost } from "../src-node/browser.js";

test("browser host maps viewer callbacks to IFC MCP tools", async () => {
  const calls = [];
  const host = createIfcMcpHost({
    viewer: {
      "show-ifc-file": async ({ file_path }) => {
        calls.push(["show-ifc-file", file_path]);
        return { loaded_ifc_file: true, active_model_path: file_path };
      },
      "set-bcf-view": async ({ bcf_path }) => {
        calls.push(["set-bcf-view", bcf_path]);
        return { applied_to_open_viewer: true, applied_bcf_path: bcf_path };
      },
      "clear-ifc-viewer": async () => {
        calls.push(["clear-ifc-viewer"]);
        return { cleared_viewer: true };
      },
    },
  });

  const toolNames = host.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("show-ifc-file"));
  assert.ok(toolNames.includes("set-bcf-view"));
  assert.ok(toolNames.includes("clear-ifc-viewer"));

  const loaded = await host.handleToolCall({
    id: "load-1",
    name: "show-ifc-file",
    input: { file_path: "model.ifc" },
  });
  assert.deepEqual(loaded, {
    id: "load-1",
    name: "show-ifc-file",
    result: { loaded_ifc_file: true, active_model_path: "model.ifc" },
  });

  const applied = await host.handleToolCall({
    id: "bcf-1",
    name: "set-bcf-view",
    input: { bcf_path: "viewpoint.bcfzip" },
  });
  assert.deepEqual(applied, {
    id: "bcf-1",
    name: "set-bcf-view",
    result: { applied_to_open_viewer: true, applied_bcf_path: "viewpoint.bcfzip" },
  });

  const cleared = await host.handleToolCall({
    id: "clear-1",
    name: "clear-ifc-viewer",
    input: {},
  });
  assert.deepEqual(cleared, {
    id: "clear-1",
    name: "clear-ifc-viewer",
    result: { cleared_viewer: true },
  });

  assert.deepEqual(calls, [
    ["show-ifc-file", "model.ifc"],
    ["set-bcf-view", "viewpoint.bcfzip"],
    ["clear-ifc-viewer"],
  ]);
});

test("browser host validates MCP tool arguments", async () => {
  const host = createIfcMcpHost({
    viewer: {
      "set-bcf-view": async () => {
        return { applied_to_open_viewer: true };
      },
    },
  });

  await assert.rejects(
    () => host.handleToolCall({
      name: "set-bcf-view",
      input: {},
    }),
    /bcf_path|Invalid input|expected string/i,
  );
});
