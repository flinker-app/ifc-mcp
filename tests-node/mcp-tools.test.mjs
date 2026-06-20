import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createBcfFile, readBcfTopicsFromBytes } from "../src-node/bcf.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleIfc = path.join(repoRoot, "examples", "sample.ifc");
const snowdonIfc = process.env.SNOWDON_IFC_PATH || "";

test("MCP run-python schema forces file_path and explains Pyodide host-path rules", async () => {
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const runPython = tools.tools.find((tool) => tool.name === "run-python");
    const openViewer = tools.tools.find((tool) => tool.name === "open-ifc-viewer");
    const showFile = tools.tools.find((tool) => tool.name === "show-ifc-file");
    const clearViewer = tools.tools.find((tool) => tool.name === "clear-ifc-viewer");
    const setView = tools.tools.find((tool) => tool.name === "set-bcf-view");

    assert.ok(runPython, "run-python tool should be registered");
    assert.ok(openViewer, "open-ifc-viewer tool should be registered");
    assert.ok(showFile, "show-ifc-file tool should be registered");
    assert.ok(clearViewer, "clear-ifc-viewer tool should be registered");
    assert.ok(setView, "set-bcf-view tool should be registered");
    assert.equal(tools.tools.some((tool) => tool.name === "open_ifc_viewer"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "set_ifc_viewer_bcf_state"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "set-ifc-view"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "load-ifc-file"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "update-ifc-viewer"), false);
    assert.deepEqual(runPython.inputSchema.required, ["code", "file_path"]);
    assert.match(runPython.description, /Pyodide cannot access[\s\S]*host filesystem paths/);
    assert.match(runPython.description, /Pyodide 0\.28\.2/);
    assert.match(runPython.description, /ifcopenshell/);
    assert.match(runPython.inputSchema.properties.code.description, /use the preloaded model variable|opened as model/i);
    assert.match(runPython.inputSchema.properties.file_path.description, /Required argument/);
    assert.equal("working_directory" in runPython.inputSchema.properties, false);
    assert.equal("max_output_chars" in runPython.inputSchema.properties, false);
    assert.match(openViewer.description, /browser or webview/);
    assert.doesNotMatch(openViewer.description, /VS Code Simple Browser/);
    assert.doesNotMatch(openViewer.description, /vscode_simple_browser_command_uri/);
    assert.doesNotMatch(openViewer.description, /127\.0\.0\.1:8765/);
    assert.doesNotMatch(setView.description, /127\.0\.0\.1:8765/);
    assert.equal("file_path" in openViewer.inputSchema.properties, false);
    assert.equal("title" in openViewer.inputSchema.properties, false);
    assert.deepEqual(showFile.inputSchema.required, ["file_path"]);
    assert.deepEqual(Object.keys(showFile.inputSchema.properties).sort(), ["file_path"]);
    assert.match(showFile.description, /download URL/i);
    assert.match(showFile.inputSchema.properties.file_path.description, /download URL/i);
    assert.equal("file_path" in setView.inputSchema.properties, false);
    assert.equal("title" in setView.inputSchema.properties, false);
    assert.deepEqual(setView.inputSchema.required, ["bcf_path"]);
    assert.deepEqual(Object.keys(setView.inputSchema.properties).sort(), ["bcf_path"]);
    assert.match(showFile.description, /model display only/);
    assert.deepEqual(Object.keys(clearViewer.inputSchema.properties).sort(), []);
    assert.match(clearViewer.description, /removing all loaded IFC files/i);
    assert.match(setView.description, /BCF\/BCFZIP viewpoint file/);
    assert.match(setView.description, /saved_files\[0\]\.url/);
    assert.match(setView.description, /```python[\s\S]*view\.bcfzip[\s\S]*```/);
    assert.match(setView.description, /from bcf\.v3\.bcfxml import BcfXml/);
    assert.match(setView.description, /VisualizationInfoHandler/);
    assert.doesNotMatch(setView.description, /from zipfile import|ZipFile\(/);
    assert.match(setView.inputSchema.properties.bcf_path.description, /generated BCF download URL/);
  });
});

test("MCP run-python rejects calls that omit file_path", async () => {
  await withMcpClient(async (client) => {
    const result = await client.callTool(
      {
        name: "run-python",
        arguments: {
          code: 'result = {"bad": "missing file_path"}',
        },
      },
      undefined,
      { timeout: 30_000 },
    );

    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text || "", /Input validation error/i);
    assert.match(result.content?.[0]?.text || "", /file_path/i);
  });
});

