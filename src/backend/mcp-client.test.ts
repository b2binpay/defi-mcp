import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendAuth } from './auth.js';
import { BackendMcpClient } from './mcp-client.js';
import { MCP_PROTOCOL_VERSION } from './types.js';

const MCP_URL = 'http://localhost:3001/mcp';

function stubAuth(token = 'jwt-token'): BackendAuth {
  return {
    getAccessToken: vi.fn().mockResolvedValue(token),
    reauthenticate: vi.fn().mockResolvedValue(undefined),
  } as unknown as BackendAuth;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BackendMcpClient', () => {
  it('sends a well-formed JSON-RPC tools/call with Bearer auth and protocol header', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    const client = new BackendMcpClient({ mcpUrl: MCP_URL, auth: stubAuth() });

    const result = await client.callTool('propose_payout', { amount: '10.00' });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(MCP_URL);
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer jwt-token',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'content-type': 'application/json',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'propose_payout', arguments: { amount: '10.00' } },
    });
  });

  it('maps a JSON-RPC error response to JsonRpcCallError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params', data: ['x'] } }),
    );
    const client = new BackendMcpClient({ mcpUrl: MCP_URL, auth: stubAuth() });

    await expect(client.callTool('propose_payout')).rejects.toMatchObject({
      name: 'JsonRpcCallError',
      code: -32602,
      message: 'bad params',
      data: ['x'],
    });
  });

  it('re-authenticates once on JSON-RPC UNAUTHORIZED and retries', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unauthorized' } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 2, result: { ok: true } }));
    const auth = stubAuth();
    const client = new BackendMcpClient({ mcpUrl: MCP_URL, auth });

    const result = await client.callTool('list_queue_operations');

    expect(result).toEqual({ ok: true });
    expect(auth.reauthenticate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-authenticates on HTTP 401 and retries', async () => {
    const auth = stubAuth();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 401, statusText: 'Unauthorized' }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 2, result: { ok: true } }));
    const client = new BackendMcpClient({ mcpUrl: MCP_URL, auth });

    await expect(client.callTool('list_queue_operations')).resolves.toEqual({ ok: true });
    expect(auth.reauthenticate).toHaveBeenCalledTimes(1);
  });

  it('follows nextCursor pagination in listTools', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }], nextCursor: 'b' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'b', inputSchema: {} }] } }),
      );
    const client = new BackendMcpClient({ mcpUrl: MCP_URL, auth: stubAuth() });

    const tools = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['a', 'b']);
  });

  it('keeps a known scope annotation and drops an unknown one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: 'list_currencies', inputSchema: {}, annotations: { scope: 'catalog', readOnlyHint: true } },
            { name: 'list_invoices', inputSchema: {}, annotations: { scope: 'nonsense', futureHint: 1 } },
          ],
        },
      }),
    );
    const client = new BackendMcpClient({ mcpUrl: MCP_URL, auth: stubAuth() });

    const tools = await client.listTools();

    expect(tools[0].annotations?.scope).toBe('catalog');
    expect(tools[1].annotations?.scope).toBeUndefined();
  });

  it('rejects a response whose id does not match the request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ jsonrpc: '2.0', id: 999, result: { ok: true } }));
    const client = new BackendMcpClient({ mcpUrl: MCP_URL, auth: stubAuth() });

    await expect(client.callTool('list_queue_operations')).rejects.toThrow(/id mismatch/);
  });

  it('aborts listTools on a repeating cursor', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const id = JSON.parse(init?.body as string).id;
      return jsonResponse({
        jsonrpc: '2.0',
        id,
        result: { tools: [{ name: 'a', inputSchema: {} }], nextCursor: 'loop' },
      });
    });
    const client = new BackendMcpClient({ mcpUrl: MCP_URL, auth: stubAuth() });

    await expect(client.listTools()).rejects.toThrow(/repeating cursor/);
  });
});
