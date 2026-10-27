// Use the real collector and syntax parsers. Count parser work separately from
// cancellation checks, and compare reused decisions with fresh context owners.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';

class Position {
  constructor(public line: number, public character: number) {}
}
class Range {
  start: Position;
  end: Position;
  constructor(line: number, character: number, endLine: number, endCharacter: number) {
    this.start = new Position(line, character);
    this.end = new Position(endLine, endCharacter);
  }
}
function makeDocument(text: string, uri = 'file:///fixture/lookup-syntax.py') {
  const lines = text.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  return {
    uri: { scheme: 'file', fsPath: uri.slice('file://'.length), toString: () => uri },
    languageId: 'python', version: 1, isClosed: false, lineCount: lines.length,
    getText: (range?: Range) => range
      ? text.slice(offsets[range.start.line] + range.start.character, offsets[range.end.line] + range.end.character)
      : text,
    lineAt: (line: number) => ({ text: lines[line] }),
    offsetAt: (position: Position) => offsets[position.line] + position.character,
    getWordRangeAtPosition: (position: Position, pattern = /[A-Za-z_][\w]*/) => {
      const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      for (const match of lines[position.line].matchAll(regex)) {
        const start = match.index ?? 0;
        if (position.character >= start && position.character < start + match[0].length) {
          return new Range(position.line, start, position.line, start + match[0].length);
        }
      }
      return undefined;
    },
  };
}