test("MCP run-python accepts an empty file_path for non-file Python jobs", async () => {
  await withMcpClient(async (client) => {
    const output = await callRunPython(client, {
      file_path: "",
      code: 'result = {"model_is_none": model is None}',
    });

    assert.equal(output.ok, true);
    assert.equal(output.result.model_is_none, true);
    assert.equal(output.file_path, null);
    assert.equal("sdk_output" in output, false);
    assert.equal("working_directory" in output, false);
    assert.equal("output_dir" in output, false);
  });
});

test("MCP run-python uploads absolute IFC paths with spaces instead of opening host paths in Pyodide", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ifc mcp absolute path "));
  const ifcPath = path.join(tempRoot, "Snowdon Towers Sample Architectural_IFC2x3.ifc");
  await fs.copyFile(sampleIfc, ifcPath);

  await withMcpClient(async (client) => {
    const output = await callRunPython(client, {
      file_path: ifcPath,
      timeout_seconds: 180,
      code: `
walls = model.by_type("IfcWall")
result = {
    "schema": model.schema,
    "wall_count": len(walls),
    "first_wall": walls[0],
}
`,
    });

    assert.equal(output.ok, true);
    assert.equal(output.file_path, ifcPath);
    assert.equal(output.result.schema, "IFC4");
    assert.equal(output.result.wall_count, 1);
    assert.equal("sdk_output" in output, false);
  });
});

test("MCP run-python parses sample IFC through the real CDN Pyodide runtime", async () => {
  await withMcpClient(async (client) => {
    const output = await callRunPython(client, {
      file_path: sampleIfc,
      timeout_seconds: 180,
      code: `
walls = model.by_type("IfcWall")
result = {
    "schema": model.schema,
    "wall_count": len(walls),
    "first_wall_global_id": walls[0].GlobalId if walls else None,
}
`,
    });

    assert.equal(output.ok, true);
    assert.equal(output.result.schema, "IFC4");
    assert.equal(output.result.wall_count, 1);
    assert.equal(output.result.first_wall_global_id, "0000000000000000000005");
    assert.equal(output.stderr, "");
  });
});

test("MCP run-python validates sample IFC through the real CDN Pyodide runtime", async () => {
  await withMcpClient(async (client) => {
    const output = await callRunPython(client, {
      file_path: sampleIfc,
      timeout_seconds: 180,
      code: `
logger = ifc_validate.json_logger()
ifc_validate.validate(ifc_file_path, logger)
result = {
    "schema": model.schema,
    "issue_count": len(logger.statements),
}
`,
    });

    assert.equal(output.ok, true);
    assert.equal(output.result.schema, "IFC4");
    assert.equal(typeof output.result.issue_count, "number");
    assert.equal(output.stderr, "");
  });
});

test("set-bcf-view Python example generates and applies a valid BCFZIP", async () => {
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const setView = tools.tools.find((tool) => tool.name === "set-bcf-view");
    assert.ok(setView, "set-bcf-view tool should be registered");

    const output = await callRunPython(client, {
      file_path: sampleIfc,
      timeout_seconds: 180,
      code: extractPythonExample(setView.description),
    });

    assert.equal(output.ok, true);
    assert.match(output.result.bcf_path, /view\.bcfzip$/);
    const bcfFile = output.saved_files.find((file) => file.name === "view.bcfzip");
    assert.ok(bcfFile?.url, "Python example should return view.bcfzip in saved_files");

    const response = await fetch(bcfFile.url);
    assert.equal(response.ok, true);
    const bcfBytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bcfBytes.subarray(0, 2).toString("utf8"), "PK");

    const parsed = await readBcfTopicsFromBytes(bcfBytes, { bcfPath: bcfFile.url });
    assert.equal(parsed.topic_count, 1);
    assert.equal(parsed.topics[0].title, "Review wall");
    assert.deepEqual(parsed.topics[0].viewpoints[0].selected_global_ids, [
      "0000000000000000000005",
    ]);
    assert.equal(parsed.topics[0].viewpoints[0].visibility_default, "false");
    assert.deepEqual(parsed.topics[0].viewpoints[0].visibility_exceptions, [
      "0000000000000000000005",
    ]);

    await callJsonTool(client, "show-ifc-file", {
      file_path: sampleIfc,
    });
    const updated = await callJsonTool(client, "set-bcf-view", {
      bcf_path: bcfFile.url,
    });

    assert.equal(updated.applied_to_open_viewer, true);
    assert.equal(updated.has_bcf, true);
    assert.equal(updated.bcf_topic_guid, parsed.topics[0].guid);
  });
});

