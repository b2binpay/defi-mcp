import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPackageVersion } from './version.js';

const manifestUrl = new URL('../package.json', import.meta.url);
const entryUrl = new URL('./index.ts', import.meta.url);

describe('readPackageVersion', () => {
  it('reports the version in this package manifest', () => {
    const { version } = JSON.parse(readFileSync(manifestUrl, 'utf8'));

    expect(readPackageVersion()).toBe(version);
  });

  it('finds the manifest from a nested build directory', () => {
    const nested = new URL('../dist/src/index.js', import.meta.url).href;
    const { version } = JSON.parse(readFileSync(manifestUrl, 'utf8'));

    expect(readPackageVersion(nested)).toBe(version);
  });

  it('throws when no manifest of this package is above the file', () => {
    expect(() => readPackageVersion(pathToFileURL('/nonexistent/dir/file.js').href)).toThrow(
      /Cannot find the @b2binpay\/defi-mcp package\.json/,
    );
  });
});

describe('CLI entry', () => {
  it('starts with a node shebang so the npm bin runs as an executable', () => {
    const [firstLine] = readFileSync(entryUrl, 'utf8').split('\n');

    expect(firstLine).toBe('#!/usr/bin/env node');
  });
});
