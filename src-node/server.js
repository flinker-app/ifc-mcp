import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createDefaultIfcMcpToolHandlers } from "./default-handlers.js";
import { createIfcMcpHostHandlers } from "./host-handlers.js";
import { createIfcMcpToolHost } from "./tool-host.js";
import { configureDesktopViewer } from "./desktop-viewer.js";
import { publicToolDefinition } from "./tool-definitions.js";
import { closePythonRuntime } from "./python-local.js";
import { stopViewerServer } from "./viewer.js";

const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export function createServer({
  desktopViewer = null,
  viewer = null,
  python = null,
  context = {},
  onCall = null,
  fileHandoffEntry = null,
  timeoutMs,
  maxConcurrentCalls,
} = {}) {
  configureDesktopViewer(desktopViewer);

  const defaultHandlers = createDefaultIfcMcpToolHandlers(fileHandoffEntry);
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

  const server = new Server({ name, version }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: toolHost.tools.map(publicToolDefinition) }));
  server.setRequestHandler("tools/call", ({ params }, { mcpReq }) =>
    toolHost.callTool(params.name, params.arguments, { signal: mcpReq.signal }));

  return server;
}

export async function main(options = {}) {
  const reportError = error => console.error(error);
  const transport = new StdioServerTransport();
  const handle = serveStdio(() => createServer(options), { transport, onerror: reportError });
  let shutdown;
  const close = () => {
    if (!shutdown) {
      shutdown = (async () => {
        process.off("SIGINT", onShutdown);
        process.off("SIGTERM", onShutdown);
        closePythonRuntime();
        await Promise.all([handle.close(), stopViewerServer()]);
      })();
    }
    return shutdown;
  };
  const onShutdown = () => { void close().catch(reportError); };
  const onTransportClose = transport.onclose;
  transport.onclose = () => { onTransportClose?.(); onShutdown(); };
  process.once("SIGINT", onShutdown);
  process.once("SIGTERM", onShutdown);
  return { close };
}

export {
  IFC_MCP_TOOL_DEFINITIONS,
  IFC_MCP_TOOL_NAMES,
} from "./tool-host.js";
export { createIfcMcpHost } from "./browser.js";
