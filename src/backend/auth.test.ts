import type { LocalAccount } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendAuth } from './auth.js';
import { postJson } from './http.js';

vi.mock('./http.js', () => ({ postJson: vi.fn(), HTTP_TIMEOUT_MS: 30_000 }));

const mockPostJson = vi.mocked(postJson);

const ACCOUNT = { address: '0xabc', signMessage: async () => '0xsignature' } as unknown as LocalAccount;

function makeAuth(): BackendAuth {
  return new BackendAuth({
    protocol: 'siwe',
    apiUrl: 'https://api.test',
    authUrl: 'https://app.test',
    chainId: 11155111,
    account: ACCOUNT,
  });
}

function session(overrides: Partial<{ accessToken: string; expiresAt: string }> = {}) {
  return {
    accessToken: overrides.accessToken ?? 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: 'u1', address: '0xabc' },
  };
}

/** Route the mocked postJson by endpoint: nonce → challenge, verify/refresh → the given session. */
function routeAuth(sessionByUrl: () => ReturnType<typeof session>): void {
  mockPostJson.mockImplementation(async (url: string) => {
    if (url.endsWith('/nonce')) {
      return { nonce: 'n', message: 'sign me' };
    }
    return sessionByUrl();
  });
}

beforeEach(() => {
  mockPostJson.mockReset();
});

describe('BackendAuth', () => {
  it('authenticates on first use and returns the access token', async () => {
    routeAuth(() => session({ accessToken: 'access-1' }));
    const auth = makeAuth();
    expect(await auth.getAccessToken()).toBe('access-1');
  });

  it('coalesces concurrent first-use calls into a single auth flow', async () => {
    routeAuth(() => session());
    const auth = makeAuth();
    await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
    const nonceCalls = mockPostJson.mock.calls.filter(([url]) => String(url).endsWith('/nonce'));
    expect(nonceCalls).toHaveLength(1);
  });

  it('does not surface an unhandled rejection when authentication fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      mockPostJson.mockRejectedValue(new Error('backend down'));
      const auth = makeAuth();
      await expect(auth.getAccessToken()).rejects.toThrow('backend down');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not clobber a concurrently reauthenticated session on refresh success', async () => {
    // First auth yields an already-expired session, so the next call refreshes.
    routeAuth(() => session({ accessToken: 'access-1', expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    const auth = makeAuth();
    await auth.getAccessToken();

    let releaseRefresh: () => void = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    mockPostJson.mockReset();
    mockPostJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/nonce')) {
        return { nonce: 'n', message: 'sign me' };
      }
      if (url.endsWith('/refresh')) {
        await refreshGate;
        return session({ accessToken: 'access-refreshed' });
      }
      return session({ accessToken: 'access-2' }); // /verify → the concurrent reauth's fresh session
    });

    const refreshing = auth.getAccessToken(); // expired → in-flight refresh (blocked on the gate)
    await auth.reauthenticate(); // clears + re-auths to a newer session while refresh is in flight
    releaseRefresh(); // now let the stale refresh resolve
    await refreshing;

    // The refresh must not overwrite the newer session; the reauth token wins.
    expect(await auth.getAccessToken()).toBe('access-2');
  });

  it('coalesces onto the in-flight re-auth (not a stale refresh) when the session is cleared mid-refresh', async () => {
    routeAuth(() => session({ accessToken: 'access-1', expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    const auth = makeAuth();
    await auth.getAccessToken();

    let releaseRefresh: () => void = () => {};
    let releaseNonce: () => void = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const nonceGate = new Promise<void>((resolve) => {
      releaseNonce = resolve;
    });
    mockPostJson.mockReset();
    mockPostJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/refresh')) {
        await refreshGate;
        return session({ accessToken: 'access-refreshed' });
      }
      if (url.endsWith('/nonce')) {
        await nonceGate; // hold the re-auth in flight so this.session stays null
        return { nonce: 'n', message: 'sign me' };
      }
      return session({ accessToken: 'access-3' });
    });

    const refreshing = auth.getAccessToken(); // expired → in-flight refresh (gated)
    const reauthing = auth.reauthenticate(); // clears session, re-auth blocked on the nonce gate
    await new Promise((r) => setTimeout(r, 5));
    releaseRefresh(); // refresh resolves while session is null → must join the re-auth, not return stale
    await new Promise((r) => setTimeout(r, 5));
    releaseNonce();

    const [refreshed] = await Promise.all([refreshing, reauthing]);
    expect(refreshed).toBe('access-3'); // the fresh re-auth token, not 'access-refreshed'
    const nonceCalls = mockPostJson.mock.calls.filter(([url]) => String(url).endsWith('/nonce'));
    expect(nonceCalls).toHaveLength(1);
  });

  it('falls back to a full re-auth when the refresh token is rejected', async () => {
    // First auth yields an already-expired session, forcing the next call to refresh.
    routeAuth(() => session({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    const auth = makeAuth();
    await auth.getAccessToken();

    mockPostJson.mockReset();
    mockPostJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/refresh')) {
        throw new Error('refresh rejected');
      }
      if (url.endsWith('/nonce')) {
        return { nonce: 'n', message: 'sign me' };
      }
      return session({ accessToken: 'access-2' });
    });

    expect(await auth.getAccessToken()).toBe('access-2');
    const nonceCalls = mockPostJson.mock.calls.filter(([url]) => String(url).endsWith('/nonce'));
    expect(nonceCalls).toHaveLength(1);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
