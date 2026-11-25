import { z } from 'zod';

export const JSON_RPC_VERSION = '2.0';
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export enum McpMethod {
  INITIALIZE = 'initialize',
  TOOLS_LIST = 'tools/list',
  TOOLS_CALL = 'tools/call',
}

const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

const jsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

/**
 * JSON-RPC 2.0 response envelope. `result` stays `unknown` because its shape is
 * tool-specific; callers validate it with their own schema at the point of use.
 */
export const jsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: jsonRpcIdSchema,
  result: z.unknown().optional(),
  error: jsonRpcErrorSchema.optional(),
});

/**
 * The routing scope the backend publishes per tool: how much of a principal its answer depends on.
 * A tool that declares none is routed as {@link ToolScope.ACCOUNT} — see `backend-registry.ts`.
 */
export enum ToolScope {
  CATALOG = 'catalog',
  IDENTITY = 'identity',
  ACCOUNT = 'account',
}

/**
 * Tool annotations. `loose()` because the spec keeps adding hint fields and an unknown one must
 * not fail the whole catalog; an unrecognised `scope` value is dropped rather than guessed at.
 */
const mcpToolAnnotationsSchema = z
  .object({
    readOnlyHint: z.boolean().optional(),
    scope: z.enum(ToolScope).optional().catch(undefined),
  })
  .loose();

export const mcpToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: mcpToolAnnotationsSchema.optional(),
});

export const toolsListResultSchema = z.object({
  tools: z.array(mcpToolDefinitionSchema),
  nextCursor: z.string().optional(),
});

export type McpToolDefinition = z.infer<typeof mcpToolDefinitionSchema>;
export type ToolsListResult = z.infer<typeof toolsListResultSchema>;

/** SIWE auth (REST) — mirrors backend AuthResponseDto. */
export const authSessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
  user: z.object({ id: z.string(), address: z.string() }),
});

export const nonceResponseSchema = z.object({
  nonce: z.string(),
  message: z.string(),
});

export type AuthSession = z.infer<typeof authSessionSchema>;
export type NonceResponse = z.infer<typeof nonceResponseSchema>;