async function main(): Promise<void> {
  const filename = path.join(__dirname, 'pythonProviders.js');
  const nodeRequire = createRequire(filename);
  const module = { exports: {} as any };
  const source = fs.readFileSync(filename, 'utf8');
  const inspection = `
const syntaxParseCounts = {queryset:0,dict:0,f:0,expression:0,prefetch:0};
const parseQueryset = querysetStringCallContext;
querysetStringCallContext = (...args) => {syntaxParseCounts.queryset++;return parseQueryset(...args);};
const parseDict = unpackedLookupDictCallContext;
unpackedLookupDictCallContext = (...args) => {syntaxParseCounts.dict++;return parseDict(...args);};
const parseF = fExpressionCallContext;
fExpressionCallContext = (...args) => {syntaxParseCounts.f++;return parseF(...args);};
const parseExpression = expressionStringArgumentCallContext;
expressionStringArgumentCallContext = (...args) => {syntaxParseCounts.expression++;return parseExpression(...args);};
const parsePrefetch = prefetchLookupCallContext;
prefetchLookupCallContext = (...args) => {syntaxParseCounts.prefetch++;return parsePrefetch(...args);};
module.exports.syntaxTest = {validate:validateLookupContexts,collect:findLookupDiagnosticContexts,counts:syntaxParseCounts};`;
  const wrapper = vm.runInNewContext(
    `(function(exports,require,module){\n${source}\n${inspection}\n})`,
    { console, performance, process: { env: {} }, setTimeout, clearTimeout, AbortController }
  );
  wrapper(module.exports, (name: string) => {
    if (name === 'vscode') return { Position, Range };
    if (name === '../config/settings') return {};
    if (name === '../python/pylance') return {};
    return nodeRequire(name);
  }, module);
  const { validate, collect, counts } = module.exports.syntaxTest;
  const totalParses = (): number => Object.values(counts).reduce((a: number, b) => a + Number(b), 0);
  const snapshot = (contexts: any[]): unknown => JSON.parse(JSON.stringify(contexts));
  const clone = (context: any): any => ({ ...context });
  let checks = 0;
  const check = (condition: unknown, message: string): void => { checks++; assert.ok(condition, message); };

  const fixture = fs.readFileSync(path.resolve(__dirname, '../../../fixtures/minimal_project/blog/heavy_lookup_examples.py'), 'utf8');
  const document = makeDocument(fixture);
  const contexts = await collect(document, () => false, 100, document.lineCount);
  const rawInputs = contexts.map(clone);
  let visited = 0;
  const cold = validate(contexts, fixture, () => { visited++; return false; }, document);
  check(contexts.length === 1500 && cold.length === 750, 'Use the same real raw 1500 / valid 750 fixture as the editor measurements.');
  check(visited === contexts.length, 'Cold validation must check cancellation for every raw context.');
  const coldParses = totalParses();
  const needsParsing = (item: any): boolean => !!item._needsCallContextValidation && item._absoluteStart !== undefined;
  const parsingContexts = contexts.filter(needsParsing).length;
  check(coldParses === parsingContexts && parsingContexts > 0, 'The cold fixture must really parse every deferred syntax candidate.');
  const coldOutput = snapshot(cold);
  visited = 0;
  const warm = validate(contexts, fixture, () => { visited++; return false; }, document);
  check(totalParses() === coldParses, 'Warm syntax decisions must avoid reparsing both accepted and rejected contexts.');
  check(visited === contexts.length, 'Cache hits must still check cancellation for every raw context.');
  assert.deepEqual(snapshot(warm), coldOutput); checks++;

  visited = 0;
  const cancelled = validate(contexts, fixture, () => ++visited > 22, document);
  assert.deepEqual(snapshot(cancelled), snapshot(contexts.slice(0, 22).filter((item: any) => cold.includes(item)))); checks++;
  check(visited === 23 && totalParses() === coldParses, 'Cancellation must stop warm work at the same raw-context boundary.');
  const resumed = validate(contexts, fixture, () => false, document);
  assert.deepEqual(snapshot(resumed), coldOutput); checks++;

  module.exports.simulateDaemonReadyCacheClearForTesting();
  validate(contexts, fixture, () => false, document);
  check(totalParses() === coldParses, 'Metadata invalidation must preserve pure syntax decisions while clearing dynamic receiver/lookup state.');
  const anotherOwner = makeDocument(fixture);
  const beforeNewOwner = totalParses();
  assert.deepEqual(snapshot(validate(contexts, fixture, () => false, anotherOwner)), coldOutput); checks++;
  check(totalParses() - beforeNewOwner === parsingContexts, 'Another document at the same URI and version must own independent syntax decisions.');
  const beforeVersion = totalParses();
  document.version++;
  validate(contexts, fixture, () => false, document);
  check(totalParses() - beforeVersion === parsingContexts, 'A new version must invalidate syntax decisions even when its text is equal.');
  const beforeClosed = totalParses();
  document.isClosed = true;
  validate(contexts, fixture, () => false, document);
  validate(contexts, fixture, () => false, document);
  check(totalParses() - beforeClosed === parsingContexts * 2, 'A closed owner must neither reuse nor recreate a validation cache.');

  const syntax = [
    'Post.objects.values("title")',
    'Post.objects.filter(**{"title__exact": "name"})',
    'Post.objects.prefetch_related(Prefetch("author", queryset=Author.objects.all()))',
    'Post.objects.annotate(renamed=F("title"))',
    'Post.objects.annotate(total=Count("author__name"))',
    'unrelated = {"unknown": "name"}',
    'unrelated.values("title")',
  ].join('\n');
  const syntaxDocument = makeDocument(syntax, 'file:///fixture/kinds.py');
  const mixed = await collect(syntaxDocument, () => false, 0, syntaxDocument.lineCount);
  const mixedRaw = mixed.map(clone);
  const first = validate(mixed, syntax, () => false, syntaxDocument);
  check(first.length > 0 && first.length < mixed.length, 'The grammar fixture must include both accepted and rejected syntax.');
  const beforeMixedWarm = totalParses();
  assert.deepEqual(snapshot(validate(mixed, syntax, () => false, syntaxDocument)), snapshot(first)); checks++;
  check(totalParses() === beforeMixedWarm, 'All collector grammar kinds must reuse their unchanged decisions.');
  check(Object.values(counts).every(value => Number(value) > 0), 'Exercise queryset, dictionary, F, expression and Prefetch parsers.');

  // Compare every changed input with a cold owner using the actual parser,
  // including fields that mutate on successful validation.
  const changes: Array<[string, any]> = [
    ['method', 'only'], ['receiverExpression', 'Other.objects'],
    ['_absoluteStart', 0], ['_absoluteEnd', 1],
    ['_isDictKey', false], ['_isFExpression', false],
    ['_isExpressionPath', false], ['_isPrefetch', false],
    ['_needsCallContextValidation', false],
  ];
  for (const [key, value] of changes) {
    const owner = makeDocument(syntax, 'file:///fixture/input-change.py');
    const grammarFlag = key.startsWith('_is') ? key : '_isDictKey';
    const item = clone(mixedRaw.find((context: any) => context[grammarFlag]));
    assert.ok(item);
    validate([item], syntax, () => false, owner);
    const beforeInputChange = totalParses();
    item[key] = value;
    const oracle = clone(item);
    const actual = validate([item], syntax, () => false, owner);
    check(needsParsing(item) ? totalParses() > beforeInputChange : totalParses() === beforeInputChange,
      `Changed ${key} must honor the current validation inputs before reusing a decision.`);
    const fresh = validate([oracle], syntax, () => false, makeDocument(syntax));
    assert.deepEqual(snapshot(actual), snapshot(fresh), `Changed ${key} must match a cold syntax decision.`); checks++;
  }
  const changedText = syntax.replace('Post.objects.values("title")', 'plain.values("title")');
  const changedInputs = mixed.map(clone);
  const beforeTextChange = totalParses();
  const actualChanged = validate(mixed, changedText, () => false, syntaxDocument);
  check(totalParses() > beforeTextChange, 'Different exact text at the same version must force new syntax work.');
  const freshChanged = validate(changedInputs, changedText, () => false, makeDocument(changedText));
  assert.deepEqual(snapshot(actualChanged), snapshot(freshChanged)); checks++;

  // Cancellation during a cold batch stores only decisions actually reached;
  // a resumed scan must validate the remaining contexts and retain order.
  const partialOwner = makeDocument(fixture, 'file:///fixture/partial.py');
  const partialInputs = rawInputs.map(clone);
  const beforePartial = totalParses();
  visited = 0;
  validate(partialInputs, fixture, () => ++visited > 22, partialOwner);
  check(totalParses() - beforePartial === partialInputs.slice(0, 22).filter(needsParsing).length,
    'A cancelled cold pass must not speculate past the budget boundary.');
  const completed = validate(partialInputs, fixture, () => false, partialOwner);
  assert.deepEqual(snapshot(completed), coldOutput); checks++;
  check(totalParses() - beforePartial === parsingContexts, 'Resuming a partial validation must parse each untouched context exactly once.');
  console.log(JSON.stringify({ checks, rawFixtureContexts: contexts.length, validFixtureContexts: cold.length,
    coldParserCalls: coldParses, warmParserCalls: 0, cancellationChecksPerCompletePass: contexts.length,
    parserCounts: counts, exactTextAndVersionAndOwnerGuards: true }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
