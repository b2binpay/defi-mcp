import { describe, expect, it } from 'vitest';
import { sameTronAddress, toEvmHex, toTronBase58 } from './tron-address.js';

const BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const HEX_41 = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
const EVM = '0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C';

describe('toTronBase58', () => {
  it('returns a Base58Check address unchanged', () => {
    expect(toTronBase58(BASE58)).toBe(BASE58);
  });

  it('converts 41-prefixed hex to Base58Check', () => {
    expect(toTronBase58(HEX_41)).toBe(BASE58);
  });

  it('converts 0x EVM hex to Base58Check', () => {
    expect(toTronBase58(EVM)).toBe(BASE58);
  });

  it('throws on a malformed address', () => {
    expect(() => toTronBase58('not-an-address')).toThrow(/Invalid TRON address/);
  });
});

describe('toEvmHex', () => {
  it('derives the checksummed EVM hex from a Base58Check address', () => {
    expect(toEvmHex(BASE58)).toBe(EVM);
  });

  it('checksums an already-EVM hex address', () => {
    expect(toEvmHex(EVM.toLowerCase())).toBe(EVM);
  });
});

describe('sameTronAddress', () => {
  it('matches equivalent forms of the same account', () => {
    expect(sameTronAddress(BASE58, EVM)).toBe(true);
    expect(sameTronAddress(BASE58, HEX_41)).toBe(true);
  });

  it('rejects different accounts', () => {
    expect(sameTronAddress(BASE58, '0x0000000000000000000000000000000000000001')).toBe(false);
  });
});
