// Behavioral unit test for maskPythonStringsAndComments — the length-preserving
// string/comment masker that stops `.annotate(`-like substrings INSIDE Python
// string literals and `#` comments from being mis-parsed as real annotate calls
// (the phantom-virtual-field bug). The function is module-private, so we extract
// its source from the compiled artifact and eval it in isolation.
//
//   npm run compile && node out/client/providers/maskStringLiterals.test.js

import * as fs from 'fs';
import * as path from 'path';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function loadMasker(): (text: string) => string {
  const fullPath = path.resolve(
    __dirname, '..', '..', '..', 'out', 'client', 'providers',
    'pythonProviders.js',
  );
  const content = fs.readFileSync(fullPath, 'utf8');
  const marker = 'function maskPythonStringsAndComments(';
  const start = content.indexOf(marker);
  assert(start >= 0, 'maskPythonStringsAndComments missing from compiled output');
  // Walk braces from the function body to extract the full definition.
  const braceStart = content.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < content.length; i += 1) {
    if (content[i] === '{') { depth += 1; }
    else if (content[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert(end > 0, 'could not extract masker function body');
  const src = content.slice(start, end);
  // eslint-disable-next-line no-eval
  return eval(`(${src})`) as (text: string) => string;
}

function run(): void {
  const mask = loadMasker();

  // Same length preserved.
  const sample = 'a.filter(note=".annotate(evil=1)").b()';
  assert(mask(sample).length === sample.length, 'masker preserves length');

  // `.annotate(` inside a double-quoted string is neutralized.
  assert(
    !/\.annotate\s*\(/.test(mask('x.filter(n=".annotate(evil=Count(\'a\'))")')),
    'annotate inside a double-quoted string must be masked',
  );
  // Inside single quotes too.
  assert(
    !/\.annotate\s*\(/.test(mask("x.filter(n='.annotate(evil=1)')")),
    'annotate inside a single-quoted string must be masked',
  );
  // Inside a triple-quoted string.
  assert(
    !/\.annotate\s*\(/.test(mask('x = """ .annotate(evil=1) """')),
    'annotate inside a triple-quoted string must be masked',
  );
  // Inside a comment.
  assert(
    !/\.annotate\s*\(/.test(mask('x = 1  # .annotate(evil=1)')),
    'annotate inside a comment must be masked',
  );

  // A REAL annotate outside any literal survives.
  assert(
    /\.annotate\s*\(/.test(mask('qs.annotate(_real=Count("message"))')),
    'a real .annotate( outside string literals must be preserved',
  );
  // Real annotate preserved even when a string ARG contains annotate-like text.
  const mixed = mask('qs.annotate(_real=Value("x .annotate(ghost=1)"))');
  assert(
    (mixed.match(/\.annotate\s*\(/g) ?? []).length === 1,
    'exactly the real .annotate( is preserved when a string arg contains annotate text',
  );

  console.log('  [ok] maskPythonStringsAndComments neutralizes literals/comments, keeps real calls');
}

run();
