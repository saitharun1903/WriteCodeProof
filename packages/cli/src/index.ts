#!/usr/bin/env node
import pc from 'picocolors';
import { buildProgram } from './program.js';

// Exit code 3 = tool error (spec section 14).
const TOOL_ERROR_EXIT_CODE = 3;

buildProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`writecode-proof: ${message}`));
    process.exitCode = TOOL_ERROR_EXIT_CODE;
  });
