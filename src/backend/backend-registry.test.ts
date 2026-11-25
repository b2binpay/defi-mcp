import { describe, expect, it, vi } from 'vitest';
import type { ChainKind } from '../config/chain-kind.js';
import type { AppConfig } from '../config/env.js';
import { Keystore } from '../keystore/keystore.js';
import { SessionStore } from '../orchestration/session.js';
import {
  type BackendCallable,
  BackendRegistry,
  BackendRouter,
  type ProtocolClients,
  toolScopes,
} from './backend-registry.js';
import { JsonRpcCallError } from './mcp-client.js';
import { ToolScope } from './types.js';

const TVM_CHAIN = 728126428;
const EVM_CHAIN = 11155111;
const EVM_ADDRESS = '0x2222222222222222222222222222222222222222';
const TRON_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function config(authChainId: AppConfig['authChainId']): AppConfig {
  return {
    backendApiUrl: 'http://localhost:3000',
    backendMcpUrl: 'http://localhost:3005/mcp',
    authUrl: 'http://localhost:4201',
    defaultChainId: EVM_CHAIN,
    tronFeeLimit: 150_000_000,
    networks: { [EVM_CHAIN]: 'https://rpc.test', [TVM_CHAIN]: 'https://api.trongrid.io' },
    keySource: 'env',
    authChainId,
  };
}

function fakeClients(kinds: ChainKind[]): {
  clients: ProtocolClients;
  calls: Record<ChainKind, ReturnType<typeof vi.fn>>;
} {
  const calls = { evm: vi.fn(), tvm: vi.fn() };
  const clientFor = (kind: ChainKind): BackendCallable => {
    if (!kinds.includes(kind)) {
      throw new Error(`No ${kind.toUpperCase()} identity configured`);
    }
    return { callTool: async (name, args) => calls[kind](name, args) };
  };
  const clients: ProtocolClients = {
    filledKinds: () => kinds,
    clientFor,
    discoveryClient: () => clientFor(kinds[0]),
  };
  return { clients, calls };
}

const CATALOG_TOOLS = [
  'list_currencies',
  'get_currency',
  'list_networks',
  'get_rates',
  'get_service_status',
  'get_smart_contract_version',
  'list_credit_pricing',
  'list_cross_chain_routes',
];

/** The scopes the backend publishes in `tools/list`, parsed the way boot parses them. */
function backendScopes() {
  return toolScopes([
    ...CATALOG_TOOLS.map((name) => definition(name, ToolScope.CATALOG)),
    definition('list_accounts', ToolScope.IDENTITY),
    definition('get_profile', ToolScope.IDENTITY),
    definition('list_invoices', ToolScope.ACCOUNT),
    definition('get_account', ToolScope.ACCOUNT),
    definition('propose_stake', ToolScope.ACCOUNT),
  ]);
}

function definition(name: string, scope: ToolScope) {
  return { name, inputSchema: {}, annotations: { scope } };
}

describe('BackendRegistry.build auth-chain override', () => {
  it('rejects an override whose chain kind does not match the slot', () => {
    const keystore = Keystore.fromSlots({ evm: KEY });
    expect(() => BackendRegistry.build(config({ evm: TVM_CHAIN }), keystore)).toThrow(/not a EVM chain/);
  });

  it('accepts an override of the matching kind', () => {
    const keystore = Keystore.fromSlots({ evm: KEY });
    expect(() => BackendRegistry.build(config({ evm: EVM_CHAIN }), keystore)).not.toThrow();
  });
});

