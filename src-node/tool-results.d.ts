import type { CallToolResult } from "@modelcontextprotocol/server";
export type { CallToolResult } from "@modelcontextprotocol/server";
export function toolResult(value: unknown, isError?: boolean): CallToolResult;
export function toolError(error: unknown): CallToolResult;
export function toolResultText(result: CallToolResult): string;
export function bcfToolResult(report?: unknown): CallToolResult;
export function pythonToolResult(value: unknown): CallToolResult;
