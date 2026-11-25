import { describe, expect, it } from 'vitest';
import { queueOperationSchema, tvmQueueOperationSchema } from './tool-results.js';

/**
 * The shape `get_queue_operation` returns on the current api: the queue
 * response carries the packed `signatureBlob` plus a `signers` roster and no per-signer blob
 * list. Parsing this payload is the contract these schemas have to satisfy.
 */
const liveResponse = {
  id: '100000000000000001',
  executeOperationId: '0x000000000000000000000000000000000000000000000000032453e6ff4009f0',
  nonce: '1',
  operationType: 'PAYOUT',
  status: 'READY',
  calls: [{ to: '0x1111111111111111111111111111111111111111', data: '0x', value: '100000000000000' }],
  payload: { payoutId: '100000000000000002' },
  signaturesCollected: 1,
  signaturesRequired: 1,
  userSigned: true,
  canSign: false,
  canExecute: true,
  canDelete: false,
  canReject: true,
  isBlocked: false,
  createdAt: '2026-09-17T15:45:21.143Z',
  createdBy: '0x1111111111111111111111111111111111111111',
  signers: [
    { address: '0x1111111111111111111111111111111111111111', isSigned: true, signedAt: '2026-09-17T15:47:59.998Z' },
  ],
  signatureBlob: `0x11111111111111111111111111111111111111110041${'a'.repeat(130)}`,
  txHash: null,
  expiresAt: null,
  dappMetadata: null,
};

describe('queueOperationSchema', () => {
  it('parses the queue operation the current api returns', () => {
    const parsed = queueOperationSchema.parse(liveResponse);

    expect(parsed.signatureBlob).toBe(liveResponse.signatureBlob);
    expect(parsed.canExecute).toBe(true);
  });

  it('parses it as a TVM operation too', () => {
    expect(() => tvmQueueOperationSchema.parse(liveResponse)).not.toThrow();
  });

  it('requires the signature blob field to be present', () => {
    const { signatureBlob, ...withoutBlob } = liveResponse;

    expect(signatureBlob).toBeDefined();
    expect(queueOperationSchema.safeParse(withoutBlob).success).toBe(false);
  });
});
