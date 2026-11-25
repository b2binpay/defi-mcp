import { TRON_ZERO_ADDRESS, type TronAddress } from '@b2binpay/defi-sdk';
import { TronWeb } from 'tronweb';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import type { TronSigner } from '../keystore/keystore.js';
import { collectClaimDeposits } from './claim-collect.js';
import type { AccountSession } from './session.js';
import { assertTronDomainMatchesSession, readOnchainTronDomain } from './sign-operation.tron.js';
import { toTronBase58 } from './tron-address.js';
import { isTronTransaction, signAndBroadcastTron } from './tron-tx.js';

/** MultiSigWallet `claim(erc20, depositIds)` entrypoint. */
const CLAIM_SELECTOR = 'claim(address,bytes32[])';

type TvmSession = Extract<AccountSession, { chainKind: 'tvm' }>;

export interface ClaimTronDeps {
  client: BackendMcpClient;
  signer: TronSigner;
  session: TvmSession;
  /** TRON fee limit in SUN. */
  feeLimit: number;
}

export interface ClaimTronResult {
  /** TRON transaction id (64-char hex, no `0x` prefix). */
  txHash: string;
  status: 'success';
  currencyId: string;
  symbol: string;
  deposits: number;
}

/** The `erc20` argument for `claim` on TRON: native coin → address(0) base58, token → its validated base58. */
function tronErc20Param(address: string | null): TronAddress {
  return address ? toTronBase58(address) : TRON_ZERO_ADDRESS;
}

/**
 * TRON counterpart of {@link claim}: sweep all claimable deposits of one currency into the selected
 * multisig via a direct `claim` contract call from the agent hot wallet. No multisig signature is
 * required (funds move into the account), so this mirrors the EVM path with TronWeb broadcasting.
 */
export async function claimTron(deps: ClaimTronDeps, currencyId: string): Promise<ClaimTronResult> {
  const { client, signer, session, feeLimit } = deps;

  const { erc20Address, symbol, depositIds } = await collectClaimDeposits(client, session.deploymentId, currencyId);

  // Verify the fullHost really serves the selected chain/contract before broadcasting.
  const domain = await readOnchainTronDomain(session);
  assertTronDomainMatchesSession(domain, session);

  // Build the claim directly: the SDK's buildClaimTransaction requires an `execute` entry in the
  // ABI (it is the execute builder), which the claim path has no reason to carry. triggerSmartContract
  // takes the caller as the 5th arg, so `owner_address` is set explicitly from the hot wallet.
  const tronWeb = new TronWeb({ fullHost: session.fullHost });
  const contractAddress = toTronBase58(session.contract);
  const callerAddress = toTronBase58(signer.address);

  const built = await tronWeb.transactionBuilder.triggerSmartContract(
    contractAddress,
    CLAIM_SELECTOR,
    { feeLimit, callValue: 0 },
    [
      { type: 'address', value: tronErc20Param(erc20Address) },
      { type: 'bytes32[]', value: depositIds },
    ],
    callerAddress,
  );
  if (!built.result?.result || !isTronTransaction(built.transaction)) {
    throw new Error(`Claim build for currency ${currencyId} produced no broadcastable transaction`);
  }

  const txHash = await signAndBroadcastTron(
    tronWeb,
    signer,
    built.transaction,
    `Claim transaction for currency ${currencyId}`,
  );
  return { txHash, status: 'success', currencyId, symbol, deposits: depositIds.length };
}
