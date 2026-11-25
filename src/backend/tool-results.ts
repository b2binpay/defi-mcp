import { type Address, type Hex, isAddress } from 'viem';
import { z } from 'zod';

const addressSchema = z.string().refine((value): value is Address => isAddress(value), 'expected an EVM address');

/** TRON Base58Check address: `T`-prefixed, 34 chars. */
const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * Relaxed address for TVM payloads: a TRON Base58Check address (T...) or an EVM hex
 * address. EVM schemas stay strict; only the TVM-specific schemas use this.
 */
const tronOrEvmAddressSchema = z
  .string()
  .refine((value) => TRON_BASE58.test(value) || isAddress(value), 'expected a TRON base58 or EVM address');

const bytes32Schema = z
  .string()
  .refine((value): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value), 'expected a 0x-prefixed 32-byte hex string');

/** Normalizes to a `0x`-prefixed, even-length hex byte string (empty → `0x`). */
const hexBytesSchema = z
  .string()
  .transform((value) => (value.startsWith('0x') ? value : `0x${value}`))
  .refine((value): value is Hex => /^0x([0-9a-fA-F]{2})*$/.test(value), 'expected a hex byte string');

/** Non-negative integer as a decimal string (uint256 value / nonce). */
const uintStringSchema = z.string().refine((value) => /^\d+$/.test(value), 'expected a non-negative integer string');

/** The account fields (from TeamResponseDto) that `select_account` reads via get_account. */
const accountSchema = z.object({
  id: z.string(),
  contract: addressSchema,
  smartContractVersionId: z.string(),
  isTron: z.boolean(),
});

const accountDeploymentSchema = z.object({
  deploymentId: z.string(),
  chainId: z.string(),
  networkName: z.string(),
  deploymentStatus: z.string(),
});

/** TeamDetailsDto returned by `get_account`: account + per-chain deployments. */
export const accountDetailsSchema = z.object({
  account: accountSchema,
  deployments: z.array(accountDeploymentSchema),
});

export type AccountDeployment = z.infer<typeof accountDeploymentSchema>;
export type AccountDetails = z.infer<typeof accountDetailsSchema>;

/** TVM variant of `get_account`: the multisig `contract` is a TRON Base58Check address. */
export const tvmAccountDetailsSchema = z.object({
  account: accountSchema.extend({ contract: tronOrEvmAddressSchema }),
  deployments: z.array(accountDeploymentSchema),
});

export type TvmAccountDetails = z.infer<typeof tvmAccountDetailsSchema>;

// Mirrors QueueOperationResponseDtoOperationTypeEnum. Kept a closed enum on purpose: the SDK's
// `QueueOperationResponseDto` (consumed by the TVM execute builder) types this field as the same
// enum, so the schema must match it — relaxing to a bare string would not typecheck.
export const queueOperationTypeSchema = z.enum([
  'MULTISIG_CONFIG_CHANGE',
  'REJECT',
  'PAYOUT',
  'DAPP_TRANSACTION',
  'CROSS_CHAIN_TRANSFER',
  'COWSWAP',
  'CLAIM_WHITELIST_CHANGE',
  'CLAIM_TO',
  'STAKE',
  'UNSTAKE',
  'CANCEL_UNSTAKING',
  'STAKING_WITHDRAW',
  'VOTE',
  'CLAIM_REWARDS',
  'DELEGATE',
  'RECLAIM',
]);

export type QueueOperationType = z.infer<typeof queueOperationTypeSchema>;

const operationCallSchema = z.object({
  to: addressSchema,
  value: uintStringSchema,
  data: hexBytesSchema,
});

/**
 * Subset of QueueOperationResponseDto returned by `get_queue_operation`. Calls are
 * normalized here so signing and execute-encoding consume identical bytes.
 *
 * Per-signer blobs are not part of the response: the backend returns the packed,
 * signer-sorted `signatureBlob` and a `signers` roster, and the blob is what both the EVM
 * and TVM execute encoders pass to the contract.
 */
/** Queue operation ids are snowflake integers; digits only, so an id can never carry text into a review. */
const operationIdSchema = z.string().regex(/^\d+$/, 'expected a numeric operation id');

