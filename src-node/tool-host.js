import {
  IFC_MCP_TOOL_DEFINITIONS,
  getIfcMcpToolDefinition,
} from "./tool-definitions.js";

export class IfcMcpToolError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "IfcMcpToolError";
    this.toolName = options.toolName || null;
  }
}

export function createIfcMcpToolHost({
  handlers = {},
  defaultHandlers = {},
  context = {},
  onCall = null,
} = {}) {
  const handlerMap = {
    ...defaultHandlers,
    ...handlers,
  };

  const host = {
    tools: IFC_MCP_TOOL_DEFINITIONS,

    async callTool(name, args = {}) {
      const tool = getIfcMcpToolDefinition(name);
      if (!tool) {
        throw new IfcMcpToolError(`Unknown IFC MCP tool: ${name}`, { toolName: name });
      }

      const handler = handlerMap[tool.name];
      if (typeof handler !== "function") {
        throw new IfcMcpToolError(`No handler configured for IFC MCP tool: ${tool.name}`, {
          toolName: tool.name,
        });
      }

      const input = tool.schema.parse(args ?? {});
      if (typeof onCall === "function") {
        await onCall({ name: tool.name, input, tool, context });
      }

      return handler(input, {
        tool,
        context,
        callTool: host.callTool,
      });
    },
  };

  return host;
}

export {
  IFC_MCP_TOOL_DEFINITIONS,
  IFC_MCP_TOOL_NAMES,
  getIfcMcpToolDefinition,
} from "./tool-definitions.js";
