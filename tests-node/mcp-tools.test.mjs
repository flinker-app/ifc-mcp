import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import JSZip from "jszip";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { toolResult, toolError } from "../src-node/tool-results.js";
import { createBcfFile, readBcfTopicsFromBytes } from "../src-node/bcf.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleIfc = path.join(repoRoot, "examples", "sample.ifc");
const snowdonIfc = process.env.SNOWDON_IFC_PATH || "";

test("MCP run-python schema uses plural files and explains file inputs", async () => {
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
    assert.deepEqual(runPython.inputSchema.required, ["files", "code"]);
    assert.match(runPython.description, /Pyodide 0\.28\.2/);
    assert.match(runPython.description, /ifcopenshell/);
    assert.equal("file_path" in runPython.inputSchema.properties, false);
    assert.match(runPython.inputSchema.properties.code.description, /ifcopenshell\.open\("model\.ifc"\)/i);
    assert.match(runPython.inputSchema.properties.files.description, /Desktop hosts[\s\S]*browser hosts/i);
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

test("MCP run-python accepts empty files for non-file Python jobs", async () => {
  await withMcpClient(async (client) => {
    const output = await callRunPython(client, {
      code: 'print("ok")',
      files: [],
    });

    assert.equal(output.stdout, "ok\n");
    assert.deepEqual(output.uploaded_files, []);
  });
});

test("MCP run-python rejects old file_path argument", async () => {
  await withMcpClient(async (client) => {
    const result = await client.callTool(
      {
        name: "run-python",
        arguments: {
          file_path: "",
          code: 'result = {"bad": "old file_path"}',
        },
      },
      { timeout: 30_000 },
    );

    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text || "", /Input validation error/i);
    assert.match(result.content?.[0]?.text || "", /file_path/i);
  });
});

test("MCP run-python mounts IFC paths with spaces for direct Python open", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ifc mcp absolute path "));
  const ifcPath = path.join(tempRoot, "Snowdon Towers Sample Architectural_IFC2x3.ifc");
  await fs.copyFile(sampleIfc, ifcPath);
  const ifcName = path.basename(ifcPath);

  await withMcpClient(async (client) => {
    const output = await callRunPython(client, {
      files: [ifcPath],
      code: `
import ifcopenshell
import json

ifc_name = ${JSON.stringify(ifcName)}
with open(ifc_name, "rb") as handle:
    magic = handle.read(10).decode("utf-8")
model = ifcopenshell.open(ifc_name)
walls = model.by_type("IfcWall")
print(json.dumps({
    "mounted_name": ifc_name,
    "magic": magic,
    "schema": model.schema,
    "wall_count": len(walls),
    "first_wall_global_id": walls[0].GlobalId,
}))
`,
    });

    const parsed = JSON.parse(output.stdout);
    assert.equal(output.uploaded_files[0].path, ifcPath);
    assert.equal(output.uploaded_files[0].name, "Snowdon Towers Sample Architectural_IFC2x3.ifc");
    assert.equal(parsed.mounted_name, "Snowdon Towers Sample Architectural_IFC2x3.ifc");
    assert.equal(parsed.magic, "ISO-10303-");
    assert.equal(parsed.schema, "IFC4");
    assert.equal(parsed.wall_count, 1);
    assert.equal("sdk_output" in output, false);
  });
});

test("MCP run-python mounts multiple IFC files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ifc mcp multiple files "));
  const firstPath = path.join(tempRoot, "sample.ifc");
  const secondPath = path.join(tempRoot, "sample copy.ifc");
  await fs.copyFile(sampleIfc, firstPath);
  await fs.copyFile(sampleIfc, secondPath);
  const mountedNames = [path.basename(firstPath), path.basename(secondPath)];

  await withMcpClient(async (client) => {
    const output = await callRunPython(client, {
      files: [firstPath, secondPath],
      code: `
import ifcopenshell
import json

mounted_names = ${JSON.stringify(mountedNames)}
models = [ifcopenshell.open(name) for name in mounted_names]
print(json.dumps({
    "mounted_names": mounted_names,
    "schemas": [model.schema for model in models],
    "wall_counts": [len(model.by_type("IfcWall")) for model in models],
}))
`,
    });

    const parsed = JSON.parse(output.stdout);
    assert.deepEqual(output.uploaded_files.map((file) => file.path), [firstPath, secondPath]);
    assert.deepEqual(parsed.mounted_names, ["sample.ifc", "sample copy.ifc"]);
    assert.deepEqual(parsed.schemas, ["IFC4", "IFC4"]);
    assert.deepEqual(parsed.wall_counts, [1, 1]);
  });
});

