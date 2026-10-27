import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import type { LookupPathResolution } from '../protocol';

// Exercise the compiled diagnostic builders without loading the VS Code host.
// Local/background lookups intentionally omit target/source-location metadata.
const artifactPath = path.join(__dirname, 'pythonProviders.js');
const source = ts.createSourceFile(
  artifactPath, fs.readFileSync(artifactPath, 'utf8'), ts.ScriptTarget.ES2022,
  true, ts.ScriptKind.JS
);
const names = [
  'buildDirectFieldDiagnostic',
  'buildSchemaFieldDiagnostic',
  'buildBulkUpdateFieldDiagnostic',
];
const declarations = source.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? '')
);
assert.strictEqual(declarations.length, names.length);
const builders = new vm.Script(
  declarations.map(statement => statement.getText(source)).join('\n')
  + `\n[${names.join(',')}];`
).runInNewContext({
  vscode: {
    DiagnosticSeverity: { Error: 0 },
    Diagnostic: class {
      source?: string;
      constructor(public range: unknown, public message: string, public severity: number) {}
    },
  },
}) as Array<(context: Record<string, unknown>, label: string, resolution: LookupPathResolution)
  => { message: string; source: string } | undefined>;

for (const [index, build] of builders.entries()) {
  const context = { value: 'title', lookupValue: 'title', method: 'create', range: {} };
  assert.strictEqual(
    build(context, 'blog.Book', { resolved: true, baseModelLabel: 'blog.Book' }),
    undefined,
    `${names[index]} must accept a resolved field without target metadata`
  );
  for (const [value, resolution] of [
    ['bogus', { resolved: false, reason: 'segment_not_found' }],
    ['title__exact', { resolved: true, lookupOperator: 'exact' }],
    ['author__name', { resolved: true }],
  ] as Array<[string, LookupPathResolution]>) {
    const diagnostic = build({ ...context, value }, 'blog.Book', resolution);
    assert.ok(diagnostic, `${names[index]} must reject ${value}`);
    assert.ok(diagnostic.message.includes(`\`${value}\``));
    assert.strictEqual(diagnostic.source, 'Django ORM Intellisense');
  }
}
assert.strictEqual(
  builders[1](
    { value: '-created_at', lookupValue: 'created_at', range: {} },
    'blog.Book', { resolved: true }
  ),
  undefined,
  'descending schema fields must accept a locationless resolution of their normalized value'
);
console.log('all 13 field diagnostic checks passed');
