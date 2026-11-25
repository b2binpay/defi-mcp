import { TronWeb } from 'tronweb';
import { describe, expect, it } from 'vitest';
import { decodeTronMessage } from './tron-tx.js';

const tronWeb = new TronWeb({ fullHost: 'https://api.shasta.trongrid.io' });

describe('decodeTronMessage', () => {
  it('decodes a hex-encoded node message to UTF-8', () => {
    // hex('BANDWIDTH') — the form TronGrid returns broadcast.message in.
    expect(decodeTronMessage(tronWeb, '42414e445749445448')).toBe('BANDWIDTH');
  });

  it('passes a plain (non-hex) string through unchanged', () => {
    expect(decodeTronMessage(tronWeb, 'balance is not sufficient')).toBe('balance is not sufficient');
  });

  it('returns an empty string for a missing message', () => {
    expect(decodeTronMessage(tronWeb, undefined)).toBe('');
  });
});
