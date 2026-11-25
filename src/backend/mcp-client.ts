import type { BackendAuth } from './auth.js';
import { HTTP_TIMEOUT_MS } from './http.js';
import {
  JSON_RPC_VERSION,
  jsonRpcEnvelopeSchema,
  MCP_PROTOCOL_VERSION,
  McpMethod,
  type McpToolDefinition,
  toolsListResultSchema,
} from './types.js';

const JSON_RPC_UNAUTHORIZED = -32001;
const HTTP_UNAUTHORIZED = 401;

export class JsonRpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcCallError';
  }
}

/** The JSON-RPC error detail worth keeping once a call has failed, for any caller that needs it. */
export interface ErrorDetail {
  readonly message: string;
  readonly code?: number;
  readonly data?: unknown;
}

/**
 * Extracts `{ code, message, data }` from a caught value the same way everywhere a failed
 * `callTool` result is surfaced, so a `JsonRpcCallError`'s `code`/`data` survive to the client
 * (`gateway.ts`'s single-call path, `backend-registry.ts`'s identity fan-out) instead of one path
 * keeping them and the other collapsing to a bare message.
 */
export function describeError(error: unknown): ErrorDetail {
  if (error instanceof JsonRpcCallError) {
    return { message: error.message, code: error.code, data: error.data };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function isAuthError(error: unknown): boolean {
  // Only 401 / JSON-RPC unauthorized warrant a re-auth. 403 is authorization (a legitimately
  // forbidden call) — re-authenticating would burn a full auth cycle on every denied request.
  return (
    error instanceof JsonRpcCallError && (error.code === JSON_RPC_UNAUTHORIZED || error.code === HTTP_UNAUTHORIZED)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The backend returns the bare tool DTO in `result`. If it ever returns a spec-compliant MCP
 * `CallToolResult` flagged `isError`, surface it as an error instead of relaying the failure
 * as a successful result. A bare DTO (no `isError`) passes straight through unchanged.
 */
function unwrapToolError(name: string, result: unknown): unknown {
  if (!isRecord(result) || result.isError !== true) {
    return result;
  }
  const content = result.content;
  const text = Array.isArray(content)
    ? content
        .map((entry) => (isRecord(entry) && typeof entry.text === 'string' ? entry.text : ''))
        .join(' ')
        .trim()
    : '';
  throw new JsonRpcCallError(0, `Backend tool ${name} failed${text ? `: ${text}` : ''}`);
}

export interface BackendMcpClientOptions {
  mcpUrl: string;
  auth: BackendAuth;
}

/**
 * JSON-RPC 2.0 client for the backend `POST /mcp` endpoint. Injects the identity's JWT
 * (SIWE for EVM, TIP-191 for TRON) as a Bearer token and re-authenticates once on an auth failure.
 */
export class BackendMcpClient {
  private nextId = 1;

  constructor(private readonly options: BackendMcpClientOptions) {}

  async initialize(): Promise<unknown> {
    return this.call(McpMethod.INITIALIZE);
  }

  /** All backend tools, following `nextCursor` pagination to completion. */
  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const raw = await this.call(McpMethod.TOOLS_LIST, cursor ? { cursor } : {});
      const page = toolsListResultSchema.parse(raw);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new JsonRpcCallError(0, 'tools/list returned a repeating cursor; aborting pagination');
      }
      if (cursor) {
        seenCursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return unwrapToolError(name, await this.call(McpMethod.TOOLS_CALL, { name, arguments: args }));
  }

  private async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.dispatch(method, params);
    } catch (error) {
      if (isAuthError(error)) {
        await this.options.auth.reauthenticate();
        return this.dispatch(method, params);
      }
      throw error;
    }
  }

  private async dispatch(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const accessToken = await this.options.auth.getAccessToken();
    const id = this.nextId++;
    const response = await fetch(this.options.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new JsonRpcCallError(response.status, `MCP transport error: ${response.status} ${response.statusText}`);
    }

    const envelope = jsonRpcEnvelopeSchema.parse(await response.json());
    if (envelope.id !== id) {
      throw new JsonRpcCallError(0, `JSON-RPC id mismatch: expected ${id}, got ${String(envelope.id)}`);
    }
    if (envelope.error) {
      throw new JsonRpcCallError(envelope.error.code, envelope.error.message, envelope.error.data);
    }
    return envelope.result;
  }
}
