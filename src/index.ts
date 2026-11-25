#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BackendRegistry, BackendRouter, toolScopes } from './backend/backend-registry.js';
import type { BackendMcpClient } from './backend/mcp-client.js';
import type { McpToolDefinition } from './backend/types.js';
import { loadConfig } from './config/env.js';
import { createKeySource, loadKeySlots } from './keystore/key-sources.js';
import { Keystore } from './keystore/keystore.js';
import { SessionStore } from './orchestration/session.js';
import { createGateway } from './server/gateway.js';
import { composeInstructions } from './server/instructions.js';
import { buildLocalTools } from './tools/local-tools.js';
import { readPackageVersion } from './version.js';

const initializeResultSchema = z.object({ instructions: z.string().optional() });

interface BackendSurface {
  tools: McpToolDefinition[];
  instructions?: string;
}

const SERVER_NAME = 'b2binpay-defi-mcp';
const SERVER_VERSION = readPackageVersion();

/** stdio transport reserves stdout for the protocol; all diagnostics go to stderr. */
function logError(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Group/other permission bits; a key-bearing file readable beyond the owner is a leak risk. */
const GROUP_OTHER_PERM_MASK = 0o077;

async function loadDotenv(): Promise<void> {
  try {
    const dotenv = await import('dotenv');
    dotenv.config({ quiet: true });
    await warnIfEnvFileLoose();
  } catch {
    // dotenv is a dev-only convenience; production supplies env directly.
  }
}

/** Warn (never fail) if a local `.env` holding key material is readable by group/other. */
async function warnIfEnvFileLoose(): Promise<void> {
  try {
    const { statSync } = await import('node:fs');
    const stats = statSync('.env');
    if (stats.mode & GROUP_OTHER_PERM_MASK) {
      logError('Warning: .env is readable beyond its owner; run `chmod 600 .env` to protect key material.');
    }
  } catch {
    // No local .env (env supplied directly) — nothing to check.
  }
}

/**
 * Fetch the backend tool catalog at startup. The catalog is identity-independent, so any filled
 * slot can serve it; tries each in discovery order so a single degraded slot (e.g. its auth
 * fails) doesn't strand the server with zero backend tools. Tolerant of an unreachable backend —
 * boots with local tools only if every slot fails; backend tools appear after a restart.
 */
async function loadBackendTools(clients: BackendMcpClient[]): Promise<BackendSurface> {
  let lastError: unknown;
  for (const client of clients) {
    try {
      const init = initializeResultSchema.safeParse(await client.initialize());
      const tools = await client.listTools();
      return { tools, instructions: init.success ? init.data.instructions : undefined };
    } catch (error) {
      lastError = error;
    }
  }
  logError(
    `Warning: could not load backend tools: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  return { tools: [] };
}

async function main(): Promise<void> {
  // Dispatch the `keychain` management CLI before any config/key loading, so managing entries
  // never requires a resolvable key configuration.
  const argv = process.argv.slice(2);
  if (argv[0] === 'keychain') {
    const { runKeychainCli } = await import('./cli/keychain.js');
    await runKeychainCli(argv.slice(1));
    return;
  }

  await loadDotenv();
  const config = loadConfig();
  const keySource = await createKeySource(config.keySource);
  const keystore = Keystore.fromSlots(await loadKeySlots(keySource));

  const registry = BackendRegistry.build(config, keystore);
  const sessions = new SessionStore();

  // Fetch the identity-independent tool catalog once, via the discovery slot (falling back to
  // another filled slot if it fails); other slots authenticate lazily on first use.
  const backend = await loadBackendTools(registry.discoveryClients());

  // The catalog carries each tool's routing scope, so the router learns from the backend which
  // calls are principal-independent instead of keeping its own list of tool names.
  const router = new BackendRouter(registry, sessions, toolScopes(backend.tools));
  const localTools = buildLocalTools({ keystore, registry, sessions, config });

  const server = createGateway({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    instructions: composeInstructions(backend.instructions),
    backend: router,
    localTools,
    backendTools: backend.tools,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const addresses = keystore.addresses();
  const identities = keystore
    .filledKinds()
    .map((kind) => `${kind.toUpperCase()} ${addresses[kind]}`)
    .join(', ');
  logError(
    `${SERVER_NAME} v${SERVER_VERSION} ready on stdio ` +
      `(${identities}, ${localTools.length} local + ${backend.tools.length} backend tools)`,
  );
}

main().catch((error) => {
  logError(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
