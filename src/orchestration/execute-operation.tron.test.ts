import { describe, expect, it, vi } from 'vitest';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import type { TronSigner } from '../keystore/keystore.js';
import { executeOperationTron } from './execute-operation.tron.js';
import type { AccountSession } from './session.js';

const buildExecuteTransaction = vi.fn(async () => ({ raw: { raw_data: {} } }));
const clientOptions = vi.fn();

vi.mock('@b2binpay/defi-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b2binpay/defi-sdk')>();
  return {
    ...actual,
    TronMultisigBlockchainClient: class {
      constructor(options: unknown) {
        clientOptions(options);
      }
      buildExecuteTransaction = buildExecuteTransaction;
    },
  };
});

vi.mock('./sign-operation.tron.js', () => ({
  readOnchainTronDomain: vi.fn(async () => ({ version: '1.2.0' })),
  assertTronDomainMatchesSession: vi.fn(),
}));

vi.mock('./tron-tx.js', () => ({
  isTronTransaction: (value: unknown) => typeof value === 'object' && value !== null && 'raw_data' in value,
  signAndBroadcastTron: vi.fn(async () => 'f'.repeat(64)),
}));

const OPERATION_ID = '42';

/** Schema-valid TVM executable operation; individual tests flip the guard fields. */
const EXECUTABLE = {
  id: OPERATION_ID,
  executeOperationId: '0x00000000000000000000000000000000000000000000000000000000000000ab',
  nonce: '7',
  status: 'READY',
  calls: [{ to: '0x2222222222222222222222222222222222222222', value: '1000', data: '0x' }],
  signatureBlob: '0xdeadbeef',
  signaturesCollected: 2,
  signaturesRequired: 2,
  canSign: false,
  canExecute: true,
  isBlocked: false,
  userSigned: true,
  operationType: 'PAYOUT',
  payload: {},
  txHash: null,
  canDelete: false,
  canReject: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'agent',
};

function stubClient(operation: Record<string, unknown>): {
  client: BackendMcpClient;
  callTool: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn(async () => operation);
  return { client: { callTool } as unknown as BackendMcpClient, callTool };
}

const session: Extract<AccountSession, { chainKind: 'tvm' }> = {
  chainKind: 'tvm',
  deploymentId: 'd1',
  contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  chainId: 728126428,
  fullHost: 'https://api.shasta.trongrid.io',
  version: '1.2.0',
};

const deps = (client: BackendMcpClient) => ({ client, signer: {} as TronSigner, session, feeLimit: 100_000_000 });

describe('executeOperationTron guards', () => {
  it('refuses to broadcast when the operation is not executable', async () => {
    const { client } = stubClient({ ...EXECUTABLE, canExecute: false });
    await expect(executeOperationTron(deps(client), OPERATION_ID)).rejects.toThrow(/not executable/);
  });

  it('refuses to broadcast a blocked operation', async () => {
    const { client } = stubClient({ ...EXECUTABLE, isBlocked: true });
    await expect(executeOperationTron(deps(client), OPERATION_ID)).rejects.toThrow(/not executable/);
  });

  it('refuses to broadcast without a signature blob', async () => {
    const { client } = stubClient({ ...EXECUTABLE, signatureBlob: null });
    await expect(executeOperationTron(deps(client), OPERATION_ID)).rejects.toThrow(/no signature blob/);
  });
});

describe('executeOperationTron', () => {
  it('hands the SDK the backend signature blob and EVM-hex call targets on the session chain', async () => {
    const { client } = stubClient(EXECUTABLE);
    const signer = { address: session.contract } as TronSigner;

    const result = await executeOperationTron({ ...deps(client), signer }, OPERATION_ID);

    expect(result).toEqual({ txHash: 'f'.repeat(64), status: 'success' });
    expect(clientOptions).toHaveBeenCalledWith(expect.objectContaining({ chainId: session.chainId }));
    const [{ operations }] = buildExecuteTransaction.mock.calls[0] as unknown as [{ operations: unknown[] }];
    expect(operations).toEqual([
      expect.objectContaining({
        signatureBlob: EXECUTABLE.signatureBlob,
        executeOperationId: EXECUTABLE.executeOperationId,
        calls: [{ to: EXECUTABLE.calls[0].to, value: '1000', data: '0x' }],
      }),
    ]);
    expect(operations[0]).not.toHaveProperty('signatures');
  });
});
