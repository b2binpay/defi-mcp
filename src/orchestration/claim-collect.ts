import { type Hex, toHex } from 'viem';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { type ClaimItem, claimsPageSchema } from '../backend/tool-results.js';
import { sameTronAddress } from './tron-address.js';

const PAGE_SIZE = 100;

/**
 * Whether two claim-item currency addresses refer to the same token. Normalizes across
 * encodings (TRON base58 vs hex, EVM checksum casing) so equivalent forms are not rejected;
 * `null` is the native coin and only equals `null`.
 */
function sameCurrencyAddress(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return sameTronAddress(a, b);
}

export interface ClaimDeposits {
  /** Currency contract address as the backend returns it (EVM hex / TRON base58), or null for the native coin. */
  erc20Address: string | null;
  symbol: string;
  depositIds: Hex[];
}

/** Backend `invoiceNonce` is a decimal (or hex) string; on-chain `claim` expects `bytes32`. */
function invoiceNonceToBytes32(nonce: string): Hex {
  return toHex(BigInt(nonce), { size: 32 });
}

/**
 * Gather every claimable deposit of one currency on a deployment, paging through `list_claims`
 * and filtering by currency id. Returns the deposit ids (as `bytes32`) and the currency address
 * the on-chain `claim` call needs. Throws if the currency has nothing to claim.
 */
export async function collectClaimDeposits(
  client: BackendMcpClient,
  deploymentId: string,
  currencyId: string,
): Promise<ClaimDeposits> {
  const items: ClaimItem[] = [];
  const wanted = currencyId.toLowerCase();
  let page = 1;
  let fetched = 0;
  for (;;) {
    const result = claimsPageSchema.parse(
      await client.callTool('list_claims', { deploymentId, page, pageSize: PAGE_SIZE }),
    );
    // Ids embed a hex address; compare case-insensitively so a casing mismatch is not read as "empty".
    items.push(...result.items.filter((item) => item.currency.id.toLowerCase() === wanted));
    fetched += result.items.length;
    // Terminate on the backend's own metadata, not the requested page size (it may cap it).
    if (result.items.length === 0 || fetched >= result.total) {
      break;
    }
    page += 1;
  }

  if (items.length === 0) {
    throw new Error(`No claimable deposits for currency ${currencyId} on deployment ${deploymentId}`);
  }

  const { address, symbol } = items[0].currency;
  for (const item of items) {
    if (!sameCurrencyAddress(item.currency.address, address)) {
      throw new Error(
        `Currency ${currencyId} returned inconsistent addresses ("${address}" vs "${item.currency.address}")`,
      );
    }
  }

  // A page shift between sequential fetches can return the same deposit twice; a duplicate id in
  // the on-chain claim array reverts the whole tx, so dedupe before returning.
  const depositIds = [...new Set(items.map((item) => invoiceNonceToBytes32(item.invoiceNonce)))];

  return { erc20Address: address, symbol, depositIds };
}
