import { encodeAbiParameters, type Hex, isAddress, keccak256 } from 'viem';
import { type QueueOperationType, queueOperationTypeSchema } from '../backend/tool-results.js';
import { type CallReviewContext, type DescribedCall, describeCall, type ReviewCall } from './describe-call.js';
import { assertPrintableLine, toDisplayJson, toDisplayText } from './display-text.js';
import type { AccountSession } from './session.js';
import { toEvmHex, toTronBase58 } from './tron-address.js';

const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/** The canonical encoding of the signed calls: `(address to, uint256 value, bytes data)[]`. */
const CALLS_DIGEST_PARAMS = [
  {
    type: 'tuple[]',
    components: [
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'value' },
      { type: 'bytes', name: 'data' },
    ],
  },
] as const;

/** The queued-operation fields a review reads. Descriptive fields are optional: the review never depends on them. */
export interface ReviewableOperation {
  id: string;
  nonce: string;
  calls: readonly ReviewCall[];
  operationType?: QueueOperationType;
  payload?: Record<string, unknown>;
  dappMetadata?: { dappName?: string; dappUrl?: string; icon?: string } | null;
  deployment: { id: string; chainId: string; contractAddress: string };
}

/** Who reviews which operation: the operation id the caller asked for, the selected account, and the agent signer. */
export interface ReviewRequest {
  operationId: string;
  session: AccountSession;
  signerAddress: string;
}

/** Fields written by whoever proposed the operation: shown for context, never part of what the human confirms. */
export interface UnverifiedProposerFields {
  dappName?: string;
  dappUrl?: string;
  payload?: unknown;
}

export interface OperationReview {
  operationId: string;
  /** The backend's label for the operation; informational, the effects below are what the signature authorizes. */
  operationType: QueueOperationType | null;
  nonce: string;
  chainId: number;
  account: string;
  /** keccak256 of the ABI-encoded calls; part of `confirm`, so a change to any byte of any call changes `confirm`. */
  callsDigest: Hex;
  effects: string[];
  warnings: string[];
  /** True when a call's effect cannot be fully decoded; signing then also needs `allowUnknownCalls: true`. */
  requiresAllowUnknownCalls: boolean;
  unverifiedProposerFields: UnverifiedProposerFields;
  /** The exact text `sign_operation` requires as its `confirm` argument. */
  confirm: string;
}

/** What the caller of `sign_operation` asserts the human approved. */
export interface SignConfirmation {
  confirm?: string;
  allowUnknownCalls?: boolean;
}

/** The backend must answer for the operation that was asked for, bound to the selected deployment. */
function assertRequestedAndBound(operation: ReviewableOperation, { operationId, session }: ReviewRequest): void {
  if (operation.id !== operationId) {
    throw new Error(`The backend returned operation ${toDisplayText(operation.id)} when asked for ${operationId}`);
  }
  const { deployment } = operation;
  const isSameDeployment =
    deployment.id === session.deploymentId &&
    Number(deployment.chainId) === session.chainId &&
    toEvmHex(deployment.contractAddress) === toEvmHex(session.contract);
  if (!isSameDeployment) {
    throw new Error(
      `Operation ${operationId} belongs to deployment ${toDisplayText(deployment.id)} (chain ` +
        `${toDisplayText(deployment.chainId)}, contract ${toDisplayText(deployment.contractAddress)}), not to the ` +
        `selected account ${session.contract} on chain ${session.chainId}`,
    );
  }
}

function formatAddress(session: AccountSession, address: string): string {
  return session.chainKind === 'tvm' ? toTronBase58(address) : toEvmHex(address);
}

/** A payload address list, formatted; `null` unless every entry is a valid EVM or TRON address. */
function formatPayloadOwners(session: AccountSession, owners: unknown): string[] | null {
  if (!Array.isArray(owners)) {
    return null;
  }
  try {
    return owners.map((owner) => {
      if (typeof owner !== 'string' || !(isAddress(owner) || TRON_BASE58.test(owner))) {
        throw new Error('not an address');
      }
      return formatAddress(session, owner);
    });
  } catch {
    return null;
  }
}

/** Same owner list up to order: equal length, and the same distinct addresses (compared as 20-byte hex). */
function isSameOwnerList(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left.map((address) => toEvmHex(address)));
  const rightSet = new Set(right.map((address) => toEvmHex(address)));
  return (
    left.length === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((address) => rightSet.has(address))
  );
}

function payloadMismatchWarning(
  operation: ReviewableOperation,
  setConfig: NonNullable<DescribedCall['setConfig']>,
  session: AccountSession,
): string | null {
  const owners = formatPayloadOwners(session, operation.payload?.approvers);
  if (!owners) {
    return 'the operation payload approvers are not a valid address list';
  }
  const threshold = operation.payload?.threshold;
  const isIntegerThreshold = typeof threshold === 'number' && Number.isSafeInteger(threshold);
  if (isIntegerThreshold && threshold === Number(setConfig.threshold) && isSameOwnerList(owners, setConfig.owners)) {
    return null;
  }
  const thresholdText = isIntegerThreshold ? `threshold ${threshold}` : 'a threshold that is not an integer';
  return `the operation payload claims owners [${owners.join(', ')}] with ${thresholdText}, but the calls set the owners shown below`;
}

