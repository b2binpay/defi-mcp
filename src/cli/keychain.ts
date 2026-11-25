import { CHAIN_KINDS, type ChainKind } from '../config/chain-kind.js';
import {
  classifyBlob,
  isNoEntryError,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  type KeyringApi,
  loadKeyring,
} from '../keystore/keychain-source.js';

/** Upper bound on piped-stdin secret size; a key/mnemonic is well under 1 KiB. */
const MAX_STDIN_BYTES = 64 * 1024;

/**
 * Injectable IO seam so the CLI is unit-testable without a real TTY or keychain. The secret is
 * produced by {@link readSecret} (a no-echo prompt on a TTY, piped stdin otherwise) — never from argv.
 */
export interface KeychainCliIo {
  loadKeyring(): Promise<KeyringApi>;
  readSecret(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

/** ASCII control codes handled by the no-echo prompt. */
const CHAR_CODE = { CTRL_C: 3, CTRL_D: 4, BACKSPACE_H: 8, LF: 10, CR: 13, DEL: 127 } as const;

/** A usage error: the caller maps any thrown error to a nonzero exit code. */
class UsageError extends Error {}

function usageError(message: string): UsageError {
  return new UsageError(`usage: ${message}`);
}

/** Require exactly one slot argument. A stray extra arg (the argv-secret footgun) is a usage error. */
function requireSlot(rest: string[], sub: string): ChainKind {
  if (rest.length === 0) {
    throw usageError(`defi-mcp keychain ${sub} <evm|tvm>`);
  }
  if (rest.length > 1) {
    throw usageError(
      `defi-mcp keychain ${sub} <evm|tvm> takes exactly one slot. Do not pass the secret as an ` +
        `argument — it is read from a no-echo prompt or piped stdin.`,
    );
  }
  const slot = rest[0];
  if (slot !== 'evm' && slot !== 'tvm') {
    // Never echo the argument: a mistyped `keychain set <key>` (slot omitted) would otherwise
    // print the secret into stderr, which MCP clients / CI capture to logs.
    throw usageError(`unknown slot (expected evm or tvm)`);
  }
  return slot;
}

async function setEntry(rest: string[], io: KeychainCliIo): Promise<void> {
  const slot = requireSlot(rest, 'set');
  const keyring = await io.loadKeyring();
  // Collapse internal whitespace so a mnemonic piped from a wrapped file stores in the canonical
  // single-space form read back by deriveFromMnemonic; a no-op for a hex key (no inner whitespace).
  const secret = (await io.readSecret()).trim().replace(/\s+/g, ' ');
  if (!secret) {
    throw new Error('No secret provided. Enter it at the prompt or pipe it via stdin.');
  }
  // Validate before storing (design D3); classifyBlob throws on anything that is neither a
  // trimmed hex-shaped key nor a valid BIP39 mnemonic. The derived key is discarded here.
  classifyBlob(slot, secret, `${slot} secret`);
  await new keyring.AsyncEntry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT[slot]).setPassword(secret);
  io.err(`Stored ${slot} key in the OS keychain (service '${KEYCHAIN_SERVICE}').`);
}

async function removeEntry(rest: string[], io: KeychainCliIo): Promise<void> {
  const slot = requireSlot(rest, 'rm');
  const keyring = await io.loadKeyring();
  const entry = new keyring.AsyncEntry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT[slot]);
  try {
    await entry.deleteCredential();
  } catch (error) {
    // Idempotent: a missing entry is success. Swallow only NoEntry — a locked/unavailable keychain
    // must still surface as a failure (nonzero exit), never be reported as a successful removal.
    if (!isNoEntryError(error)) {
      throw error;
    }
  }
  io.err(`Removed ${slot} key from the OS keychain (if present).`);
}

async function listEntries(rest: string[], io: KeychainCliIo): Promise<void> {
  if (rest.length > 0) {
    throw usageError('defi-mcp keychain list takes no arguments');
  }
  const keyring = await io.loadKeyring();
  for (const kind of CHAIN_KINDS) {
    io.out(`${kind}: ${(await isEntryPresent(keyring, KEYCHAIN_ACCOUNT[kind])) ? 'set' : 'absent'}`);
  }
}

/**
 * Presence of a slot entry, reading only to check (never printing the value). A NoEntry error is
 * treated as absent — same as {@link KeychainKeySource.read} — so a missing slot never fails `list`
 * on backends that raise instead of returning null; a locked/unavailable keychain still surfaces.
 */
async function isEntryPresent(keyring: KeyringApi, account: string): Promise<boolean> {
  try {
    return (await new keyring.AsyncEntry(KEYCHAIN_SERVICE, account).getPassword()) != null;
  } catch (error) {
    if (isNoEntryError(error)) {
      return false;
    }
    throw error;
  }
}

/** Read a secret from the terminal without echoing it. Prompt goes to stderr; stdout stays clean. */
function promptNoEcho(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let secret = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = (): void => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === CHAR_CODE.LF || code === CHAR_CODE.CR) {
          cleanup();
          resolve(secret);
          return;
        }
        if (code === CHAR_CODE.CTRL_C || code === CHAR_CODE.CTRL_D) {
          // Ctrl-C / Ctrl-D (EOF) abort — never submit a partial secret.
          cleanup();
          reject(new Error('Aborted.'));
          return;
        }
        if (code === CHAR_CODE.DEL || code === CHAR_CODE.BACKSPACE_H) {
          secret = secret.slice(0, -1);
        } else {
          secret += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

/** Read the entire piped stdin as the secret (automation escape hatch). */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_STDIN_BYTES) {
      throw new Error(`Secret from stdin exceeds ${MAX_STDIN_BYTES} bytes; refusing to read.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function defaultIo(): KeychainCliIo {
  const interactive = Boolean(process.stdin.isTTY);
  return {
    loadKeyring,
    readSecret: () => (interactive ? promptNoEcho('Enter secret (input hidden): ') : readAllStdin()),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

/**
 * Run the `keychain` subcommand. Dispatched before any server config/key loading, so managing
 * entries never needs a resolvable key configuration. Throws on any usage/validation/native/keychain
 * error; the caller maps a throw to a nonzero exit code.
 */
export async function runKeychainCli(args: string[], io: KeychainCliIo = defaultIo()): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'set':
      return setEntry(rest, io);
    case 'rm':
      return removeEntry(rest, io);
    case 'list':
      return listEntries(rest, io);
    default:
      // No argv echo (see requireSlot): a fat-fingered secret must never reach stderr/logs.
      throw usageError(`defi-mcp keychain <set|rm|list> <evm|tvm> (unknown subcommand)`);
  }
}
