// Exercise overlap retention and document-close cleanup in the real compiled
// diagnostic pipeline. Private state is exposed only inside this VM fixture.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';

type Callback = (...args: any[]) => void;
type Disposable = { dispose(): void };
class Position {
  constructor(public line: number, public character: number) {}
  toString(): string { return `${this.line}:${this.character}`; }
}
class Range {
  start: Position;
  end: Position;
  constructor(line: number, character: number, endLine: number, endCharacter: number) {
    this.start = new Position(line, character);
    this.end = new Position(endLine, endCharacter);
  }
}

async function main(): Promise<void> {
  const events = new Map<string, Callback>();
  const timers = new Set<NodeJS.Timeout>();
  const logs: string[] = [];
  let publications = 0;
  let lineReads = 0;
  let fullDocument = false;
  let holdLookups = false;
  const heldLookups: Array<() => void> = [];
  let blockNextStart = false;
  let releaseNextStart: (() => void) | undefined;
  const on = (name: string) => (callback: Callback): Disposable => {
    events.set(name, callback);
    return { dispose() { events.delete(name); } };
  };
  const registration = (): Disposable => ({ dispose() {} });
  const lines = Array.from({ length: 1500 }, (_, line) => line % 20 === 0
    ? 'owner = models.ForeignKey("blog.Post", on_delete=models.CASCADE)'
    : line % 10 === 0 ? `Post.objects.values("bog_${line}")` : '# padding');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const uri = 'file:///fixture/overlap.py';
  const document = {
    uri: { scheme: 'file', fsPath: '/fixture/overlap.py', toString: () => uri },
    version: 1, languageId: 'python', lineCount: lines.length, isClosed: false,
    getText: () => lines.join('\n'),
    lineAt: (line: number) => { lineReads++; return { text: lines[line] }; },
    offsetAt: (position: Position) => offsets[position.line] + position.character,
    getWordRangeAtPosition: () => undefined,
  };
  const editor = { document, visibleRanges: [new Range(50, 0, 250, 0)] };
  const vscode = {
    Position, Range,
    EventEmitter: class { readonly event = registration; fire() {} dispose() {} },
    Disposable: class { constructor(private callback: Callback) {} dispose() { this.callback(); } },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Diagnostic: class {
      source?: string;
      constructor(public range: Range, public message: string, public severity: number) {}
    },
    languages: {
      createDiagnosticCollection: () => ({ set() { publications++; }, clear() {}, delete() {}, dispose() {} }),
      registerHoverProvider: registration, registerCompletionItemProvider: registration,
      registerSignatureHelpProvider: registration, registerDefinitionProvider: registration,
      registerInlayHintsProvider: registration,
    },
    window: { visibleTextEditors: [editor],
      onDidChangeVisibleTextEditors: on('editors'), onDidChangeTextEditorVisibleRanges: on('ranges') },
    workspace: { workspaceFolders: [], onDidOpenTextDocument: on('open'),
      onDidChangeTextDocument: on('edit'), onDidCloseTextDocument: on('close'),
      onDidSaveTextDocument: on('save'), onDidChangeConfiguration: on('configuration') },
  };
  const resolution = { resolved: false, reason: 'segment_not_found', missingSegment: 'bog' };
  const daemon = {
    isReady: () => true, isAborted: () => false, getSessionRevision: () => 0,
    getState: () => ({ workspaceRoot: '/fixture', runtime: { djangoVersion: '5.2' } }),
    ensureStarted: async () => {
      if (blockNextStart) {
        blockNextStart = false;
        await new Promise<void>(resolve => { releaseNextStart = resolve; });
      }
    },
    logDiagnostic: (line: string) => logs.push(line),
    snapshotIpcStats: () => new Map(), diffIpcStats: () => [],
    withDeadline: (_deadline: number, callback: () => unknown) => callback(),
    withRequestSource: (_source: string, callback: () => unknown) => callback(),
    onDidChangeState: on('state'), onDidReindexModels: on('models'),
    hasModelByShortName: (name: string) => name === 'Post',
    findModelLabelByShortName: (name: string) => name === 'Post' ? 'blog.Post' : undefined,
    resolveLookupPath: async () => {
      if (holdLookups) await new Promise<void>(resolve => heldLookups.push(resolve));
      return resolution;
    },
    resolveLookupPathBatch: async (items: unknown[]) => items.map(() => resolution),
    resolveRelationTarget: async () => ({ resolved: true }),
    listLookupPathCompletionsLocal: () => ({ resolved: true, items: [] }),
  };
  const filename = path.join(__dirname, 'pythonProviders.js');
  const nodeRequire = createRequire(filename);
  const requireMock = (name: string): unknown => {
    if (name === 'vscode') return vscode;
    if (name === '../config/settings') return {
      CONFIGURATION_SECTION: 'djangoOrmIntellisense',
      getExtensionSettings: () => ({ diagnosticsEnabled: true, diagnosticsFullDocument: fullDocument }),
    };
    if (name === '../python/pylance') return { isPylanceAvailable: () => true };
    return nodeRequire(name);
  };
  const context = vm.createContext({ console, performance, AbortController, queueMicrotask,
    process: { env: {} },
    setTimeout(callback: Callback, delay: number) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer: NodeJS.Timeout) { timers.delete(timer); clearTimeout(timer); },
  });
  const module = { exports: {} as any };
  const inspection = `
module.exports.testState = {
  scans: _scanCacheAcrossRegistrations,
  receivers: _receiverCachesAcrossRegistrations,
  lookups: _lookupResolutionCachesAcrossRegistrations,
  get syntaxValidation() { return lookupContextValidationCaches; },
  findLookups: findLookupDiagnosticContexts,
  findRelations: findRelationDiagnosticContexts,
  collect: collectDiagnosticScanContexts
};`;
  const wrapper = vm.runInContext(
    `(function(exports, require, module) {\n${fs.readFileSync(filename, 'utf8')}\n${inspection}\n})`, context
  );
  wrapper(module.exports, requireMock, module);
  const registrations = module.exports.registerPythonProviders(daemon) as Disposable[];
  const waitForPublication = async (previous: number): Promise<void> => {
    const deadline = Date.now() + 5000;
    while ((publications <= previous || module.exports.getActiveDiagnosticScanRunningCountForTesting() > 0)
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(publications > previous, `Expected a new diagnostic publication:\n${logs.join('\n')}`);
    assert.equal(module.exports.getActiveDiagnosticScanRunningCountForTesting(), 0);
  };
  const lookupKey = (item: any): string => JSON.stringify([item.range.start.line,
    item.range.start.character, item.value, !!item._isExpressionPath, !!item._isFExpression,
    !!item._isDictKey, !!item._isPrefetch]);
  const relationKey = (item: any): string => `${item.range.start.line}:${item.range.start.character}:${item.value}`;
  try {
    await waitForPublication(0);
    for (let line = 100; line <= 350; line += 50) {
      const previous = publications;
      editor.visibleRanges = [new Range(line, 0, line + 200, 0)];
      events.get('ranges')!({ textEditor: editor, visibleRanges: editor.visibleRanges });
      await waitForPublication(previous);
    }
    const state = module.exports.testState;
    const cache = state.scans.get(uri);
    assert.ok(cache && state.receivers.has(uri) && state.lookups.has(uri),
      'All three diagnostic caches must actually be populated before close.');
    assert.ok(state.syntaxValidation.has(document), 'The syntax cache must own the live scanned document.');
    const expectedLookups = await state.findLookups(document, () => false, 0, 600, daemon);
    const expectedRelations = state.findRelations(document, 0, 600);
    const cachedLookupKeys = Array.from(cache.lookups, lookupKey);
    const cachedRelationKeys = Array.from(cache.relations, relationKey);
    const report = {
      rangeQueries: 7, unionLines: 600,
      expectedLookups: expectedLookups.length, retainedLookups: cache.lookups.length,
      expectedRelations: expectedRelations.length, retainedRelations: cache.relations.length,
      retainedContextJsonBytes: Buffer.byteLength(JSON.stringify({ lookups: cache.lookups, relations: cache.relations })),
      duplicateLookups: cachedLookupKeys.length - new Set(cachedLookupKeys).size,
      duplicateRelations: cachedRelationKeys.length - new Set(cachedRelationKeys).size,
      actualScannedLines: logs.filter(line => line.startsWith('[diagnostics:phase] scan-visible '))
        .reduce((total, line) => total + Number(/scannedLines=(\d+)/.exec(line)?.[1] ?? 0), 0),
      closedDocumentCacheOwners: {} as Record<string, number>,
    };
    document.isClosed = true;
    events.get('close')!(document);
    assert.equal(state.syntaxValidation.has(document), false, 'Closing must release the exact document syntax owner.');
    report.closedDocumentCacheOwners = {
      scan: state.scans.size, receiver: state.receivers.size, lookup: state.lookups.size,
    };
    console.log(JSON.stringify(report));
    assert.deepEqual([...new Set(cachedLookupKeys)].sort(), Array.from(expectedLookups, lookupKey).sort(),
      'Overlap reuse must preserve the complete raw lookup collector oracle.');
    assert.deepEqual([...new Set(cachedRelationKeys)].sort(), Array.from(expectedRelations, relationKey).sort(),
      'Overlap reuse must preserve the complete relation collector oracle.');
    assert.equal(report.duplicateLookups, 0, 'Overlapping viewports must not retain duplicate lookup contexts.');
    assert.equal(report.duplicateRelations, 0, 'Overlapping viewports must not retain duplicate relation contexts.');
    assert.equal(report.actualScannedLines, 600, 'Each line in the viewport union must be collected exactly once.');
    assert.deepEqual(report.closedDocumentCacheOwners, { scan: 0, receiver: 0, lookup: 0 },
      'Closing a document must release every diagnostic cache owner.');

    // Query disjoint ranges in reverse order, then bridge several holes and
    // request a complete hit. Compare against fresh real collectors, including
    // their order and total document reads, rather than a second cache algorithm.
    const gapUri = 'file:///fixture/gaps.py';
    const gapDocument = { ...document, isClosed: false,
      uri: { scheme: 'file', fsPath: '/fixture/gaps.py', toString: () => gapUri } };
    const readsBefore = lineReads;
    let newlyScanned = 0;
    for (const [start, end] of [[500, 600], [100, 200], [0, 700], [250, 550]]) {
      const result = await state.collect(gapDocument, start, end, () => false, daemon);
      newlyScanned += result.scannedLines;
    }
    const gapReads = lineReads - readsBefore;
    const fullHit = await state.collect(gapDocument, 0, 700, () => false, daemon);
    const oracleStart = lineReads;
    const oracleLookups = await state.findLookups(gapDocument, () => false, 0, 700, daemon);
    const oracleRelations = state.findRelations(gapDocument, 0, 700);
    const oracleReads = lineReads - oracleStart;
    assert.equal(newlyScanned, 700);
    assert.equal(gapReads, oracleReads, 'Gap collection must read each covered line only as often as one fresh scan.');
    assert.equal(fullHit.cacheHit, true);
    assert.equal(fullHit.scannedLines, 0);
    assert.deepEqual(Array.from(fullHit.lookups, lookupKey), Array.from(oracleLookups, lookupKey),
      'Cached lookup order must match a fresh scan after reverse/disjoint/gap queries.');
    assert.deepEqual(Array.from(fullHit.relations, relationKey), Array.from(oracleRelations, relationKey));
    gapDocument.version++;
    const edited = await state.collect(gapDocument, 0, 100, () => false, daemon);
    assert.equal(edited.scannedLines, 100);
    assert.equal(edited.cacheHit, false, 'A new document version must discard previous coverage.');
    assert.deepEqual(JSON.parse(JSON.stringify(state.scans.get(gapUri).scanned)), [[0, 100]]);
    events.get('close')!(gapDocument);
    console.log(JSON.stringify({ disjointGapQueries: 4, unionLines: 700, newlyScanned,
      documentReads: gapReads, freshOracleDocumentReads: oracleReads, fullHitScannedLines: 0,
      versionInvalidation: true }));

    // Close while visible lookup work is suspended, then deliver its real
    // result. The old callback must not publish or recreate phase2 caches.
    document.isClosed = false;
    document.version++;
    fullDocument = true;
    holdLookups = true;
    const publicationsBeforeCloseRace = publications;
    events.get('edit')!({ document });
    const raceDeadline = Date.now() + 5000;
    while (heldLookups.length === 0 && Date.now() < raceDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(heldLookups.length > 0, 'The close race must interrupt actual in-flight lookup requests.');
    document.isClosed = true;
    events.get('close')!(document);
    // Reopening the same URI can reuse its version number. Populate a new
    // document owner's range before the old callback settles (an ABA race).
    const reopened = { ...document, isClosed: false };
    await state.collect(reopened, 100, 200, () => false, daemon);
    const reopenedCache = state.scans.get(uri);
    holdLookups = false;
    heldLookups.splice(0).forEach(resolve => resolve());
    while (module.exports.getActiveDiagnosticScanRunningCountForTesting() > 0 && Date.now() < raceDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(module.exports.getActiveDiagnosticScanRunningCountForTesting(), 0);
    assert.equal(publications, publicationsBeforeCloseRace, 'Late results must not publish diagnostics for a closed document.');
    assert.equal(state.scans.get(uri), reopenedCache, 'Late results must preserve the reopened document cache owner.');
    assert.deepEqual(JSON.parse(JSON.stringify(reopenedCache.scanned)), [[100, 200]],
      'The old callback must not append its phase2 ranges to a same-URI/same-version reopened cache.');
    reopened.isClosed = true;
    events.get('close')!(reopened);
    assert.equal(state.scans.size + state.receivers.size + state.lookups.size, 0,
      'Late results must not recreate closed-document cache owners.');
    console.log('PASS: closed-document in-flight result suppressed, reopened same-URI/version owner preserved; zero diagnostic cache owners');

    // A reopened document can request diagnostics while the old document's
    // request still owns the URI scan slot. Its pending work must keep the
    // new document object, rather than being discarded when the old closes.
    const oldDocument = { ...document, isClosed: false, version: document.version + 1 };
    editor.document = oldDocument;
    fullDocument = false;
    holdLookups = true;
    events.get('open')!(oldDocument);
    const reopenDeadline = Date.now() + 5000;
    while (heldLookups.length === 0 && Date.now() < reopenDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(heldLookups.length > 0);
    const beforeReopenPublications = publications;
    oldDocument.isClosed = true;
    events.get('close')!(oldDocument);
    const newDocument = { ...oldDocument, isClosed: false };
    editor.document = newDocument;
    blockNextStart = true;
    const reopenLogStart = logs.length;
    events.get('open')!(newDocument);
    while (!logs.slice(reopenLogStart).some(line => line.includes('cause=active-scan')) && Date.now() < reopenDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(logs.slice(reopenLogStart).some(line => line.includes('cause=active-scan')),
      'The new document must actually queue behind the old URI scan slot.');
    holdLookups = false;
    heldLookups.splice(0).forEach(resolve => resolve());
    while (!releaseNextStart && Date.now() < reopenDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(releaseNextStart, 'Closing the old owner must not discard the reopened document pending refresh.');
    assert.equal(publications, beforeReopenPublications, 'The old owner must not publish while the new owner starts.');
    releaseNextStart();
    releaseNextStart = undefined;
    await waitForPublication(beforeReopenPublications);
    assert.equal(logs.slice(reopenLogStart).filter(line =>
      line.includes('fire reason=pending-refresh-after-active-scan')).length, 1,
    'The reopened owner must receive exactly one deferred diagnostic scan.');
    newDocument.isClosed = true;
    events.get('close')!(newDocument);
    assert.equal(state.scans.size + state.receivers.size + state.lookups.size, 0);
    console.log('PASS: reopened same-URI/version pending diagnostics drain once on the new document owner');
  } finally {
    registrations.forEach(item => item.dispose());
    holdLookups = false;
    heldLookups.splice(0).forEach(resolve => resolve());
    releaseNextStart?.();
    for (const timer of timers) clearTimeout(timer);
    assert.equal(timers.size, 0, 'Provider disposal must release all diagnostic timers.');
    assert.equal(events.size, 0, 'Provider disposal must release all subscriptions.');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
