'use strict';
// Isolate the real compiled fallback when source-class resolution is absent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const sourcePath = process.argv[2] || 'out/client/providers/pythonProviders.js';
const source = fs.readFileSync(sourcePath, 'utf8');
const expectedComplete = process.argv[3] !== 'before';
const start = source.indexOf('async function resolveReceiverInstanceHoverAtPosition(');
const end = source.indexOf('\nfunction buildFastAssignedOrmInstanceHover(', start);
assert.ok(start >= 0 && end > start, 'Locate the compiled receiver-instance fallback');
const target = { label: 'blog.Company', objectName: 'Company', module: 'blog.models', filePath: '' };
class MarkdownString {
  value = '';
  appendMarkdown(value) { this.value += value; }
}
class Hover {
  constructor(contents, range) { this.contents = contents; this.range = range; }
}
const context = vm.createContext({
  vscode: { MarkdownString, Hover },
  receiverExpressionPrefixAtPosition: () => ({ expression: 'self.company', range: { end: {} } }),
  resolveOrmReceiverAtOffset: async () => ({ kind: 'instance', modelLabel: target.label }),
  resolveClassDefinitionForExpression: async () => undefined,
  listAllRelationTargets: async () => ({ items: [target] }),
  relationTargetQualifiedSymbol: item => `${item.module}.${item.objectName}`,
  appendImportFilePath: (_markdown, filePath) => assert.equal(filePath, target.filePath),
});
const resolve = vm.runInContext(source.slice(start, end) + '\nresolveReceiverInstanceHoverAtPosition;', context);
resolve({ isAborted: () => false }, { offsetAt: () => 12 }, {}).then(hover => {
  const markdown = hover.contents.value;
  assert.ok(markdown.includes('**self.company**: `Company` instance'));
  assert.ok(markdown.includes('Model: `blog.Company`'));
  assert.ok(markdown.includes('Module: `blog.models`'));
  const resolvedSymbolPresent = markdown.includes('Resolved symbol: `blog.models.Company`');
  const classCategoryPresent = markdown.includes('Class category: `django`');
  assert.equal(resolvedSymbolPresent, expectedComplete);
  assert.equal(classCategoryPresent, expectedComplete);
  console.log(JSON.stringify({ sourcePath,
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    sourceClassAvailable: false, expectedComplete, resolvedSymbolPresent, classCategoryPresent, markdown }, null, 2));
}).catch(error => { console.error(error); process.exitCode = 1; });
