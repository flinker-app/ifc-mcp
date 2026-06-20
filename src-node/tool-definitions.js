import * as z from "zod/v4";

import { DEFAULT_COPILOT_SDK_URL } from "./constants.js";

export const RUN_PYTHON_DESCRIPTION = `
Execute LLM-created Python in the Flinker Copilot SDK Node/Pyodide IFC runtime.
Use this tool for IFC inspection, validation, reports, exports, and creating
new IFC files. This is the Python execution entry point for IFC data tasks.

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

const runPythonCodeDescription =
  "Python code to execute in Pyodide. For existing IFC file tasks, the file is already uploaded from file_path and opened as model before this code runs. Use model.by_type(...), element_util, and ifc_file_path; do not import/open the user's host path with ifcopenshell.open(r\"C:\\...\") or similar. For IFC creation tasks, create the IFC output file in output_dir. Set result for structured JSON output.";

const runPythonFilePathDescription =
  "Required argument. Host OS path to a local IFC/IFCXML/IFCZIP file; this uploads the file into Pyodide and preloads model. For IFC creation or other no-file Python jobs, pass an empty string.";

const showIfcFilePathDescription =
  "Local IFC/IFCXML/IFCZIP file path, or a generated IFC localhost download URL from run Python saved_files, to load into the viewer.";

const bcfPathDescription =
  "Local BCF/BCFZIP file path, or a generated BCF download URL from run Python saved_files, to apply in the viewer.";

export const SET_BCF_VIEW_DESCRIPTION = `
Set the view state in the already-open local IFC viewer by applying a BCF/BCFZIP viewpoint file.
Pass either a local BCF/BCFZIP file path or a generated BCF download URL from run Python saved_files.
This tool does not show/load IFC files; use show-ifc-file for that.
It should not open a new browser tab and should not use browser automation.
To generate a BCFZIP with run-python, write it to output_dir, then call set-bcf-view with saved_files[0].url:
\`\`\`python
from uuid import uuid4
from bcf.v3 import model as mdl
from bcf.v3.bcfxml import BcfXml
from bcf.v3.visinfo import VisualizationInfoHandler

gid = model.by_type("IfcWall")[0].GlobalId
component = mdl.Component(ifc_guid=gid)
visinfo = mdl.VisualizationInfo(
    guid=str(uuid4()),
    components=mdl.Components(
        selection=mdl.ComponentSelection(component=[component]),
        visibility=mdl.ComponentVisibility(
            default_visibility=False,
            exceptions=mdl.ComponentVisibilityExceptions(component=[component]),
        ),
    ),
)
bcf = BcfXml.create_new(project_name="IFC MCP")
topic = bcf.add_topic("Review wall", "Review wall", "ifc-mcp", topic_type="Issue", topic_status="Open")
topic.add_visinfo_handler(VisualizationInfoHandler(visinfo))
bcf_path = output_dir / "view.bcfzip"
bcf.save(bcf_path)
result = {"bcf_path": str(bcf_path)}
\`\`\`
`.trim();

const emptyObjectJsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const IFC_MCP_TOOL_DEFINITIONS = [
  {
    name: "run-python",
    title: "run Python",
    description: RUN_PYTHON_DESCRIPTION,
    schema: z.object({
      code: z.string().describe(runPythonCodeDescription),
      file_path: z.string().describe(runPythonFilePathDescription),
      timeout_seconds: z.number().int().min(1).default(120).describe("Timeout in seconds."),
    }),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: runPythonCodeDescription,
        },
        file_path: {
          type: "string",
          description: runPythonFilePathDescription,
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          default: 120,
          description: "Timeout in seconds.",
        },
      },
      required: ["code", "file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "open-ifc-viewer",
    title: "open IFC viewer",
    description:
      "Open or show the local IFC viewer and return its stable viewer URL. This tool does not load IFC files and does not change selection/isolation state. After this tool returns, use the returned URL as the viewer address. If the client can open links, open that local URL; otherwise tell the user to open the URL in a browser or webview. Use show-ifc-file to show IFC files. Use set-bcf-view to apply a BCF viewpoint file. Do not use browser automation to click or select elements in the viewer.",
    schema: z.object({}),
    inputSchema: emptyObjectJsonSchema,
  },
  {
    name: "show-ifc-file",
    title: "show IFC file",
    description:
      "Show one IFC file in the already-open local IFC viewer. Pass either a local IFC/IFCXML/IFCZIP file path or a generated IFC download URL from run Python saved_files. Use this for IFC model display only. Repeated calls add multiple IFC files to the same viewer. Returns the same stable viewer URL; after this tool returns, use that URL as the viewer address. Use open-ifc-viewer to open the viewer and set-bcf-view to apply a BCF viewpoint file.",
    schema: z.object({
      file_path: z.string().describe(showIfcFilePathDescription),
    }),
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: showIfcFilePathDescription,
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "clear-ifc-viewer",
    title: "clear IFC viewer",
    description:
      "Clear the already-open local IFC viewer by removing all loaded IFC files and BCF viewpoint state. This keeps the same stable viewer URL and does not close the browser tab. Use show-ifc-file after this to load a fresh IFC model.",
    schema: z.object({}),
    inputSchema: emptyObjectJsonSchema,
  },
  {
    name: "set-bcf-view",
    title: "set BCF view",
    description: SET_BCF_VIEW_DESCRIPTION,
    schema: z.object({
      bcf_path: z.string().describe(bcfPathDescription),
    }),
    inputSchema: {
      type: "object",
      properties: {
        bcf_path: {
          type: "string",
          description: bcfPathDescription,
        },
      },
      required: ["bcf_path"],
      additionalProperties: false,
    },
  },
];

export const IFC_MCP_TOOL_NAMES = IFC_MCP_TOOL_DEFINITIONS.map((tool) => tool.name);

export function getIfcMcpToolDefinition(name) {
  return IFC_MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name) || null;
}

export function publicToolDefinition(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: cloneJson(tool.inputSchema),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