export const queueOperationSchema = z.object({
  id: operationIdSchema,
  executeOperationId: bytes32Schema,
  nonce: uintStringSchema,
  status: z.string(),
  calls: z.array(operationCallSchema),
  signatureBlob: hexBytesSchema.nullable(),
  signaturesCollected: z.number(),
  signaturesRequired: z.number(),
  canSign: z.boolean(),
  canExecute: z.boolean(),
  isBlocked: z.boolean(),
  userSigned: z.boolean(),
});

export type QueueOperation = z.infer<typeof queueOperationSchema>;

/**
 * TVM variant of `get_queue_operation`: call targets may be TRON Base58Check addresses.
 * Every other field matches the EVM operation, so signing/execute guards are shared.
 */
export const tvmQueueOperationSchema = queueOperationSchema.extend({
  calls: z.array(operationCallSchema.extend({ to: tronOrEvmAddressSchema })),
});

export type TvmQueueOperation = z.infer<typeof tvmQueueOperationSchema>;

/**
 * The fields a sign review reads beyond the base operation: the bound deployment it must match, and the
 * descriptive fields it reports as unverified.
 */
const reviewShape = {
  operationType: queueOperationTypeSchema.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  dappMetadata: z
    .object({ dappName: z.string().optional(), dappUrl: z.string().optional(), icon: z.string().optional() })
    .nullable()
    .optional(),
  deployment: z.object({ id: z.string(), chainId: z.string(), contractAddress: z.string() }),
} as const;

/** `get_queue_operation` as read for signing an EVM operation. */
export const reviewableOperationSchema = queueOperationSchema.extend(reviewShape);

export type ReviewableQueueOperation = z.infer<typeof reviewableOperationSchema>;

/** `get_queue_operation` as read for signing a TVM operation. */
export const tvmReviewableOperationSchema = tvmQueueOperationSchema.extend(reviewShape);

export type TvmReviewableQueueOperation = z.infer<typeof tvmReviewableOperationSchema>;

/** Mirrors QueueOperationResponseDtoStatusEnum (SDK contract; see above). */
const queueOperationStatusSchema = z.enum(['PENDING', 'READY', 'EXECUTED', 'FAILED', 'CANCELLED']);

/**
 * The extra `QueueOperationResponseDto` fields (beyond the base queue operation) that the SDK's
 * `TronMultisigBlockchainClient` requires to build the on-chain execute transaction. Kept as a
 * shared shape so the executable schema is just the queue operation plus these.
 */
const executableOperationShape = {
  operationType: queueOperationTypeSchema,
  status: queueOperationStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  txHash: z.string().nullable(),
  canDelete: z.boolean(),
  canReject: z.boolean(),
  createdAt: z.string(),
  createdBy: z.string(),
} as const;

/** Full TVM queue operation = the TVM queue operation + the executable DTO fields. */
export const tvmExecutableOperationSchema = tvmQueueOperationSchema.extend(executableOperationShape);

export type TvmExecutableOperation = z.infer<typeof tvmExecutableOperationSchema>;

/** DeploymentParamsResponseDto returned by `get_account_deploy_params`. */
export const deployParamsSchema = z.object({
  implementationAddress: addressSchema,
  initializerBytecode: hexBytesSchema,
  nonce: bytes32Schema,
  deployerAddress: addressSchema,
});

export type DeployParams = z.infer<typeof deployParamsSchema>;

/** Currency block on a claim item (subset of CurrencyResponseDto). */
const claimCurrencySchema = z.object({
  id: z.string(),
  symbol: z.string(),
  address: z.string().nullable(),
});

/**
 * One claimable deposit group from `list_claims` (subset of ClaimItemDto). `invoiceNonce`
 * is a decimal/hex string the on-chain `claim` consumes as a `bytes32` deposit id.
 */
export const claimItemSchema = z.object({
  invoiceId: z.string(),
  invoiceNonce: z.string(),
  currency: claimCurrencySchema,
  amount: z.string(),
});

export type ClaimItem = z.infer<typeof claimItemSchema>;

/** Paginated `list_claims` result. */
export const claimsPageSchema = z.object({
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  items: z.array(claimItemSchema),
});

export type ClaimsPage = z.infer<typeof claimsPageSchema>;

/** Subset of SignatureResponseDto returned by `submit_signature`. */
export const submitSignatureResultSchema = z.object({
  operationId: z.string(),
  signaturesCollected: z.number(),
  signaturesRequired: z.number(),
  canExecute: z.boolean(),
  userSigned: z.boolean(),
});

export type SubmitSignatureResult = z.infer<typeof submitSignatureResultSchema>;