/** Operation-level warnings first, then each call's own; all built from decoded values, never from backend text. */
function buildWarnings(
  operation: ReviewableOperation,
  described: readonly DescribedCall[],
  { session, signerAddress }: ReviewRequest,
): string[] {
  const warnings = new Set<string>();
  const setConfigs = described.flatMap((call) => (call.setConfig ? [call.setConfig] : []));
  const signer = toEvmHex(signerAddress);
  if (setConfigs.some((setConfig) => !setConfig.owners.some((owner) => toEvmHex(owner) === signer))) {
    warnings.add(`removes this agent's signer ${formatAddress(session, signer)} from the account owners`);
  }
  if (operation.operationType === queueOperationTypeSchema.enum.MULTISIG_CONFIG_CHANGE) {
    if (setConfigs.length === 0) {
      warnings.add('labelled a config change, but no call changes this account owners');
    }
    for (const setConfig of setConfigs) {
      const mismatch = payloadMismatchWarning(operation, setConfig, session);
      if (mismatch) {
        warnings.add(mismatch);
      }
    }
  }
  const callWarnings = described.flatMap((call, index) =>
    call.warnings.map((warning) => `call (${index + 1}) ${warning}`),
  );
  return [...warnings, ...callWarnings];
}

function digestCalls(calls: readonly ReviewCall[]): Hex {
  const encoded = calls.map(({ to, value, data }) => ({ to: toEvmHex(to), value: BigInt(value), data }));
  return keccak256(encodeAbiParameters(CALLS_DIGEST_PARAMS, [encoded]));
}

function proposerFields(operation: ReviewableOperation): UnverifiedProposerFields {
  const fields: UnverifiedProposerFields = {};
  if (operation.dappMetadata?.dappName) {
    fields.dappName = toDisplayText(operation.dappMetadata.dappName);
  }
  if (operation.dappMetadata?.dappUrl) {
    fields.dappUrl = toDisplayText(operation.dappMetadata.dappUrl);
  }
  if (operation.payload && Object.keys(operation.payload).length > 0) {
    fields.payload = toDisplayJson(operation.payload);
  }
  return fields;
}

/** Header, call count and every warning come before the effects, so a long operation cannot push them off-screen. */
function composeConfirm(review: Omit<OperationReview, 'confirm'>): string {
  const effects =
    review.effects.length > 0
      ? review.effects.map((effect, index) => `(${index + 1}) ${effect}`).join('; ')
      : `no calls: consumes nonce ${review.nonce} without any other effect`;
  const warnings = review.warnings.length > 0 ? ` | WARNING: ${review.warnings.join('; ')}` : '';
  const unknown = review.requiresAllowUnknownCalls
    ? ' | UNVERIFIABLE: contains calls whose effect cannot be decoded'
    : '';
  const confirm =
    `Sign operation ${review.operationId} nonce ${review.nonce} on chain ${review.chainId} for account ` +
    `${review.account}, calls digest ${review.callsDigest}: ${review.effects.length} call(s)${warnings}${unknown} | ${effects}`;
  assertPrintableLine(confirm);
  return confirm;
}

/**
 * Decode what signing this operation authorizes, from its calls alone. Refuses an operation other than the one asked
 * for, and one bound to another deployment, since its signature would be scoped to the selected account's domain and
 * replayable there.
 */
export function buildOperationReview(operation: ReviewableOperation, request: ReviewRequest): OperationReview {
  assertRequestedAndBound(operation, request);
  const { session } = request;
  const context: CallReviewContext = { kind: session.chainKind, account: toEvmHex(session.contract) };
  const described = operation.calls.map((call) => describeCall(call, context));
  const review = {
    operationId: operation.id,
    operationType: operation.operationType ?? null,
    nonce: operation.nonce,
    chainId: session.chainId,
    account: formatAddress(session, session.contract),
    callsDigest: digestCalls(operation.calls),
    effects: described.map((call) => call.text),
    warnings: buildWarnings(operation, described, request),
    requiresAllowUnknownCalls: described.some((call) => !call.isDecoded),
    unverifiedProposerFields: proposerFields(operation),
  };
  return { ...review, confirm: composeConfirm(review) };
}

/**
 * Sign only what the human was shown: `confirm` is an argument of the signing call, so the host's approval prompt
 * displays it, and it must equal the summary decoded from the very calls being signed.
 */
export function assertReviewConfirmed(review: OperationReview, confirmation: SignConfirmation): void {
  if (confirmation.confirm?.trim() !== review.confirm) {
    const reason = confirmation.confirm === undefined ? 'no confirm was given' : 'confirm does not match';
    throw new Error(
      `Not signed: ${reason}. Show the user the warnings and effects below; only if they agree, call ` +
        `sign_operation again with confirm set to exactly the "confirm" value.\n${JSON.stringify(review)}`,
    );
  }
  if (review.requiresAllowUnknownCalls && confirmation.allowUnknownCalls !== true) {
    throw new Error(
      'Not signed: the operation contains calls whose effect cannot be decoded. Pass allowUnknownCalls: true ' +
        `only if the user explicitly accepts that.\n${JSON.stringify(review)}`,
    );
  }
}
