import { createPublicClient, createWalletClient, encodeFunctionData, type Hex, http, type LocalAccount } from 'viem';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { type DeployParams, deployParamsSchema } from '../backend/tool-results.js';
import { PROXY_FACTORY_ABI } from '../contracts/proxy-factory-abi.js';
import { RECEIPT_TIMEOUT_MS, toChain } from './chain.js';

export interface DeployAccountDeps {
  client: BackendMcpClient;
  account: LocalAccount;
  chainId: number;
  rpcUrl: string;
}

export interface DeployAccountResult {
  txHash: Hex;
  status: 'success';
}

/**
 * Deploy the multisig on-chain: fetch the CREATE2 deploy params from the backend and
 * broadcast `createInstance` on the proxy factory from the agent hot wallet. The backend
 * indexer registers the resulting deployment (its `deploymentId`) with a lag; this tool
 * only broadcasts and confirms the on-chain transaction.
 */
export async function deployAccount(deps: DeployAccountDeps, accountId: string): Promise<DeployAccountResult> {
  const { client, account, chainId, rpcUrl } = deps;

  const params: DeployParams = deployParamsSchema.parse(
    await client.callTool('get_account_deploy_params', { accountId }),
  );

  const chain = toChain(chainId, rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });

  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== chainId) {
    throw new Error(`RPC chain ${rpcChainId} does not match the requested chain ${chainId}`);
  }

  const txHash = await walletClient.sendTransaction({
    to: params.deployerAddress,
    data: encodeFunctionData({
      abi: PROXY_FACTORY_ABI,
      functionName: 'createInstance',
      args: [params.implementationAddress, params.initializerBytecode, params.nonce],
    }),
    value: 0n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') {
    throw new Error(`Deploy transaction ${txHash} reverted`);
  }
  return { txHash, status: 'success' };
}