test("MCP run-python parses sample IFC through the real CDN Pyodide runtime", async () => {
  await withMcpClient(async (client) => {
    const output = await callRunPython(client, {
      files: [sampleIfc],
      code: `
import ifcopenshell
import json

model = ifcopenshell.open("sample.ifc")
walls = model.by_type("IfcWall")
print(json.dumps({
    "schema": model.schema,
    "wall_count": len(walls),
    "first_wall_global_id": walls[0].GlobalId if walls else None,
}))
`,
    });

    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.schema, "IFC4");
    assert.equal(parsed.wall_count, 1);
    assert.equal(parsed.first_wall_global_id, "0000000000000000000005");
    assert.equal(output.stderr, "");
  });
});

test("MCP run-python validates sample IFC through the real CDN Pyodide runtime", async () => {
  await withMcpClient(async (client) => {
    const output = await callRunPython(client, {
      files: [sampleIfc],
      code: `
import ifcopenshell
import ifcopenshell.validate as ifc_validate
import json

model = ifcopenshell.open("sample.ifc")
logger = ifc_validate.json_logger()
ifc_validate.validate("sample.ifc", logger)
print(json.dumps({
    "schema": model.schema,
    "issue_count": len(logger.statements),
}))
`,
    });

    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.schema, "IFC4");
    assert.equal(typeof parsed.issue_count, "number");
    assert.equal(output.stderr, "");
  });
});

