import { type TronAddress, tronToEvmHex, validateTronAddress } from '@b2binpay/defi-sdk';
import { TronWeb } from 'tronweb';
import { getAddress, type Hex } from 'viem';

const TRON_HEX_PREFIX = '41';

/**
 * Normalize any Tron/EVM address form (Base58Check `T...`, `41`-prefixed hex, or `0x`
 * EVM hex) to a branded Tron Base58Check address. Throws if the result is not a valid
 * TRON address, so callers never hold a malformed contract/caller address.
 */
export function toTronBase58(addr: string): TronAddress {
  const base58 = addr.startsWith('T') ? addr : TronWeb.address.fromHex(toTronHex(addr));
  const { isValid, errors, normalizedAddress } = validateTronAddress({ address: base58 });
  if (!isValid || !normalizedAddress) {
    throw new Error(`Invalid TRON address "${addr}": ${errors.join(', ')}`);
  }
  return normalizedAddress;
}

/** Convert any Tron/EVM address form to a checksummed 20-byte EVM hex address (`0x...`). */
export function toEvmHex(addr: string): Hex {
  if (addr.startsWith('0x')) {
    return getAddress(addr);
  }
  return getAddress(tronToEvmHex(toTronBase58(addr)));
}

/** Whether two addresses (in any Tron/EVM form) refer to the same on-chain account. */
export function sameTronAddress(a: string, b: string): boolean {
  return toEvmHex(a) === toEvmHex(b);
}

/** `41`-prefixed TRON hex is 21 bytes = 42 chars. */
const TRON_HEX_LENGTH = 42;

/** Map an `0x`/`41`/bare hex string to the `41`-prefixed hex TronWeb expects. */
function toTronHex(addr: string): string {
  if (addr.startsWith('0x')) {
    return `${TRON_HEX_PREFIX}${addr.slice(2)}`;
  }
  // Only treat it as already-prefixed at the full TRON hex length; a bare 40-char EVM address
  // that happens to start with "41" still needs the prefix.
  if (addr.startsWith(TRON_HEX_PREFIX) && addr.length === TRON_HEX_LENGTH) {
    return addr;
  }
  return `${TRON_HEX_PREFIX}${addr}`;
}
