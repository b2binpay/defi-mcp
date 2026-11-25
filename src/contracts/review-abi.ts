import type { Abi } from 'viem';

/**
 * Token calls whose effect is fully described by their arguments: ERC-20 transfer / approve / transferFrom /
 * increaseAllowance and ERC-721/1155 `setApprovalForAll`. Deliberately not the full `erc20Abi`: a view selector
 * decoded as "known" would let an opaque call pass review without the explicit unknown-call opt-in.
 */
export const TOKEN_REVIEW_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'amount' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'spender' },
      { type: 'uint256', name: 'amount' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'from' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'amount' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'increaseAllowance',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'spender' },
      { type: 'uint256', name: 'addedValue' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'operator' },
      { type: 'bool', name: 'approved' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** Uniswap Permit2 `approve`: lets `spender` pull up to `amount` of `token` from the caller until `expiration`. */
export const PERMIT2_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'token' },
      { type: 'address', name: 'spender' },
      { type: 'uint160', name: 'amount' },
      { type: 'uint48', name: 'expiration' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/**
 * The multisig's own state-changing functions (EVM `MultiSigWallet`, TVM `MultiSigWalletStaking`), decoded only for
 * calls that target the selected account itself.
 */
export const ACCOUNT_SELF_CALL_ABI = [
  {
    type: 'function',
    name: 'setConfig',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address[]', name: 'owners_' },
      { type: 'uint256', name: 'threshold_' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setWhitelist',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address[]', name: 'accounts' },
      { type: 'bool[]', name: 'statuses' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'erc20' },
      { type: 'bytes32[]', name: 'accountIds' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimTo',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'erc20' },
      { type: 'address', name: 'to' },
      { type: 'bytes32[]', name: 'accountIds' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'freezeBalanceV2',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256', name: 'amount' },
      { type: 'uint256', name: 'resourceType' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'unfreezeBalanceV2',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256', name: 'amount' },
      { type: 'uint256', name: 'resourceType' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'cancelAllUnfreezeV2', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'withdrawExpireUnfreeze', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'withdrawReward', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'voteWitnesses',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address[]', name: 'srs' },
      { type: 'uint256[]', name: 'tronPowerAmounts' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'delegateResource',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256', name: 'amount' },
      { type: 'address', name: 'receiver' },
      { type: 'uint256', name: 'resourceType' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'undelegateResource',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256', name: 'amount' },
      { type: 'address', name: 'receiver' },
      { type: 'uint256', name: 'resourceType' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** CoW Protocol settlement pre-signature; the order terms live off-chain behind the `orderUid` hash. */
export const COW_PRE_SIGNATURE_ABI = [
  {
    type: 'function',
    name: 'setPreSignature',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'bytes', name: 'orderUid' },
      { type: 'bool', name: 'signed' },
    ],
    outputs: [],
  },
] as const satisfies Abi;
