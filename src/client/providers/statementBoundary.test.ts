// Comments and docstrings must not redirect completion to an earlier query.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const content = fs.readFileSync(path.join(__dirname, 'pythonProviders.js'), 'utf8');
const source = ts.createSourceFile('providers.js', content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const functions = new Set(['topLevelStatementStarts', 'continuesTopLevelExpression']);
const implementation = source.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && statement.name && functions.has(statement.name.text)).map(statement => statement.getText(source)).join('\n');
const script = new vm.Script(`${implementation}\nMath.max(...topLevelStatementStarts(text, text.length))`);
for (const prefix of [
  '# captain\'s receiver ( remains in a comment\n',
  '"""A docstring with "quotes", (parentheses), and # signs."""\n',
  'old.objects.filter(title="a ( string )")\n',
  fs.readFileSync(path.resolve(__dirname, '../../../fixtures/minimal_project/blog/query_examples.py'), 'utf8'),
]) {
  const text = `${prefix}\nPost.objects.filter`;
  assert.equal(script.runInNewContext({ text }), text.lastIndexOf('Post.objects.filter'));
}
const continued = 'Post.objects\n    .filter';
assert.equal(script.runInNewContext({ text: continued }), 0);
console.log('PASS: statement boundaries ignore comments and docstrings and preserve multiline chains');
