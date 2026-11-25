import type { Hex } from 'viem';
import type { ChainKind } from '../config/chain-kind.js';
import { deriveFromMnemonic, type KeySource, parsePrivateKey } from './key-sources.js';

/** Stable OS-keychain service name; per-protocol account keys select the slot within it. */
export const KEYCHAIN_SERVICE = 'b2binpay-defi-mcp';

/** Account key per protocol slot — no environment suffix in this version (design D4). */
export const KEYCHAIN_ACCOUNT: Record<ChainKind, string> = { evm: 'evm', tvm: 'tvm' };

/** A trimmed value of this shape is treated as a raw private key; anything else, a mnemonic. */
const HEX_SHAPE = /^(0x)?[0-9a-fA-F]{64}$/;

/** Hex-looking but wrong length — almost certainly a mistyped key, not a mnemonic. */
const HEX_ISH = /^(0x)?[0-9a-fA-F]+$/;

/** One OS-keychain credential entry — the subset of `@napi-rs/keyring`'s `AsyncEntry` we use. */
export interface KeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

/**
 * The narrow keychain surface the server + CLI depend on. `@napi-rs/keyring` satisfies it
 * structurally; a test can supply an in-memory fake without casts.
 */
export interface KeyringApi {
  AsyncEntry: new (service: string, account: string) => KeyringEntry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether an error means "the entry does not exist" rather than a locked/unavailable store.
 * `@napi-rs/keyring` returns `null` for a missing entry on some platforms and raises a `NoEntry`
 * error on others, so the absence signal must be recognized both ways to honor "missing = empty".
 */
export function isNoEntryError(error: unknown): boolean {
  const text = `${(error as { code?: unknown })?.code ?? ''} ${errorMessage(error)}`.toLowerCase();
  return /no[\s_-]?entry|no matching entry|not found/.test(text);
}

/**
 * Lazily import the native keychain addon. A load failure (optional dependency absent or the
 * platform has no prebuilt binary) is fatal under `KEY_SOURCE=keychain` and names the remediation.
 * Env-only users never reach this path, so they never require the native module.
 */
export async function loadKeyring(): Promise<KeyringApi> {
  try {
    return await import('@napi-rs/keyring');
  } catch (error) {
    throw new Error(
      `KEY_SOURCE=keychain requires the native @napi-rs/keyring module, which failed to load ` +
        `(${errorMessage(error)}). Install it on this platform (it ships prebuilt binaries for common ` +
        `targets), or switch to KEY_SOURCE=env.`,
    );
  }
}

/**
 * Keychain-only classification (design D3). A keychain entry is one opaque blob — unlike env, where
 * the variable name types the value — so trim first, then a value of {@link HEX_SHAPE} is parsed as
 * a private key and anything else is validated as an English-wordlist BIP39 mnemonic, reusing the
 * same shared primitives as the env path. Trimming first means whitespace-padded hex is accepted.
 */
export function classifyBlob(kind: ChainKind, blob: string, label: string): Hex {
  const trimmed = blob.trim();
  if (HEX_SHAPE.test(trimmed)) {
    return parsePrivateKey(label, trimmed);
  }
  if (HEX_ISH.test(trimmed)) {
    // Hex characters only but not 64 — a truncated/overlong key, not a mnemonic. Report the
    // length (never the value) so the "not a valid mnemonic" error doesn't mislead.
    const hexLen = trimmed.replace(/^0x/, '').length;
    throw new Error(
      `${label} looks like a hex private key but has ${hexLen} hex chars (expected 64); ` +
        `check for a truncated or extra character`,
    );
  }
  return deriveFromMnemonic(kind, trimmed, label);
}

/**
 * OS-keychain backend. Reads one entry per protocol slot from the OS secret store, classified per
 * {@link classifyBlob}.
 *
 * Failure model with `@napi-rs/keyring`: its `getPassword` swallows read errors (missing entry,
 * locked store, denied ACL) to `undefined`, so a failed read is treated as an **empty slot** — the
 * server then fails via the "at least one slot required" rule rather than a keychain-specific error.
 * A store that is genuinely unreachable throws at the constructor / native layer (e.g. no Secret
 * Service on a headless Linux host) and IS fatal via the catch below. Either way this backend never
 * falls back to env — switching to plaintext is an explicit `KEY_SOURCE=env` (design D6). The catch
 * stays as defense in depth for platforms/versions whose read path does throw.
 */
export class KeychainKeySource implements KeySource {
  async read(kind: ChainKind): Promise<Hex | undefined> {
    const keyring = await loadKeyring();
    const account = KEYCHAIN_ACCOUNT[kind];
    let blob: string | null | undefined;
    try {
      blob = await new keyring.AsyncEntry(KEYCHAIN_SERVICE, account).getPassword();
    } catch (error) {
      if (isNoEntryError(error)) {
        return undefined;
      }
      throw new Error(
        `Could not read the ${kind} key from the OS keychain ` +
          `(service '${KEYCHAIN_SERVICE}', account '${account}'): ${errorMessage(error)}. ` +
          `The keychain may be locked, access was denied, or the store is unavailable (e.g. no ` +
          `Secret Service on a headless host). Unlock/grant access, or switch to KEY_SOURCE=env.`,
      );
    }
    if (blob == null) {
      return undefined;
    }
    return classifyBlob(kind, blob, `keychain entry '${account}'`);
  }
}
