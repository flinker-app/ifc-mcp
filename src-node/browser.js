import { createIfcMcpHostHandlers } from "./host-handlers.js";
import { IFC_MCP_TOOL_DEFINITIONS, publicToolDefinition } from "./tool-definitions.js";
import { createIfcMcpToolHost } from "./tool-host.js";
import { createIfcMcpBrowserRuntime } from "./browser-runtime.js";

export function createIfcMcpHost({
  viewer = null,
  python = null,
  files = null,
  loadPython,
  context = {},
  onCall = null,
  timeoutMs,
  maxConcurrentCalls,
} = {}) {
  const runtime = files ? createIfcMcpBrowserRuntime({ files, viewer, loadPython }) : null;
  const toolHost = createIfcMcpToolHost({
    defaultHandlers: runtime?.handlers,
    // With local files, viewer callbacks receive resolved bytes through the runtime.
    handlers: createIfcMcpHostHandlers({ viewer: runtime ? null : viewer, python }),
    context,
    onCall,
    timeoutMs,
    maxConcurrentCalls,
  });

  return {
    ...(runtime ? { getGeneratedFiles: runtime.getGeneratedFiles, clearFiles: runtime.clearFiles } : {}),
    tools: IFC_MCP_TOOL_DEFINITIONS.map(publicToolDefinition),

    async handleToolCall(toolCall, options) {
      const name = toolCall?.name;
      const input = toolCall?.input ?? toolCall?.arguments ?? {};
      return toolHost.callTool(name, input, options);
    },
  };
}

export {
  IFC_MCP_TOOL_DEFINITIONS,
  IFC_MCP_TOOL_NAMES,
  getIfcMcpToolDefinition,
} from "./tool-definitions.js";
export { toolResult, toolError, toolResultText, bcfToolResult } from "./tool-results.js";