test("set-bcf-view Python examples generate and apply valid BCFZIPs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ifc-mcp-bcf-examples-"));
  const exampleIfc = path.join(root, "sample.ifc");
  const fixture = await fs.readFile(path.join(repoRoot, "tests-node/fixtures/prompt-model.ifc"), "utf8");
  await fs.writeFile(exampleIfc, fixture);
  const wallGuid = fixture.match(/=IFCWALL\('([^']+)'/)[1];
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const setView = tools.tools.find((tool) => tool.name === "set-bcf-view");
    assert.ok(setView, "set-bcf-view tool should be registered");

    const output = await callRunPython(client, {
      files: [exampleIfc],
      code: extractPythonExample(setView.description),
    });

    assert.match(output.stdout, /view\.bcfzip/);
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
      wallGuid,
    ]);
    assert.equal(parsed.topics[0].viewpoints[0].visibility_default, "false");
    assert.deepEqual(parsed.topics[0].viewpoints[0].visibility_exceptions, [
      wallGuid,
    ]);

    await callJsonTool(client, "show-ifc-file", {
      file_path: exampleIfc,
    });
    const updated = await callJsonTool(client, "set-bcf-view", {
      bcf_path: bcfFile.url,
    });

    assert.equal(updated.isError, true);
    assert.match(updated.content[0].text, /No browser viewer is connected/);

    const colored = await callRunPython(client, {
      files: [exampleIfc], code: extractPythonExample(setView.description, 1),
    });

    const colorFile = colored.saved_files.find(file => file.name === "colors.bcfzip");
    assert.ok(colorFile, "Color example should save a BCFZIP");
    const bytes = new Uint8Array(await (await fetch(colorFile.url)).arrayBuffer());
    const colorTopics = await readBcfTopicsFromBytes(bytes);
    assert.deepEqual(colorTopics.topics[0].viewpoints[0].colored_components, [{ color: "0088FF", global_ids: [wallGuid] }]);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await Object.values(zip.files).find(file => file.name.endsWith(".bcfv")).async("string");
    assert.match(xml, /<PerspectiveCamera>/);
    assert.doesNotMatch(xml, /<Visibility/);

    for (const index of [0, 1]) {
      const empty = await callRunPython(client, {
        files: [exampleIfc],
        code: extractPythonExample(setView.description, index).replace('by_type("IfcWall")', 'by_type("IfcDoor")'),
      });

      assert.match(empty.stdout, /No walls found/);
      assert.equal(empty.saved_files.length, 0, "No matches should not generate a viewpoint");
    }
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
      const snowdonName = path.basename(snowdonIfc);
      const output = await callRunPython(client, {
        files: [snowdonIfc],
        code: `
import ifcopenshell
import json

model = ifcopenshell.open(${JSON.stringify(snowdonName)})
counts = {
    "IfcWall": len(model.by_type("IfcWall")),
    "IfcWallStandardCase": len(model.by_type("IfcWallStandardCase")),
}
print(json.dumps({
    "schema": model.schema,
    "wall_count": counts["IfcWall"] + counts["IfcWallStandardCase"],
    "counts": counts,
}))
`,
      });

      const parsed = JSON.parse(output.stdout);
      assert.equal(parsed.schema, "IFC2X3");
      assert.equal(parsed.counts.IfcWall, 1078);
      assert.equal(parsed.counts.IfcWallStandardCase, 904);
      assert.equal(parsed.wall_count, 1982);
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
    assert.equal(loaded.loaded_ifc_file, false, "No connected viewer confirmed loading");

    const loadedAgain = await callJsonTool(client, "show-ifc-file", {
      file_path: sampleIfc,
    });
    assert.equal(loadedAgain.url, opened.url);
    assert.equal(loadedAgain.model_count, 1);
    assert.equal(loadedAgain.added_model, false);

    const exchange = (message = {}) => fetch(`${opened.url}/state`, {
      method: "POST", headers: { Origin: opened.url, "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    assert.equal((await exchange()).status, 200);
    const updating = callJsonTool(client, "set-bcf-view", {
      bcf_path: bcfPath,
    });
    const state = await waitForViewerRequest(opened.url);
    const result = toolError("BCF partly applied. One component was not found.");
    assert.equal((await exchange({ id: state.request_id, result })).status, 200);
    const updated = await updating;

    assert.equal(updated.isError, true);
    assert.deepEqual(updated, result);
    assert.equal(state.has_bcf, true);
    assert.equal(state.bcf_version, 1);
    assert.ok(state.bcf_topic_guid);

    assert.equal((await exchange({ id: state.request_id, result: toolResult("Viewer updated.") })).status, 409);
    assert.equal((await fetch(`${opened.url}/bcf-feedback`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${opened.url}/state`, { method: "POST", body: "{}" })).status, 403);

    const clearing = callJsonTool(client, "clear-ifc-viewer", {});
    const clearState = await waitForViewerRequest(opened.url);
    assert.notEqual(clearState.request_id, state.request_id);
    assert.equal((await exchange({ id: clearState.request_id, result: toolResult("Viewer updated.") })).status, 200);
    const cleared = await clearing;
    assert.equal(cleared.url, opened.url);
    assert.equal(cleared.cleared_viewer, true);
    assert.deepEqual(cleared.model_paths, []);
    assert.equal(cleared.model_count, 0);
    assert.equal(cleared.has_bcf, false);
  });
});

async function waitForViewerRequest(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await fetch(`${url}/state`)).json();
    if (state.request_id) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Viewer request was not queued.");
}

async function withMcpClient(callback) {
  const transport = new StdioClientTransport({
    command: process.execPath,
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
    {
      timeout: 300_000,
      maxTotalTimeout: 360_000,
    },
  );
  assert.equal(result.content?.[0]?.type, "text");
  if (name === "run-python") assert.equal(result.isError, false, result.content[0].text);
  return result.structuredContent ?? result;
}

function extractPythonExample(description, index = 0) {
  const match = [...String(description || "").matchAll(/```python\n([\s\S]*?)\n```/g)][index];
  assert.ok(match, "set-bcf-view description should include a Python code block");
  return match[1];
}
