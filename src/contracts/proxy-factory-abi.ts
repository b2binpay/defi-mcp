import type { Abi } from 'viem';

/**
 * Minimal fragment of the multisig proxy factory ABI — just `createInstance`, the
 * entrypoint that CREATE2-deploys a multisig at the deterministic address. Matches
 * the deploy-params returned by the backend (implementation, initializer, saltNonce).
 */
export const PROXY_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createInstance',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'bytes32' },
    ],
    outputs: [{ name: 'instance', type: 'address' }],
  },
] as const satisfies Abi;
