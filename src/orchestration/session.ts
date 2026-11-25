import type { Hex } from 'viem';

/**
 * The multisig account/deployment the agent is acting on. Joined from `list_accounts`
 * (contract, version) and the local chain config; `deploymentId` is supplied explicitly
 * because the backend `/mcp` surface does not yet expose it (see design.md open question).
 *
 * Discriminated by `chainKind`: EVM sessions carry an `0x` contract and an RPC URL;
 * TVM (TRON) sessions carry a Base58Check contract (T...) and a TronWeb `fullHost`.
 */
export type AccountSession =
  | {
      chainKind: 'evm';
      deploymentId: string;
      contract: Hex;
      chainId: number;
      rpcUrl: string;
      version: string;
    }
  | {
      chainKind: 'tvm';
      deploymentId: string;
      contract: string;
      chainId: number;
      fullHost: string;
      version: string;
    };

/**
 * Holds the single selected account/deployment for the process.
 *
 * The stdio server is a single-client, one-identity-at-a-time surface, so one mutable slot is
 * the intended model. Concurrency safety rests on `AccountSession` being immutable: `select`
 * swaps the whole object rather than mutating it, so an operation that reads the session once
 * (`require()` captured into a local) keeps a stable snapshot for its full duration even if a
 * concurrent `select_account` swaps the store underneath it. Callers MUST capture once and pass
 * the snapshot down — never re-read `current()`/`require()` mid-operation — for that guarantee
 * to hold. Serving genuinely concurrent, differently-scoped callers would need per-request
 * sessions or explicit per-call deployment args instead (out of scope for the stdio model).
 */
export class SessionStore {
  private session: AccountSession | null = null;

  select(session: AccountSession): void {
    this.session = session;
  }

  current(): AccountSession | null {
    return this.session;
  }

  require(): AccountSession {
    if (!this.session) {
      throw new Error('No account selected. Call select_account first.');
    }
    return this.session;
  }
}

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Extract the semver version from a `smartContractVersionId` like "1.0.0-evm". This value is
 * informational (the sign/execute paths use the on-chain domain version, not this), so an
 * unrecognized format falls back to the raw id rather than blocking account selection.
 */
export function parseContractVersion(smartContractVersionId: string): string {
  const [version] = smartContractVersionId.split('-');
  return version && SEMVER.test(version) ? version : smartContractVersionId;
}
