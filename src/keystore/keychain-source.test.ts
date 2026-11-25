import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** In-memory keychain shared by the mock; `locked` simulates an unavailable/locked store. */
const store = new Map<string, string>();
const state = { locked: false, throwNoEntry: false };

vi.mock('@napi-rs/keyring', () => {
  class AsyncEntry {
    private readonly key: string;
    constructor(service: string, account: string) {
      this.key = `${service}:${account}`;
    }
    async getPassword(): Promise<string | null> {
      if (state.locked) {
        throw new Error('the keychain is locked');
      }
      if (state.throwNoEntry && !store.has(this.key)) {
        // Some platforms raise a NoEntry error for a missing entry instead of returning null.
        throw Object.assign(new Error('No matching entry found in secure storage'), { code: 'NoEntry' });
      }
      return store.has(this.key) ? (store.get(this.key) as string) : null;
    }
    async setPassword(password: string): Promise<void> {
      store.set(this.key, password);
    }
    async deleteCredential(): Promise<boolean> {
      return store.delete(this.key);
    }
  }
  return { AsyncEntry };
});

const { KeychainKeySource } = await import('./keychain-source.js');
const { loadKeySlots } = await import('./key-sources.js');

const MNEMONIC = 'test test test test test test test test test test test junk';
const EVM_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RAW_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const put = (account: string, value: string): void => {
  store.set(`b2binpay-defi-mcp:${account}`, value);
};

beforeEach(() => {
  store.clear();
  state.locked = false;
  state.throwNoEntry = false;
});

describe('KeychainKeySource', () => {
  it('reads a hex private key from the slot entry', async () => {
    put('evm', RAW_KEY);
    expect(await new KeychainKeySource().read('evm')).toBe(RAW_KEY);
  });

  it('trims whitespace-padded hex, matching the env path', async () => {
    put('evm', `  ${RAW_KEY}\n`);
    expect(await new KeychainKeySource().read('evm')).toBe(RAW_KEY);
  });

  it('derives a stored mnemonic at the protocol path', async () => {
    put('evm', MNEMONIC);
    const key = await new KeychainKeySource().read('evm');
    expect(key).toBe(EVM_KEY_0);
    expect(privateKeyToAccount(key ?? '0x').address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('treats a missing entry as an empty slot (no error)', async () => {
    expect(await new KeychainKeySource().read('tvm')).toBeUndefined();
  });

  it('treats a NoEntry error as an empty slot, not a fatal read', async () => {
    state.throwNoEntry = true;
    expect(await new KeychainKeySource().read('tvm')).toBeUndefined();
  });

  it('resolves slots independently', async () => {
    put('evm', RAW_KEY);
    const source = new KeychainKeySource();
    expect(await source.read('evm')).toBe(RAW_KEY);
    expect(await source.read('tvm')).toBeUndefined();
  });

  it('is fatal when the keychain is locked/unavailable, and does not fall back to env', async () => {
    put('evm', RAW_KEY);
    state.locked = true;
    await expect(new KeychainKeySource().read('evm')).rejects.toThrow(/keychain may be locked/i);
  });

  it('rejects a hex-looking blob of the wrong length as a mistyped key, not a mnemonic', async () => {
    put('evm', RAW_KEY.slice(0, -1)); // 63 hex chars
    await expect(new KeychainKeySource().read('evm')).rejects.toThrow(/hex private key but has 63 hex chars/);
    await expect(new KeychainKeySource().read('evm')).rejects.not.toThrow(/mnemonic/i);
  });

  it('normalizes internal whitespace in a stored mnemonic (newline-wrapped)', async () => {
    put('evm', MNEMONIC.replace(/ /g, '\n')); // words separated by newlines
    expect(await new KeychainKeySource().read('evm')).toBe(EVM_KEY_0);
  });

  it('rejects an invalid blob without leaking its value', async () => {
    const garbage = 'zzz not a key or mnemonic zzz';
    put('evm', garbage);
    const source = new KeychainKeySource();
    await expect(source.read('evm')).rejects.toThrow(/BIP39/);
    await source.read('evm').catch((error: unknown) => {
      expect((error as Error).message).not.toContain(garbage);
    });
  });
});

describe('loadKeySlots over the keychain backend', () => {
  it('fails with "at least one slot" when both entries are empty', async () => {
    await expect(loadKeySlots(new KeychainKeySource())).rejects.toThrow(/No signing key configured/);
  });

  it('aggregates independent slots', async () => {
    put('evm', RAW_KEY);
    put('tvm', MNEMONIC);
    const slots = await loadKeySlots(new KeychainKeySource());
    expect(slots.evm).toBe(RAW_KEY);
    expect(slots.tvm).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