describe('BackendRouter', () => {
  it('routes to the sole filled slot when no session is selected', async () => {
    const { clients, calls } = fakeClients(['evm']);
    const router = new BackendRouter(clients, new SessionStore());
    calls.evm.mockResolvedValue({ ok: true });
    await router.callTool('list_invoices', {});
    expect(calls.evm).toHaveBeenCalledWith('list_invoices', {});
  });

  it('pins routing to the selected session protocol', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const sessions = new SessionStore();
    sessions.select({
      chainKind: 'tvm',
      deploymentId: 'd',
      contract: 'T',
      chainId: TVM_CHAIN,
      fullHost: 'h',
      version: '1.0.0',
    });
    const router = new BackendRouter(clients, sessions);
    calls.tvm.mockResolvedValue({ ok: true });
    await router.callTool('get_queue_operation', { operationId: 'o1' });
    expect(calls.tvm).toHaveBeenCalledOnce();
    expect(calls.evm).not.toHaveBeenCalled();
  });

  it('fans out an identity-wide read across both slots and tags each result', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    calls.evm.mockResolvedValue({ accounts: ['e'] });
    calls.tvm.mockResolvedValue({ accounts: ['t'] });
    const merged = await router.callTool('list_accounts', {});
    expect(merged).toEqual([
      { protocol: 'evm', result: { accounts: ['e'] } },
      { protocol: 'tvm', result: { accounts: ['t'] } },
    ]);
  });

  it('routes a catalog read to a single slot, not fanned out', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore(), backendScopes());
    calls.evm.mockResolvedValue({ currencies: [] });
    await router.callTool('list_currencies', {});
    expect(calls.evm).toHaveBeenCalledOnce();
    expect(calls.tvm).not.toHaveBeenCalled();
  });

  it.each(CATALOG_TOOLS)('routes the catalog read %s to a single slot', async (name) => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore(), backendScopes());
    calls.evm.mockResolvedValue({ ok: true });

    await router.callTool(name, {});

    expect(calls.evm).toHaveBeenCalledOnce();
    expect(calls.tvm).not.toHaveBeenCalled();
  });

  it('fans out get_profile across both slots — it describes the principal, not an account', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    calls.evm.mockResolvedValue({ baseCurrency: 'usd' });
    calls.tvm.mockResolvedValue({ baseCurrency: 'eur' });

    const merged = await router.callTool('get_profile', {});

    expect(merged).toEqual([
      { protocol: 'evm', result: { baseCurrency: 'usd' } },
      { protocol: 'tvm', result: { baseCurrency: 'eur' } },
    ]);
  });

  it('treats list_cross_chain_routes as a catalog read only until it names a deployment', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore(), backendScopes());
    calls.evm.mockResolvedValue({ chains: [] });

    await router.callTool('list_cross_chain_routes', {});
    expect(calls.evm).toHaveBeenCalledOnce();

    await expect(
      router.callTool('list_cross_chain_routes', { deploymentId: 'd1', srcCurrencyId: 'c1' }),
    ).rejects.toThrow(/Select an account first/);
    expect(calls.evm).toHaveBeenCalledOnce();
  });

  it('takes the classification from the catalog, so a backend-side change needs no code here', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const scopes = toolScopes([definition('list_super_representatives', ToolScope.CATALOG)]);
    const router = new BackendRouter(clients, new SessionStore(), scopes);
    calls.evm.mockResolvedValue({ witnesses: [] });

    await router.callTool('list_super_representatives', {});

    expect(calls.evm).toHaveBeenCalledOnce();
    expect(calls.tvm).not.toHaveBeenCalled();
  });

  it('falls back to account scope for a tool the catalog does not classify', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());

    await expect(router.callTool('list_currencies', {})).rejects.toThrow(/Select an account first/);
    expect(calls.evm).not.toHaveBeenCalled();
  });

  it.each(['list_accounts', 'get_profile'])(
    'still fans out %s against a backend that publishes no scopes',
    async (name) => {
      const { clients, calls } = fakeClients(['evm', 'tvm']);
      const router = new BackendRouter(clients, new SessionStore());
      calls.evm.mockResolvedValue({ ok: 'e' });
      calls.tvm.mockResolvedValue({ ok: 't' });

      const merged = await router.callTool(name, {});

      expect(merged).toEqual([
        { protocol: 'evm', result: { ok: 'e' } },
        { protocol: 'tvm', result: { ok: 't' } },
      ]);
    },
  );

  it('treats a scope value it does not know as account-scoped', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const scopes = toolScopes([
      { name: 'list_currencies', inputSchema: {}, annotations: { scope: 'global' as ToolScope } },
    ]);
    const router = new BackendRouter(clients, new SessionStore(), scopes);

    await expect(router.callTool('list_currencies', {})).rejects.toThrow(/Select an account first/);
    expect(calls.evm).not.toHaveBeenCalled();
  });

  it('keeps an unrecognised backend tool account-scoped', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());

    await expect(router.callTool('propose_stake', { deploymentId: 'd1' })).rejects.toThrow(/Select an account first/);
    expect(calls.evm).not.toHaveBeenCalled();
    expect(calls.tvm).not.toHaveBeenCalled();
  });

  it('requires a selection for an account-scoped tool when both slots are filled', async () => {
    const { clients } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    await expect(router.callTool('get_account', { accountId: 'a1' })).rejects.toThrow(/Select an account first/);
  });

  it('requires a selection for a deployment-scoped read when both slots are filled', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    await expect(router.callTool('list_invoices', { deploymentId: 'd1' })).rejects.toThrow(/Select an account first/);
    expect(calls.evm).not.toHaveBeenCalled();
    expect(calls.tvm).not.toHaveBeenCalled();
  });

  it('routes create_account by its isTron flag when both slots are filled', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    calls.tvm.mockResolvedValue({ accountId: 't1' });
    calls.evm.mockResolvedValue({ accountId: 'e1' });
    await router.callTool('create_account', { isTron: true, name: 'x' });
    expect(calls.tvm).toHaveBeenCalledOnce();
    expect(calls.evm).not.toHaveBeenCalled();
    await router.callTool('create_account', { name: 'y' });
    expect(calls.evm).toHaveBeenCalledOnce();
  });

  it('routes create_account by isTron even when a session of another protocol is selected', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const sessions = new SessionStore();
    sessions.select({
      chainKind: 'evm',
      deploymentId: 'd',
      contract: '0x00',
      chainId: 11155111,
      rpcUrl: 'r',
      version: '1.0.0',
    });
    const router = new BackendRouter(clients, sessions);
    calls.tvm.mockResolvedValue({ accountId: 't1' });
    await router.callTool('create_account', { isTron: true, name: 'x' });
    expect(calls.tvm).toHaveBeenCalledOnce();
    expect(calls.evm).not.toHaveBeenCalled();
  });

  it('rejects create_account for a TRON account when the TVM slot is empty', async () => {
    const { clients } = fakeClients(['evm']);
    const router = new BackendRouter(clients, new SessionStore());
    await expect(router.callTool('create_account', { isTron: true, name: 'x' })).rejects.toThrow(
      /No TVM identity configured/,
    );
  });

  it('rejects a non-boolean isTron on create_account', async () => {
    const { clients } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    await expect(router.callTool('create_account', { isTron: 'true', name: 'x' })).rejects.toThrow(
      /isTron must be a boolean/,
    );
  });

  it('routes create_address_book_entry by the address family, not fanned out', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    calls.evm.mockResolvedValue({ id: 'e' });
    calls.tvm.mockResolvedValue({ id: 't' });
    await router.callTool('create_address_book_entry', { label: 'a', address: EVM_ADDRESS.toLowerCase() });
    expect(calls.evm).toHaveBeenCalledOnce();
    expect(calls.tvm).not.toHaveBeenCalled();
    await router.callTool('create_address_book_entry', { label: 'b', address: TRON_ADDRESS });
    expect(calls.tvm).toHaveBeenCalledOnce();
    expect(calls.evm).toHaveBeenCalledOnce();
  });

  it('rejects create_address_book_entry for an address of neither family before calling any slot', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    for (const address of ['', 'not-an-address', '0x1234', 'T123']) {
      await expect(router.callTool('create_address_book_entry', { label: 'x', address })).rejects.toThrow(
        /neither an EVM nor a TRON address/,
      );
    }
    expect(calls.evm).not.toHaveBeenCalled();
    expect(calls.tvm).not.toHaveBeenCalled();
  });

  it('rejects create_address_book_entry for a TRON address when the TVM slot is empty', async () => {
    const { clients } = fakeClients(['evm']);
    const router = new BackendRouter(clients, new SessionStore());
    await expect(router.callTool('create_address_book_entry', { label: 'x', address: TRON_ADDRESS })).rejects.toThrow(
      /No TVM identity configured/,
    );
  });

  it('tags a degraded slot with its error without failing the healthy one', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    calls.evm.mockResolvedValue({ accounts: ['e'] });
    calls.tvm.mockRejectedValue(new Error('tvm auth failed'));
    const merged = await router.callTool('list_accounts', {});
    expect(merged).toEqual([
      { protocol: 'evm', result: { accounts: ['e'] } },
      { protocol: 'tvm', error: { message: 'tvm auth failed' } },
    ]);
  });

  it('carries a JSON-RPC error code and data through the degraded-slot tag', async () => {
    const { clients, calls } = fakeClients(['evm', 'tvm']);
    const router = new BackendRouter(clients, new SessionStore());
    calls.evm.mockResolvedValue({ accounts: ['e'] });
    calls.tvm.mockRejectedValue(new JsonRpcCallError(-32001, 'unauthorized', { reason: 'expired' }));
    const merged = await router.callTool('list_accounts', {});
    expect(merged).toEqual([
      { protocol: 'evm', result: { accounts: ['e'] } },
      { protocol: 'tvm', error: { message: 'unauthorized', code: -32001, data: { reason: 'expired' } } },
    ]);
  });
});
