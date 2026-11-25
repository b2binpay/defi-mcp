import {
  type Abi,
  type DecodeFunctionDataReturnType,
  decodeFunctionData,
  formatUnits,
  type Hex,
  hexToBigInt,
  keccak256,
  maxUint160,
  maxUint256,
  size,
  slice,
  zeroAddress,
} from 'viem';
import type { ChainKind } from '../config/chain-kind.js';
import {
  ACCOUNT_SELF_CALL_ABI,
  COW_PRE_SIGNATURE_ABI,
  PERMIT2_APPROVE_ABI,
  TOKEN_REVIEW_ABI,
} from '../contracts/review-abi.js';
import { toEvmHex, toTronBase58 } from './tron-address.js';

/** One call of a queued operation, as signed: target, native value (base units) and calldata. */
export interface ReviewCall {
  to: string;
  value: string;
  data: Hex;
}

export interface CallReviewContext {
  kind: ChainKind;
  /** The selected account as checksummed 20-byte hex; a call to it is a call to the multisig itself. */
  account: Hex;
}

export interface DescribedCall {
  text: string;
  /** Whether `text` states the call's whole effect; false for an unknown selector or an opaque call. */
  isDecoded: boolean;
  /** Risks of this call the human must see first, built from decoded values only. */
  warnings: string[];
  /** Present when the call is `setConfig` on the account itself. */
  setConfig?: { owners: readonly Hex[]; threshold: bigint };
}

/** Native units per chain kind: every configured EVM chain uses 18 decimals, TRON 6 (SUN). */
const NATIVE_UNIT: Record<ChainKind, { decimals: number; name: string; base: string }> = {
  evm: { decimals: 18, name: 'native coin', base: 'wei' },
  tvm: { decimals: 6, name: 'TRX', base: 'sun' },
};

/** TRON `resourceType` codes of the staking calls. */
const TRON_RESOURCE: Record<string, string> = { '0': 'BANDWIDTH', '1': 'ENERGY' };

const SELECTOR_BYTES = 4;

/** CoW order uid = order digest (32 bytes) ‖ owner (20 bytes) ‖ validTo (uint32, 4 bytes). */
const COW_UID = { bytes: 56, digestEnd: 32, ownerEnd: 52 } as const;

/** Largest unix-seconds value `Date` can render (±8.64e15 ms). */
const MAX_DATE_SECONDS = 8_640_000_000_000n;
const MS_PER_SECOND = 1000;

type SelfCall = DecodeFunctionDataReturnType<typeof ACCOUNT_SELF_CALL_ABI>;
type TokenCall = DecodeFunctionDataReturnType<typeof TOKEN_REVIEW_ABI>;

function tryDecode<const abi extends Abi>(abi: abi, data: Hex): DecodeFunctionDataReturnType<abi> | null {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return null;
  }
}

function decoded(text: string, warnings: string[] = []): DescribedCall {
  return { text, isDecoded: true, warnings };
}

function formatAddress(kind: ChainKind, address: string): string {
  return kind === 'tvm' ? toTronBase58(address) : toEvmHex(address);
}

function formatNative(kind: ChainKind, value: bigint): string {
  const unit = NATIVE_UNIT[kind];
  return `${formatUnits(value, unit.decimals)} ${unit.name} (${value} ${unit.base})`;
}

function formatTokenAmount(amount: bigint, unlimited: bigint = maxUint256): string {
  return amount === unlimited ? 'UNLIMITED base units' : `${amount} base units`;
}

/** `approve` and `transferFrom` share their selectors with ERC-721, where the uint256 argument is a token id. */
function formatAmountOrNft(token: string, value: bigint): string {
  return `${formatTokenAmount(value)} of token ${token} (NFT #${value} if ${token} is an ERC-721 collection)`;
}

/** A claimed deposit account sends its whole `erc20` balance, if any, then self-destructs to the recipient with its whole native balance. */
function formatClaimedBalances(kind: ChainKind, erc20: Hex): string {
  const native = `the whole ${NATIVE_UNIT[kind].name} balance`;
  return erc20 === zeroAddress ? native : `the whole balance of token ${formatAddress(kind, erc20)} and ${native}`;
}

function formatDepositIds(ids: readonly Hex[]): string {
  return `${ids.length} deposit(s) [${ids.join(', ')}]`;
}

function formatResource(resourceType: bigint): string {
  return TRON_RESOURCE[resourceType.toString()] ?? `resource type ${resourceType}`;
}

function formatTimestamp(seconds: bigint): string {
  if (seconds === 0n) {
    return 'the current block';
  }
  return seconds > MAX_DATE_SECONDS ? `unix time ${seconds}` : new Date(Number(seconds) * MS_PER_SECOND).toISOString();
}

