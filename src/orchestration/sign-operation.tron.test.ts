import type { transactions } from '@b2binpay/defi-sdk';
import { encodeFunctionData } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { tvmReviewableOperationSchema } from '../backend/tool-results.js';
import { ACCOUNT_SELF_CALL_ABI } from '../contracts/review-abi.js';
import type { TronSigner } from '../keystore/keystore.js';
import { buildOperationReview } from './operation-review.js';
import type { AccountSession } from './session.js';
import type { SignOperationRequest } from './sign-operation.js';
import { signOperationTron } from './sign-operation.tron.js';
import { toEvmHex } from './tron-address.js';

type TvmSession = Extract<AccountSession, { chainKind: 'tvm' }>;

const CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SIGNER_ADDRESS = 'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ';
const CALL_TARGET = 'TBvJUBXorwBPzqvV38vjDgegj5Eh6g2Tsq';
const OPERATION_ID = '42';
// A syntactically valid 65-byte ECDSA signature (deterministic stub, not verified on-chain).
const RAW_SIGNATURE = `0x${'ab'.repeat(65)}`;

const OPERATION = {
  id: OPERATION_ID,
  executeOperationId: '0x00000000000000000000000000000000000000000000000000000000000000ab',
  nonce: '7',
  status: 'PENDING',
  calls: [{ to: CALL_TARGET, value: '1000', data: '0x' }],
  signatureBlob: null,
  signaturesCollected: 0,
  signaturesRequired: 2,
  canSign: true,
  canExecute: false,
  isBlocked: false,
  userSigned: false,
  operationType: 'PAYOUT',
  deployment: { id: 'd1', chainId: '728126428', contractAddress: CONTRACT },
};

const SUBMIT_RESULT = {
  operationId: OPERATION_ID,
  signaturesCollected: 1,
  signaturesRequired: 2,
  canExecute: false,
  userSigned: true,
};

function stubClientFor(operation: Record<string, unknown>): {
  client: BackendMcpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'get_queue_operation') {
      return operation;
    }
    return SUBMIT_RESULT;
  });
  return { client: { callTool } as unknown as BackendMcpClient, calls };
}

function stubClient(): { client: BackendMcpClient; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  return stubClientFor(OPERATION);
}

function stubSigner(): TronSigner {
  return {
    address: SIGNER_ADDRESS,
    signMessage: vi.fn(async () => RAW_SIGNATURE),
    signTypedData: vi.fn(async () => RAW_SIGNATURE),
    signTransaction: vi.fn(),
  };
}

function session(version: string): TvmSession {
  return {
    chainKind: 'tvm',
    deploymentId: 'd1',
    contract: CONTRACT,
    chainId: 728126428,
    fullHost: 'https://api.trongrid.io',
    version,
  };
}

const domainReader = (version: string) => async () => ({
  name: 'MultiSigWallet',
  version,
  chainId: 728126428n,
  verifyingContract: CONTRACT as transactions.TronExecuteTypedDataPayload['domain']['verifyingContract'],
});

/** The request a host sends after the user approved the decoded review. */
function confirmed(): SignOperationRequest {
  return confirmedFor(OPERATION);
}

function confirmedFor(operation: Record<string, unknown>): SignOperationRequest {
  const review = buildOperationReview(tvmReviewableOperationSchema.parse(operation), {
    operationId: OPERATION_ID,
    session: session('1.0.0'),
    signerAddress: SIGNER_ADDRESS,
  });
  return { operationId: OPERATION_ID, confirm: review.confirm };
}