test(
  "MCP run-python counts the local Snowdon IFC file when present",
  {
    skip:
      snowdonIfc && fsSync.existsSync(snowdonIfc)
        ? false
        : "Set SNOWDON_IFC_PATH to run the optional large local IFC test.",
  },
  async () => {
    await withMcpClient(async (client) => {
      const output = await callRunPython(client, {
        file_path: snowdonIfc,
        timeout_seconds: 600,
        code: `
counts = {
    "IfcWall": len(model.by_type("IfcWall")),
    "IfcWallStandardCase": len(model.by_type("IfcWallStandardCase")),
}
result = {
    "schema": model.schema,
    "wall_count": counts["IfcWall"] + counts["IfcWallStandardCase"],
    "counts": counts,
}
`,
      });

      assert.equal(output.ok, true);
      assert.equal(output.result.schema, "IFC2X3");
      assert.equal(output.result.counts.IfcWall, 1078);
      assert.equal(output.result.counts.IfcWallStandardCase, 904);
      assert.equal(output.result.wall_count, 1982);
      assert.equal(output.stderr, "");
    });
  },
);

test("MCP viewer tools use one stable viewer URL and can update the same viewer", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ifc-mcp-bcf-tool-"));
  const bcfPath = path.join(tempRoot, "viewpoint.bcfzip");
  await createBcfFile({
    outputPath: bcfPath,
    title: "Review Wall A",
    selectedGlobalIds: ["0000000000000000000005"],
    isolatedGlobalIds: ["0000000000000000000005"],
    ifcPath: sampleIfc,
  });

  await withMcpClient(async (client) => {
    const opened = await callJsonTool(client, "open-ifc-viewer", {});
    const openedUrl = new URL(opened.url);

    assert.equal(openedUrl.hostname, "127.0.0.1");
    assert.ok(Number(openedUrl.port) > 0);
    assert.equal("session" in opened, false);
    assert.equal("vscode_simple_browser_command_uri" in opened, false);
    assert.equal("vscode_simple_browser_instruction" in opened, false);
    assert.match(opened.viewer_instruction, /browser or webview/);
    assert.deepEqual(opened.model_paths, []);
    assert.equal(opened.model_count, 0);
    assert.equal(opened.has_bcf, false);

    const loaded = await callJsonTool(client, "show-ifc-file", {
      file_path: sampleIfc,
    });
    assert.equal(loaded.url, opened.url);
    assert.deepEqual(loaded.model_paths, [sampleIfc]);
    assert.equal(loaded.model_count, 1);
    assert.equal(loaded.loaded_ifc_file, true);

    const loadedAgain = await callJsonTool(client, "show-ifc-file", {
      file_path: sampleIfc,
    });
    assert.equal(loadedAgain.url, opened.url);
    assert.equal(loadedAgain.model_count, 1);
    assert.equal(loadedAgain.added_model, false);

    const updated = await callJsonTool(client, "set-bcf-view", {
      bcf_path: bcfPath,
    });

    assert.equal("session" in updated, false);
    assert.equal(updated.url, opened.url);
    assert.equal(updated.applied_to_open_viewer, true);
    assert.equal(updated.has_bcf, true);
    assert.equal(updated.bcf_version, 1);
    assert.ok(updated.bcf_topic_guid);
    assert.equal(updated.applied_bcf_path, bcfPath);

    const cleared = await callJsonTool(client, "clear-ifc-viewer", {});
    assert.equal(cleared.url, opened.url);
    assert.equal(cleared.cleared_viewer, true);
    assert.deepEqual(cleared.model_paths, []);
    assert.equal(cleared.model_count, 0);
    assert.equal(cleared.has_bcf, false);
  });
});

async function withMcpClient(callback) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["bin/ifc-mcp.js"],
    env: process.env,
  });
  const client = new Client({ name: "ifc-mcp-tools-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    await callback(client);
  } finally {
    await client.close();
  }
}

async function callRunPython(client, args) {
  return callJsonTool(client, "run-python", args);
}

async function callJsonTool(client, name, args) {
  const result = await client.callTool(
    {
      name,
      arguments: args,
    },
    undefined,
    {
      timeout: 300_000,
      maxTotalTimeout: 360_000,
    },
  );
  assert.equal(result.content?.[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

function extractPythonExample(description) {
  const match = String(description || "").match(/```python\n([\s\S]*?)\n```/);
  assert.ok(match, "set-bcf-view description should include a Python code block");
  return match[1];
}
