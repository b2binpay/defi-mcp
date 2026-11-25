import type { LocalAccount } from 'viem';
import type { ChainKind } from '../config/chain-kind.js';
import type { TronSigner } from '../keystore/keystore.js';
import { postJson } from './http.js';
import { type AuthSession, authSessionSchema, type NonceResponse, nonceResponseSchema } from './types.js';

/** Backend auth protocol wire value. `siwe` for EVM identities, `tron` for TVM identities. */
export type AuthProtocol = 'siwe' | 'tron';

/** The backend auth protocol a chain kind authenticates under. */
export const AUTH_PROTOCOL = { evm: 'siwe', tvm: 'tron' } as const satisfies Record<ChainKind, AuthProtocol>;

/** Auth endpoints live under the versioned REST prefix; `apiUrl` is the bare base. */
const AUTH_BASE = 'api/v1/auth';
/** Refresh a little before expiry so an in-flight request never races the deadline. */
const EXPIRY_SKEW_MS = 30_000;

interface BaseAuthOptions {
  apiUrl: string;
  authUrl: string;
  chainId: number;
}

/**
 * Protocol-tagged auth options: `siwe` signs the challenge with a viem account,
 * `tron` signs it with a TronWeb-backed keystore signer (TIP-191 personal message).
 */
export type BackendAuthOptions =
  | (BaseAuthOptions & { protocol: 'siwe'; account: LocalAccount })
  | (BaseAuthOptions & { protocol: 'tron'; signer: TronSigner });

interface ChallengeSigner {
  address: string;
  signChallenge(message: string): Promise<string>;
}

/**
 * Challenge-signature authentication against the backend REST API. Signs the nonce
 * challenge with the local keystore identity for the configured protocol and holds
 * the resulting JWT session for the MCP client. The key never leaves the keystore.
 */
type FlightKind = 'auth' | 'refresh';

export class BackendAuth {
  private session: AuthSession | null = null;
  private inflight: { kind: FlightKind; promise: Promise<AuthSession> } | null = null;

  constructor(private readonly options: BackendAuthOptions) {}

  /** Discard the cached session and run the full auth flow again. */
  async reauthenticate(): Promise<AuthSession> {
    this.session = null;
    return this.authenticate();
  }

  authenticate(): Promise<AuthSession> {
    return this.singleFlight('auth', () => this.runAuthenticate());
  }

  /**
   * Coalesce concurrent calls of the same kind onto one in-flight request. A refresh and a
   * full re-auth are different kinds, so a pending refresh never satisfies `reauthenticate`
   * (which needs a fresh token, not the one that may have just been rejected).
   */
  private singleFlight(kind: FlightKind, run: () => Promise<AuthSession>): Promise<AuthSession> {
    if (this.inflight && this.inflight.kind === kind) {
      return this.inflight.promise;
    }
    const promise = run();
    this.inflight = { kind, promise };
    const clear = (): void => {
      if (this.inflight?.promise === promise) {
        this.inflight = null;
      }
    };
    // `.then(clear, clear)`, not `.finally(clear)`: finally re-raises the rejection on its derived
    // promise, which nobody awaits → an unhandled rejection that crashes the process. Handling both
    // outcomes here keeps the tracking chain settled while callers await the original `promise`.
    promise.then(clear, clear);
    return promise;
  }

  /** Resolve the identity address and challenge signer for the configured protocol. */
  private challengeSigner(): ChallengeSigner {
    if (this.options.protocol === 'tron') {
      const { signer } = this.options;
      return { address: signer.address, signChallenge: (message) => signer.signMessage(message) };
    }
    const { account } = this.options;
    return { address: account.address, signChallenge: (message) => account.signMessage({ message }) };
  }

  private async runAuthenticate(): Promise<AuthSession> {
    const { apiUrl, authUrl, chainId, protocol } = this.options;
    const { address, signChallenge } = this.challengeSigner();
    const nonce: NonceResponse = await postJson(
      `${apiUrl}/${AUTH_BASE}/nonce`,
      { protocol, address, chainId: String(chainId), authUrl },
      nonceResponseSchema,
    );

    const signature = await signChallenge(nonce.message);

    this.session = await postJson(
      `${apiUrl}/${AUTH_BASE}/verify`,
      { protocol, message: nonce.message, signature },
      authSessionSchema,
    );
    return this.session;
  }

  private refresh(): Promise<AuthSession> {
    if (!this.session) {
      return this.authenticate();
    }
    return this.singleFlight('refresh', () => this.runRefresh());
  }

  private async runRefresh(): Promise<AuthSession> {
    const current = this.session;
    if (!current) {
      // Route through authenticate() so concurrent callers coalesce onto one auth flight, rather
      // than each running a parallel runAuthenticate() that races on this.session.
      return this.authenticate();
    }
    try {
      const refreshed = await postJson(
        `${this.options.apiUrl}/${AUTH_BASE}/refresh`,
        { refreshToken: current.refreshToken },
        authSessionSchema,
      );
      // A concurrent reauthenticate/authenticate may have replaced (or cleared) the session while
      // this refresh was in flight. Only publish the refreshed token if the session is still the
      // one we refreshed from — otherwise it is derived from a superseded refresh token.
      if (this.session === current) {
        this.session = refreshed;
        return refreshed;
      }
      // A newer session was already published — return it. If the session was cleared mid-flight
      // (a re-auth is running), coalesce onto that flight rather than returning the stale refresh.
      if (this.session) {
        return this.session;
      }
      return this.authenticate();
    } catch {
      // A concurrent authenticate/reauthenticate may have replaced the session with a fresh one
      // while this refresh was in flight; don't clobber it.
      if (this.session && this.session !== current) {
        return this.session;
      }
      // Otherwise a rejected/expired refresh token would wedge the session forever; drop it and
      // fall back to a full re-authentication (via authenticate() so concurrent callers coalesce
      // onto one flight) so the next call recovers on its own.
      this.session = null;
      return this.authenticate();
    }
  }

  /** Current access token, authenticating on first use and refreshing before expiry. */
  async getAccessToken(): Promise<string> {
    // Read the token off the session each call returns, not `this.session` after the await — a
    // concurrent reauthenticate could null the field between the await and the read.
    if (!this.session) {
      return (await this.authenticate()).accessToken;
    }
    if (this.isExpired(this.session)) {
      return (await this.refresh()).accessToken;
    }
    return this.session.accessToken;
  }

  private isExpired(session: AuthSession): boolean {
    const expiresAt = Date.parse(session.expiresAt);
    if (Number.isNaN(expiresAt)) {
      return true;
    }
    return expiresAt <= Date.now() + EXPIRY_SKEW_MS;
  }
}