function isAccount(context: CallReviewContext, address: Hex): boolean {
  return toEvmHex(address) === context.account;
}

function describeConfigCall(call: SelfCall, context: CallReviewContext): DescribedCall | null {
  const { kind } = context;
  switch (call.functionName) {
    case 'setConfig': {
      const [owners, threshold] = call.args;
      const list = owners.map((owner) => formatAddress(kind, owner)).join(', ');
      return {
        ...decoded(`set account owners to [${list}] with threshold ${threshold}`),
        setConfig: { owners, threshold },
      };
    }
    case 'setWhitelist': {
      const [accounts, statuses] = call.args;
      const added = accounts.filter((_, index) => statuses[index]).map((item) => formatAddress(kind, item));
      const removed = accounts.filter((_, index) => !statuses[index]).map((item) => formatAddress(kind, item));
      return decoded(`update the claim whitelist: add [${added.join(', ')}], remove [${removed.join(', ')}]`);
    }
    case 'claim': {
      const [erc20, ids] = call.args;
      return decoded(
        `claim ${formatDepositIds(ids)}: move ${formatClaimedBalances(kind, erc20)} of each into this account`,
      );
    }
    case 'claimTo': {
      const [erc20, to, ids] = call.args;
      const recipient = formatAddress(kind, to);
      const text = `claim ${formatDepositIds(ids)}: move ${formatClaimedBalances(kind, erc20)} of each to ${recipient}`;
      return decoded(
        text,
        isAccount(context, to) ? [] : [`sends claimed deposits to ${recipient}, not to this account`],
      );
    }
    default:
      return null;
  }
}

function describeStakingCall(call: SelfCall, kind: ChainKind): DescribedCall | null {
  switch (call.functionName) {
    case 'freezeBalanceV2':
      return decoded(`stake ${formatNative(kind, call.args[0])} for ${formatResource(call.args[1])}`);
    case 'unfreezeBalanceV2':
      return decoded(`unstake ${formatNative(kind, call.args[0])} of ${formatResource(call.args[1])}`);
    case 'cancelAllUnfreezeV2':
      return decoded('cancel all pending unstakes');
    case 'withdrawExpireUnfreeze':
      return decoded('withdraw expired unstaked TRX into this account');
    case 'withdrawReward':
      return decoded('withdraw voting rewards into this account');
    case 'voteWitnesses': {
      const [srs, amounts] = call.args;
      const votes = srs.map((sr, index) => `${amounts[index] ?? 0n} TRON Power for ${formatAddress(kind, sr)}`);
      return decoded(`replace votes with [${votes.join(', ')}]`);
    }
    case 'delegateResource': {
      const [amount, receiver, resourceType] = call.args;
      return decoded(
        `delegate ${formatResource(resourceType)} of ${formatNative(kind, amount)} to ${formatAddress(kind, receiver)}`,
      );
    }
    case 'undelegateResource': {
      const [amount, receiver, resourceType] = call.args;
      return decoded(
        `undelegate ${formatResource(resourceType)} of ${formatNative(kind, amount)} from ${formatAddress(kind, receiver)}`,
      );
    }
    default:
      return null;
  }
}

function describeSelfCall(data: Hex, context: CallReviewContext): DescribedCall | null {
  const call = tryDecode(ACCOUNT_SELF_CALL_ABI, data);
  if (!call) {
    return null;
  }
  return describeConfigCall(call, context) ?? describeStakingCall(call, context.kind);
}

/** A grant of spending rights to anyone but the account itself is always worth a warning. */
function allowanceWarning(context: CallReviewContext, spender: Hex, amount: bigint, grant: string): string[] {
  return amount > 0n && !isAccount(context, spender) ? [grant] : [];
}

/** On an ERC-721 collection `approve(spender, 0)` grants NFT #0, so only a zero spender or the account is harmless. */
function approveWarning(context: CallReviewContext, spender: Hex, amount: bigint, token: string): string[] {
  if (spender === zeroAddress || isAccount(context, spender)) {
    return [];
  }
  const grantee = formatAddress(context.kind, spender);
  return amount > 0n
    ? [`grants ${grantee} an allowance of ${formatAmountOrNft(token, amount)}`]
    : [`grants ${grantee} control of NFT #0 of ${token} if it is an ERC-721 collection`];
}

