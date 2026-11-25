import { transactions } from '@b2binpay/defi-sdk';
import { createPublicClient, createWalletClient, type Hex, http, type LocalAccount } from 'viem';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { type QueueOperation, queueOperationSchema } from '../backend/tool-results.js';
import { EXECUTE_ABI } from '../contracts/execute-abi.js';
import { RECEIPT_TIMEOUT_MS, toChain } from './chain.js';
import type { AccountSession } from './session.js';

type EvmSession = Extract<AccountSession, { chainKind: 'evm' }>;

export interface ExecuteOperationDeps {
  client: BackendMcpClient;
  account: LocalAccount;
  session: EvmSession;
}

export interface ExecuteOperationResult {
  txHash: Hex;
  status: 'success';
}

/**
 * Broadcast the on-chain execute transaction for a threshold-met operation from the
 * agent hot wallet. Refuses to broadcast if the operation is not executable.
 */
export async function executeOperation(
  deps: ExecuteOperationDeps,
  operationId: string,
): Promise<ExecuteOperationResult> {
  const { client, account, session } = deps;
  const { rpcUrl } = session;

  const operation: QueueOperation = queueOperationSchema.parse(
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

  const chain = toChain(session.chainId, rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });

  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== session.chainId) {
    throw new Error(`RPC chain ${rpcChainId} does not match the selected chain ${session.chainId}`);
  }

  const prepared = transactions.buildExecuteOperationsTransaction({
    operations: [operation],
    contractAddress: session.contract,
    chainId: session.chainId,
    abi: EXECUTE_ABI,
  });
  const txHash = await walletClient.sendTransaction({ to: prepared.to, data: prepared.data, value: 0n });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') {
    throw new Error(`Execute transaction ${txHash} reverted`);
  }
  return { txHash, status: 'success' };
}
