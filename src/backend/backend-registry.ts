import { validateTronAddress } from '@b2binpay/defi-sdk';
import { isAddress } from 'viem';
import { CHAIN_KINDS, type ChainKind, chainKind } from '../config/chain-kind.js';
import { type AppConfig, rpcForChain } from '../config/env.js';
import type { Keystore } from '../keystore/keystore.js';
import type { SessionStore } from '../orchestration/session.js';
import { AUTH_PROTOCOL, BackendAuth } from './auth.js';
import { BackendMcpClient, describeError, type ErrorDetail } from './mcp-client.js';
import { type McpToolDefinition, ToolScope } from './types.js';

/**
 * Scopes read off the backend's `tools/list` annotations, so the backend owns the classification
 * and this server holds no table of tool names. Built once at boot from the same catalog the
 * gateway advertises.
 */
export type ToolScopes = ReadonlyMap<string, ToolScope>;

export function toolScopes(tools: McpToolDefinition[]): ToolScopes {
  const scopes = new Map<string, ToolScope>();
  for (const tool of tools) {
    const scope = tool.annotations?.scope;
    if (scope) {
      scopes.set(tool.name, scope);
    }
  }
  return scopes;
}

/**
 * Fallback for a backend that publishes no `scope` annotation: the two reads that must not be
 * account-scoped for the surface to work at all. `list_accounts` is how a client discovers what
 * it may select, and `get_profile` is the identity itself — routing either as account-scoped
 * would demand a selection that cannot be made yet. Everything else falls through to
 * {@link ToolScope.ACCOUNT}, which only ever asks for a selected account.
 */
const FALLBACK_IDENTITY_READS: ReadonlySet<string> = new Set(['list_accounts', 'get_profile']);

/**
 * A catalog read answers the same for every principal, so one slot serves it. An explicit
 * `deploymentId` overrides the declared scope: it narrows the answer to one account (as
 * `list_cross_chain_routes` does), and only the owning identity may answer that.
 */
function isCatalogRead(scope: ToolScope, args: Record<string, unknown>): boolean {
  return scope === ToolScope.CATALOG && args.deploymentId === undefined;
}

/** Creates a new account before any exists to select; routed by its `isTron` argument. */
const CREATE_ACCOUNT = 'create_account';

/**
 * Writes one address-book row for the caller's own identity. IDENTITY-scoped (it takes no account
 * argument), but unlike a read, IDENTITY's normal fan-out would write the same label/address pair
 * into every filled slot's address book. Routed instead by the target address's own family.
 */
const CREATE_ADDRESS_BOOK_ENTRY = 'create_address_book_entry';

/** A backend endpoint the router can dispatch a tool call to. */
export interface BackendCallable {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** The per-protocol client set the router dispatches over — implemented by {@link BackendRegistry}. */
export interface ProtocolClients {
  filledKinds(): ChainKind[];
  clientFor(kind: ChainKind): BackendCallable;
  discoveryClient(): BackendCallable;
}

/** One backend view produced under a specific protocol identity, for a merged fan-out result. */
interface TaggedResult {
  protocol: ChainKind;
  result?: unknown;
  error?: ErrorDetail;
}

/** The chain family a `create_account` call targets, from its explicit `isTron` flag. */
function createAccountKind(args: Record<string, unknown>): ChainKind {
  const { isTron } = args;
  if (isTron === undefined) {
    return 'evm';
  }
  if (typeof isTron !== 'boolean') {
    throw new Error('create_account: isTron must be a boolean');
  }
  return isTron ? 'tvm' : 'evm';
}

/** The chain family a `create_address_book_entry` call targets, from its `address` argument's own form. */
function createAddressBookEntryKind(args: Record<string, unknown>): ChainKind {
  const { address } = args;
  if (typeof address !== 'string') {
    throw new Error('create_address_book_entry: address must be a string');
  }
  if (isAddress(address, { strict: false })) {
    return 'evm';
  }
  if (validateTronAddress({ address }).isValid) {
    return 'tvm';
  }
  throw new Error(`create_address_book_entry: "${address}" is neither an EVM nor a TRON address`);
}

/**
 * The nonce chainId a protocol authenticates under. The JWT is chain-agnostic, so any valid
 * chain of the right kind works: prefer an explicit `*_AUTH_CHAIN_ID` override, then the
 * configured default when it matches, else the first configured chain of that kind.
 *
 * The override exists because the derived fallback picks the *first* configured chain of the kind
 * (numeric keys iterate ascending → EVM chain 1, TRON mainnet), which the backend rejects on an
 * environment where that chain is not active (e.g. a Shasta-only dev). Set `TVM_AUTH_CHAIN_ID`
 * there.
 */
function authChainId(config: AppConfig, kind: ChainKind): number {
  const override = config.authChainId[kind];
  if (override !== undefined) {
    // The override must be a chain of this slot's kind, or auth would sign the nonce for the
    // wrong protocol (SIWE with a TRON id) or resolve a non-TRON RPC for the TVM signer.
    if (chainKind(override) !== kind) {
      throw new Error(
        `${kind.toUpperCase()}_AUTH_CHAIN_ID=${override} is not a ${kind.toUpperCase()} chain; set a ${kind} chain id`,
      );
    }
    return override;
  }
  if (chainKind(config.defaultChainId) === kind) {
    return config.defaultChainId;
  }
  const match = Object.keys(config.networks)
    .map(Number)
    .find((chainId) => chainKind(chainId) === kind);
  if (!match) {
    throw new Error(`No ${kind} chain configured to authenticate the ${kind} identity`);
  }
  // Derived fallback: the first configured chain of this kind (often a mainnet). If it is not
  // active in the backend environment, /nonce rejects it — warn so the cause is visible, and
  // point at the explicit override. stderr is this server's diagnostic stream.
  process.stderr.write(
    `Warning: authenticating the ${kind} identity on derived chain ${match} (no ${kind.toUpperCase()}_AUTH_CHAIN_ID ` +
      `set and DEFAULT_CHAIN_ID is a different kind). Set ${kind.toUpperCase()}_AUTH_CHAIN_ID if the backend rejects it.\n`,
  );
  return match;
}

/** Build a backend auth session for a filled slot's identity. */
function buildAuth(config: AppConfig, keystore: Keystore, kind: ChainKind): BackendAuth {
  const chainId = authChainId(config, kind);
  const base = { apiUrl: config.backendApiUrl, authUrl: config.authUrl, chainId };
  if (kind === 'tvm') {
    const signer = keystore.requireIdentity('tvm').createSigner(rpcForChain(config, chainId));
    return new BackendAuth({ ...base, protocol: AUTH_PROTOCOL.tvm, signer });
  }
  const account = keystore.requireIdentity('evm').account;
  return new BackendAuth({ ...base, protocol: AUTH_PROTOCOL.evm, account });
}

/**
 * Per-protocol backend clients, one per filled keystore slot. Each wraps its own lazy auth
 * session so a slot that is never exercised is never authenticated (beyond boot discovery).
 */
export class BackendRegistry {
  private constructor(private readonly clients: Partial<Record<ChainKind, BackendMcpClient>>) {}

