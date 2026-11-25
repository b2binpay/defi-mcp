import type { Hex } from 'viem';
import { createPublicClient, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { claim } from './claim.js';
import { collectClaimDeposits } from './claim-collect.js';
import type { AccountSession } from './session.js';

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: vi.fn(), createWalletClient: vi.fn() };
});
vi.mock('./claim-collect.js', () => ({ collectClaimDeposits: vi.fn() }));

const ACCOUNT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const CONTRACT: Hex = '0x1111111111111111111111111111111111111111';
const TOKEN: Hex = '0x5555555555555555555555555555555555555555';
const CHAIN_ID = 11155111;
const CURRENCY_ID = 'cur-1';
const TX_HASH: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000abc';
const DEPOSIT_IDS: Hex[] = ['0x00000000000000000000000000000000000000000000000000000000000000a1'];

function session(): Extract<AccountSession, { chainKind: 'evm' }> {
  return {
    chainKind: 'evm',
    deploymentId: 'd1',
    contract: CONTRACT,
    chainId: CHAIN_ID,
    rpcUrl: 'https://rpc.test',
    version: '1.2.0',
  };
}

const client = { callTool: vi.fn() } as unknown as BackendMcpClient;

function collectReturns(erc20Address: string | null, symbol = 'USDT') {
  vi.mocked(collectClaimDeposits).mockResolvedValue({ erc20Address, symbol, depositIds: DEPOSIT_IDS });
}

function mockChain({ rpcChainId = CHAIN_ID, receiptStatus = 'success' as 'success' | 'reverted' } = {}): {
  sendTransaction: ReturnType<typeof vi.fn>;
} {
  const sendTransaction = vi.fn(async () => TX_HASH);
  vi.mocked(createPublicClient).mockReturnValue({
    getChainId: vi.fn(async () => rpcChainId),
    waitForTransactionReceipt: vi.fn(async () => ({ status: receiptStatus })),
  } as unknown as ReturnType<typeof createPublicClient>);
  vi.mocked(createWalletClient).mockReturnValue({ sendTransaction } as unknown as ReturnType<
    typeof createWalletClient
  >);
  return { sendTransaction };
}

describe('claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sweeps a token currency into the account contract and reports deposit count', async () => {
    collectReturns(TOKEN);
    const { sendTransaction } = mockChain();

    const result = await claim({ client, account: ACCOUNT, session: session() }, CURRENCY_ID);

    expect(result).toEqual({
      txHash: TX_HASH,
      status: 'success',
      currencyId: CURRENCY_ID,
      symbol: 'USDT',
      deposits: 1,
    });
    const sent = sendTransaction.mock.calls[0][0];
    expect(sent.to).toBe(CONTRACT);
    expect(sent.value).toBe(0n);
  });

  it('sweeps the native coin (null currency address → zero address) without error', async () => {
    collectReturns(null, 'ETH');
    mockChain();
    const result = await claim({ client, account: ACCOUNT, session: session() }, CURRENCY_ID);
    expect(result.symbol).toBe('ETH');
  });

  it('rejects a malformed currency address before broadcasting', async () => {
    collectReturns('not-an-address');
    const { sendTransaction } = mockChain();
    await expect(claim({ client, account: ACCOUNT, session: session() }, CURRENCY_ID)).rejects.toThrow(
      /not a valid ERC-20/,
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses when the RPC chain does not match the selected chain', async () => {
    collectReturns(TOKEN);
    const { sendTransaction } = mockChain({ rpcChainId: 1 });
    await expect(claim({ client, account: ACCOUNT, session: session() }, CURRENCY_ID)).rejects.toThrow(
      /does not match the selected chain/,
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('throws when the claim transaction reverts', async () => {
    collectReturns(TOKEN);
    mockChain({ receiptStatus: 'reverted' });
    await expect(claim({ client, account: ACCOUNT, session: session() }, CURRENCY_ID)).rejects.toThrow(/reverted/);
  });
});
