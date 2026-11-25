import { z } from 'zod';

/**
 * Built-in networks (chainId → RPC, or TronWeb fullHost for TVM). Override or extend any entry with a
 * `RPC_URL_<chainId>` env var. Public RPCs by default; swap for private ones in prod.
 */
export const DEFAULT_NETWORKS: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  56: 'https://bsc-rpc.publicnode.com',
  97: 'https://bsc-testnet-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  80002: 'https://polygon-amoy-bor-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  421614: 'https://arbitrum-sepolia-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  84532: 'https://base-sepolia-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  11155420: 'https://optimism-sepolia-rpc.publicnode.com',
  // TVM (TRON) — fullHost URLs
  728126428: 'https://api.trongrid.io',
  2494104990: 'https://api.shasta.trongrid.io',
  3448148188: 'https://nile.trongrid.io',
};

/**
 * Default endpoints of the production B2BINPAY DeFi platform. Overridable via env. Signing keys are
 * loaded separately (see {@link import('../keystore/key-sources.js').loadKeySlots}); at least one
 * key slot must be configured.
 */
export const DEFAULT_CONFIG = {
  BACKEND_API_URL: 'https://api.defi.b2binpay.com',
  BACKEND_MCP_URL: 'https://mcp.defi.b2binpay.com/mcp',
  AUTH_URL: 'https://defi.b2binpay.com',
  DEFAULT_CHAIN_ID: 11155111,
  TRON_FEE_LIMIT: 150_000_000,
} as const;

const RPC_URL_ENV = /^RPC_URL_(\d+)$/;

/** Backend that supplies the signing key: plaintext env (default) or the OS secret store. */
export const KEY_SOURCE_KINDS = ['env', 'keychain'] as const;
export type KeySourceKind = (typeof KEY_SOURCE_KINDS)[number];

const envSchema = z.object({
  BACKEND_API_URL: z.url().default(DEFAULT_CONFIG.BACKEND_API_URL),
  BACKEND_MCP_URL: z.url().default(DEFAULT_CONFIG.BACKEND_MCP_URL),
  AUTH_URL: z.url().default(DEFAULT_CONFIG.AUTH_URL),
  DEFAULT_CHAIN_ID: z.coerce.number().int().positive().default(DEFAULT_CONFIG.DEFAULT_CHAIN_ID),
  TRON_FEE_LIMIT: z.coerce.number().int().positive().default(DEFAULT_CONFIG.TRON_FEE_LIMIT),
  EVM_AUTH_CHAIN_ID: z.coerce.number().int().positive().optional(),
  TVM_AUTH_CHAIN_ID: z.coerce.number().int().positive().optional(),
  KEY_SOURCE: z.enum(KEY_SOURCE_KINDS).default('env'),
});

export interface AppConfig {
  backendApiUrl: string;
  backendMcpUrl: string;
  authUrl: string;
  defaultChainId: number;
  tronFeeLimit: number;
  networks: Record<number, string>;
  /** Which backend supplies the signing key: `env` (default) or the OS `keychain`. */
  keySource: KeySourceKind;
  /**
   * Explicit per-protocol chain to authenticate under, overriding the derived choice. Set these
   * when the default chain's kind differs from a slot and the first configured chain of that kind
   * (e.g. TRON mainnet) is not active in the backend environment (e.g. a Shasta-only dev).
   */
  authChainId: { evm?: number; tvm?: number };
}

/** Merge `RPC_URL_<chainId>` env overrides onto the built-in network map. */
function resolveNetworks(source: NodeJS.ProcessEnv): Record<number, string> {
  const networks: Record<number, string> = { ...DEFAULT_NETWORKS };
  for (const [key, value] of Object.entries(source)) {
    const match = key.match(RPC_URL_ENV);
    if (match && value) {
      networks[Number(match[1])] = value;
    }
  }
  return networks;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return {
    backendApiUrl: result.data.BACKEND_API_URL,
    backendMcpUrl: result.data.BACKEND_MCP_URL,
    authUrl: result.data.AUTH_URL,
    defaultChainId: result.data.DEFAULT_CHAIN_ID,
    tronFeeLimit: result.data.TRON_FEE_LIMIT,
    networks: resolveNetworks(source),
    keySource: result.data.KEY_SOURCE,
    authChainId: { evm: result.data.EVM_AUTH_CHAIN_ID, tvm: result.data.TVM_AUTH_CHAIN_ID },
  };
}

/** RPC URL for a chain, or throw with the list of configured chains. */
export function rpcForChain(config: AppConfig, chainId: number): string {
  const rpc = config.networks[chainId];
  if (!rpc) {
    throw new Error(
      `No RPC configured for chain ${chainId}. Configured: ${Object.keys(config.networks).join(', ')}. ` +
        `Add RPC_URL_${chainId}=<url> to configure it.`,
    );
  }
  return rpc;
}
