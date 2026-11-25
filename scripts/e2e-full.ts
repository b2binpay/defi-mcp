import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as dotenv from 'dotenv';
import { createPublicClient, createWalletClient, type Hex, http, parseEther } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

dotenv.config({ quiet: true });

const CHAIN_ID = process.env.DEFAULT_CHAIN_ID ?? '11155111';
const RPC_URL = process.env[`RPC_URL_${CHAIN_ID}`] ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const FUND_ETH = '0.001';
const PAYOUT_AMOUNT = '0.0001';
/** Native coin: the native currency id equals the chain id. */
const CURRENCY_ID = CHAIN_ID;

/**
 * The client-side funding wallet uses the same EVM signer the server derives: a per-slot
 * `EVM_PRIVATE_KEY`, else the shared/EVM mnemonic at `m/44'/60'/0'/0/0` (mnemonicToAccount's
 * default path). Mirrors the server's EVM slot resolution so the funded address is the signer.
 */
function resolveFundingAccount() {
  const pk = process.env.EVM_PRIVATE_KEY;
  if (pk) {
    return privateKeyToAccount(`0x${pk.replace(/^0x/, '')}` as Hex);
  }
  const mnemonic = (process.env.EVM_MNEMONIC ?? process.env.MNEMONIC ?? '').trim();
  if (!mnemonic) {
    throw new Error('Set EVM_PRIVATE_KEY or EVM_MNEMONIC/MNEMONIC to fund the multisig');
  }
  return mnemonicToAccount(mnemonic);
}

const account = resolveFundingAccount();
const chain = {
  id: Number(CHAIN_ID),
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Account = { id: string; contract: Hex };

/**
 * Normalize the list_accounts response to the EVM account list. With both slots configured the
 * router fans out and returns `[{ protocol, result }]`; a single EVM slot returns the bare list.
 */
function pickEvmAccounts(raw: unknown): Account[] {
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null && 'protocol' in raw[0]) {
    const tagged = raw as Array<{ protocol: string; result?: Account[] }>;
    return tagged.find((entry) => entry.protocol === 'evm')?.result ?? [];
  }
  return raw as Account[];
}

async function main(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/src/index.js'], env });
  const client = new Client({ name: 'e2e-full', version: '0.0.0' });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const resp = await client.callTool({ name, arguments: args });
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

  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ chain, account, transport: http(RPC_URL) });

  const accounts = pickEvmAccounts(await call('list_accounts'));
  if (accounts.length === 0) {
    throw new Error('no EVM accounts for this identity');
  }
  const target = accounts[0];
  console.log('using account', target.id);

  type Session = { deploymentId: string; contract: Hex };
  const trySelect = async (): Promise<Session | undefined> => {
    try {
      return (await call('select_account', { accountId: target.id })) as Session;
    } catch {
      return undefined;
    }
  };

  // A rerun finds the account already deployed: createInstance with the same salt reverts.
  let session = await trySelect();
  if (!session) {
    await call('deploy_account', { accountId: target.id });
  }

  // Retry select_account until the indexer registers the deployment.
  for (let i = 0; i < 40 && !session; i++) {
    session = await trySelect();
    if (!session) {
      await sleep(3000);
    }
  }
  if (!session) {
    throw new Error('deployment not indexed in time');
  }

  console.log(`funding multisig ${session.contract} with ${FUND_ETH} ETH...`);
  const fundHash = await walletClient.sendTransaction({ to: session.contract, value: parseEther(FUND_ETH) });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log('funded:', fundHash);

  const payout = (await call('propose_payout', {
    deploymentId: session.deploymentId,
    currencyId: CURRENCY_ID,
    amount: PAYOUT_AMOUNT,
    toAddress: account.address,
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

  const review = (await call('review_operation', { operationId })) as { confirm: string };
  await call('sign_operation', { operationId, confirm: review.confirm });

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

  await call('execute_operation', { operationId });

  await client.close();
  console.log('E2E COMPLETE');
}

main().catch((error) => {
  console.error('E2E FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