function describeTokenCall(call: TokenCall, token: string, context: CallReviewContext): DescribedCall {
  const address = (value: Hex) => formatAddress(context.kind, value);
  switch (call.functionName) {
    case 'transfer': {
      const [to, amount] = call.args;
      return decoded(`transfer ${formatTokenAmount(amount)} of token ${token} to ${address(to)}`);
    }
    case 'approve': {
      const [spender, amount] = call.args;
      return decoded(
        `approve ${address(spender)} to spend ${formatAmountOrNft(token, amount)}`,
        approveWarning(context, spender, amount, token),
      );
    }
    case 'increaseAllowance': {
      const [spender, added] = call.args;
      const allowance = `${formatTokenAmount(added)} of token ${token}`;
      const grant = `grants ${address(spender)} ${allowance} more allowance`;
      const text = `increase the allowance of ${address(spender)} by ${allowance}`;
      return decoded(text, allowanceWarning(context, spender, added, grant));
    }
    case 'transferFrom': {
      const [from, to, amount] = call.args;
      const move = `${formatAmountOrNft(token, amount)} from ${address(from)} to ${address(to)}`;
      return decoded(`transfer ${move}`, isAccount(context, to) ? [] : [`pulls ${move}`]);
    }
    case 'setApprovalForAll': {
      const [operator, approved] = call.args;
      if (!approved) {
        return decoded(`revoke the collection-wide approval of ${address(operator)} on ${token}`);
      }
      const grant = `grants ${address(operator)} control of every token of collection ${token}`;
      return decoded(`let ${address(operator)} transfer every token of collection ${token}`, [grant]);
    }
  }
}

function describePermit2Approve(data: Hex, target: string, context: CallReviewContext): DescribedCall | null {
  const call = tryDecode(PERMIT2_APPROVE_ABI, data);
  if (!call) {
    return null;
  }
  const [token, spender, amount, expiration] = call.args;
  const spenderText = formatAddress(context.kind, spender);
  const allowance = `${formatTokenAmount(amount, maxUint160)} of token ${formatAddress(context.kind, token)}`;
  const text = `Permit2 ${target}: allow ${spenderText} to pull ${allowance} until ${formatTimestamp(BigInt(expiration))}`;
  return decoded(
    text,
    allowanceWarning(context, spender, amount, `grants ${spenderText} a Permit2 allowance of ${allowance}`),
  );
}

function describeCowPreSignature(data: Hex, target: string, context: CallReviewContext): DescribedCall | null {
  const call = tryDecode(COW_PRE_SIGNATURE_ABI, data);
  if (!call) {
    return null;
  }
  const [orderUid, signed] = call.args;
  const action = signed ? 'pre-sign' : 'revoke the pre-signature of';
  const order =
    size(orderUid) === COW_UID.bytes
      ? `${slice(orderUid, 0, COW_UID.digestEnd)} (owner ${formatAddress(context.kind, slice(orderUid, COW_UID.digestEnd, COW_UID.ownerEnd))}, ` +
        `valid until ${formatTimestamp(hexToBigInt(slice(orderUid, COW_UID.ownerEnd)))})`
      : orderUid;
  const text = `${action} CoW order ${order} at ${target}; the order terms (amounts, receiver) are not in the call`;
  return { text, isDecoded: false, warnings: [] };
}

function describeExternalCall(data: Hex, target: string, context: CallReviewContext): DescribedCall | null {
  const token = tryDecode(TOKEN_REVIEW_ABI, data);
  if (token) {
    return describeTokenCall(token, target, context);
  }
  return describePermit2Approve(data, target, context) ?? describeCowPreSignature(data, target, context);
}

function describeUnknownCall(data: Hex, target: string, value: bigint, kind: ChainKind): DescribedCall {
  const selector = size(data) >= SELECTOR_BYTES ? slice(data, 0, SELECTOR_BYTES) : data;
  const text =
    `UNKNOWN call to ${target}: selector ${selector}, ${size(data)} bytes of data (keccak256 ${keccak256(data)}), ` +
    `value ${formatNative(kind, value)}`;
  return { text, isDecoded: false, warnings: [] };
}

/**
 * Describe one call from its target, value and calldata alone — never from a backend- or proposer-written
 * description. Pure and deterministic, so the review a human approves and the check before signing agree byte for
 * byte.
 */
export function describeCall(call: ReviewCall, context: CallReviewContext): DescribedCall {
  const { kind } = context;
  const to = toEvmHex(call.to);
  const value = BigInt(call.value);
  const target = formatAddress(kind, to);

  if (size(call.data) === 0) {
    return decoded(
      value > 0n ? `send ${formatNative(kind, value)} to ${target}` : `empty call to ${target} (no value, no data)`,
    );
  }

  const described =
    to === context.account ? describeSelfCall(call.data, context) : describeExternalCall(call.data, target, context);
  if (!described) {
    return describeUnknownCall(call.data, target, value, kind);
  }
  return value > 0n ? { ...described, text: `${described.text}, attaching ${formatNative(kind, value)}` } : described;
}
