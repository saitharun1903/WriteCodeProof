import { Command } from 'commander';
import { readPackageVersion } from '@writecode-proof/core';

export function buildProgram(): Command {
  return new Command()
    .name('writecode-proof')
    .description('Proof Pack for a code change: tests, behaviour diff, security scan, risk score.')
    .version(readPackageVersion(import.meta.url), '-v, --version');
}
