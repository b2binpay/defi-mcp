import type { transactions } from '@b2binpay/defi-sdk';
import { TronWeb, type Types } from 'tronweb';
import type { Hex, LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_KINDS, type ChainKind } from '../config/chain-kind.js';
import type { KeySlots } from './key-sources.js';

/**
 * A TRON signer bound to a keystore key and a TronWeb `fullHost`. Exposes only
 * signing operations; the raw key stays inside the keystore module.
 */
export interface TronSigner {
  address: string;
  /** TIP-191 personal-message signature (used for the auth challenge). */
  signMessage(message: string): Promise<string>;
  /** TIP-712 typed-data signature (used for operation signing). */
  signTypedData(prepared: transactions.TronSignableTypedData): Promise<string>;
  /** Sign a built transaction (used to broadcast the on-chain execute). */
  signTransaction(transaction: Types.Transaction): Promise<Types.SignedTransaction>;
}

/** The EVM signing identity: a viem account that signs without exposing the key. */
export interface EvmIdentity {
  kind: 'evm';
  address: string;
  account: LocalAccount;
}

/** The TVM signing identity: a TRON base58 address and a fullHost-bound signer factory. */
export interface TronIdentity {
  kind: 'tvm';
  address: string;
  createSigner(fullHost: string): TronSigner;
}

/** The concrete identity type held by each protocol slot, so lookups narrow without a re-check. */
interface IdentityFor {
  evm: EvmIdentity;
  tvm: TronIdentity;
}

/**
 * Local keystore holding at most one EVM and one TVM signing identity.
 *
 * The trust boundary this server owns: the raw keys live only here, never leave the
 * process, and never enter LLM context. Callers get a viem `LocalAccount` or a
 * `TronSigner` (which can sign) but never the raw key material.
 *
 * Storage is env/config-provided for this iteration. A file/KMS/remote-signer/TEE
 * backend is future scope.
 */
export class Keystore {
  private readonly identities: Partial<{ [K in ChainKind]: IdentityFor[K] }>;

  private constructor(identities: Partial<{ [K in ChainKind]: IdentityFor[K] }>) {
    this.identities = identities;
  }

  /** Build the keystore from resolved per-protocol keys; at least one slot must be present. */
  static fromSlots(slots: KeySlots): Keystore {
    const identities: Partial<{ [K in ChainKind]: IdentityFor[K] }> = {};
    if (slots.evm) {
      identities.evm = buildEvmIdentity(slots.evm);
    }
    if (slots.tvm) {
      identities.tvm = buildTronIdentity(slots.tvm);
    }
    if (!identities.evm && !identities.tvm) {
      throw new Error('Keystore requires at least one key slot');
    }
    return new Keystore(identities);
  }

  /** The identity for a protocol, or `undefined` when its slot is empty. */
  identity<K extends ChainKind>(kind: K): IdentityFor[K] | undefined {
    return this.identities[kind];
  }

  /** The identity for a protocol, or throw naming the missing slot. */
  requireIdentity<K extends ChainKind>(kind: K): IdentityFor[K] {
    const identity = this.identities[kind];
    if (!identity) {
      throw new Error(
        `No ${kind.toUpperCase()} key configured; this server cannot act on ${kind.toUpperCase()} chains`,
      );
    }
    return identity;
  }

  /** Filled protocol slots, EVM before TVM — the deterministic order boot discovery uses. */
  filledKinds(): ChainKind[] {
    return CHAIN_KINDS.filter((kind) => this.identities[kind] !== undefined);
  }

  /** Signer addresses per filled slot, for diagnostics and address-listing tools. */
  addresses(): Partial<Record<ChainKind, string>> {
    const result: Partial<Record<ChainKind, string>> = {};
    for (const kind of CHAIN_KINDS) {
      const identity = this.identities[kind];
      if (identity) {
        result[kind] = identity.address;
      }
    }
    return result;
  }
}

function buildEvmIdentity(privateKey: Hex): EvmIdentity {
  const account = privateKeyToAccount(privateKey);
  return { kind: 'evm', address: account.address, account };
}

function buildTronIdentity(privateKey: Hex): TronIdentity {
  const tronKey = privateKey.slice(2);
  const address = TronWeb.address.fromPrivateKey(tronKey);
  if (!address) {
    throw new Error('Could not derive a TRON address from the TVM key');
  }
  return {
    kind: 'tvm',
    address,
    createSigner: (fullHost) => {
      const tronWeb = new TronWeb({ fullHost, privateKey: tronKey });
      return {
        address,
        signMessage: async (message) => tronWeb.trx.signMessageV2(message),
        signTypedData: async (prepared) =>
          tronWeb.trx._signTypedData(prepared.domain, prepared.types, prepared.message),
        signTransaction: async (transaction) => tronWeb.trx.sign(transaction),
      };
    },
  };
}