  static build(config: AppConfig, keystore: Keystore): BackendRegistry {
    const clients: Partial<Record<ChainKind, BackendMcpClient>> = {};
    for (const kind of keystore.filledKinds()) {
      clients[kind] = new BackendMcpClient({ mcpUrl: config.backendMcpUrl, auth: buildAuth(config, keystore, kind) });
    }
    return new BackendRegistry(clients);
  }

  filledKinds(): ChainKind[] {
    return CHAIN_KINDS.filter((kind) => this.clients[kind] !== undefined);
  }

  /** The client for a protocol, or throw naming the missing slot. */
  clientFor(kind: ChainKind): BackendMcpClient {
    const client = this.clients[kind];
    if (!client) {
      throw new Error(`No ${kind.toUpperCase()} identity configured; cannot reach the backend as a ${kind} principal`);
    }
    return client;
  }

  /** The single slot used to fetch the identity-independent backend tool catalog at boot. */
  discoveryClient(): BackendMcpClient {
    const [first] = this.filledKinds();
    return this.clientFor(first);
  }

  /** Clients in discovery order (first filled first) so boot can fall back to another slot. */
  discoveryClients(): BackendMcpClient[] {
    return this.filledKinds().map((kind) => this.clientFor(kind));
  }
}

/**
 * Routes backend tool calls to the identity that owns the target account:
 *  - a selected session pins the protocol;
 *  - with no session and one filled slot, that slot is used;
 *  - with no session and both slots, the scope the backend published for the tool decides:
 *    an identity-wide read fans out and merges per protocol, a catalog read uses one slot, and
 *    an account-scoped tool requires an account to be selected first.
 */
export class BackendRouter {
  constructor(
    private readonly registry: ProtocolClients,
    private readonly sessions: SessionStore,
    private readonly scopes: ToolScopes = new Map(),
  ) {}

  /**
   * The scope the backend declared for a tool. Unknown to the catalog — a tool added to the
   * backend after this server booted, or a backend old enough to publish no annotations — is
   * account-scoped, so it asks for a selection instead of guessing an identity.
   */
  private scopeOf(name: string): ToolScope {
    const declared = this.scopes.get(name);
    if (declared) {
      return declared;
    }
    return FALLBACK_IDENTITY_READS.has(name) ? ToolScope.IDENTITY : ToolScope.ACCOUNT;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // create_account targets the family in its own `isTron` flag, independent of any selected
    // session — creating a TRON account while an EVM account is selected (or vice versa) must go
    // to the TRON identity, not the session's. This precedes both the session and single-slot
    // shortcuts so the flag always wins and a missing slot errors instead of misrouting.
    if (name === CREATE_ACCOUNT) {
      return this.registry.clientFor(createAccountKind(args)).callTool(name, args);
    }
    if (name === CREATE_ADDRESS_BOOK_ENTRY) {
      return this.registry.clientFor(createAddressBookEntryKind(args)).callTool(name, args);
    }

    const selected = this.sessions.current();
    if (selected) {
      return this.registry.clientFor(selected.chainKind).callTool(name, args);
    }

    const kinds = this.registry.filledKinds();
    if (kinds.length === 1) {
      return this.registry.clientFor(kinds[0]).callTool(name, args);
    }

    const scope = this.scopeOf(name);
    if (isCatalogRead(scope, args)) {
      return this.registry.discoveryClient().callTool(name, args);
    }
    if (scope === ToolScope.IDENTITY) {
      // allSettled, not all: a degraded slot (bad key, auth failure) must not blind the healthy
      // one — its result comes back tagged with the error instead of failing the whole read.
      const settled = await Promise.allSettled(kinds.map((kind) => this.registry.clientFor(kind).callTool(name, args)));
      return settled.map((outcome, index): TaggedResult => {
        const protocol = kinds[index];
        if (outcome.status === 'fulfilled') {
          return { protocol, result: outcome.value };
        }
        return { protocol, error: describeError(outcome.reason) };
      });
    }
    throw new Error(
      `${name} needs a specific identity but none is selected and multiple are configured. ` +
        'Select an account first (select_account) so the correct protocol is used.',
    );
  }
}
