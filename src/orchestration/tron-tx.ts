import type { TronWeb, Types } from 'tronweb';
import type { TronSigner } from '../keystore/keystore.js';

const RECEIPT_POLL_MS = 3000;
const RECEIPT_POLL_TRIES = 20;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Narrow the opaque transaction object a TronWeb builder returns to a signable transaction. */
export function isTronTransaction(value: unknown): value is Types.Transaction {
  return typeof value === 'object' && value !== null && 'raw_data' in value;
}

/** Hex string as TronGrid returns `broadcast.message` (before UTF-8 decoding). */
const HEX_MESSAGE = /^[0-9a-fA-F]+$/;

/** Decode a hex-encoded broadcast message to UTF-8; pass through a plain string unchanged. */
export function decodeTronMessage(tronWeb: TronWeb, message: string | undefined): string {
  if (!message) {
    return '';
  }
  if (HEX_MESSAGE.test(message) && message.length % 2 === 0) {
    try {
      return tronWeb.toUtf8(message);
    } catch {
      return message;
    }
  }
  return message;
}

/**
 * Poll the on-chain receipt until the transaction either succeeds or fails. TRON accepts a tx
 * before executing it, so acceptance alone is not success — a contract call can still revert or
 * run out of energy. Throws on failure or if unconfirmed in time.
 */
export async function confirmTronTx(tronWeb: TronWeb, txid: string): Promise<void> {
  for (let attempt = 0; attempt < RECEIPT_POLL_TRIES; attempt++) {
    const info = await tronWeb.trx.getTransactionInfo(txid);
    if (info && Object.keys(info).length > 0) {
      // A top-level `result: 'FAILED'` can appear with an empty `receipt.result`, so check it too.
      if (info.result === 'FAILED') {
        throw new Error(`TRON transaction ${txid} failed on-chain${info.resMessage ? `: ${info.resMessage}` : ''}`);
      }
      if (info.receipt) {
        // A contract call sets `receipt.result`; success is 'SUCCESS' (or empty on some nodes).
        const result = info.receipt.result;
        if (result && result !== 'SUCCESS') {
          throw new Error(`TRON transaction ${txid} failed on-chain: ${result}`);
        }
        return;
      }
    }
    await sleep(RECEIPT_POLL_MS);
  }
  throw new Error(`TRON transaction ${txid} was not confirmed in time`);
}

/**
 * Sign a built TRON transaction with the keystore signer, broadcast it, and wait for the
 * on-chain receipt. Returns the confirmed txid. `label` names the operation in error messages.
 */
export async function signAndBroadcastTron(
  tronWeb: TronWeb,
  signer: TronSigner,
  transaction: Types.Transaction,
  label: string,
): Promise<string> {
  const signed = await signer.signTransaction(transaction);
  const broadcast = await tronWeb.trx.sendRawTransaction(signed);
  if (!broadcast.result || !broadcast.txid) {
    // Surface the node's rejection reason (e.g. BANDWITH_ERROR, "balance is not sufficient")
    // instead of a generic message — it is what the caller needs to fix the transaction. The
    // node hex-encodes `message` (like other TronWeb reads), so decode it to UTF-8.
    const reason = [broadcast.code, decodeTronMessage(tronWeb, broadcast.message)].filter(Boolean).join(': ');
    throw new Error(`${label} was not accepted by the network${reason ? ` (${reason})` : ''}`);
  }

  await confirmTronTx(tronWeb, broadcast.txid);
  return broadcast.txid;
}
