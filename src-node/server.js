import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createDefaultIfcMcpToolHandlers } from "./default-handlers.js";
import { createIfcMcpHostHandlers } from "./host-handlers.js";
import { createIfcMcpToolHost } from "./tool-host.js";
import { configureDesktopViewer } from "./desktop-viewer.js";
import { publicToolDefinition } from "./tool-definitions.js";

const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

class IfcMcpServer extends Server {
  // SDK 2.0.0's cancellation handler ignores falsy IDs, including the first
  // modern request (0). Reuse its controller so it also suppresses the reply.
  // Keep the SDK pinned and remove this shim when the upstream guard is fixed.
  _oncancel(notification) {
    const id = notification.params.requestId;
    if (id === 0 || id === "") this._requestHandlerAbortControllers.get(id)?.abort(notification.params.reason);
    else return super._oncancel(notification);
  }
}

export function createServer({
  desktopViewer = null,
  viewer = null,
  python = null,
  context = {},
  onCall = null,
  timeoutMs,
  maxConcurrentCalls,
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
    timeoutMs,
    maxConcurrentCalls,
  });

  const server = new IfcMcpServer({ name, version }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: toolHost.tools.map(publicToolDefinition) }));
  server.setRequestHandler("tools/call", ({ params }, { mcpReq }) =>
    toolHost.callTool(params.name, params.arguments, { signal: mcpReq.signal }));

  return server;
}

export async function main(options = {}) {
  return serveStdio(() => createServer(options), { onerror: error => console.error(error) });
}

export {
  IFC_MCP_TOOL_DEFINITIONS,
  IFC_MCP_TOOL_NAMES,
} from "./tool-host.js";
export { createIfcMcpHost } from "./browser.js";
