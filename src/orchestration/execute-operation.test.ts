import type { Hex } from 'viem';
import { createPublicClient, createWalletClient, decodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { EXECUTE_ABI } from '../contracts/execute-abi.js';
import { executeOperation } from './execute-operation.js';
import type { AccountSession } from './session.js';

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: vi.fn(), createWalletClient: vi.fn() };
});

const ACCOUNT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const CONTRACT: Hex = '0x1111111111111111111111111111111111111111';
const CHAIN_ID = 11155111;
const OPERATION_ID = '42';
const TX_HASH: Hex = '0xabc0000000000000000000000000000000000000000000000000000000000abc';

const EXECUTABLE = {
  id: OPERATION_ID,
  executeOperationId: '0x00000000000000000000000000000000000000000000000000000000000000ab',
  nonce: '7',
  status: 'PENDING',
  calls: [{ to: '0x2222222222222222222222222222222222222222', value: '1000', data: '0x' }],
  signatureBlob: '0xdeadbeef',
  signaturesCollected: 2,
  signaturesRequired: 2,
  canSign: false,
  canExecute: true,
  isBlocked: false,
  userSigned: true,
};

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

function stubClient(operation: Record<string, unknown>): {
  client: BackendMcpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return operation;
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

describe('executeOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts the execute tx to the account contract and confirms success', async () => {
    const { client, calls } = stubClient(EXECUTABLE);
    const { sendTransaction } = mockChain();

    const result = await executeOperation({ client, account: ACCOUNT, session: session() }, OPERATION_ID);

    expect(result).toEqual({ txHash: TX_HASH, status: 'success' });
    expect(calls[0]).toEqual({ name: 'get_queue_operation', args: { operationId: OPERATION_ID } });
    const sent = sendTransaction.mock.calls[0][0];
    expect(sent.to).toBe(CONTRACT);
    expect(sent.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data: sent.data });
    expect(decoded.functionName).toBe('execute');
    expect(decoded.args).toEqual([
      [
        {
          calls: [{ to: EXECUTABLE.calls[0].to, value: 1000n, data: '0x' }],
          signatures: EXECUTABLE.signatureBlob,
          id: EXECUTABLE.executeOperationId,
        },
      ],
    ]);
  });

  it('refuses to broadcast when the operation is not executable', async () => {
    const { client } = stubClient({ ...EXECUTABLE, canExecute: false });
    mockChain();
    await expect(executeOperation({ client, account: ACCOUNT, session: session() }, OPERATION_ID)).rejects.toThrow(
      /not executable/,
    );
    expect(vi.mocked(createWalletClient)).not.toHaveBeenCalled();
  });

  it('refuses to broadcast a blocked operation', async () => {
    const { client } = stubClient({ ...EXECUTABLE, isBlocked: true });
    mockChain();
    await expect(executeOperation({ client, account: ACCOUNT, session: session() }, OPERATION_ID)).rejects.toThrow(
      /not executable/,
    );
  });

  it('refuses to broadcast without a signature blob', async () => {
    const { client } = stubClient({ ...EXECUTABLE, signatureBlob: null });
    mockChain();
    await expect(executeOperation({ client, account: ACCOUNT, session: session() }, OPERATION_ID)).rejects.toThrow(
      /no signature blob/,
    );
  });

  it('refuses when the RPC chain does not match the selected chain', async () => {
    const { client } = stubClient(EXECUTABLE);
    const { sendTransaction } = mockChain({ rpcChainId: 1 });
    await expect(executeOperation({ client, account: ACCOUNT, session: session() }, OPERATION_ID)).rejects.toThrow(
      /does not match the selected chain/,
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('throws when the execute transaction reverts', async () => {
    const { client } = stubClient(EXECUTABLE);
    mockChain({ receiptStatus: 'reverted' });
    await expect(executeOperation({ client, account: ACCOUNT, session: session() }, OPERATION_ID)).rejects.toThrow(
      /reverted/,
    );
  });
});
