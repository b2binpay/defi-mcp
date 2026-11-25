import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { type Hex, toHex } from 'viem';
import { english, HDKey } from 'viem/accounts';
import { z } from 'zod';
import type { ChainKind } from '../config/chain-kind.js';
import type { KeySourceKind } from '../config/env.js';

/**
 * BIP44 derivation path per protocol, index 0. Standard wallet paths so the derived
 * addresses match MetaMask (coin 60) and TronLink (coin 195) on import.
 */
const DERIVATION_PATH: Record<ChainKind, string> = {
  evm: "m/44'/60'/0'/0/0",
  tvm: "m/44'/195'/0'/0/0",
};

/** Resolved private keys per protocol slot; a missing slot is simply absent. */
export type KeySlots = Partial<Record<ChainKind, Hex>>;

const hexPrivateKey = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value.startsWith('0x') ? value : `0x${value}`))
  .refine((value): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value), {
    message: 'must be a 32-byte hex string',
  });

/** Per-protocol env var names for the two key sources a slot accepts. */
const SLOT_ENV: Record<ChainKind, { privateKey: string; mnemonic: string }> = {
  evm: { privateKey: 'EVM_PRIVATE_KEY', mnemonic: 'EVM_MNEMONIC' },
  tvm: { privateKey: 'TVM_PRIVATE_KEY', mnemonic: 'TVM_MNEMONIC' },
};

const SHARED_MNEMONIC_ENV = 'MNEMONIC';

/**
 * Shared primitive: validate and normalize a raw hex private key. Reused by every backend;
 * `label` names the source (env var or keychain entry) in the error, never the value.
 */
export function parsePrivateKey(label: string, raw: string): Hex {
  const result = hexPrivateKey.safeParse(raw);
  if (!result.success) {
    throw new Error(`${label} ${result.error.issues.map((issue) => issue.message).join(', ')}`);
  }
  return result.data;
}

/**
 * Shared primitive: derive the slot's private key from a BIP39 mnemonic at its protocol's path,
 * then wipe the derivation seed and HD private bytes. `source` names the origin in errors only.
 */
export function deriveFromMnemonic(kind: ChainKind, mnemonic: string, source: string): Hex {
  // Collapse any internal whitespace (newlines from a wrapped file, double spaces) to single
  // spaces: @scure/bip39 splits strictly on a single space, so a valid phrase piped from a file
  // would otherwise fail validation.
  const normalized = mnemonic.trim().replace(/\s+/g, ' ');
  if (!validateMnemonic(normalized, english)) {
    throw new Error(`${source} is not a valid BIP39 mnemonic (bad word list or checksum)`);
  }
  const seed = mnemonicToSeedSync(normalized);
  const hdKey = HDKey.fromMasterSeed(seed);
  try {
    const derived = hdKey.derive(DERIVATION_PATH[kind]);
    if (!derived.privateKey) {
      throw new Error(`Could not derive a ${kind} private key from ${source}`);
    }
    return toHex(derived.privateKey);
  } finally {
    // The hot key persists as the return value for signing, but the seed derives *every* slot —
    // wipe it and the HD node's private bytes even on a derivation error so they don't linger.
    seed.fill(0);
    hdKey.wipePrivateData();
  }
}

/**
 * A pluggable per-slot key backend. Resolves a protocol slot to its private key, or `undefined`
 * when that slot has no source. The active backend alone decides each slot — there is no
 * cross-backend merge. How a slot's source is *typed* is backend-specific (see {@link EnvKeySource}
 * vs the keychain backend); only the shared primitives above are reused across backends.
 */
export interface KeySource {
  read(kind: ChainKind): Promise<Hex | undefined>;
}

/**
 * Environment-variable backend (the default). Source-typed: the variable *name* selects the
 * primitive — a `*_PRIVATE_KEY` var is always parsed as a hex key and a `*_MNEMONIC`/shared
 * `MNEMONIC` var is always derived as a BIP39 mnemonic. A value is never auto-reclassified, so a
 * malformed `*_PRIVATE_KEY` fails as an invalid key rather than being retried as a mnemonic.
 */
export class EnvKeySource implements KeySource {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  /**
   * Resolve one protocol slot synchronously, in priority order: per-slot private key, per-slot
   * mnemonic, then the shared mnemonic. A slot given both a per-slot private key and a per-slot
   * mnemonic is a configuration error; the shared `MNEMONIC` is a fallback, never a conflict.
   */
  resolve(kind: ChainKind): Hex | undefined {
    const { privateKey: pkEnv, mnemonic: mnemonicEnv } = SLOT_ENV[kind];
    const pk = this.source[pkEnv];
    const slotMnemonic = this.source[mnemonicEnv];

    if (pk && slotMnemonic) {
      throw new Error(`Set only one of ${pkEnv} or ${mnemonicEnv} for the ${kind} slot, not both`);
    }
    if (pk) {
      return parsePrivateKey(pkEnv, pk);
    }
    if (slotMnemonic) {
      return deriveFromMnemonic(kind, slotMnemonic, mnemonicEnv);
    }
    const shared = this.source[SHARED_MNEMONIC_ENV];
    if (shared) {
      return deriveFromMnemonic(kind, shared, SHARED_MNEMONIC_ENV);
    }
    return undefined;
  }

  async read(kind: ChainKind): Promise<Hex | undefined> {
    return this.resolve(kind);
  }
}

/**
 * Pick the key backend for `kind`. The keychain backend is dynamically imported so that
 * `KEY_SOURCE=env` never loads the keychain module or its native addon.
 */
export async function createKeySource(kind: KeySourceKind): Promise<KeySource> {
  if (kind === 'keychain') {
    const { KeychainKeySource } = await import('./keychain-source.js');
    return new KeychainKeySource();
  }
  return new EnvKeySource();
}

/**
 * Load the EVM and TVM signing keys from the active backend. Loaded separately from
 * {@link import('../config/env.js').loadConfig} so no key material ever lives on the shared
 * config object; it flows only into the keystore. At least one slot must resolve to a key.
 */
export async function loadKeySlots(source: KeySource): Promise<KeySlots> {
  const slots: KeySlots = {};
  const evm = await source.read('evm');
  if (evm) {
    slots.evm = evm;
  }
  const tvm = await source.read('tvm');
  if (tvm) {
    slots.tvm = tvm;
  }
  if (!slots.evm && !slots.tvm) {
    throw new Error(
      'No signing key configured. Set at least one slot (EVM and/or TVM) for the active KEY_SOURCE ' +
        'backend — for KEY_SOURCE=env: MNEMONIC (both), or EVM_MNEMONIC / EVM_PRIVATE_KEY and/or ' +
        'TVM_MNEMONIC / TVM_PRIVATE_KEY; for KEY_SOURCE=keychain: run `defi-mcp keychain set evm|tvm` ' +
        '(a locked or access-denied keychain can also present as empty — unlock it or grant access).',
    );
  }
  return slots;
}
