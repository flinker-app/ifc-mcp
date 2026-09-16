import * as z from "zod/v4";

const pythonCodeDescription =
  'Raw Python code. Open input files by name, e.g. ifcopenshell.open("model.ifc") or open("model.ifc", "rb").';
const pythonFilesDescription =
  "IFC/IFCXML/IFCZIP inputs; use [] if none. Desktop hosts use local filesystem paths; browser hosts use browser-defined paths.";

export const IFC_MCP_TOOL_DEFINITIONS = [
  {
    name: "run-python",
    title: "run Python",
    description: `
Execute LLM-created Python in the SDK Node/Pyodide IFC runtime.
IFC inputs are mounted only from this call's files array; files listed or open
in the viewer are not automatically available to Python.
Use this tool for IFC inspection, validation, reports, exports, and creating
new IFC files.
For viewer selection, visibility or coloring, generate BCF for set-bcf-view;
Write efficient IfcOpenShell code to get results fast. Inspect unfamiliar APIs before use;

Runtime context: Pyodide uses
the bundled Pyodide 0.28.2 runtime. The package set includes
micropip, ifcopenshell, numpy, pandas, matplotlib, shapely, and
typing-extensions. The Python code is passed directly to the SDK.

Return contract: this tool exposes stdout, stderr, saved_files, uploaded_files,
and any result returned by the raw SDK. Generated files are returned as
temporary localhost download URLs in saved_files. Do not assume files were
written to the user's working directory.
`.trim(),
    schema: z.strictObject({
      files: z.array(z.string()).describe(pythonFilesDescription),
      code: z.string().describe(pythonCodeDescription),
    }),
  },
  {
    name: "open-ifc-viewer",
    title: "open IFC viewer",
    description:
      "Open the local IFC viewer if it is not already open. Returns its stable URL to open in a browser or webview. This does not load IFC files or change view state. Use the viewer tools, not browser automation, to interact with the model.",
    schema: z.strictObject({}),
  },
  {
    name: "show-ifc-file",
    title: "show IFC file",
    description:
      "Add one IFC file to the already-open local viewer; skip files already loaded. Pass a local IFC/IFCXML/IFCZIP path or a generated IFC download URL from run-python saved_files. Use this for IFC model display only. Returns the same stable viewer URL.",
    schema: z.strictObject({
      file_path: z.string().describe(
        "Local IFC/IFCXML/IFCZIP file path, or a generated IFC localhost download URL from run Python saved_files, to load into the viewer.",
      ),
    }),
  },
  {
    name: "clear-ifc-viewer",
    title: "clear IFC viewer",
    description:
      "Clear the already-open local IFC viewer by removing all loaded IFC files and BCF viewpoint state. This keeps the same stable viewer URL and does not close the browser tab. Use show-ifc-file after this to load a fresh IFC model.",
    schema: z.strictObject({}),
  },
  {
    name: "set-bcf-view",
    title: "set BCF view",
    description: `
Set the view state in the already-open local IFC viewer by applying a BCF/BCFZIP viewpoint file.
Pass either a local BCF/BCFZIP file path or a generated BCF download URL from run Python saved_files.
Apply directly to a loaded model; use show-ifc-file only if the target model is not loaded.
It should not open a new browser tab and should not use browser automation.
Return the application status and issues to the user. Applied, partial and
unconfirmed results finish the action; do not reapply or diagnose warnings.
Retry a failed application only after correcting a concrete reported error.
To generate a BCFZIP with run-python, write a .bcfzip file, then call set-bcf-view with saved_files[0].url:
\`\`\`python
import ifcopenshell
from bcf.v3 import model as mdl
from bcf.v3.bcfxml import BcfXml
from bcf.v3.visinfo import VisualizationInfoHandler

model = ifcopenshell.open("sample.ifc")
walls = model.by_type("IfcWall")
if walls:
    component = mdl.Component(ifc_guid=walls[0].GlobalId)
    view = VisualizationInfoHandler.create_new(walls[0])
    view.visualization_info.components = mdl.Components(
        selection=mdl.ComponentSelection(component=[component]),
        visibility=mdl.ComponentVisibility(
            default_visibility=False,
            exceptions=mdl.ComponentVisibilityExceptions(component=[component]),
        ),
    )
    bcf = BcfXml.create_new(project_name="IFC MCP")
    topic = bcf.add_topic("Review wall", "Review wall", "ifc-mcp", topic_type="Issue", topic_status="Open")
    topic.add_visinfo_handler(view)
    bcf.save("view.bcfzip")
    print("view.bcfzip")
else:
    print("No walls found.")
\`\`\`

Second example: color all walls blue and frame the first wall.
BCF colors use RRGGBB or AARRGGBB hex digits without #.
Components.coloring requires a ComponentColoring container, not a plain list;
its color field holds the list of ComponentColoringColor entries.
\`\`\`python
import ifcopenshell
from bcf.v3 import model as mdl
from bcf.v3.bcfxml import BcfXml
from bcf.v3.visinfo import VisualizationInfoHandler

model = ifcopenshell.open("sample.ifc")
walls = model.by_type("IfcWall")
if walls:
    view = VisualizationInfoHandler.create_new(walls[0])
    view.visualization_info.components = mdl.Components(
        coloring=mdl.ComponentColoring(color=[
            mdl.ComponentColoringColor(
                color="0088FF",
                components=mdl.ComponentColoringColorComponents(
                    component=[mdl.Component(ifc_guid=wall.GlobalId) for wall in walls],
                ),
            ),
        ]),
    )
    bcf = BcfXml.create_new(project_name="IFC MCP")
    topic = bcf.add_topic("Color walls", "Color walls blue", "ifc-mcp", topic_type="Issue", topic_status="Open")
    topic.add_visinfo_handler(view)
    bcf.save("colors.bcfzip")
    print("colors.bcfzip")
else:
    print("No walls found.")
\`\`\`
`.trim(),
    schema: z.strictObject({
      bcf_path: z.string().describe(
        "Local BCF/BCFZIP file path, or a generated BCF download URL from run Python saved_files, to apply in the viewer.",
      ),
    }),
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
    inputSchema: z.toJSONSchema(tool.schema, { io: "input", target: "draft-2020-12" }),
  };
}
