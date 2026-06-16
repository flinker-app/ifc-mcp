import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { DEFAULT_COPILOT_SDK_URL } from "./constants.js";
import { configureDesktopViewer } from "./desktop-viewer.js";
import { executeIfcPython } from "./python-runner.js";
import { clearViewer, loadIfcFile, openViewer, setViewerBcfState } from "./viewer.js";

const INSTRUCTIONS = `
Use this server for Industry Foundation Classes (IFC) and BCF coordination workflows.
For any IFC data task, including creating new IFC files, call run Python. This
is the single Python execution entry point.

Viewer workflow: open-ifc-viewer only opens or shows the local IFC viewer and
returns its stable viewer URL. show-ifc-file adds IFC files to that viewer from
either local IFC paths or generated saved_files download URLs returned by run
Python. A single viewer can contain multiple IFC files. set-bcf-view only
changes the viewer state by applying a BCF viewpoint file. clear-ifc-viewer
removes all loaded IFC files and BCF state from the same viewer.
After open-ifc-viewer or show-ifc-file returns, use the returned URL as the
viewer address. If the MCP client can open links, open that local URL. If it
cannot, tell the user to open the URL in a browser or webview available in their
client.
Do not use browser automation to click/select elements in the viewer.
`.trim();

const RUN_PYTHON_DESCRIPTION = `
Execute LLM-created Python in the Flinker Copilot SDK Node/Pyodide IFC runtime.
Use this tool for IFC inspection, validation, reports, exports, and creating
new IFC files.

Runtime context: the default SDK module is ${DEFAULT_COPILOT_SDK_URL}. It uses
the bundled Pyodide 0.28.2 runtime. The default SDK package set includes
micropip, ifcopenshell, numpy, pandas, matplotlib, shapely, and
typing-extensions. The MCP wrapper preloads ifcopenshell,
ifcopenshell.util.element as element_util, ifcopenshell.validate as
ifc_validate, Path, json, resolve_path, output_dir, dump, ifc_file_path, and
model.

Critical file rule: Pyodide cannot access the user's host filesystem paths
directly. Host paths like C:\\..., /Users/..., /home/..., or network drive
paths are not visible inside Pyodide unless this MCP tool uploads the file.
When the user provides a local IFC file, always pass that host path in the
file_path argument. Generated Python must use the preloaded model variable for
IFC queries. Do not generate ifcopenshell.open(r"C:\\..."),
ifcopenshell.open("/Users/..."), or ifcopenshell.open("/home/...") for the
user's model. Use ifc_file_path only for APIs that require a filename inside
Pyodide, such as ifc_validate.validate(ifc_file_path, logger).

Return contract: set a variable named result to a JSON-serializable value for
structured output. If generated Python creates files, they are returned as
temporary localhost download URLs in saved_files. Do not assume files were
written to the user's working directory. For IFC creation tasks, create an
.ifc/.ifcxml/.ifczip file in output_dir so it is returned in saved_files.
`.trim();

