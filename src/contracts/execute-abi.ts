import type { Abi } from 'viem';

/**
 * Minimal fragment of the MultiSigWallet ABI — just the `execute` entrypoint, which
 * is all `encodeFunctionData` needs to build the on-chain execute transaction. The
 * SDK does not ship a bundled ABI, so the fragment is declared here.
 */
export const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple[]',
        name: 'operations',
        components: [
          {
            type: 'tuple[]',
            name: 'calls',
            components: [
              { type: 'address', name: 'to' },
              { type: 'uint256', name: 'value' },
              { type: 'bytes', name: 'data' },
            ],
          },
          { type: 'bytes', name: 'signatures' },
          { type: 'bytes32', name: 'id' },
        ],
      },
    ],
    outputs: [],
  },
  {
    // ERC-5267: the canonical EIP-712 domain, read on-chain before signing.
    type: 'function',
    name: 'eip712Domain',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'bytes1', name: 'fields' },
      { type: 'string', name: 'name' },
      { type: 'string', name: 'version' },
      { type: 'uint256', name: 'chainId' },
      { type: 'address', name: 'verifyingContract' },
      { type: 'bytes32', name: 'salt' },
      { type: 'uint256[]', name: 'extensions' },
    ],
  },
] as const satisfies Abi;
