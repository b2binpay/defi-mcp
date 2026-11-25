import { type Chain, defineChain } from 'viem';

/** Bound the on-chain receipt wait so a dropped/stuck EVM tx never hangs the agent indefinitely. */
export const RECEIPT_TIMEOUT_MS = 120_000;

/** Minimal viem Chain for the configured EVM network. */
export function toChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
