import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read `version` from the package.json that sits one level above the calling
 * module's directory (`src/` or `dist/`). Pass `import.meta.url`.
 */
export function readPackageVersion(moduleUrl: string): string {
  const pkgPath = join(dirname(fileURLToPath(moduleUrl)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string') {
    throw new Error(`No version field in ${pkgPath}`);
  }
  return pkg.version;
}
