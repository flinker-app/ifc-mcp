import { createIfcMcpHostHandlers } from "./host-handlers.js";
import { IFC_MCP_TOOL_DEFINITIONS, publicToolDefinition } from "./tool-definitions.js";
import { createIfcMcpToolHost, IfcMcpToolError } from "./tool-host.js";

export function createIfcMcpHost({
  viewer = null,
  python = null,
  context = {},
  onCall = null,
} = {}) {
  const toolHost = createIfcMcpToolHost({
    handlers: createIfcMcpHostHandlers({ viewer, python }),
    context,
    onCall,
  });

  return {
    tools: IFC_MCP_TOOL_DEFINITIONS.map(publicToolDefinition),

    async handleToolCall(toolCall) {
      const name = toolCall?.name;
      const input = toolCall?.input ?? toolCall?.arguments ?? {};
      return {
        id: toolCall?.id ?? null,
        name,
        result: await toolHost.callTool(name, input),
      };
    },
  };
}

export {
  IFC_MCP_TOOL_DEFINITIONS,
  IFC_MCP_TOOL_NAMES,
  getIfcMcpToolDefinition,
} from "./tool-definitions.js";
export { IfcMcpToolError };
