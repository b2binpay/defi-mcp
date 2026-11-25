import { transactions } from '@b2binpay/defi-sdk';
import { TronWeb } from 'tronweb';
import { isHex } from 'viem';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import {
  type SubmitSignatureResult,
  submitSignatureResultSchema,
  type TvmReviewableQueueOperation,
  tvmReviewableOperationSchema,
} from '../backend/tool-results.js';
import { EXECUTE_ABI } from '../contracts/execute-abi.js';
import type { TronSigner } from '../keystore/keystore.js';
import { assertReviewConfirmed, buildOperationReview } from './operation-review.js';
import type { AccountSession } from './session.js';
import type { SignOperationRequest } from './sign-operation.js';
import { sameTronAddress, toTronBase58 } from './tron-address.js';

const {
  buildTronExecuteTypedData,
  fetchTronExecuteTypedDataDomain,
  prepareTronTypedDataForSigning,
  packTronSignatures,
} = transactions;

type TvmSession = Extract<AccountSession, { chainKind: 'tvm' }>;
type TronDomain = transactions.TronExecuteTypedDataPayload['domain'];

/** Reads the TIP-712 domain the operation must be signed under. */
export type TronDomainReader = (session: TvmSession) => Promise<TronDomain>;

export interface SignOperationTronDeps {
  client: BackendMcpClient;
  signer: TronSigner;
  session: TvmSession;
  /** Override for tests; defaults to reading `eip712Domain()` on-chain via TronWeb. */
  readDomain?: TronDomainReader;
}

/**
 * Read the contract's canonical TIP-712 domain on-chain and assert it matches the
 * selected chain and contract — so a wrong fullHost or contract can't produce a
 * mis-scoped signature. The domain name/version come from the contract itself.
 */
export const readOnchainTronDomain: TronDomainReader = async (session) => {
  const contractAddress = toTronBase58(session.contract);
  const tronWeb = new TronWeb({ fullHost: session.fullHost });
  // `eip712Domain()` is a constant call, but TronWeb still needs an `owner_address` for it and a
  // keyless instance has none ("owner_address isn't set"). The value is irrelevant for a view, so
  // use the contract's own address.
  tronWeb.setAddress(contractAddress);
  return fetchTronExecuteTypedDataDomain({ tronWeb, contractAddress, abi: EXECUTE_ABI });
};

/** Assert the on-chain domain is scoped to the selected TVM chain and contract. */
export function assertTronDomainMatchesSession(domain: TronDomain, session: TvmSession): void {
  if (domain.chainId !== BigInt(session.chainId)) {
    throw new Error(`Contract TIP-712 chainId ${domain.chainId} does not match the selected chain ${session.chainId}`);
  }
  if (!sameTronAddress(domain.verifyingContract, session.contract)) {
    throw new Error(
      `Contract TIP-712 verifyingContract ${domain.verifyingContract} does not match ${session.contract}`,
    );
  }
}

/**
 * Fetch a queued TRON operation, refuse unless the confirmation equals the review decoded from its calls, then build
 * and sign its TIP-712 Execute typed data with the keystore signer, pack the signature per the contract version, and
 * submit it. The private key never leaves the keystore.
 */
export async function signOperationTron(
  deps: SignOperationTronDeps,
  request: SignOperationRequest,
): Promise<SubmitSignatureResult> {
  const { client, signer, session, readDomain = readOnchainTronDomain } = deps;
  const { operationId } = request;

  const operation: TvmReviewableQueueOperation = tvmReviewableOperationSchema.parse(
    await client.callTool('get_queue_operation', { operationId }),
  );

  if (!operation.canSign || operation.userSigned || operation.isBlocked) {
    throw new Error(
      `Operation ${operationId} is not signable (canSign=${operation.canSign}, userSigned=${operation.userSigned}, isBlocked=${operation.isBlocked})`,
    );
  }
  assertReviewConfirmed(
    buildOperationReview(operation, { operationId, session, signerAddress: signer.address }),
    request,
  );

  const domain = await readDomain(session);
  assertTronDomainMatchesSession(domain, session);
  if (!domain.version) {
    throw new Error('Contract TIP-712 domain has no version');
  }

  const typedData = buildTronExecuteTypedData({
    domain,
    calls: operation.calls.map((call) => ({
      to: toTronBase58(call.to),
      value: BigInt(call.value),
      data: call.data,
    })),
    nonce: BigInt(operation.nonce),
  });
  const prepared = prepareTronTypedDataForSigning(typedData);

  const rawSignature = await signer.signTypedData(prepared);
  if (!isHex(rawSignature)) {
    throw new Error('TRON signer returned a non-hex signature');
  }

  // Pack with the same version the signature is scoped under (the on-chain domain),
  // mirroring the EVM path so the envelope format matches what the contract verifies.
  const signature = packTronSignatures(
    [{ signer: toTronBase58(signer.address), signature: rawSignature }],
    domain.version,
  );

  return submitSignatureResultSchema.parse(await client.callTool('submit_signature', { operationId, signature }));
}
