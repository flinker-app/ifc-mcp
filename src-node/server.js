import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createDefaultIfcMcpToolHandlers } from "./default-handlers.js";
import { createIfcMcpHostHandlers } from "./host-handlers.js";
import { createIfcMcpToolHost } from "./tool-host.js";
import { configureDesktopViewer } from "./desktop-viewer.js";
import { publicToolDefinition } from "./tool-definitions.js";
import { createLocalPythonRuntime } from "./python-local.js";
import { onPythonFileRevocation } from "./approved-python-files.js";
import { stopViewerServer } from "./viewer.js";

const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export function createServer(options) {
  return buildServer(options);
}

function buildServer({
  desktopViewer = null,
  viewer = null,
  python = null,
  context = {},
  onCall = null,
  fileHandoffEntry = null,
  timeoutMs,
  maxConcurrentCalls,
} = {}, stdioRuntime) {
  configureDesktopViewer(desktopViewer);

  const runtime = stdioRuntime ?? createLocalPythonRuntime();
  const defaultHandlers = createDefaultIfcMcpToolHandlers(fileHandoffEntry, runtime);
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
  const unsubscribe = onPythonFileRevocation(id => runtime.revoke(id));
  server.onclose = () => {
    unsubscribe();
    void runtime.reset()?.catch(error => console.error(error));
  };
  server.setRequestHandler("tools/list", () => ({ tools: toolHost.tools.map(publicToolDefinition) }));
  let checkedClient = false;
  server.setRequestHandler("tools/call", ({ params }, { mcpReq }) => {
    if (stdioRuntime && !checkedClient) {
      checkedClient = true;
      const client = mcpReq.envelope?.clientInfo ?? server.getClientVersion();
      // Codex gives each conversation its own local MCP connection.
      if (client?.name === "codex-mcp-client") runtime.keepWarmForChat();
    }
    return toolHost.callTool(params.name, params.arguments, { signal: mcpReq.signal });
  });

  return server;
}

export async function main(options = {}) {
  const reportError = error => console.error(error);
  const transport = new StdioServerTransport();
  const runtime = createLocalPythonRuntime();
  const handle = serveStdio(() => buildServer(options, runtime), { transport, onerror: reportError });
  let shutdown;
  const close = () => {
    if (!shutdown) {
      shutdown = (async () => {
        process.off("SIGINT", onShutdown);
        process.off("SIGTERM", onShutdown);
        await Promise.all([handle.close(), stopViewerServer(), runtime.reset()]);
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