export function createServer({ desktopViewer = null } = {}) {
  configureDesktopViewer(desktopViewer);

  const server = new McpServer({
    name: "IFC MCP",
    version: "0.1.12",
    instructions: INSTRUCTIONS,
  });

  server.registerTool(
    "run-python",
    {
      title: "run Python",
      description: RUN_PYTHON_DESCRIPTION,
      inputSchema: z.object({
        code: z
          .string()
          .describe(
            "Python code to execute in Pyodide. For existing IFC file tasks, the file is already uploaded from file_path and opened as model before this code runs. Use model.by_type(...), element_util, and ifc_file_path; do not import/open the user's host path with ifcopenshell.open(r\"C:\\...\") or similar. For IFC creation tasks, create the IFC output file in output_dir. Set result for structured JSON output.",
          ),
        file_path: z
          .string()
          .describe(
            "Required argument. Host OS path to a local IFC/IFCXML/IFCZIP file; this uploads the file into Pyodide and preloads model. For IFC creation or other no-file Python jobs, pass an empty string.",
          ),
        timeout_seconds: z.number().int().min(1).default(120).describe("Timeout in seconds."),
      }),
    },
    async ({
      code,
      file_path,
      timeout_seconds = 120,
    }) => {
      if (typeof file_path !== "string") {
        throw new Error(
          "run-python requires file_path. For a local IFC file, pass the host OS path in file_path and use the preloaded model variable in code. For IFC creation or other no-file Python jobs, pass file_path as an empty string.",
        );
      }
      const executed = await executeIfcPython({
        code,
        filePath: file_path || null,
        timeoutSeconds: timeout_seconds,
      });
      return jsonToolResult(publicPythonResult(executed));
    },
  );

  server.registerTool(
    "open-ifc-viewer",
    {
      title: "open IFC viewer",
      description:
        "Open or show the local IFC viewer and return its stable viewer URL. This tool does not load IFC files and does not change selection/isolation state. After this tool returns, use the returned URL as the viewer address. If the client can open links, open that local URL; otherwise tell the user to open the URL in a browser or webview. Use show-ifc-file to show IFC files. Use set-bcf-view to apply a BCF viewpoint file.",
      inputSchema: z.object({}),
    },
    async () => jsonToolResult(await openViewer()),
  );

  server.registerTool(
    "show-ifc-file",
    {
      title: "show IFC file",
      description:
        "Show one IFC file in the already-open local IFC viewer. Pass either a local IFC/IFCXML/IFCZIP file path or a generated IFC download URL from run Python saved_files. Use this for IFC model display only. Repeated calls add multiple IFC files to the same viewer. Use open-ifc-viewer to open the viewer and set-bcf-view to apply a BCF viewpoint file.",
      inputSchema: z.object({
        file_path: z
          .string()
          .describe(
            "Local IFC/IFCXML/IFCZIP file path, or a generated IFC localhost download URL from run Python saved_files, to load into the viewer.",
          ),
      }),
    },
    async ({ file_path }) =>
      jsonToolResult(
        await loadIfcFile({
          filePath: file_path,
        }),
      ),
  );

  server.registerTool(
    "clear-ifc-viewer",
    {
      title: "clear IFC viewer",
      description:
        "Clear the already-open local IFC viewer by removing all loaded IFC files and BCF viewpoint state. This keeps the same stable viewer URL and does not close the browser tab. Use show-ifc-file after this to load a fresh IFC model.",
      inputSchema: z.object({}),
    },
    async () => jsonToolResult(await clearViewer()),
  );

  server.registerTool(
    "set-bcf-view",
    {
      title: "set BCF view",
      description:
        "Set the view state in the already-open local IFC viewer by applying a BCF/BCFZIP viewpoint file. Pass either a local BCF/BCFZIP file path or a generated BCF download URL from run Python saved_files. This tool does not show/load IFC files; use show-ifc-file for that. It should not open a new browser tab and should not use browser automation.",
      inputSchema: z.object({
        bcf_path: z
          .string()
          .describe(
            "Local BCF/BCFZIP file path, or a generated BCF download URL from run Python saved_files, to apply in the viewer.",
          ),
      }),
    },
    async ({ bcf_path }) =>
      jsonToolResult(
        await setViewerBcfState({
          bcfPath: bcf_path,
        }),
      ),
  );

  return server;
}

export async function main(options = {}) {
  const transport = new StdioServerTransport();
  await createServer(options).connect(transport);
}

function jsonToolResult(value) {
  return {
    structuredContent: value,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function publicPythonResult(value) {
  return {
    ok: Boolean(value?.ok),
    result: value?.result ?? null,
    stdout: value?.stdout || "",
    stderr: value?.stderr || "",
    saved_files: Array.isArray(value?.saved_files) ? value.saved_files : [],
    file_path: value?.file_path || null,
  };
}
