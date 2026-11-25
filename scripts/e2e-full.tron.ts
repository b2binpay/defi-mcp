import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as dotenv from 'dotenv';
import { TronWeb } from 'tronweb';

dotenv.config({ quiet: true });

/**
 * Shasta testnet — the only TRON testnet the platform supports for this flow. Deliberately does
 * NOT fall back to `DEFAULT_CHAIN_ID`: that is often an EVM chain (e.g. Sepolia) in a dual-stack
 * env, which would drive this TRON-only script onto the wrong chain.
 */
const CHAIN_ID = process.env.TVM_CHAIN_ID ?? '2494104990';
/** Native TRX: on TRON the native currency id equals the chain id. */
const CURRENCY_ID = process.env.CURRENCY_ID ?? CHAIN_ID;
/** TRX amounts in SUN (1 TRX = 1e6 SUN). */
const FUND_SUN = 20_000_000;
const PAYOUT_AMOUNT = '1';
/** TRON BIP44 coin type; matches the server's TVM slot derivation. */
const TVM_DERIVATION_PATH = "m/44'/195'/0'/0/0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The client-side funding wallet uses the same TVM signer the server derives: a per-slot
 * `TVM_PRIVATE_KEY`, else the shared/TVM mnemonic at `m/44'/195'/0'/0/0`. Mirrors the server's
 * TVM slot resolution so the funded address is the signer that proposes/executes.
 */
function resolveFundingPrivateKey(): string {
  const pk = process.env.TVM_PRIVATE_KEY;
  if (pk) {
    return pk.replace(/^0x/, '');
  }
  const mnemonic = (process.env.TVM_MNEMONIC ?? process.env.MNEMONIC ?? '').trim();
  if (!mnemonic) {
    throw new Error('Set TVM_PRIVATE_KEY or TVM_MNEMONIC/MNEMONIC to fund the multisig');
  }
  return TronWeb.fromMnemonic(mnemonic, TVM_DERIVATION_PATH).privateKey.replace(/^0x/, '');
}

type Account = {
  id: string;
  contract: string;
  networkId?: string;
  isHidden?: boolean;
  initialConfig?: { threshold?: number };
};

/**
 * Normalize the list_accounts response to the TVM account list. With both slots configured the
 * router fans out and returns `[{ protocol, result }]`; a single TVM slot returns the bare list.
 */
function pickTvmAccounts(raw: unknown): Account[] {
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null && 'protocol' in raw[0]) {
    const tagged = raw as Array<{ protocol: string; result?: Account[] }>;
    return tagged.find((entry) => entry.protocol === 'tvm')?.result ?? [];
  }
  return raw as Account[];
}

/**
 * Prefer a 1-of-1 account on the target chain: the local agent holds a single signer, so a
 * higher threshold can never reach the signature count needed to execute. Falls back to the
 * first account if none is single-signer.
 */
function pickTarget(accounts: Account[], chainId: string): Account {
  const singleSigner = accounts.find((a) => a.initialConfig?.threshold === 1 && !a.isHidden && a.networkId === chainId);
  return singleSigner ?? accounts[0];
}

async function main(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/src/index.js'], env });
  const client = new Client({ name: 'e2e-full-tron', version: '0.0.0' });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> => {
    const resp = await client.callTool(
      { name, arguments: args },
      undefined,
      timeoutMs ? { timeout: timeoutMs } : undefined,
    );
    const content = Array.isArray(resp.content) ? resp.content : [];
    const text = content.find((p) => p.type === 'text')?.text ?? '';
    if (resp.isError) {
      throw new Error(`${name} failed: ${text}`);
    }
    console.log(`${name}:`, text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const privateKey = resolveFundingPrivateKey();
  const chainId = Number(CHAIN_ID);

  const accounts = pickTvmAccounts(await call('list_accounts'));
  if (accounts.length === 0) {
    throw new Error('no TVM accounts for this identity');
  }
  const target = pickTarget(accounts, CHAIN_ID);
  console.log('using account', target.id, `(threshold ${target.initialConfig?.threshold})`);

  // These accounts are already deployed on-chain, so select first; only deploy when selection
  // never resolves (a genuinely fresh account whose deployment the indexer has yet to register).
  type Session = { deploymentId: string; contract: string; fullHost: string };
  const trySelect = async (): Promise<Session | undefined> => {
    try {
      return (await call('select_account', { accountId: target.id, chainId })) as Session;
    } catch {
      return undefined;
    }
  };

  let session = await trySelect();
  if (!session) {
    await call('deploy_account', { accountId: target.id, chainId }, 180_000);
    for (let i = 0; i < 40 && !session; i++) {
      await sleep(3000);
      session = await trySelect();
    }
  }
  if (!session) {
    throw new Error('deployment not indexed in time');
  }

  const tronWeb = new TronWeb({ fullHost: session.fullHost, privateKey });
  const fromAddress = tronWeb.defaultAddress.base58;
  if (!fromAddress) {
    throw new Error('funding private key produced no address');
  }

  console.log(`funding multisig ${session.contract} with ${FUND_SUN} SUN...`);
  const funded = (await tronWeb.trx.sendTransaction(session.contract, FUND_SUN)) as { txid?: string };
  const fundTxId = funded.txid;
  if (!fundTxId) {
    throw new Error('funding transaction was not broadcast');
  }
  let fundConfirmed = false;
  for (let i = 0; i < 40; i++) {
    const info = (await tronWeb.trx.getTransactionInfo(fundTxId)) as {
      blockNumber?: number;
      receipt?: { result?: string };
    };
    if (info?.blockNumber) {
      // A plain TRX transfer carries no `receipt.result`; a contract call does — fail on a revert.
      if (info.receipt?.result && info.receipt.result !== 'SUCCESS') {
        throw new Error(`funding tx ${fundTxId} failed on-chain: ${info.receipt.result}`);
      }
      fundConfirmed = true;
      break;
    }
    await sleep(3000);
  }
  if (!fundConfirmed) {
    throw new Error(`funding tx ${fundTxId} was not confirmed in time`);
  }
  console.log('funded:', fundTxId);

  const payout = (await call('propose_payout', {
    deploymentId: session.deploymentId,
    currencyId: CURRENCY_ID,
    amount: PAYOUT_AMOUNT,
    toAddress: fromAddress,
  })) as { queueOperationId?: string };

  let operationId = payout.queueOperationId ?? undefined;
  for (let i = 0; !operationId && i < 40; i++) {
    await sleep(3000);
    const queue = (await call('list_queue_operations', { deploymentId: session.deploymentId })) as {
      items: Array<{ id: string; canSign: boolean }>;
    };
    operationId = queue.items.find((op) => op.canSign)?.id;
  }
  if (!operationId) {
    throw new Error('queue operation was not built in time');
  }
  console.log('operationId:', operationId);

  const review = (await call('review_operation', { operationId }, 180_000)) as { confirm: string };
  await call('sign_operation', { operationId, confirm: review.confirm }, 180_000);

  let executable = false;
  for (let i = 0; i < 40 && !executable; i++) {
    const details = (await call('get_queue_operation', { operationId })) as { canExecute: boolean };
    executable = details.canExecute;
    if (!executable) {
      await sleep(3000);
    }
  }
  if (!executable) {
    throw new Error('operation not executable in time');
  }

  await call('execute_operation', { operationId }, 180_000);

  await client.close();
  console.log('TRON E2E COMPLETE');
}

main().catch((error) => {
  console.error('TRON E2E FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
