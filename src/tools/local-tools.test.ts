import { describe, expect, it } from 'vitest';
import { BackendRegistry } from '../backend/backend-registry.js';
import type { AppConfig } from '../config/env.js';
import type { KeySlots } from '../keystore/key-sources.js';
import { Keystore } from '../keystore/keystore.js';
import { SessionStore } from '../orchestration/session.js';
import { buildLocalTools, type LocalTool } from './local-tools.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const EVM_CHAIN = 11155111;
const TVM_CHAIN = 728126428;

function config(defaultChainId = EVM_CHAIN): AppConfig {
  return {
    backendApiUrl: 'http://localhost:3000',
    backendMcpUrl: 'http://localhost:3005/mcp',
    authUrl: 'http://localhost:4201',
    defaultChainId,
    tronFeeLimit: 150_000_000,
    networks: { [EVM_CHAIN]: 'https://rpc.test', [TVM_CHAIN]: 'https://api.trongrid.io' },
    keySource: 'env',
    authChainId: {},
  };
}

function tools(slots: KeySlots, cfg = config()): LocalTool[] {
  const keystore = Keystore.fromSlots(slots);
  const registry = BackendRegistry.build(cfg, keystore);
  return buildLocalTools({ keystore, registry, sessions: new SessionStore(), config: cfg });
}

function byName(list: LocalTool[], name: string): LocalTool {
  const tool = list.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`${name} tool not found`);
  }
  return tool;
}

describe('select_account slot guards', () => {
  it('rejects a TVM chain when only the EVM slot is filled', async () => {
    const list = tools({ evm: KEY });
    await expect(byName(list, 'select_account').handler({ accountId: 'a1', chainId: TVM_CHAIN })).rejects.toThrow(
      /No TVM identity configured/,
    );
  });

  it('rejects an EVM chain when only the TVM slot is filled', async () => {
    const list = tools({ tvm: KEY });
    await expect(byName(list, 'select_account').handler({ accountId: 'a1', chainId: EVM_CHAIN })).rejects.toThrow(
      /No EVM identity configured/,
    );
  });

  it('requires an explicit chainId when the default chain has no filled slot', async () => {
    const list = tools({ tvm: KEY }, config(EVM_CHAIN));
    await expect(byName(list, 'select_account').handler({ accountId: 'a1' })).rejects.toThrow(
      /pass an explicit chainId/,
    );
  });
});

describe('get_signer_addresses', () => {
  it('returns one address per configured slot', async () => {
    const list = tools({ evm: KEY, tvm: KEY });
    const parsed = JSON.parse(await byName(list, 'get_signer_addresses').handler({}));
    expect(parsed.evm).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(parsed.tvm).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it('omits an unconfigured slot', async () => {
    const list = tools({ evm: KEY });
    const parsed = JSON.parse(await byName(list, 'get_signer_addresses').handler({}));
    expect(parsed.evm).toBeDefined();
    expect(parsed.tvm).toBeUndefined();
  });
});

describe('claim', () => {
  it('requires an account to be selected before touching the backend', async () => {
    const list = tools({ evm: KEY });
    await expect(byName(list, 'claim').handler({ currencyId: '11155111-0xabc' })).rejects.toThrow(
      /No account selected/,
    );
  });
});

describe('local tool annotations', () => {
  /** The local tools that commit the keystore key: an on-chain broadcast or a signature counted toward threshold. */
  const ON_CHAIN_TOOLS = ['deploy_account', 'sign_operation', 'execute_operation', 'claim'];

  it('marks exactly the on-chain tools destructive and every other local tool non-destructive', () => {
    for (const tool of tools({ evm: KEY })) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations?.destructiveHint ?? false, tool.name).toBe(ON_CHAIN_TOOLS.includes(tool.name));
    }
  });
});

describe('review_operation and sign_operation', () => {
  it('exposes a read-only review tool next to the destructive signing tool', () => {
    const list = tools({ evm: KEY });
    const review = byName(list, 'review_operation');
    const sign = byName(list, 'sign_operation');

    expect(review.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(sign.annotations).toEqual({ destructiveHint: true, readOnlyHint: false });
    expect(sign.inputSchema.required).toEqual(['operationId', 'confirm']);
    expect(Object.keys(sign.inputSchema.properties ?? {})).toEqual(['operationId', 'confirm', 'allowUnknownCalls']);
  });

  it('requires a selected account before reviewing', async () => {
    const list = tools({ evm: KEY });

    await expect(byName(list, 'review_operation').handler({ operationId: '1' })).rejects.toThrow(/No account selected/);
  });
});
