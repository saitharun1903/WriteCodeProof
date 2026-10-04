import { createRequire } from 'node:module';
import { Language, Parser, type Tree } from 'web-tree-sitter';
import type { SourceLanguage } from '../types.js';
import { GRAMMAR_WASM } from './languages.js';

const require = createRequire(import.meta.url);

let runtime: Promise<void> | undefined;
// Parsing is synchronous, so one parser per language is safe to share.
const parsers = new Map<SourceLanguage, Promise<Parser>>();

function loadParser(language: SourceLanguage): Promise<Parser> {
  let parser = parsers.get(language);
  if (!parser) {
    runtime ??= Parser.init();
    parser = runtime
      .then(() => Language.load(require.resolve(GRAMMAR_WASM[language])))
      .then((grammar) => new Parser().setLanguage(grammar));
    parser.catch(() => parsers.delete(language));
    parsers.set(language, parser);
  }
  return parser;
}

/** Parse `source`. The caller owns the tree and must call `tree.delete()`. */
export async function parseSource(language: SourceLanguage, source: string): Promise<Tree> {
  const parser = await loadParser(language);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${language} source`);
  return tree;
}
