import { describe, expect, it, vi } from 'vitest';
import type { KeyringApi } from '../keystore/keychain-source.js';
import { type KeychainCliIo, runKeychainCli } from './keychain.js';

const RAW_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SERVICE = 'b2binpay-defi-mcp';

interface Harness {
  io: KeychainCliIo;
  store: Map<string, string>;
  out: string[];
  err: string[];
  readSecret: ReturnType<typeof vi.fn>;
}

function harness(secret = RAW_KEY): Harness {
  const store = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const readSecret = vi.fn(async () => secret);
  const keyring: KeyringApi = {
    AsyncEntry: class {
      private readonly key: string;
      constructor(service: string, account: string) {
        this.key = `${service}:${account}`;
      }
      async getPassword(): Promise<string | null> {
        return store.has(this.key) ? (store.get(this.key) as string) : null;
      }
      async setPassword(password: string): Promise<void> {
        store.set(this.key, password);
      }
      async deleteCredential(): Promise<boolean> {
        return store.delete(this.key);
      }
    },
  };
  const io: KeychainCliIo = {
    loadKeyring: async () => keyring,
    readSecret,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, store, out, err, readSecret };
}

describe('runKeychainCli', () => {
  it('set stores the secret read from the injected source, not argv', async () => {
    const h = harness(RAW_KEY);
    await runKeychainCli(['set', 'evm'], h.io);
    expect(h.readSecret).toHaveBeenCalledOnce();
    expect(h.store.get(`${SERVICE}:evm`)).toBe(RAW_KEY);
  });

  it('rejects an extra argv value, reads nothing, and stores nothing', async () => {
    const h = harness();
    await expect(runKeychainCli(['set', 'evm', RAW_KEY], h.io)).rejects.toThrow(/usage/);
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(h.store.size).toBe(0);
  });

  it('rejects an invalid secret and stores nothing', async () => {
    const h = harness('not-a-key-or-mnemonic');
    await expect(runKeychainCli(['set', 'tvm'], h.io)).rejects.toThrow(/BIP39/);
    expect(h.store.size).toBe(0);
  });

  it('set overwrites an existing entry', async () => {
    const h = harness(RAW_KEY);
    h.store.set(`${SERVICE}:evm`, '0xdead');
    await runKeychainCli(['set', 'evm'], h.io);
    expect(h.store.get(`${SERVICE}:evm`)).toBe(RAW_KEY);
  });

  it('rm is idempotent — succeeds when the entry is absent', async () => {
    const h = harness();
    await expect(runKeychainCli(['rm', 'tvm'], h.io)).resolves.toBeUndefined();
  });

  it('rm deletes an existing entry', async () => {
    const h = harness();
    h.store.set(`${SERVICE}:evm`, RAW_KEY);
    await runKeychainCli(['rm', 'evm'], h.io);
    expect(h.store.has(`${SERVICE}:evm`)).toBe(false);
  });

  it('list prints presence only, never the stored value', async () => {
    const h = harness();
    h.store.set(`${SERVICE}:evm`, RAW_KEY);
    await runKeychainCli(['list'], h.io);
    expect(h.out).toEqual(['evm: set', 'tvm: absent']);
    expect(h.out.join('\n')).not.toContain(RAW_KEY);
  });

  it('rm rethrows a locked/unavailable keychain error instead of reporting success', async () => {
    const out: string[] = [];
    const keyring: KeyringApi = {
      AsyncEntry: class {
        async getPassword(): Promise<string | null> {
          throw new Error('the keychain is locked');
        }
        async setPassword(): Promise<void> {}
        async deleteCredential(): Promise<boolean> {
          throw new Error('the keychain is locked');
        }
      },
    };
    const io: KeychainCliIo = {
      loadKeyring: async () => keyring,
      readSecret: async () => '',
      out: (line) => out.push(line),
      err: () => {},
    };
    await expect(runKeychainCli(['rm', 'evm'], io)).rejects.toThrow(/locked/);
  });

  it('list treats a NoEntry-throwing backend as absent, not a failure', async () => {
    const out: string[] = [];
    const store = new Map<string, string>([[`${SERVICE}:evm`, RAW_KEY]]);
    const keyring: KeyringApi = {
      AsyncEntry: class {
        private readonly key: string;
        constructor(service: string, account: string) {
          this.key = `${service}:${account}`;
        }
        async getPassword(): Promise<string | null> {
          if (!store.has(this.key)) {
            throw Object.assign(new Error('No matching entry found in secure storage'), { code: 'NoEntry' });
          }
          return store.get(this.key) as string;
        }
        async setPassword(): Promise<void> {}
        async deleteCredential(): Promise<boolean> {
          return store.delete(this.key);
        }
      },
    };
    const io: KeychainCliIo = {
      loadKeyring: async () => keyring,
      readSecret: async () => '',
      out: (line) => out.push(line),
      err: () => {},
    };
    await runKeychainCli(['list'], io);
    expect(out).toEqual(['evm: set', 'tvm: absent']);
  });

  it('rejects an unknown subcommand', async () => {
    const h = harness();
    await expect(runKeychainCli(['bogus'], h.io)).rejects.toThrow(/usage/);
  });

  it('rejects an unknown slot', async () => {
    const h = harness();
    await expect(runKeychainCli(['set', 'btc'], h.io)).rejects.toThrow(/unknown slot/);
    expect(h.readSecret).not.toHaveBeenCalled();
  });

  it('never echoes a mistyped secret passed as the slot argument', async () => {
    const h = harness();
    // `keychain set <key>` with the slot omitted: the key lands in the slot position.
    let caught: unknown;
    await runKeychainCli(['set', RAW_KEY], h.io).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error('expected a thrown Error');
    }
    expect(caught.message).toMatch(/unknown slot/);
    expect(caught.message).not.toContain(RAW_KEY);
    expect(h.readSecret).not.toHaveBeenCalled();
    expect(h.store.size).toBe(0);
  });
});
