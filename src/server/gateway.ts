import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describeError } from '../backend/mcp-client.js';
import { sanitizeToolSchema } from '../backend/schema-sanitize.js';
import type { McpToolDefinition } from '../backend/types.js';
import type { LocalTool } from '../tools/local-tools.js';

function errorText(error: unknown): string {
  const detail = describeError(error);
  if (detail.code === undefined) {
    return detail.message;
  }
  const data = detail.data === undefined ? '' : ` data=${JSON.stringify(detail.data)}`;
  return `[${detail.code}] ${detail.message}${data}`;
}

/** Routes a backend (proxied) tool call to the identity that owns the target account. */
export interface BackendCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface GatewayOptions {
  name: string;
  version: string;
  instructions: string;
  backend: BackendCaller;
  localTools: LocalTool[];
  backendTools: McpToolDefinition[];
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

/**
 * MCP gateway: exposes the local keystore/signing tools plus the backend's proxied
 * tools over one stdio surface. Local tools run in-process; unknown names are forwarded
 * to the backend `/mcp` verbatim.
 */
export function createGateway(options: GatewayOptions): Server {
  const { name, version, instructions, backend, localTools, backendTools } = options;
  const localByName = new Map(localTools.map((tool) => [tool.name, tool]));

  const toolDefinitions = [
    ...localTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
    ...backendTools
      .filter((tool) => !localByName.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: sanitizeToolSchema(tool.inputSchema),
        annotations: tool.annotations,
      })),
  ];

  const server = new Server({ name, version }, { capabilities: { tools: {} }, instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args = {} } = request.params;
    try {
      const local = localByName.get(toolName);
      if (local) {
        return textResult(await local.handler(args));
      }
      const result = await backend.callTool(toolName, args);
      return textResult(typeof result === 'string' ? result : JSON.stringify(result));
    } catch (error) {
      return textResult(errorText(error), true);
    }
  });

  return server;
}
