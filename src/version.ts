import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const PACKAGE_NAME = '@b2binpay/defi-mcp';
const MANIFEST = 'package.json';

const manifestSchema = z.object({ name: z.string(), version: z.string() });

/**
 * Version of this package as installed, read from its own manifest so a release, a rolling dev
 * build and a local checkout each report the version they were published or bumped to. The
 * manifest sits one level above `src/` and two above `dist/src/`, so the lookup walks up to the
 * first `package.json` carrying this package's name.
 */
export function readPackageVersion(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    const candidate = join(dir, MANIFEST);
    if (existsSync(candidate)) {
      const manifest = manifestSchema.safeParse(JSON.parse(readFileSync(candidate, 'utf8')));
      if (manifest.success && manifest.data.name === PACKAGE_NAME) {
        return manifest.data.version;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Cannot find the ${PACKAGE_NAME} ${MANIFEST} above ${fileURLToPath(fromUrl)}`);
    }
    dir = parent;
  }
}
