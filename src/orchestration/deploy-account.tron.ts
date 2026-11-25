import { TronWeb } from 'tronweb';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { type DeployParams, deployParamsSchema } from '../backend/tool-results.js';
import type { TronSigner } from '../keystore/keystore.js';
import { toTronBase58 } from './tron-address.js';
import { isTronTransaction, signAndBroadcastTron } from './tron-tx.js';

/** Proxy factory `createInstance(address,bytes,bytes32)` — the deploy entrypoint. */
const CREATE_INSTANCE_SELECTOR = 'createInstance(address,bytes,bytes32)';

export interface DeployAccountTronDeps {
  client: BackendMcpClient;
  signer: TronSigner;
  fullHost: string;
  /** TRON fee limit in SUN. */
  feeLimit: number;
}

export interface DeployAccountTronResult {
  /** TRON transaction id (64-char hex, no `0x` prefix). */
  txHash: string;
  status: 'success';
}

/**
 * Deploy a TRON multisig on-chain: fetch the CREATE2 deploy params from the backend and
 * broadcast `createInstance` on the proxy factory via TronWeb. Deploy params carry EVM-hex
 * addresses (same endpoint as EVM); the factory + implementation are converted to base58 for
 * TronWeb, while `initializer`/`saltNonce` stay hex. The backend indexer registers the
 * deployment (its `deploymentId`) after the tx confirms.
 */
export async function deployAccountTron(
  deps: DeployAccountTronDeps,
  accountId: string,
): Promise<DeployAccountTronResult> {
  const { client, signer, fullHost, feeLimit } = deps;

  const params: DeployParams = deployParamsSchema.parse(
    await client.callTool('get_account_deploy_params', { accountId }),
  );

  const tronWeb = new TronWeb({ fullHost });
  const factory = toTronBase58(params.deployerAddress);
  const caller = toTronBase58(signer.address);

  // No deployed contract exists yet to read a domain from, so verify the network another way:
  // the proxy factory must have contract code on this fullHost, else it is the wrong TRON network.
  const factoryContract = await tronWeb.trx.getContract(factory);
  if (!factoryContract?.bytecode) {
    throw new Error(`Proxy factory ${factory} has no contract code on ${fullHost}; wrong TRON network?`);
  }

  const built = await tronWeb.transactionBuilder.triggerSmartContract(
    factory,
    CREATE_INSTANCE_SELECTOR,
    { feeLimit, callValue: 0 },
    [
      { type: 'address', value: toTronBase58(params.implementationAddress) },
      { type: 'bytes', value: params.initializerBytecode },
      { type: 'bytes32', value: params.nonce },
    ],
    caller,
  );
  if (!built.result?.result || !isTronTransaction(built.transaction)) {
    throw new Error(`Deploy build for account ${accountId} produced no broadcastable transaction`);
  }

  const txHash = await signAndBroadcastTron(
    tronWeb,
    signer,
    built.transaction,
    `Deploy transaction for account ${accountId}`,
  );
  return { txHash, status: 'success' };
}
