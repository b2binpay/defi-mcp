import type { Hex } from 'viem';
import { createPublicClient, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { deployAccount } from './deploy-account.js';

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: vi.fn(), createWalletClient: vi.fn() };
});

const ACCOUNT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const CHAIN_ID = 11155111;
const ACCOUNT_ID = 'acc-1';
const TX_HASH: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000abc';

const DEPLOY_PARAMS = {
  implementationAddress: '0x3333333333333333333333333333333333333333',
  initializerBytecode: '0x1234',
  nonce: '0x0000000000000000000000000000000000000000000000000000000000000001',
  deployerAddress: '0x4444444444444444444444444444444444444444',
};

function stubClient(): { client: BackendMcpClient; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return DEPLOY_PARAMS;
  });
  return { client: { callTool } as unknown as BackendMcpClient, calls };
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

const deps = (client: BackendMcpClient) => ({
  client,
  account: ACCOUNT,
  chainId: CHAIN_ID,
  rpcUrl: 'https://rpc.test',
});

describe('deployAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts createInstance to the proxy factory and confirms success', async () => {
    const { client, calls } = stubClient();
    const { sendTransaction } = mockChain();

    const result = await deployAccount(deps(client), ACCOUNT_ID);

    expect(result).toEqual({ txHash: TX_HASH, status: 'success' });
    expect(calls[0]).toEqual({ name: 'get_account_deploy_params', args: { accountId: ACCOUNT_ID } });
    const sent = sendTransaction.mock.calls[0][0];
    expect(sent.to).toBe(DEPLOY_PARAMS.deployerAddress);
    expect(sent.value).toBe(0n);
  });

  it('refuses when the RPC chain does not match the requested chain', async () => {
    const { client } = stubClient();
    const { sendTransaction } = mockChain({ rpcChainId: 1 });
    await expect(deployAccount(deps(client), ACCOUNT_ID)).rejects.toThrow(/does not match the requested chain/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('throws when the deploy transaction reverts', async () => {
    const { client } = stubClient();
    mockChain({ receiptStatus: 'reverted' });
    await expect(deployAccount(deps(client), ACCOUNT_ID)).rejects.toThrow(/reverted/);
  });
});
