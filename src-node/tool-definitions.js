import * as z from "zod/v4";

import { DEFAULT_COPILOT_SDK_URL } from "./constants.js";

const emptyObjectJsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const IFC_MCP_TOOL_DEFINITIONS = [
  {
    name: "run-python",
    title: "run Python",
    description: `
Execute LLM-created Python in the SDK Node/Pyodide IFC runtime.
Use this tool for IFC inspection, validation, reports, exports, and creating
new IFC files.

Runtime context: Pyodide uses
the bundled Pyodide 0.28.2 runtime. The package set includes
micropip, ifcopenshell, numpy, pandas, matplotlib, shapely, and
typing-extensions. The Python code is passed directly to the SDK.

File inputs: pass IFC/IFCXML/IFCZIP file paths in the files array. In the
desktop Node server these are local filesystem paths; in a browser host they
are browser-defined paths resolved by that host. Generated Python can open
those files by name, e.g. ifcopenshell.open("model.ifc") or open("model.ifc", "rb").

Return contract: this tool exposes stdout, stderr, saved_files, uploaded_files,
and any result returned by the raw SDK. Generated files are returned as
temporary localhost download URLs in saved_files. Do not assume files were
written to the user's working directory.
`.trim(),
    schema: z.object({
      code: z.string().describe(
        'Raw Python code to execute through the SDK. Files passed through files can be opened by name, e.g. ifcopenshell.open("model.ifc") or open("model.ifc", "rb").',
      ),
      files: z.array(z.string()).default([]).describe(
        "Optional array of IFC/IFCXML/IFCZIP file paths. Desktop hosts use local filesystem paths; browser hosts use browser-defined paths.",
      ),
      timeout_seconds: z.number().int().min(1).default(120).describe("Timeout in seconds."),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            'Raw Python code to execute through the SDK. Files passed through files can be opened by name, e.g. ifcopenshell.open("model.ifc") or open("model.ifc", "rb").',
        },
        files: {
          type: "array",
          items: {
            type: "string",
          },
          default: [],
          description:
            "Optional array of IFC/IFCXML/IFCZIP file paths. Desktop hosts use local filesystem paths; browser hosts use browser-defined paths.",
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          default: 120,
          description: "Timeout in seconds.",
        },
      },
      required: ["code"],
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
      file_path: z.string().describe(
        "Local IFC/IFCXML/IFCZIP file path, or a generated IFC localhost download URL from run Python saved_files, to load into the viewer.",
      ),
    }),
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Local IFC/IFCXML/IFCZIP file path, or a generated IFC localhost download URL from run Python saved_files, to load into the viewer.",
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
    description: `
Set the view state in the already-open local IFC viewer by applying a BCF/BCFZIP viewpoint file.
Pass either a local BCF/BCFZIP file path or a generated BCF download URL from run Python saved_files.
This tool does not show/load IFC files; use show-ifc-file for that.
It should not open a new browser tab and should not use browser automation.
To generate a BCFZIP with run-python, write a .bcfzip file, then call set-bcf-view with saved_files[0].url:
\`\`\`python
from uuid import uuid4
import ifcopenshell
from bcf.v3 import model as mdl
from bcf.v3.bcfxml import BcfXml
from bcf.v3.visinfo import VisualizationInfoHandler

model = ifcopenshell.open("sample.ifc")
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
bcf_path = "view.bcfzip"
bcf.save(bcf_path)
print(str(bcf_path))
\`\`\`
`.trim(),
    schema: z.object({
      bcf_path: z.string().describe(
        "Local BCF/BCFZIP file path, or a generated BCF download URL from run Python saved_files, to apply in the viewer.",
      ),
    }),
    inputSchema: {
      type: "object",
      properties: {
        bcf_path: {
          type: "string",
          description:
            "Local BCF/BCFZIP file path, or a generated BCF download URL from run Python saved_files, to apply in the viewer.",
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
