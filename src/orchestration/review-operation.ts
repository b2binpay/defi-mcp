import type { BackendMcpClient } from '../backend/mcp-client.js';
import { reviewableOperationSchema, tvmReviewableOperationSchema } from '../backend/tool-results.js';
import { buildOperationReview, type OperationReview } from './operation-review.js';
import type { AccountSession } from './session.js';

/** Fetch a queued operation of the selected account and decode what signing it would authorize. Signs nothing. */
export async function reviewOperation(
  client: BackendMcpClient,
  session: AccountSession,
  signerAddress: string,
  operationId: string,
): Promise<OperationReview> {
  const raw = await client.callTool('get_queue_operation', { operationId });
  const operation =
    session.chainKind === 'tvm' ? tvmReviewableOperationSchema.parse(raw) : reviewableOperationSchema.parse(raw);
  return buildOperationReview(operation, { operationId, session, signerAddress });
}
