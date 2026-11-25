import { TRON_CHAIN_IDS } from '@b2binpay/defi-sdk';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_NETWORKS, loadConfig, rpcForChain } from './env.js';

describe('loadConfig', () => {
  it('applies defaults when nothing is set', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.backendApiUrl).toBe(DEFAULT_CONFIG.BACKEND_API_URL);
    expect(config.backendMcpUrl).toBe(DEFAULT_CONFIG.BACKEND_MCP_URL);
    expect(config.authUrl).toBe(DEFAULT_CONFIG.AUTH_URL);
    expect(config.defaultChainId).toBe(DEFAULT_CONFIG.DEFAULT_CHAIN_ID);
    expect(config.networks).toEqual(DEFAULT_NETWORKS);
  });

  it('merges RPC_URL_<chainId> overrides onto the network map', () => {
    const config = loadConfig({
      RPC_URL_11155111: 'https://my-sepolia.test',
      RPC_URL_999999: 'https://custom-chain.test',
    } as NodeJS.ProcessEnv);
    expect(config.networks[11155111]).toBe('https://my-sepolia.test');
    expect(config.networks[999999]).toBe('https://custom-chain.test');
    expect(config.networks[1]).toBe(DEFAULT_NETWORKS[1]);
  });

  it('overrides backend endpoints and default chain via env', () => {
    const config = loadConfig({
      BACKEND_MCP_URL: 'https://example.test/mcp',
      DEFAULT_CHAIN_ID: '97',
    } as NodeJS.ProcessEnv);
    expect(config.backendMcpUrl).toBe('https://example.test/mcp');
    expect(config.defaultChainId).toBe(97);
  });

  it('maps per-protocol auth-chain overrides', () => {
    const config = loadConfig({ EVM_AUTH_CHAIN_ID: '11155111', TVM_AUTH_CHAIN_ID: '2494104990' } as NodeJS.ProcessEnv);
    expect(config.authChainId).toEqual({ evm: 11155111, tvm: 2494104990 });
  });

  it('maps a single per-protocol auth-chain override, leaving the other undefined', () => {
    const config = loadConfig({ TVM_AUTH_CHAIN_ID: '2494104990' } as NodeJS.ProcessEnv);
    expect(config.authChainId).toEqual({ evm: undefined, tvm: 2494104990 });
  });

  it('rejects a non-positive auth-chain override', () => {
    expect(() => loadConfig({ EVM_AUTH_CHAIN_ID: '0' } as NodeJS.ProcessEnv)).toThrow(/EVM_AUTH_CHAIN_ID/);
    expect(() => loadConfig({ TVM_AUTH_CHAIN_ID: '-1' } as NodeJS.ProcessEnv)).toThrow(/TVM_AUTH_CHAIN_ID/);
  });

  it('leaves auth-chain overrides undefined when unset', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.authChainId).toEqual({ evm: undefined, tvm: undefined });
  });

  it('defaults KEY_SOURCE to env and accepts keychain', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).keySource).toBe('env');
    expect(loadConfig({ KEY_SOURCE: 'keychain' } as NodeJS.ProcessEnv).keySource).toBe('keychain');
  });

  it('rejects an unknown KEY_SOURCE value naming the field', () => {
    expect(() => loadConfig({ KEY_SOURCE: 'kms' } as NodeJS.ProcessEnv)).toThrow(/KEY_SOURCE/);
  });

  it('does not carry any key material on the shared config object', () => {
    const config = loadConfig({ MNEMONIC: 'x', EVM_PRIVATE_KEY: 'y' } as NodeJS.ProcessEnv);
    expect(config).not.toHaveProperty('agentPrivateKey');
    expect(config).not.toHaveProperty('mnemonic');
  });
});

describe('rpcForChain', () => {
  it('returns the RPC for a configured chain', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(rpcForChain(config, 11155111)).toBe(DEFAULT_NETWORKS[11155111]);
  });

  it('throws with guidance for an unconfigured chain', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(() => rpcForChain(config, 424242)).toThrow(/No RPC configured for chain 424242/);
  });
});

describe('DEFAULT_NETWORKS', () => {
  it('has a default fullHost for every TRON chain the SDK knows', () => {
    const missing = [...TRON_CHAIN_IDS].filter((chainId) => !DEFAULT_NETWORKS[chainId]);
    expect(missing).toEqual([]);
  });
});
