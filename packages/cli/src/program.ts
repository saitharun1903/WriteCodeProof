import { Command, Option } from 'commander';
import { LLM_PROVIDERS, readPackageVersion } from '@writecode-proof/core';
import { checkCommand, type CheckOptions } from './commands/check.js';
import { doctorCommand } from './commands/doctor.js';

export function buildProgram(): Command {
  const program = new Command()
    .name('writecode-proof')
    .description('Proof Pack for a code change: tests, behaviour diff, security scan, risk score.')
    .version(readPackageVersion(import.meta.url), '-v, --version')
    .showHelpAfterError();

  program
    .command('check')
    .description('Check a change (default: working tree against main)')
    .argument('[path]', 'any folder inside the git repository', '.')
    .option('--base <ref>', 'branch, tag or commit to compare against (default: main)')
    .option('--head <ref>', 'branch, tag or commit to check (default: working tree)')
    .option('--json', 'print a machine-readable report to stdout')
    .option('--out <file.md>', 'also write the report as Markdown')
    .option('--no-generate', 'skip generated tests (faster)')
    .option('--no-llm', 'use no model at all (edge-case inputs only, no generated tests)')
    .addOption(
      new Option('--provider <name>', 'LLM provider for this run').choices([...LLM_PROVIDERS]),
    )
    .option('--ai-authored', 'the change was written by an AI (adds to the risk score)')
    .option('--no-store', 'do not save the run to DATABASE_URL')
    .option('-q, --quiet', 'no progress output')
    .action(async (path: string, options: CheckOptions) => {
      process.exitCode = await checkCommand(path, options);
    });

  program
    .command('doctor')
    .description('Check that Docker, the sandbox images, git and the LLM are ready')
    .action(async () => {
      process.exitCode = await doctorCommand();
    });

  return program;
}
