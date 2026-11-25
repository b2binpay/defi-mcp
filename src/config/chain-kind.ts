import { TRON_CHAIN_IDS } from '@b2binpay/defi-sdk';

export type ChainKind = 'evm' | 'tvm';

/** All chain kinds in the canonical order slots are filled and discovery is attempted. */
export const CHAIN_KINDS: readonly ChainKind[] = ['evm', 'tvm'];

/** Classify a chain id: TVM for the known TRON networks, EVM otherwise. */
export function chainKind(chainId: number): ChainKind {
  return TRON_CHAIN_IDS.has(chainId) ? 'tvm' : 'evm';
}
