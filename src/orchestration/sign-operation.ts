import { transactions } from '@b2binpay/defi-sdk';
import { createPublicClient, http, type LocalAccount, type TypedDataDomain } from 'viem';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import {
  type ReviewableQueueOperation,
  reviewableOperationSchema,
  type SubmitSignatureResult,
  submitSignatureResultSchema,
} from '../backend/tool-results.js';
import { EXECUTE_ABI } from '../contracts/execute-abi.js';
import { toChain } from './chain.js';
import { assertReviewConfirmed, buildOperationReview, type SignConfirmation } from './operation-review.js';
import type { AccountSession } from './session.js';

const { buildExecuteTypedMessage, buildExecuteTypedData, packSignatures } = transactions;

type EvmSession = Extract<AccountSession, { chainKind: 'evm' }>;

/** Reads the EIP-712 domain the operation must be signed under. */
export type DomainReader = (session: EvmSession) => Promise<TypedDataDomain>;

export interface SignOperationDeps {
  client: BackendMcpClient;
  account: LocalAccount;
  session: EvmSession;
  /** Override for tests; defaults to reading `eip712Domain()` on-chain. */
  readDomain?: DomainReader;
}

/**
 * Read the contract's canonical EIP-712 domain (ERC-5267) on-chain and assert it matches
 * the selected chain and contract — so a wrong RPC or contract can't produce a mis-scoped
 * signature. The domain name/version come from the contract itself, not a local constant.
 */
const readOnchainDomain: DomainReader = async (session) => {
  const publicClient = createPublicClient({
    chain: toChain(session.chainId, session.rpcUrl),
    transport: http(session.rpcUrl),
  });
  const [, name, version, chainId, verifyingContract] = await publicClient.readContract({
    address: session.contract,
    abi: EXECUTE_ABI,
    functionName: 'eip712Domain',
  });
  if (Number(chainId) !== session.chainId) {
    throw new Error(`Contract EIP-712 chainId ${chainId} does not match the selected chain ${session.chainId}`);
  }
  if (verifyingContract.toLowerCase() !== session.contract.toLowerCase()) {
    throw new Error(`Contract EIP-712 verifyingContract ${verifyingContract} does not match ${session.contract}`);
  }
  return { name, version, chainId: session.chainId, verifyingContract };
};

/** Which operation to sign, and what the caller asserts the human approved for it. */
export interface SignOperationRequest extends SignConfirmation {
  operationId: string;
}

/**
 * Fetch a queued operation, refuse unless the confirmation equals the review decoded from its calls, then build and
 * sign its EIP-712 Execute typed data with the keystore account, pack the signature per the contract version, and
 * submit it. The private key never leaves this function.
 */
export async function signOperation(
  deps: SignOperationDeps,
  request: SignOperationRequest,
): Promise<SubmitSignatureResult> {
  const { client, account, session, readDomain = readOnchainDomain } = deps;
  const { operationId } = request;

  const operation: ReviewableQueueOperation = reviewableOperationSchema.parse(
    await client.callTool('get_queue_operation', { operationId }),
  );

  if (!operation.canSign || operation.userSigned || operation.isBlocked) {
    throw new Error(
      `Operation ${operationId} is not signable (canSign=${operation.canSign}, userSigned=${operation.userSigned}, isBlocked=${operation.isBlocked})`,
    );
  }
  assertReviewConfirmed(
    buildOperationReview(operation, { operationId, session, signerAddress: account.address }),
    request,
  );

  const domain = await readDomain(session);
  if (!domain.version) {
    throw new Error('Contract EIP-712 domain has no version');
  }
  const message = buildExecuteTypedMessage({ calls: operation.calls, nonce: operation.nonce });
  const typedData = buildExecuteTypedData({ domain, message });

  const rawSignature = await account.signTypedData(typedData);
  // Pack with the same version the signature is scoped under (the on-chain domain), not the
  // backend-derived session.version — otherwise the envelope format (raw vs packed) could
  // diverge from what the contract verifies.
  const signature = packSignatures([{ user: account.address, sign: rawSignature }], domain.version);

  return submitSignatureResultSchema.parse(await client.callTool('submit_signature', { operationId, signature }));
}
