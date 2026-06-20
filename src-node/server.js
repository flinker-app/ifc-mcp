import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createDefaultIfcMcpToolHandlers } from "./default-handlers.js";
import { createIfcMcpHostHandlers } from "./host-handlers.js";
import { createIfcMcpToolHost } from "./tool-host.js";
import { configureDesktopViewer } from "./desktop-viewer.js";

export function createServer({
  desktopViewer = null,
  viewer = null,
  python = null,
  context = {},
  onCall = null,
} = {}) {
  configureDesktopViewer(desktopViewer);

  const defaultHandlers = createDefaultIfcMcpToolHandlers();
  const hostHandlers = createIfcMcpHostHandlers({ viewer, python });
  const toolHost = createIfcMcpToolHost({
    defaultHandlers: {
      ...defaultHandlers,
      ...hostHandlers,
    },
    context,
    onCall,
  });

  const server = new McpServer({
    name: "IFC MCP",
    version: "0.1.14",
  });

  for (const tool of toolHost.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
      },
      async (args) => jsonToolResult(await toolHost.callTool(tool.name, args)),
    );
  }

  return server;
}

export async function main(options = {}) {
  const transport = new StdioServerTransport();
  await createServer(options).connect(transport);
}

export {
  IFC_MCP_TOOL_DEFINITIONS,
  IFC_MCP_TOOL_NAMES,
} from "./tool-host.js";
export { createIfcMcpHost } from "./browser.js";

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
