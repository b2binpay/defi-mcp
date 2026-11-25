import type { Abi } from 'viem';

/**
 * Minimal fragment of the MultiSigWallet ABI — the `claim` entrypoint that sweeps invoice
 * deposits into the multisig. `claim(erc20, depositIds)` is `onlyOwnerOrWhitelisted` and moves
 * funds INTO the account (not out), so it needs no multisig threshold, queue, or signature — a
 * single approver broadcasts it directly. This is all `encodeFunctionData` needs.
 */
export const CLAIM_ABI = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'erc20' },
      { type: 'bytes32[]', name: 'depositIds' },
    ],
    outputs: [],
  },
] as const satisfies Abi;
