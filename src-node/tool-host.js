import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { toolResult, toolError } from "./tool-results.js";
import { abortable } from "./operations.js";
import {
  IFC_MCP_TOOL_DEFINITIONS,
  getIfcMcpToolDefinition,
} from "./tool-definitions.js";

export function createIfcMcpToolHost({
  handlers = {},
  defaultHandlers = {},
  context = {},
  onCall = null,
  timeoutMs = 600_000,
  maxConcurrentCalls = 4,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be positive.");
  if (!Number.isInteger(maxConcurrentCalls) || maxConcurrentCalls < 1) throw new RangeError("maxConcurrentCalls must be a positive integer.");
  let activeCalls = 0;
  const handlerMap = {
    ...defaultHandlers,
    ...handlers,
  };

  const host = {
    tools: IFC_MCP_TOOL_DEFINITIONS,

    async callTool(name, args = {}, { signal } = {}) {
      const tool = getIfcMcpToolDefinition(name);
      if (!tool) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown IFC MCP tool: ${name}`);
      }

      const handler = handlerMap[tool.name];
      if (typeof handler !== "function") {
        throw new ProtocolError(ProtocolErrorCode.InternalError, `No handler configured for IFC MCP tool: ${tool.name}`);
      }

      if (activeCalls >= maxConcurrentCalls) return toolError("Too many tool calls are running. Wait for one to finish before retrying.");
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason ?? new Error("Tool call cancelled."));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const timeout = setTimeout(() => controller.abort(new Error(`Tool call exceeded ${timeoutMs} ms.`)), timeoutMs);
      try {
        controller.signal.throwIfAborted();
        const parsed = tool.schema.safeParse(args);
        if (!parsed.success) return toolError(`Input validation error: ${parsed.error.message}`);
        const input = parsed.data;
        activeCalls++;
        const running = (async () => {
          try {
            if (typeof onCall === "function") await onCall({ name: tool.name, input, tool, context, signal: controller.signal });
            controller.signal.throwIfAborted();
            const result = toolResult(await handler(input, { tool, context, signal: controller.signal,
              callTool: (nextName, nextArgs) => host.callTool(nextName, nextArgs, { signal: controller.signal }) }));
            CallToolResultSchema.parse(result);
            return result;
          } finally { activeCalls--; }
        })();
        return await abortable(running, controller.signal);
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        return toolError(error);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
      }
    },
  };

  return host;
}

export {
  IFC_MCP_TOOL_DEFINITIONS,
  IFC_MCP_TOOL_NAMES,
  getIfcMcpToolDefinition,
} from "./tool-definitions.js";
