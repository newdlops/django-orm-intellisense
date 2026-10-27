// Exercise the compiled diagnostic pipeline across same-version cancellation.
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

async function checkInterruptedScan(fullDocument: boolean): Promise<void> {
  const events = new Map<string, Callback>();
  const timers = new Set<NodeJS.Timeout>();
  const logs: string[] = [];
  const publications: Array<Array<{ message: string }>> = [];
  const registration = (): Disposable => ({ dispose() {} });
  const on = (name: string) => (callback: Callback): Disposable => {
    events.set(name, callback);
    return { dispose() { events.delete(name); } };
  };
  let interrupted = false;
  let scanClockOffset = 0;
  let modelRefreshTimer: NodeJS.Timeout | undefined;
  const lines = Array.from({ length: 1500 }, () => '# padding');
  lines[1100] = 'Post.objects.values("bog_after_cancel")';
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const visits = new Map<number, number>();
  const document = {
    uri: { scheme: 'file', fsPath: '/fixture/query.py', toString: () => 'file:///fixture/query.py' },
    version: 1, languageId: 'python', lineCount: lines.length, isClosed: false,
    getText: () => lines.join('\n'),
    lineAt(line: number) {
      const visit = (visits.get(line) ?? 0) + 1;
      visits.set(line, visit);
      // The relation pass visits this line first. Interrupt the actual lookup
      // collector before its 1000-line cancellation checkpoint, leaving the
      // invalid lookup later in the uncollected part of the same version.
      if (line === 500 && visit === 2 && !interrupted) {
        interrupted = true;
        if (fullDocument) {
          // The collector only yields microtasks, so a queued model event
          // alone cannot interrupt it. Expire the real budget check at the
          // next checkpoint, then deliver a model refresh to permit a fresh
          // same-version pass. The new pass gets its own relative budget.
          scanClockOffset = 20_000;
          modelRefreshTimer = setTimeout(() => events.get('models')!(), 0);
        } else {
          editor.visibleRanges = [new Range(150, 0, 1490, 0)];
          events.get('ranges')!({ textEditor: editor, visibleRanges: editor.visibleRanges });
        }
      }
      return { text: lines[line] };
    },
    offsetAt: (position: Position) => offsets[position.line] + position.character,
    getWordRangeAtPosition: () => undefined,
  };
  const editor = { document, visibleRanges: [new Range(0, 0, fullDocument ? 30 : 1490, 0)] };
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
      createDiagnosticCollection: () => ({
        set: (_uri: unknown, items: Array<{ message: string }>) => publications.push([...items]),
        clear() {}, delete() {}, dispose() {},
      }),
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
  let starts = 0;
  const daemon = {
    isReady: () => true, isAborted: () => false, getSessionRevision: () => 0,
    getState: () => ({ workspaceRoot: '/fixture', runtime: { djangoVersion: '5.2' } }),
    ensureStarted: async () => { starts++; },
    logDiagnostic: (line: string) => logs.push(line),
    snapshotIpcStats: () => new Map(), diffIpcStats: () => [],
    withDeadline: (_deadline: number, callback: () => unknown) => callback(),
    withRequestSource: (_source: string, callback: () => unknown) => callback(),
    onDidChangeState: on('state'), onDidReindexModels: on('models'),
    hasModelByShortName: (name: string) => name === 'Post',
    findModelLabelByShortName: (name: string) => name === 'Post' ? 'blog.Post' : undefined,
    resolveLookupPath: async () => ({ resolved: false, reason: 'segment_not_found', missingSegment: 'bog_after_cancel' }),
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
  const context = vm.createContext({ console,
    Date: class extends Date { static now() { return Date.now() + scanClockOffset; } },
    performance: { now: () => performance.now() + scanClockOffset },
    AbortController, queueMicrotask,
    process: { env: {} },
    setTimeout(callback: Callback, delay: number) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer: NodeJS.Timeout) { timers.delete(timer); clearTimeout(timer); },
  });
  const module = { exports: {} as any };
  const wrapper = vm.runInContext(
    `(function(exports, require, module) {\n${fs.readFileSync(filename, 'utf8')}\n})`, context
  );
  wrapper(module.exports, requireMock, module);
  const registrations = module.exports.registerPythonProviders(daemon) as Disposable[];
  let disposed = false;
  try {
    const deadline = Date.now() + 5000;
    const hasMissingField = (items: Array<{ message: string }> | undefined): boolean =>
      !!items?.some(item => item.message.includes('bog_after_cancel'));
    while ((starts < 2 || module.exports.getActiveDiagnosticScanRunningCountForTesting() > 0
      || !hasMissingField(publications.at(-1))) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(interrupted, 'The real lookup collector must cross the controlled interruption.');
    assert.equal(starts, 2, `Exactly one follow-up scan must run:\n${logs.join('\n')}`);
    assert.ok(publications.length > 0);
    assert.ok(hasMissingField(publications.at(-1)),
      `An incomplete cached range must not hide later lookups:\n${logs.join('\n')}`);
    if (!fullDocument) {
      assert.ok(publications.every(hasMissingField), 'Superseded visible scans must not publish.');
    } else {
      assert.ok(logs.some(line => line.includes('phase2-scan:')),
        'The full-document case must exercise the phase2 cache commit.');
      assert.ok(logs.some(line => line.includes('time budget exhausted')),
        'The full-document collector must actually exhaust its budget before the refresh.');
    }
    while (module.exports.getActiveDiagnosticScanRunningCountForTesting() > 0) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    if (!fullDocument) {
      editor.visibleRanges = [new Range(151, 0, 1491, 0)];
      for (let i = 0; i < 25; i++) {
        events.get('ranges')!({ textEditor: editor, visibleRanges: editor.visibleRanges });
      }
      assert.equal(timers.size, 0, 'Repeated same-grid scroll events must not schedule more scans.');
      editor.visibleRanges = [new Range(300, 0, 1200, 0)];
      events.get('ranges')!({ textEditor: editor, visibleRanges: editor.visibleRanges });
      assert.equal(timers.size, 1, 'A new grid range must schedule one coalesced refresh.');
    }
    registrations.forEach(item => item.dispose());
    disposed = true;
    assert.equal(timers.size, 0, 'Provider disposal must cancel the queued viewport refresh.');
    assert.equal(events.size, 0, 'Provider disposal must release viewport/workspace/model subscriptions.');
    console.log(`PASS: ${fullDocument ? 'phase2 budget cancellation/model refresh' : 'visible scan viewport refresh'} recollection, one pending rerun and disposal`);
  } finally {
    if (!disposed) registrations.forEach(item => item.dispose());
    if (modelRefreshTimer) clearTimeout(modelRefreshTimer);
    for (const timer of timers) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  await checkInterruptedScan(false);
  await checkInterruptedScan(true);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
