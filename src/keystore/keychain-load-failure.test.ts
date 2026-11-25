import { describe, expect, it, vi } from 'vitest';

// Simulate the optional native addon being absent / unbuildable on this platform: the import rejects.
vi.mock('@napi-rs/keyring', () => {
  throw new Error('Cannot find module @napi-rs/keyring');
});

const { KeychainKeySource } = await import('./keychain-source.js');

describe('KeychainKeySource native-module load failure', () => {
  it('is fatal and names the module + the KEY_SOURCE=env escape hatch', async () => {
    await expect(new KeychainKeySource().read('evm')).rejects.toThrow(
      /@napi-rs\/keyring.*failed to load[\s\S]*KEY_SOURCE=env/,
    );
  });
});
