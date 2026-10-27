import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const source = ts.createSourceFile(
  'pythonProviders.js', fs.readFileSync(path.join(__dirname, 'pythonProviders.js'), 'utf8'),
  ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS
);
const declaration = source.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(item =>
    ts.isIdentifier(item.name) && item.name.text === 'EXPRESSION_STRING_HOVER_PATTERN'));
assert.ok(declaration);
const pattern = new vm.Script(`${declaration.getText(source)}\nEXPRESSION_STRING_HOVER_PATTERN;`)
  .runInNewContext() as RegExp;

for (const [text, expected] of [
  ['expr.Greatest(models.Value(""), "name")', ['', 'name']],
  ["expr.Greatest(models.Value(''), 'category__title')", ['', 'category__title']],
  ['expr.Greatest(models.Value(""), models.Value(""), "name")', ['', '', 'name']],
  ['expr.JSONObject(name="name", category_title="category__title")', ['name', 'category__title']],
] as Array<[string, string[]]>) {
  assert.deepEqual(Array.from(text.matchAll(pattern), match => match[2]), expected, text);
}
console.log('PASS: empty expression strings preserve later field-path tokens');
