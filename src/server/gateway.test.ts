import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { JsonRpcCallError } from '../backend/mcp-client.js';
import { type BackendCaller, createGateway } from './gateway.js';

async function connectedClient(backend: BackendCaller) {
  const server = createGateway({
    name: 'test-gateway',
    version: '0.0.0',
    instructions: 'test',
    backend,
    localTools: [],
    backendTools: [],
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('createGateway — error detail propagation', () => {
  it('surfaces the JSON-RPC code and unrecognized_keys detail for a misspelled-argument call, not just the message', async () => {
    const backend: BackendCaller = {
      callTool: () =>
        Promise.reject(
          new JsonRpcCallError(-32602, 'Invalid tool arguments', [
            { code: 'unrecognized_keys', keys: ['pageSizeBOGUS'] },
          ]),
        ),
    };
    const client = await connectedClient(backend);

    const result = await client.callTool({
      name: 'list_address_book_entries',
      arguments: { pageSizeBOGUS: 1 },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('[-32602]');
    expect(text).toContain('unrecognized_keys');
    expect(text).toContain('pageSizeBOGUS');
    expect(text).not.toBe('Invalid tool arguments');
  });
});
