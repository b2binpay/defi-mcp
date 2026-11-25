import { TronWeb } from 'tronweb';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { EnvKeySource, loadKeySlots } from './key-sources.js';

/** Hardhat's well-known test mnemonic and its account-0 EVM key/address (from MetaMask/Hardhat). */
const MNEMONIC = 'test test test test test test test test test test test junk';
const EVM_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EVM_ADDR_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const RAW_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;
const source = (o: Record<string, string>): EnvKeySource => new EnvKeySource(env(o));
const evmKey = (o: Record<string, string>) => source(o).resolve('evm');
const tvmKey = (o: Record<string, string>) => source(o).resolve('tvm');

describe('EnvKeySource', () => {
  it('derives both slots from a shared mnemonic at standard paths', () => {
    expect(evmKey({ MNEMONIC })).toBe(EVM_KEY_0);
    expect(privateKeyToAccount(evmKey({ MNEMONIC }) ?? '0x').address).toBe(EVM_ADDR_0);
    // TVM derives at coin 195 → a distinct key yielding a valid TRON base58 address.
    const tvm = tvmKey({ MNEMONIC });
    expect(tvm).toMatch(/^0x[0-9a-f]{64}$/);
    expect(tvm).not.toBe(evmKey({ MNEMONIC }));
    const tronAddress = TronWeb.address.fromPrivateKey((tvm ?? '0x').slice(2));
    expect(tronAddress).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it('derives different keys per protocol from different mnemonics', () => {
    const other = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    expect(evmKey({ EVM_MNEMONIC: MNEMONIC, TVM_MNEMONIC: other })).toBe(EVM_KEY_0);
    expect(tvmKey({ EVM_MNEMONIC: MNEMONIC, TVM_MNEMONIC: other })).not.toBe(tvmKey({ MNEMONIC }));
  });

  it('per-slot private key overrides the shared mnemonic', () => {
    expect(evmKey({ MNEMONIC, EVM_PRIVATE_KEY: RAW_KEY })).toBe(RAW_KEY);
    expect(tvmKey({ MNEMONIC, EVM_PRIVATE_KEY: RAW_KEY })).toBe(tvmKey({ MNEMONIC }));
  });

  it('per-slot mnemonic overrides the shared mnemonic', () => {
    const other = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    expect(evmKey({ MNEMONIC, EVM_MNEMONIC: other })).not.toBe(EVM_KEY_0);
    expect(tvmKey({ MNEMONIC, EVM_MNEMONIC: other })).toBe(tvmKey({ MNEMONIC }));
  });

  it('normalizes a raw key without the 0x prefix', () => {
    expect(tvmKey({ TVM_PRIVATE_KEY: RAW_KEY.slice(2) })).toBe(RAW_KEY);
    expect(evmKey({ TVM_PRIVATE_KEY: RAW_KEY.slice(2) })).toBeUndefined();
  });

  it('trims surrounding whitespace/newline from a raw key', () => {
    expect(evmKey({ EVM_PRIVATE_KEY: `  ${RAW_KEY}\n` })).toBe(RAW_KEY);
  });

  it('fills only the configured slot', () => {
    expect(evmKey({ EVM_PRIVATE_KEY: RAW_KEY })).toBe(RAW_KEY);
    expect(tvmKey({ EVM_PRIVATE_KEY: RAW_KEY })).toBeUndefined();
  });

  it('rejects both a private key and a mnemonic on one slot', () => {
    expect(() => evmKey({ EVM_PRIVATE_KEY: RAW_KEY, EVM_MNEMONIC: MNEMONIC })).toThrow(
      /only one of EVM_PRIVATE_KEY or EVM_MNEMONIC/,
    );
  });

  it('rejects a mnemonic with a bad checksum', () => {
    const bad = 'test test test test test test test test test test test test';
    expect(() => evmKey({ MNEMONIC: bad })).toThrow(/checksum/);
  });

  it('rejects a malformed private key', () => {
    expect(() => evmKey({ EVM_PRIVATE_KEY: '0x1234' })).toThrow(/EVM_PRIVATE_KEY/);
  });
});

describe('loadKeySlots', () => {
  it('aggregates filled slots from the backend', async () => {
    const slots = await loadKeySlots(source({ MNEMONIC }));
    expect(slots.evm).toBe(EVM_KEY_0);
    expect(slots.tvm).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('fills only the configured slot', async () => {
    const slots = await loadKeySlots(source({ EVM_PRIVATE_KEY: RAW_KEY }));
    expect(slots.evm).toBe(RAW_KEY);
    expect(slots.tvm).toBeUndefined();
  });

  it('refuses when no slot is configured', async () => {
    await expect(loadKeySlots(source({}))).rejects.toThrow(/No signing key configured/);
  });
});