describe('signOperationTron', () => {
  it('submits a raw 65-byte signature for contract v1.0.0', async () => {
    const { client, calls } = stubClient();

    const result = await signOperationTron(
      { client, signer: stubSigner(), session: session('1.0.0'), readDomain: domainReader('1.0.0') },
      confirmed(),
    );

    expect(result).toEqual(SUBMIT_RESULT);
    expect(calls[0]).toEqual({ name: 'get_queue_operation', args: { operationId: OPERATION_ID } });
    // v1.0.0 packs as a raw concat of the single signature.
    expect(calls[1].args.signature).toBe(RAW_SIGNATURE);
  });

  it('submits a signer-prefixed packed signature for v1.1.0', async () => {
    const { client, calls } = stubClient();

    await signOperationTron(
      { client, signer: stubSigner(), session: session('1.1.0'), readDomain: domainReader('1.1.0') },
      confirmed(),
    );

    const submitted = calls[1].args.signature as string;
    const signerHex = toEvmHex(SIGNER_ADDRESS).slice(2).toLowerCase();
    // packed = 0x + [signer 20B][len 2B = 0x0041][sig 65B] = 87 bytes
    expect(submitted.toLowerCase().startsWith(`0x${signerHex}0041`)).toBe(true);
    expect(submitted).toHaveLength(2 + 87 * 2);
  });

  it('refuses to sign an operation that is not signable', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { ...OPERATION, canSign: false };
      }),
    } as unknown as BackendMcpClient;

    await expect(
      signOperationTron(
        { client, signer: stubSigner(), session: session('1.0.0'), readDomain: domainReader('1.0.0') },
        confirmed(),
      ),
    ).rejects.toThrow(/not signable/);
    expect(calls.some((call) => call.name === 'submit_signature')).toBe(false);
  });

  it('rejects a domain whose chainId does not match the session', async () => {
    const { client } = stubClient();
    const wrongChainDomain = async () => ({
      name: 'MultiSigWallet',
      version: '1.0.0',
      chainId: 1n,
      verifyingContract: CONTRACT as transactions.TronExecuteTypedDataPayload['domain']['verifyingContract'],
    });

    await expect(
      signOperationTron(
        { client, signer: stubSigner(), session: session('1.0.0'), readDomain: wrongChainDomain },
        confirmed(),
      ),
    ).rejects.toThrow(/does not match the selected chain/);
  });

  it('signs nothing for an unconfirmed TRON operation and shows its decoded TRX transfer', async () => {
    const { client, calls } = stubClient();

    await expect(
      signOperationTron(
        { client, signer: stubSigner(), session: session('1.0.0'), readDomain: domainReader('1.0.0') },
        { operationId: OPERATION_ID, confirm: 'harmless' },
      ),
    ).rejects.toThrow(`send 0.001 TRX (1000 sun) to ${CALL_TARGET}`);
    expect(calls.some((call) => call.name === 'submit_signature')).toBe(false);
  });

  it('refuses a TRON operation bound to another deployment', async () => {
    const foreign = { ...OPERATION, deployment: { ...OPERATION.deployment, id: 'other-deployment' } };
    const { client, calls } = stubClientFor(foreign);

    await expect(
      signOperationTron(
        { client, signer: stubSigner(), session: session('1.0.0'), readDomain: domainReader('1.0.0') },
        { operationId: OPERATION_ID, confirm: 'x' },
      ),
    ).rejects.toThrow(/belongs to deployment other-deployment/);
    expect(calls.some((call) => call.name === 'submit_signature')).toBe(false);
  });

  it('shows a TRON config change in base58 with its warnings, and signs it only with that confirm', async () => {
    const takeover = {
      ...OPERATION,
      operationType: 'MULTISIG_CONFIG_CHANGE',
      calls: [
        {
          to: CONTRACT,
          value: '0',
          data: encodeFunctionData({
            abi: ACCOUNT_SELF_CALL_ABI,
            functionName: 'setConfig',
            args: [[toEvmHex(CALL_TARGET)], 1n],
          }),
        },
      ],
      payload: { approvers: [SIGNER_ADDRESS, CALL_TARGET], threshold: 2 },
    };
    const { client, calls } = stubClientFor(takeover);
    const deps = { client, signer: stubSigner(), session: session('1.0.0'), readDomain: domainReader('1.0.0') };

    await expect(signOperationTron(deps, { operationId: OPERATION_ID, confirm: 'keep owners' })).rejects.toThrow(
      `removes this agent's signer ${SIGNER_ADDRESS} from the account owners; the operation payload claims owners ` +
        `[${SIGNER_ADDRESS}, ${CALL_TARGET}] with threshold 2, but the calls set the owners shown below | ` +
        `(1) set account owners to [${CALL_TARGET}] with threshold 1`,
    );
    expect(calls.some((call) => call.name === 'submit_signature')).toBe(false);

    await signOperationTron(deps, confirmedFor(takeover));
    expect(calls.some((call) => call.name === 'submit_signature')).toBe(true);
  });
});
