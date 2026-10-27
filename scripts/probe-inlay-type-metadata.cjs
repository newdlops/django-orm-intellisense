// Exercise the real compiled label function with source-optional protocol
// responses. The fixture supplies VS Code APIs; no daemon request is made.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fixture } = require('../out/client/providers/providerRequestLifecycle.test.js');

const sourcePath = process.argv[2] || 'out/client/providers/pythonProviders.js';
const before = process.argv[3] === 'before';
const source = fs.readFileSync(sourcePath, 'utf8');
const test = fixture(source + '\nmodule.exports.inlayLabelProbe = inlayTypeLabelForResolution;');
const descriptor = (pythonType, extra = {}) => ({ outputFieldKind: 'CharField', pythonType,
  isTransformed: false, ...extra });
const field = { name: 'timezone', modelLabel: 'blog.Profile', fieldKind: 'CharField',
  isRelation: false, source: 'workspace' };
const cases = [
  ['type-only-scalar', { resolved: true, terminalType: descriptor('str') }, 'str'],
  ['type-only-transform', { resolved: true, terminalType: descriptor('int', {
    outputFieldKind: 'IntegerField', isTransformed: true }) }, 'int'],
  ['type-only-in-operand', { resolved: true, terminalType: descriptor('int', {
    lookupOperator: 'in', operandPythonType: 'list[int]' }) }, 'list[int]'],
  ['type-only-isnull-operand', { resolved: true, terminalType: descriptor('str', {
    lookupOperator: 'isnull', operandPythonType: 'bool' }) }, 'bool'],
  ['unresolved-with-type', { resolved: false, terminalType: descriptor('str') }, undefined],
  ['legacy-field-kind', { resolved: true, target: field }, 'str'],
  ['legacy-python-type', { resolved: true, target: { ...field, pythonType: 'Decimal' } }, 'Decimal'],
  ['legacy-relation', { resolved: true, target: { ...field, isRelation: true,
    relatedModelLabel: 'blog.Author' } }, 'Author'],
  ['descriptor-overrides-target', { resolved: true, target: field,
    terminalType: descriptor('int', { isTransformed: true }) }, 'int'],
  ['missing-type-metadata', { resolved: true }, undefined],
];
try {
  const rows = cases.map(([name, resolution, expected]) => {
    const actual = test.providers.inlayLabelProbe(resolution);
    return { name, expected: expected ?? null, actual: actual ?? null, matches: actual === expected };
  });
  if (before) assert.deepEqual(rows.filter(row => !row.matches).map(row => row.name),
    cases.slice(0, 4).map(([name]) => name));
  else assert.ok(rows.every(row => row.matches), JSON.stringify(rows));
  assert.equal(test.sourceCalls, 0, 'Computing a hint label must not issue a daemon request');
  console.log(JSON.stringify({ sourcePath, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    expectedBeforeFailure: before, rows, sourceCalls: test.sourceCalls }, null, 2));
} finally {
  test.dispose();
  assert.equal(test.adapterCount, 0);
  assert.equal(test.emitterCount, 0);
}
