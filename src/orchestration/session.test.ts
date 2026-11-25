import { describe, expect, it } from 'vitest';
import { parseContractVersion, SessionStore } from './session.js';

describe('parseContractVersion', () => {
  it('extracts the semver prefix from a versionId', () => {
    expect(parseContractVersion('1.0.0-evm')).toBe('1.0.0');
    expect(parseContractVersion('1.2.0-tvm-728126428')).toBe('1.2.0');
  });

  it('falls back to the raw id for a malformed version (informational value, never blocks selection)', () => {
    expect(parseContractVersion('latest-evm')).toBe('latest-evm');
    expect(parseContractVersion('1.0-evm')).toBe('1.0-evm');
    expect(parseContractVersion('')).toBe('');
  });
});

describe('SessionStore', () => {
  it('throws until an account is selected', () => {
    const store = new SessionStore();
    expect(() => store.require()).toThrow(/No account selected/);

    const session = {
      chainKind: 'evm',
      deploymentId: 'd1',
      contract: '0x1',
      chainId: 1,
      rpcUrl: 'https://rpc.test',
      version: '1.0.0',
    } as const;
    store.select(session);
    expect(store.require()).toEqual(session);
  });

  it('keeps a captured snapshot stable across a concurrent select (immutable swap)', () => {
    const store = new SessionStore();
    const first = {
      chainKind: 'evm',
      deploymentId: 'd1',
      contract: '0x1',
      chainId: 1,
      rpcUrl: 'https://rpc.test',
      version: '1.0.0',
    } as const;
    store.select(first);

    const captured = store.require();

    store.select({ ...first, deploymentId: 'd2', chainId: 2 });

    expect(captured).toEqual(first);
    expect(captured.deploymentId).toBe('d1');
    expect(store.current()?.deploymentId).toBe('d2');
  });
});
