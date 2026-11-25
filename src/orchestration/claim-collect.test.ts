import { describe, expect, it, vi } from 'vitest';
import type { BackendMcpClient } from '../backend/mcp-client.js';
import { collectClaimDeposits } from './claim-collect.js';

const USDT = '11155111-0xdac17f958d2ee523a2206206994597c13d831ec7';
const DAI = '11155111-0x6b175474e89094c44da98b954eedeac495271d0f';

function item(invoiceNonce: string, currencyId: string, address: string | null, symbol: string) {
  return {
    invoiceId: `inv-${invoiceNonce}`,
    invoiceNonce,
    currency: { id: currencyId, symbol, address },
    amount: '1.0',
  };
}

function clientReturning(pages: unknown[]): { client: BackendMcpClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let call = 0;
  const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    calls.push(args);
    return pages[call++];
  });
  return { client: { callTool } as unknown as BackendMcpClient, calls };
}

describe('collectClaimDeposits', () => {
  it('gathers deposits of one currency and converts invoiceNonce to bytes32', async () => {
    const { client } = clientReturning([
      {
        total: 2,
        page: 1,
        pageSize: 100,
        items: [item('1', USDT, '0xdac17f958d2ee523a2206206994597c13d831ec7', 'USDT'), item('7', DAI, null, 'DAI')],
      },
    ]);

    const result = await collectClaimDeposits(client, 'dep-1', USDT);

    expect(result.depositIds).toHaveLength(1);
    expect(result.symbol).toBe('USDT');
    expect(result.erc20Address).toBe('0xdac17f958d2ee523a2206206994597c13d831ec7');
    expect(result.depositIds).toEqual(['0x0000000000000000000000000000000000000000000000000000000000000001']);
  });

  it('pages through list_claims until every deposit of the currency is collected', async () => {
    const fullPage = {
      total: 150,
      page: 1,
      pageSize: 100,
      items: Array.from({ length: 100 }, (_v, i) =>
        item(String(i + 1), USDT, '0xdac17f958d2ee523a2206206994597c13d831ec7', 'USDT'),
      ),
    };
    const lastPage = {
      total: 150,
      page: 2,
      pageSize: 100,
      items: Array.from({ length: 50 }, (_v, i) =>
        item(String(i + 101), USDT, '0xdac17f958d2ee523a2206206994597c13d831ec7', 'USDT'),
      ),
    };
    const { client, calls } = clientReturning([fullPage, lastPage]);

    const result = await collectClaimDeposits(client, 'dep-1', USDT);

    expect(result.depositIds).toHaveLength(150);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ page: 2, pageSize: 100 });
  });

  it('carries the native coin (null currency address) through unchanged', async () => {
    const NATIVE = '11155111';
    const { client } = clientReturning([{ total: 1, page: 1, pageSize: 100, items: [item('5', NATIVE, null, 'ETH')] }]);

    const result = await collectClaimDeposits(client, 'dep-1', NATIVE);

    expect(result.erc20Address).toBeNull();
    expect(result.depositIds).toEqual(['0x0000000000000000000000000000000000000000000000000000000000000005']);
  });

  it('throws when the currency has nothing to claim', async () => {
    const { client } = clientReturning([{ total: 1, page: 1, pageSize: 100, items: [item('1', DAI, null, 'DAI')] }]);

    await expect(collectClaimDeposits(client, 'dep-1', USDT)).rejects.toThrow(/No claimable deposits/);
  });

  it('accepts the same token address in different checksum casing', async () => {
    const lower = '0xdac17f958d2ee523a2206206994597c13d831ec7';
    const checksummed = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
    const { client } = clientReturning([
      {
        total: 2,
        page: 1,
        pageSize: 100,
        items: [item('1', USDT, lower, 'USDT'), item('2', USDT, checksummed, 'USDT')],
      },
    ]);

    const result = await collectClaimDeposits(client, 'dep-1', USDT);

    expect(result.depositIds).toHaveLength(2);
  });
});
