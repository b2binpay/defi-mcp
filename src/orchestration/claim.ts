import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  isAddress,
  type LocalAccount,
  zeroAddress,
} from 'viem';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { CLAIM_ABI } from '../contracts/claim-abi.js';
import { RECEIPT_TIMEOUT_MS, toChain } from './chain.js';
import { collectClaimDeposits } from './claim-collect.js';
import type { AccountSession } from './session.js';

type EvmSession = Extract<AccountSession, { chainKind: 'evm' }>;

export interface ClaimDeps {
  client: BackendMcpClient;
  account: LocalAccount;
  session: EvmSession;
}

export interface ClaimResult {
  txHash: Hex;
  status: 'success';
  currencyId: string;
  symbol: string;
  deposits: number;
}

/** The `erc20` argument for `claim`: native coin → address(0), token → its 0x-hex address. */
function erc20Param(address: string | null): Address {
  if (!address) {
    return zeroAddress;
  }
  const hex = address.startsWith('0x') ? address : `0x${address}`;
  if (!isAddress(hex)) {
    throw new Error(`Currency address ${address} is not a valid ERC-20 address`);
  }
  return hex;
}

/**
 * Sweep all claimable deposits of one currency into the selected multisig from the agent hot
 * wallet. `claim` moves funds into the account and needs no multisig signature, so this is a
 * single direct on-chain call (no queue, no threshold).
 */
export async function claim(deps: ClaimDeps, currencyId: string): Promise<ClaimResult> {
  const { client, account, session } = deps;
  const { rpcUrl } = session;

  const { erc20Address, symbol, depositIds } = await collectClaimDeposits(client, session.deploymentId, currencyId);

  const chain = toChain(session.chainId, rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });

  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== session.chainId) {
    throw new Error(`RPC chain ${rpcChainId} does not match the selected chain ${session.chainId}`);
  }

  const data = encodeFunctionData({
    abi: CLAIM_ABI,
    functionName: 'claim',
    args: [erc20Param(erc20Address), depositIds],
  });

  const txHash = await walletClient.sendTransaction({ to: session.contract, data, value: 0n });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') {
    throw new Error(`Claim transaction ${txHash} reverted`);
  }

  return { txHash, status: 'success', currencyId, symbol, deposits: depositIds.length };
}
