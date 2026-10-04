import { extname } from 'node:path';
import type { SourceLanguage } from '../types.js';

const BY_EXTENSION: Record<string, SourceLanguage> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
};

/** Grammar `.wasm` files shipped inside the tree-sitter grammar packages. */
export const GRAMMAR_WASM: Record<SourceLanguage, string> = {
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
};

export function detectLanguage(path: string): SourceLanguage | null {
  return BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}
