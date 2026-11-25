import { TronMultisigBlockchainClient } from '@b2binpay/defi-sdk';
import { TronWeb } from 'tronweb';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { type TvmExecutableOperation, tvmExecutableOperationSchema } from '../backend/tool-results.js';
import { EXECUTE_ABI } from '../contracts/execute-abi.js';
import type { TronSigner } from '../keystore/keystore.js';
import type { AccountSession } from './session.js';
import { assertTronDomainMatchesSession, readOnchainTronDomain } from './sign-operation.tron.js';
import { toEvmHex, toTronBase58 } from './tron-address.js';
import { isTronTransaction, signAndBroadcastTron } from './tron-tx.js';

type TvmSession = Extract<AccountSession, { chainKind: 'tvm' }>;

export interface ExecuteOperationTronDeps {
  client: BackendMcpClient;
  signer: TronSigner;
  session: TvmSession;
  /** TRON fee limit in SUN. */
  feeLimit: number;
}

export interface ExecuteOperationTronResult {
  /** TRON transaction id (64-char hex, no `0x` prefix). */
  txHash: string;
  status: 'success';
}

/**
 * Broadcast the on-chain execute transaction for a threshold-met TRON operation from
 * the agent hot wallet. Refuses to broadcast unless the operation is executable and the
 * backend already provided the packed, signer-sorted signature blob.
 */
export async function executeOperationTron(
  deps: ExecuteOperationTronDeps,
  operationId: string,
): Promise<ExecuteOperationTronResult> {
  const { client, signer, session, feeLimit } = deps;

  const operation: TvmExecutableOperation = tvmExecutableOperationSchema.parse(
    await client.callTool('get_queue_operation', { operationId }),
  );

  if (!operation.canExecute || operation.isBlocked) {
    throw new Error(
      `Operation ${operationId} is not executable (canExecute=${operation.canExecute}, isBlocked=${operation.isBlocked})`,
    );
  }
  // The backend-built blob is the packed, signer-sorted signatures the contract expects.
  if (!operation.signatureBlob) {
    throw new Error(`Operation ${operationId} has no signature blob; it is not ready to execute`);
  }

  // Verify the fullHost really serves the selected chain/contract before broadcasting.
  const domain = await readOnchainTronDomain(session);
  assertTronDomainMatchesSession(domain, session);
  if (!domain.version) {
    throw new Error('Contract TIP-712 domain has no version');
  }

  const tronWeb = new TronWeb({ fullHost: session.fullHost });
  const contractAddress = toTronBase58(session.contract);
  const callerAddress = toTronBase58(signer.address);

  const blockchainClient = new TronMultisigBlockchainClient({
    chainId: session.chainId,
    tronWeb,
    contractAbi: { abi: EXECUTE_ABI, version: domain.version },
    defaultFeeLimit: feeLimit,
  });

  // The execute ABI encodes call targets as EVM hex; TRON base58 targets are converted first.
  const executable = {
    ...operation,
    calls: operation.calls.map((call) => ({ to: toEvmHex(call.to), value: call.value, data: call.data })),
  };

  const prepared = await blockchainClient.buildExecuteTransaction({
    contractAddress,
    callerAddress,
    operations: [executable],
  });

  if (!isTronTransaction(prepared.raw)) {
    throw new Error(`Execute build for operation ${operationId} produced no broadcastable transaction`);
  }

  const txHash = await signAndBroadcastTron(
    tronWeb,
    signer,
    prepared.raw,
    `Execute transaction for operation ${operationId}`,
  );
  return { txHash, status: 'success' };
}
