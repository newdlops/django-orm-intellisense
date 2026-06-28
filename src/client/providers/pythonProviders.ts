import * as path from 'path';
import * as vscode from 'vscode';
import { getExtensionSettings, CONFIGURATION_SECTION } from '../config/settings';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import { isPylanceAvailable } from '../python/pylance';
import { pythonTypeForKind } from '../../server/fieldLookups';
import type {
  ExportOriginResolution,
  LookupPathCompletionsResult,
  LookupPathItem,
  LookupPathResolution,
  ModuleResolution,
  OrmMemberItem,
  OrmMemberResolution,
  OrmReceiverKind,
  RelationTargetItem,
  RelationTargetsResult,
  RelationTargetResolution,
} from '../protocol';

function buildPythonSelector(): vscode.DocumentSelector {
  const selectors: vscode.DocumentFilter[] = [];
  const activeDocument = vscode.window.activeTextEditor?.document;

  // Use the active file as the most-specific selector so our hover/signature
  // providers outrank generic Python stub providers from other extensions.
  if (
    activeDocument?.languageId === 'python' &&
    activeDocument.uri.scheme === 'file'
  ) {
    selectors.push({
      language: 'python',
      scheme: 'file',
      pattern: new vscode.RelativePattern(
        path.dirname(activeDocument.uri.fsPath),
        path.basename(activeDocument.uri.fsPath)
      ),
    });
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    selectors.push({
      language: 'python',
      scheme: 'file',
      pattern: new vscode.RelativePattern(folder.uri, '**/*.py'),
    });
  }

  selectors.push({ language: 'python', scheme: 'file' });
  return selectors;
}

const RELATION_FIELD_CALL_PATTERN = String.raw`(?:[A-Za-z_][\w.]*\.)?(?:ForeignKey|OneToOneField|ManyToManyField|ParentalKey|ParentalManyToManyField)`;
const RELATION_TARGET_ARGUMENT_PATTERN = String.raw`${RELATION_FIELD_CALL_PATTERN}\(\s*(?:to\s*=\s*)?`;
const RELATION_COMPLETION_PATTERN = new RegExp(
  String.raw`${RELATION_TARGET_ARGUMENT_PATTERN}(['"])([\w.]*)$`
);
const RELATION_HOVER_PATTERN = new RegExp(
  String.raw`${RELATION_TARGET_ARGUMENT_PATTERN}(['"])([\w.]+)\1`,
  'g'
);
const PREFETCH_LOOKUP_COMPLETION_PATTERN = /(?:[A-Za-z_][\w.]*\.)?Prefetch\(\s*(['"])([-\w.]*)$/;
const PREFETCH_LOOKUP_HOVER_PATTERN =
  /(?:[A-Za-z_][\w.]*\.)?Prefetch\(\s*(['"])([-\w.]+)\1/g;
const LOOKUP_DICT_KEY_COMPLETION_PATTERN =
  /(?:\*\*\{\s*|,\s*)(?:[rRuUbBfF]{0,2})(['"])([^'"]*)$/;
const LOOKUP_DICT_KEY_HOVER_PATTERN =
  /(?:\*\*\{\s*|,\s*)(?:[rRuUbBfF]{0,2})(['"])([^'"]+)\1\s*:/g;
const IMPORT_FROM_PATTERN = /^\s*from\s+([.A-Za-z_][\w.]*)\s+import\s+(.+)$/;
const IMPORT_SPEC_PATTERN = /([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?/g;
const IMPORT_MODULE_PATTERN = /^\s*import\s+(.+)$/;
const IMPORT_MODULE_SPEC_PATTERN = /([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_][\w]*))?/g;
const LOOKUP_METHOD_PATTERN =
  'values|values_list|order_by|only|defer|select_related|prefetch_related';
const KEYWORD_LOOKUP_METHOD_PATTERN =
  'filter|exclude|get|get_or_create|update_or_create';
const DIRECT_FIELD_KEYWORD_METHOD_PATTERN = 'create|update';
const STRING_LOOKUP_METHODS = new Set([
  'values',
  'values_list',
  'order_by',
  'only',
  'defer',
  'select_related',
  'prefetch_related',
]);
const RELATION_ONLY_LOOKUP_METHODS = new Set([
  'select_related',
  'prefetch_related',
]);
const KEYWORD_LOOKUP_METHODS = new Set([
  'filter',
  'exclude',
  'get',
  'get_or_create',
  'update_or_create',
]);
const DIRECT_FIELD_KEYWORD_METHODS = new Set(['create', 'update']);
const ORM_FIELD_SIGNATURE_METHODS = new Set([
  ...KEYWORD_LOOKUP_METHODS,
  ...DIRECT_FIELD_KEYWORD_METHODS,
]);
const FAST_LOCAL_ORM_MEMBER_HOVER_NAMES = new Set([
  // QuerySet / Manager methods
  'aggregate',
  'alias',
  'all',
  'annotate',
  'bulk_create',
  'bulk_update',
  'contains',
  'count',
  'create',
  'dates',
  'datetimes',
  'defer',
  'delete',
  'difference',
  'distinct',
  'earliest',
  'exclude',
  'exists',
  'explain',
  'extra',
  'filter',
  'first',
  'get',
  'get_or_create',
  'get_queryset',
  'in_bulk',
  'intersection',
  'iterator',
  'last',
  'latest',
  'none',
  'only',
  'order_by',
  'prefetch_related',
  'raw',
  'reverse',
  'select_for_update',
  'select_related',
  'union',
  'update',
  'update_or_create',
  'using',
  'values',
  'values_list',
  // Async QuerySet variants
  'aaggregate',
  'abulk_create',
  'abulk_update',
  'acontains',
  'acount',
  'acreate',
  'adelete',
  'aearliest',
  'aexists',
  'afirst',
  'aget',
  'aget_or_create',
  'ain_bulk',
  'aiterator',
  'alast',
  'alatest',
  'aupdate',
  'aupdate_or_create',
  // Model instance methods
  'save',
  'full_clean',
  'clean',
  'clean_fields',
  'validate_unique',
  'validate_constraints',
  'refresh_from_db',
  'serializable_value',
  'get_deferred_fields',
  'asave',
  'arefresh_from_db',
  'aclean',
  'afull_clean',
]);
const BULK_UPDATE_FIELD_LIST_METHODS = new Set(['bulk_update']);
const EXPRESSION_QUERYSET_METHODS = new Set([
  'filter',
  'exclude',
  'get',
  'annotate',
  'alias',
  'aggregate',
  'update',
  'create',
  'get_or_create',
  'update_or_create',
  'values',
  'values_list',
  'order_by',
  'only',
  'defer',
  'select_related',
  'prefetch_related',
]);
const SCHEMA_FIELD_LIST_COMPLETION_PATTERN =
  /\b(?:fields|include)\s*=\s*\[[^\]]*(['"])([-\w]*)$/;
const BULK_UPDATE_FIELD_LIST_COMPLETION_PATTERN =
  /\.bulk_update\(\s*[^,\n]+,\s*\[[^\]]*(['"])([-\w]*)$/;
const BULK_UPDATE_FIELD_LIST_HOVER_PATTERN =
  /\.bulk_update\(\s*[^,\n]+,\s*\[[^\]]*(['"])([-\w]+)\1/g;
const EXPRESSION_QUERYSET_METHOD_PATTERN =
  'filter|exclude|get|annotate|alias|aggregate|update|create|get_or_create|update_or_create|values|values_list|order_by|only|defer|select_related|prefetch_related';
const QUERYSET_RECEIVER_PATTERN =
  String.raw`[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*|\([^()]*\))*`;
const LOOKUP_COMPLETION_PATTERN = new RegExp(
  String.raw`\.(${LOOKUP_METHOD_PATTERN})\(\s*(['"])([-\w.]*)$`
);
const LOOKUP_HOVER_PATTERN = new RegExp(
  String.raw`\.(${LOOKUP_METHOD_PATTERN})\(\s*(['"])([-\w.]+)\2`,
  'g'
);
const F_EXPRESSION_METHOD = 'f_expression';
const EXPRESSION_PATH_METHOD_PREFIX = 'expression_path:';
const ANNOTATED_MEMBER_SOURCE = 'annotation_expression';
const INITIAL_DIAGNOSTIC_REFRESH_DELAY_MS = 500;
const EDIT_DIAGNOSTIC_DEBOUNCE_MS = 1000;
function diagnosticTimeBudgetMs(): number {
  const override = parseInt(process.env.DJLS_DIAGNOSTIC_TIME_BUDGET_MS ?? '', 10);
  return Number.isFinite(override) && override > 0 ? override : 10_000;
}

function areOrmDiagnosticsEnabled(
  scope?: vscode.ConfigurationScope
): boolean {
  return getExtensionSettings(scope).diagnosticsEnabled && isPylanceAvailable();
}

// Survives across provider re-registrations so the extension layer can ask
// "is any registration currently doing real diagnostic work?" before
// disposing+recreating provider registrations. Avoids killing a 10s scan
// just to bump provider priority by one slot.
let activeDiagnosticScanRunningCount = 0;
export function isAnyDiagnosticScanInFlight(): boolean {
  return activeDiagnosticScanRunningCount > 0;
}

/** Test-only: peek the in-flight counter for regression assertions. */
export function getActiveDiagnosticScanRunningCountForTesting(): number {
  return activeDiagnosticScanRunningCount;
}

/** Test-only: clear the cross-registration receiver/lookup caches so a
 *  fresh run starts from cold caches (mirrors a daemon restart without
 *  actually restarting). */
export function clearReceiverAndLookupCachesForTesting(): void {
  _receiverCachesAcrossRegistrations.clear();
  _lookupResolutionCachesAcrossRegistrations.clear();
  _scanCacheAcrossRegistrations.clear();
}

/** Test-only: simulate the cache clearing that `daemon.onDidChangeState`
 *  performs on a `ready` transition. Production captain trace showed this
 *  clear was wiping the scan cache too aggressively because scan results are
 *  pure functions of document text. The fix is for this clear to leave the
 *  scan cache intact; this hook lets the test prove it. */
export function simulateDaemonReadyCacheClearForTesting(): void {
  clearLookupResolutionAndReceiverCachesAcrossRegistrations();
}

/** Test-only: directly invoke the diagnostic noRecv classifier on an
 *  arbitrary receiver expression. Reproduces the captain bug where the
 *  classifier sees `return X.objects...` and extracts `return` as the
 *  root identifier (instead of normalizing the keyword prefix first). */
export function classifyNoRecvReasonForTesting(
  daemon: AnalysisDaemon,
  receiverExpression: string,
): string {
  return classifyNoRecvReason(daemon, receiverExpression);
}

// Receiver-resolution cache shared across provider re-registrations and
// keyed by (document URI, version). When a re-registration creates a fresh
// provider scope mid-edit-session, the new scope's diagnostic cycle reuses
// receiver resolutions computed in the previous cycle instead of redoing
// them all. The version key invalidates the cache automatically when the
// user edits the document.
const _receiverCachesAcrossRegistrations = new Map<string, {
  version: number;
  entries: Map<string, Promise<OrmReceiverInfo | null>>;
}>();

function getReceiverCacheForDocument(
  document: vscode.TextDocument
): Map<string, Promise<OrmReceiverInfo | null>> {
  const key = document.uri.toString();
  const existing = _receiverCachesAcrossRegistrations.get(key);
  if (existing && existing.version === document.version) {
    return existing.entries;
  }
  const entries = new Map<string, Promise<OrmReceiverInfo | null>>();
  _receiverCachesAcrossRegistrations.set(key, { version: document.version, entries });
  return entries;
}

// Same pattern for daemon-resolved lookup paths. Results depend on the daemon
// model graph, so we invalidate explicitly when the daemon state transitions
// (see daemon.onDidChangeState handler in registerPythonProviders).
const _lookupResolutionCachesAcrossRegistrations = new Map<string, {
  version: number;
  entries: Map<string, Promise<LookupPathResolution>>;
}>();

function getLookupResolutionCacheForDocument(
  document: vscode.TextDocument
): Map<string, Promise<LookupPathResolution>> {
  const key = document.uri.toString();
  const existing = _lookupResolutionCachesAcrossRegistrations.get(key);
  if (existing && existing.version === document.version) {
    return existing.entries;
  }
  const entries = new Map<string, Promise<LookupPathResolution>>();
  _lookupResolutionCachesAcrossRegistrations.set(key, { version: document.version, entries });
  return entries;
}

// Scan-result cache (lookup + relation contexts) keyed by document URI,
// scoped per version. Stores the UNION of all ranges scanned so far in the
// current cycle (and prior cycles on the same version). Subsequent range
// queries reuse the cached contexts via interval-overlap checks, so even
// queries with different start/end lines hit the cache as long as their
// lines are covered.
//
// Captain regression A: small scrolls drift the visible range by 50-100
// lines between cycles. The prior implementation keyed by exact
// `start-end` strings, so any drift produced a fresh miss and ~1.5s of
// scan work was repeated. With interval coverage tracking, the second
// cycle reuses the first cycle's full scan output via filter-by-line.
interface FullScanCacheEntry {
  version: number;
  // Sorted, non-overlapping intervals of [startLine, endLine) that have
  // been scanned. Merged opportunistically on each add().
  scanned: Array<[number, number]>;
  lookups: LookupDiagnosticContext[];
  relations: RelationDiagnosticContext[];
}

const _scanCacheAcrossRegistrations = new Map<string, FullScanCacheEntry>();

function getScanCacheEntry(
  document: vscode.TextDocument,
): FullScanCacheEntry {
  const key = document.uri.toString();
  const existing = _scanCacheAcrossRegistrations.get(key);
  if (existing && existing.version === document.version) {
    return existing;
  }
  const fresh: FullScanCacheEntry = {
    version: document.version,
    scanned: [],
    lookups: [],
    relations: [],
  };
  _scanCacheAcrossRegistrations.set(key, fresh);
  return fresh;
}

/** Returns true if every line in [startLine, endLine) is inside one of the
 *  cached intervals. */
function intervalsCover(
  intervals: Array<[number, number]>,
  startLine: number,
  endLine: number,
): boolean {
  if (startLine >= endLine) return true;
  for (const [s, e] of intervals) {
    if (s <= startLine && endLine <= e) return true;
  }
  return false;
}

/** Merge [start, end) into the sorted, non-overlapping interval list. */
function intervalsAdd(
  intervals: Array<[number, number]>,
  start: number,
  end: number,
): void {
  if (start >= end) return;
  const next: Array<[number, number]> = [];
  let inserted = false;
  let curStart = start;
  let curEnd = end;
  for (const [s, e] of intervals) {
    if (e < curStart) {
      next.push([s, e]);
      continue;
    }
    if (s > curEnd) {
      if (!inserted) {
        next.push([curStart, curEnd]);
        inserted = true;
      }
      next.push([s, e]);
      continue;
    }
    curStart = Math.min(curStart, s);
    curEnd = Math.max(curEnd, e);
  }
  if (!inserted) next.push([curStart, curEnd]);
  intervals.length = 0;
  intervals.push(...next);
}

function clearLookupResolutionAndReceiverCachesAcrossRegistrations(): void {
  _receiverCachesAcrossRegistrations.clear();
  _lookupResolutionCachesAcrossRegistrations.clear();
  // NOTE: do NOT clear the scan cache here. Scan results are a pure function
  // of document text (version) and don't depend on daemon model graph or
  // resolver state. Clearing them on daemon state transitions defeats the
  // cross-registration cache entirely because daemon-state changes always
  // precede provider re-registration in production.
}
const DIAGNOSTIC_REQUEST_BUDGET = 1000;
const DIAGNOSTIC_LOOKUP_PARALLELISM = 4;
const modelSubclassRelationCache = new Map<string, boolean>();
const VIRTUAL_LOOKUP_OPERATORS = [
  'exact',
  'iexact',
  'contains',
  'icontains',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'startswith',
  'istartswith',
  'endswith',
  'iendswith',
  'range',
  'isnull',
  'regex',
  'iregex',
  'date',
  'year',
  'month',
  'day',
  'week',
  'week_day',
  'quarter',
  'time',
  'hour',
  'minute',
  'second',
] as const;
const F_EXPRESSION_COMPLETION_PATTERN = new RegExp(
  String.raw`(?:^|[^\w.])(?:[A-Za-z_][\w.]*\.)?F\(\s*(['"])([-\w.]*)$`
);
const F_EXPRESSION_HOVER_PATTERN = new RegExp(
  String.raw`(?:^|[^\w.])(?:[A-Za-z_][\w.]*\.)?F\(\s*(['"])([-\w.]+)\1`,
  'g'
);
const EXPRESSION_FIELD_FUNCTION_NAMES = [
  'OuterRef',
  'Count',
  'Sum',
  'Avg',
  'Min',
  'Max',
  'Cast',
  'Coalesce',
  'Func',
  'ArrayAgg',
  'JSONBAgg',
  'StringAgg',
  'Concat',
  'Greatest',
  'Least',
  'Length',
  'Replace',
  'Collate',
  'Substr',
  'Extract',
  'ExtractYear',
  'ExtractDay',
  'ExtractMonth',
  'ExtractWeek',
  'ExtractWeekDay',
  'ExtractQuarter',
  'ExtractHour',
  'ExtractMinute',
  'ExtractSecond',
  'Lag',
  'Lead',
  'FirstValue',
  'LastValue',
  'NthValue',
  'TruncDate',
] as const;
const EXPRESSION_FIELD_FUNCTION_NAME_SET = new Set<string>(
  EXPRESSION_FIELD_FUNCTION_NAMES
);
const EXPRESSION_FIELD_FUNCTION_PATTERN =
  EXPRESSION_FIELD_FUNCTION_NAMES.join('|');
const EXPRESSION_WRAPPER_FUNCTION_NAMES = new Set([
  'ExpressionWrapper',
  'Value',
  'Subquery',
  'Exists',
  'ArraySubquery',
  'Window',
  'JSONObject',
]);
const EXPRESSION_PATH_COMPLETION_PATTERN = new RegExp(
  String.raw`(?:^|[^\w.])((?:[A-Za-z_][\w.]*\.)?(?:${EXPRESSION_FIELD_FUNCTION_PATTERN}))\(\s*(['"])([-\w.]*)$`
);
const EXPRESSION_PATH_HOVER_PATTERN = new RegExp(
  String.raw`(?:^|[^\w.])((?:[A-Za-z_][\w.]*\.)?(?:${EXPRESSION_FIELD_FUNCTION_PATTERN}))\(\s*(['"])([-\w.]+)\2`,
  'g'
);
const EXPRESSION_STRING_COMPLETION_PATTERN = /(['"])([-\w.]*)$/;
const EXPRESSION_STRING_HOVER_PATTERN = /(['"])([-\w.]+)\1/g;
const ANY_POSITION_EXPRESSION_FIELD_FUNCTIONS = new Set<string>([
  'Coalesce',
  'Concat',
  'Greatest',
  'Least',
  'Func',
]);
const FIRST_ARGUMENT_EXPRESSION_FIELD_FUNCTIONS = new Set<string>([
  ...EXPRESSION_FIELD_FUNCTION_NAMES.filter(
    (name) => !ANY_POSITION_EXPRESSION_FIELD_FUNCTIONS.has(name)
  ),
]);
const KEYWORD_VALUE_EXPRESSION_FIELD_FUNCTIONS = new Set<string>(['JSONObject']);
const DJANGO_FIELD_PRIORITY_METHODS = new Set(['filter', 'exclude', 'get']);
const LOOKUP_OPERATOR_METHODS = new Set([
  'filter',
  'exclude',
  'get',
  'get_or_create',
  'update_or_create',
]);
const LOOKUP_RECEIVER_KINDS = new Set<OrmReceiverKind>([
  'model_class',
  'manager',
  'queryset',
  'related_manager',
]);

// Standard QuerySet/Manager methods whose return is NOT a same-model queryset
// (they return dicts/tuples/instances/scalars). An UNKNOWN method on a
// queryset-like receiver that is NOT in this set is assumed to be a custom
// chainable QuerySet method returning Self (same-model queryset) — Django's
// idiom — instead of making receiver resolution give up. Sourced from the
// server's QUERYSET_BUILTIN_METHODS return-kind table; keep complete (includes
// `raw`, `contains`, and the async `a*` variants).
const TYPE_CHANGING_QUERYSET_METHODS = new Set<string>([
  // dicts / tuples / raw / iterators (not a same-model field queryset)
  'values', 'values_list', 'dates', 'datetimes', 'raw', 'iterator',
  // model instance / tuple
  'get', 'create', 'get_or_create', 'update_or_create',
  'first', 'last', 'earliest', 'latest',
  // scalars / non-queryset
  'count', 'exists', 'contains', 'explain', 'aggregate', 'in_bulk',
  'update', 'delete', 'bulk_create', 'bulk_update',
  // async variants of all of the above
  'aget', 'acreate', 'aget_or_create', 'aupdate_or_create',
  'afirst', 'alast', 'aearliest', 'alatest',
  'acount', 'aexists', 'acontains', 'aaggregate', 'ain_bulk',
  'aupdate', 'adelete', 'abulk_create', 'abulk_update', 'aiterator',
]);
const QUERYSET_ANNOTATION_PRESERVING_METHODS = new Set([
  'all',
  'alias',
  'annotate',
  'defer',
  'distinct',
  'exclude',
  'filter',
  'only',
  'order_by',
  'prefetch_related',
  'select_related',
]);
const INSTANCE_ANNOTATION_PRESERVING_METHODS = new Set([
  'create',
  'first',
  'get',
  'last',
]);
const LOOKUP_OPERATOR_PRIORITY = new Map(
  [
    'in',
    'exact',
    'icontains',
    'contains',
    'iexact',
    'istartswith',
    'startswith',
    'iendswith',
    'endswith',
    'isnull',
    'gte',
    'gt',
    'lte',
    'lt',
    'range',
    'date',
    'year',
    'month',
    'day',
    'hour',
    'minute',
    'second',
    'time',
    'week',
    'week_day',
    'quarter',
    'regex',
    'iregex',
  ].map((name, index) => [name, index])
);
const PREFERRED_MANAGER_MEMBER_METHOD_PRIORITY = new Map(
  [
    'create',
    'filter',
    'exclude',
    'get',
    'all',
    'get_queryset',
    'update',
    'get_or_create',
    'update_or_create',
    'first',
    'last',
    'order_by',
    'values',
    'values_list',
    'only',
    'defer',
    'select_related',
    'prefetch_related',
    'annotate',
    'alias',
    'aggregate',
    'bulk_create',
    'bulk_update',
  ].map((name, index) => [name, index])
);
const CLASS_HEADER_START_PATTERN =
  /^(\s*)class\s+([A-Za-z_][\w]*)\b(.*)$/;
const FUNCTION_DEFINITION_PATTERN =
  /^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/;
const ITERABLE_TYPE_NAMES = new Set([
  'Collection',
  'Iterable',
  'Iterator',
  'List',
  'Sequence',
  'Set',
  'Tuple',
  'collections.abc.Collection',
  'collections.abc.Iterable',
  'collections.abc.Iterator',
  'collections.abc.Sequence',
  'frozenset',
  'list',
  'set',
  'tuple',
  'typing.Collection',
  'typing.Iterable',
  'typing.Iterator',
  'typing.List',
  'typing.Sequence',
  'typing.Set',
  'typing.Tuple',
]);
const OPTIONAL_TYPE_NAMES = new Set(['Optional', 'typing.Optional']);
const UNION_TYPE_NAMES = new Set(['Union', 'typing.Union']);
const QUERYSET_TYPE_NAMES = new Set([
  'QuerySet',
  'django.db.models.QuerySet',
  'models.QuerySet',
]);
const MANAGER_TYPE_NAMES = new Set([
  'BaseManager',
  'Manager',
  'django.db.models.Manager',
  'models.Manager',
]);
const RELATED_MANAGER_TYPE_NAMES = new Set([
  'ManyRelatedManager',
  'RelatedManager',
]);
const BUILTIN_TYPE_HINT_NAMES = new Set([
  'None',
  'bool',
  'bytes',
  'dict',
  'float',
  'frozenset',
  'int',
  'list',
  'object',
  'set',
  'str',
  'tuple',
]);
const TYPING_TYPE_HINT_NAMES = new Set([
  'Any',
  'Callable',
  'Collection',
  'Iterable',
  'Iterator',
  'List',
  'Literal',
  'Optional',
  'Sequence',
  'Set',
  'Tuple',
  'Union',
  'typing.Any',
  'typing.Callable',
  'typing.Collection',
  'typing.Iterable',
  'typing.Iterator',
  'typing.List',
  'typing.Literal',
  'typing.Optional',
  'typing.Sequence',
  'typing.Set',
  'typing.Tuple',
  'typing.Union',
]);
const DJANGO_TYPE_HINT_NAMES = new Set([
  'AppConfig',
  'BaseManager',
  'Manager',
  'ManyRelatedManager',
  'Model',
  'QuerySet',
  'RelatedManager',
  'django.apps.AppConfig',
  'django.db.models.Manager',
  'django.db.models.Model',
  'django.db.models.QuerySet',
  'models.Manager',
  'models.Model',
  'models.QuerySet',
]);

interface LookupContext {
  receiverExpression: string;
  method: string;
  prefix: string;
  range: vscode.Range;
}

interface LookupLiteral {
  receiverExpression: string;
  method: string;
  value: string;
}

interface ImportBindings {
  symbols: Map<string, { moduleName: string; symbolName: string }>;
  modules: Map<string, string>;
}

type ImportReference =
  | { kind: 'symbol'; moduleName: string; symbol: string }
  | { kind: 'module'; moduleName: string };

interface RawImportStatement {
  startOffset: number;
  endOffset: number;
  text: string;
}

interface ParsedImportSymbolSpec {
  importedName: string;
  aliasName?: string;
  importedStartOffset: number;
  importedEndOffset: number;
  aliasStartOffset?: number;
  aliasEndOffset?: number;
}

interface ParsedImportModuleSpec {
  importedModule: string;
  aliasName?: string;
  importedStartOffset: number;
  importedEndOffset: number;
  aliasStartOffset?: number;
  aliasEndOffset?: number;
}

type ParsedImportStatement =
  | {
      kind: 'from';
      startOffset: number;
      endOffset: number;
      rawModuleName: string;
      moduleName?: string;
      symbolSpecs: ParsedImportSymbolSpec[];
    }
  | {
      kind: 'import';
      startOffset: number;
      endOffset: number;
      moduleSpecs: ParsedImportModuleSpec[];
    };

type SpecialClassKind = 'manager' | 'queryset' | 'related_manager';
type ClassHoverCategory = 'django' | 'general';

interface RelationDiagnosticContext {
  value: string;
  range: vscode.Range;
}

interface LookupDiagnosticContext extends LookupLiteral {
  range: vscode.Range;
}

interface DirectFieldKeywordContext {
  receiverExpression: string;
  method: string;
  prefix: string;
  range: vscode.Range;
}

interface DirectFieldKeywordLiteral {
  receiverExpression: string;
  method: string;
  value: string;
}

interface DirectFieldDiagnosticContext extends DirectFieldKeywordLiteral {
  range: vscode.Range;
}

interface SchemaFieldContext {
  prefix: string;
  range: vscode.Range;
}

interface SchemaFieldLiteral {
  value: string;
}

interface SchemaFieldDiagnosticContext extends SchemaFieldLiteral {
  range: vscode.Range;
}

interface MetaConstraintLookupContext {
  prefix: string;
  range: vscode.Range;
}

interface MetaConstraintLookupLiteral {
  value: string;
}

interface MetaConstraintLookupDiagnosticContext
  extends MetaConstraintLookupLiteral {
  range: vscode.Range;
}

interface BulkUpdateFieldListContext {
  receiverExpression: string;
  prefix: string;
  range: vscode.Range;
}

interface BulkUpdateFieldListLiteral {
  receiverExpression: string;
  value: string;
}

interface BulkUpdateFieldListDiagnosticContext
  extends BulkUpdateFieldListLiteral {
  range: vscode.Range;
}

interface PythonClassDefinition {
  name: string;
  baseExpressions: string[];
  line: number;
  indent: number;
  endLine: number;
}

interface PythonFunctionDefinition {
  name: string;
  line: number;
  indent: number;
  endLine: number;
  returnAnnotation?: string;
}

interface ClassDefinitionSource {
  document: vscode.TextDocument;
  classDef: PythonClassDefinition;
  beforeOffset: number;
}

interface FunctionDefinitionSource {
  document: vscode.TextDocument;
  functionDef: PythonFunctionDefinition;
  beforeOffset: number;
}

interface CachedParsedImportStatements {
  version: number;
  statements: ParsedImportStatement[];
}

interface CachedDocumentDefinitions {
  version: number;
  classesByName: Map<string, PythonClassDefinition>;
  topLevelFunctionsByName: Map<string, PythonFunctionDefinition>;
}

interface TypeAnnotationSource {
  document: vscode.TextDocument;
  annotation: string;
  offset: number;
}

interface ClassMemberItem {
  name: string;
  kind: 'method' | 'attribute' | 'property';
  detail: string;
  ownerClassName: string;
  typeAnnotation?: string;
  filePath: string;
  line: number;
  column: number;
}

interface ClassInstanceCompletionContext {
  receiverExpression: string;
  prefix: string;
  range: vscode.Range;
  classSource: ClassDefinitionSource;
}

type OrmMemberExpressionCandidate = {
  text: string;
  source: 'same_line' | 'structural' | 'top_level';
};

const parsedImportStatementCache = new WeakMap<
  vscode.TextDocument,
  CachedParsedImportStatements
>();
const documentTextCache = new WeakMap<
  vscode.TextDocument,
  { version: number; text: string }
>();

// document.getText() memoized by (document, version). Repeated calls in a
// single provider invocation — especially the context-matcher suite in
// provideCompletionItems — used to copy the full source buffer per call.
// Large Python files (10k+ lines) turn that into real latency on keystroke.
function getDocumentText(document: vscode.TextDocument): string {
  const cached = documentTextCache.get(document);
  if (cached && cached.version === document.version) {
    return cached.text;
  }
  const text = document['getText']();
  documentTextCache.set(document, { version: document.version, text });
  return text;
}

const documentDefinitionsCache = new WeakMap<
  vscode.TextDocument,
  CachedDocumentDefinitions
>();
let allRelationTargetsCache = new WeakMap<
  AnalysisDaemon,
  Promise<RelationTargetsResult>
>();
let staticQuerySetClassSourceCache = new WeakMap<
  AnalysisDaemon,
  Map<string, Promise<ClassDefinitionSource | undefined>>
>();
// Memoizes the (deterministic, expensive) virtual-field extraction for a custom
// QuerySet method, keyed by `${modelLabel}::${methodName}`. A deep self-
// reassignment chain (`x = x.annotate_a().annotate_b()...`) re-resolves the same
// annotate methods on every lookup and every diagnostic pass — without this memo
// the chain walk re-opens the QuerySet document and re-scans each method body
// hundreds of times and blows past the receiver-resolution timeout (observed:
// 11 methods × ~80 passes = 880 redundant class resolutions, 1.5–4s timeouts).
let customMethodVirtualFieldsCache = new WeakMap<
  AnalysisDaemon,
  Map<string, Promise<VirtualOrmField[]>>
>();
// Memoizes the ORM receiver / model label a function RETURNS, keyed by the
// function's source location AND document version
// (`${docUri}::${version}::${functionDef.line}`). A function's return type is
// independent of the call site, so the result is shared across all callers; the
// body analysis (return-expression resolution + return-annotation fallback) for
// a helper like `get_emps -> HrmEmpQuerySet` (generic QuerySet[T_co]) costs
// ~700ms and is otherwise repeated on every chain link / lookup. The cached
// value is the in-flight PROMISE so concurrent callers share one computation
// (NOT a sentinel — that would hand a sibling a spurious `undefined`). Including
// the document version self-invalidates on (even unsaved) edits to the helper.
// Self/mutual recursion is broken via per-stack function-recursion keys threaded
// through `visited` (see resolveOrmReceiverFromFunctionSource), so a re-entrant
// request returns undefined instead of awaiting its own pending promise.
let functionReceiverCache = new WeakMap<
  AnalysisDaemon,
  Map<string, Promise<OrmReceiverInfo | undefined>>
>();
let functionModelLabelCache = new WeakMap<
  AnalysisDaemon,
  Map<string, Promise<string | undefined>>
>();
const FUNCTION_RECURSION_KEY_PREFIX = 'fnrecv:';

interface ClassHoverTarget {
  source: ClassDefinitionSource;
  category: ClassHoverCategory;
  specialKind?: SpecialClassKind;
  referenceText: string;
  fromDefinition: boolean;
}

type TypeHintHoverTarget =
  | {
      kind: 'class';
      source: ClassDefinitionSource;
      category: ClassHoverCategory;
      referenceText: string;
      specialKind?: SpecialClassKind;
    }
  | {
      kind: 'type';
      canonicalName: string;
      category: 'builtin' | 'typing' | 'django';
      referenceText: string;
    };

interface TypeAnnotationSegment {
  start: number;
  end: number;
}

type ParsedCallExpression =
  | { kind: 'function'; functionName: string }
  | { kind: 'member'; objectExpression: string; memberName: string };

interface OrmReceiverInfo {
  kind: OrmReceiverKind;
  modelLabel: string;
  managerName?: string;
  virtualFields?: VirtualOrmField[];
  classSource?: ClassDefinitionSource;
  specialKind?: SpecialClassKind;
  /**
   * Marker for receivers synthesized by the captain P2 phantom fallback —
   * `<PascalCase>.objects` patterns where the daemon's indices have no
   * record of the model. modelLabel is the bare identifier with no
   * namespace, so downstream BG IPC (resolveLookupPath etc.) cannot
   * produce useful results and only wastes budget. Callers should
   * short-circuit those IPCs when this flag is set.
   */
  synthetic?: 'phantom-objects';
}

interface VirtualOrmField {
  name: string;
  detail: string;
  fieldKind: string;
  source: string;
  instanceAvailable: boolean;
  expressionName?: string;
  filePath?: string;
  line?: number;
  column?: number;
}

interface OrmMemberCompletionContext {
  receiverExpression: string;
  prefix: string;
  range: vscode.Range;
  receiver: OrmReceiverInfo;
}

interface OrmMemberAccessContext {
  receiverExpression: string;
  memberName: string;
  receiver: OrmReceiverInfo;
}

// ---------------------------------------------------------------------------
// Lookup inlay hints
// ---------------------------------------------------------------------------

/** Max lookup kwargs we resolve per inlay-hint pass (one viewport). Keeps the
 *  viewport-frequent provider bounded on large files. */
const INLAY_HINT_MAX_CANDIDATES = 60;

/** Matches a Django lookup keyword argument `field__lookup=` (requires at least
 *  one `__` so plain `field=` equality — whose type is obvious — is skipped).
 *  The lookbehind avoids attribute access / longer identifiers; `(?!=)` avoids
 *  `==`. This is only a cheap pre-filter; keywordLookupLiteral validates the
 *  actual queryset call context. */
const INLAY_LOOKUP_KWARG_RE =
  /(?<![.\w])([A-Za-z_]\w*(?:__[A-Za-z_]\w*)+)\s*=(?!=)/g;

function areLookupInlayHintsEnabled(
  scope?: vscode.ConfigurationScope
): boolean {
  return vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION, scope)
    .get<boolean>('inlayHints.enabled', true);
}

interface InlayLookupCandidate {
  /** A position INSIDE the kwarg token, for keywordLookupLiteral. */
  probe: vscode.Position;
  /** End of the kwarg token, where the `: type` hint is anchored. */
  anchor: vscode.Position;
}

function collectInlayLookupCandidates(
  document: vscode.TextDocument,
  range: vscode.Range
): InlayLookupCandidate[] {
  const candidates: InlayLookupCandidate[] = [];
  const endLine = Math.min(range.end.line, document.lineCount - 1);
  for (let line = range.start.line; line <= endLine; line++) {
    const text = document.lineAt(line).text;
    INLAY_LOOKUP_KWARG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLAY_LOOKUP_KWARG_RE.exec(text)) !== null) {
      const token = match[1];
      const startCol = match.index;
      const endCol = startCol + token.length;
      candidates.push({
        probe: new vscode.Position(line, startCol + 1),
        anchor: new vscode.Position(line, endCol),
      });
      if (candidates.length >= INLAY_HINT_MAX_CANDIDATES) {
        return candidates;
      }
    }
  }
  return candidates;
}

/**
 * Type label to show inline for a resolved lookup. For an operator lookup
 * (`field__in=`) the OPERAND type (`list[int]`) is most useful — it is the
 * value the kwarg expects. Falls back to the chain's result type, then to a
 * client-side mapping of the matched field kind, then the related model for a
 * relation terminal.
 */
function inlayTypeLabelForResolution(
  resolution: LookupPathResolution
): string | undefined {
  if (!resolution.resolved || !resolution.target) {
    return undefined;
  }
  const terminalType = resolution.terminalType;
  if (terminalType) {
    if (terminalType.lookupOperator && terminalType.operandPythonType) {
      return terminalType.operandPythonType;
    }
    return terminalType.pythonType;
  }
  const target = resolution.target;
  if (target.isRelation) {
    return target.relatedModelLabel
      ? shortModelLabelName(target.relatedModelLabel)
      : undefined;
  }
  if (target.pythonType) {
    return target.pythonType;
  }
  if (
    target.fieldKind &&
    target.fieldKind !== 'lookup_operator' &&
    target.fieldKind !== 'lookup_transform'
  ) {
    return pythonTypeForKind(target.fieldKind);
  }
  return undefined;
}

function shortModelLabelName(modelLabel: string): string {
  const dot = modelLabel.lastIndexOf('.');
  return dot >= 0 ? modelLabel.slice(dot + 1) : modelLabel;
}

export function registerPythonProviders(
  daemon: AnalysisDaemon
): vscode.Disposable[] {
  const pythonSelector = buildPythonSelector();
  const diagnosticCollection = vscode.languages.createDiagnosticCollection(
    'djangoOrmIntellisense.orm'
  );
  const diagnosticsEnabled = areOrmDiagnosticsEnabled();
  const canRunDiagnostics = (): boolean =>
    diagnosticsEnabled && daemon.isReady();
  let providersDisposed = false;
  let diagnosticsDisposed = false;
  let activeCompletionCount = 0;
  // Disposal signal: rejects when providers are disposed, used with Promise.race
  // to immediately abort in-flight hover/completion/definition/signature calls.
  let fireDisposalSignal: (() => void) | undefined;
  const disposalSignal = new Promise<never>((_, reject) => {
    fireDisposalSignal = () => reject(new Error('providers disposed'));
  });
  // Suppress unhandled rejection from the signal promise itself
  disposalSignal.catch(() => {});
  const diagnosticTimers = new Map<string, NodeJS.Timeout>();
  const lastDiagnosedDocumentVersions = new Map<string, number>();
  /** Tracks partial diagnostic results from budget-exhausted scans so the
   *  next scan of the same version can reuse them instead of restarting. */
  const partialDiagnosticResults = new Map<string, {
    version: number;
    diagnostics: vscode.Diagnostic[];
    seenRanges: Set<string>;
    budgetExhausted: boolean;
  }>();
  const activeDiagnosticScans = new Set<string>();
  let fullDiagnosticsRefreshTimer: NodeJS.Timeout | undefined;

  const isVisibleDocument = (document: vscode.TextDocument): boolean =>
    vscode.window.visibleTextEditors.some(
      (editor) => editor.document.uri.toString() === document.uri.toString()
    );

  const clearScheduledDiagnostics = (): void => {
    if (fullDiagnosticsRefreshTimer) {
      clearTimeout(fullDiagnosticsRefreshTimer);
      fullDiagnosticsRefreshTimer = undefined;
    }

    for (const timer of diagnosticTimers.values()) {
      clearTimeout(timer);
    }
    diagnosticTimers.clear();
  };

  const COMPLETION_DIAGNOSTIC_DEFER_MS = 3_000;
  const scheduleDiagnosticsRefresh = (
    document: vscode.TextDocument,
    delayMs = 200,
    reason = 'unknown'
  ): void => {
    if (!canRunDiagnostics()) {
      return;
    }
    if (!shouldAnalyzeDocument(document, daemon.getState().workspaceRoot)) {
      // Do NOT log here: this branch fires for every output-channel/log
      // document edit, which itself happens for every log line — creating
      // a feedback loop that floods the log with skip messages.
      return;
    }
    const shortPath = document.uri.fsPath.split('/').slice(-2).join('/');

    // Defer diagnostics while completions are in-flight to avoid flooding
    // the event loop with concurrent IPC calls and redundant scans.
    const originalDelay = delayMs;
    let deferred = false;
    if (activeCompletionCount > 0) {
      delayMs = Math.max(delayMs, COMPLETION_DIAGNOSTIC_DEFER_MS);
      deferred = delayMs !== originalDelay;
    }

    const key = document.uri.toString();
    if (lastDiagnosedDocumentVersions.get(key) === document.version) {
      daemon.logDiagnostic(`[diagnostics:trigger] skip reason=${reason} cause=same-version v=${document.version} ${shortPath}`);
      return;
    }

    const existingTimer = diagnosticTimers.get(key);
    const coalesced = existingTimer != null;
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    daemon.logDiagnostic(
      `[diagnostics:trigger] schedule reason=${reason} v=${document.version} delay=${delayMs}ms`
      + `${deferred ? ` (deferred-from=${originalDelay}ms completionsInflight=${activeCompletionCount})` : ''}`
      + `${coalesced ? ' coalesced=1' : ''}`
      + ` ${shortPath}`
    );

    const timer = setTimeout(() => {
      diagnosticTimers.delete(key);
      void refreshDiagnostics(document, reason);
    }, delayMs);
    diagnosticTimers.set(key, timer);
  };

  const collectDiagnosticRefreshDocuments = (): vscode.TextDocument[] => {
    const documents = new Map<string, vscode.TextDocument>();

    for (const editor of vscode.window.visibleTextEditors) {
      documents.set(editor.document.uri.toString(), editor.document);
    }

    return [...documents.values()];
  };

  const refreshTrackedDiagnostics = (): void => {
    if (diagnosticsDisposed) {
      return;
    }
    if (!canRunDiagnostics()) {
      return;
    }
    // Stagger diagnostic refreshes across visible documents to avoid
    // flooding the event loop with concurrent IPC calls.
    let staggerDelay = 0;
    const STAGGER_INCREMENT_MS = 200;
    for (const document of collectDiagnosticRefreshDocuments()) {
      if (!shouldAnalyzeDocument(document, daemon.getState().workspaceRoot)) {
        if (!diagnosticsDisposed) {
          diagnosticCollection.delete(document.uri);
        }
        continue;
      }

      // Do not overwrite an existing per-document timer (e.g. from an edit
      // debounce) — the edit-triggered timer is more specific and should
      // take priority over the blanket tracked refresh.
      const docKey = document.uri.toString();
      if (diagnosticTimers.has(docKey) || activeDiagnosticScans.has(docKey)) {
        continue;
      }

      scheduleDiagnosticsRefresh(document, staggerDelay, 'tracked-refresh');
      staggerDelay += STAGGER_INCREMENT_MS;
    }
  };

  const scheduleTrackedDiagnosticsRefresh = (
    delayMs = INITIAL_DIAGNOSTIC_REFRESH_DELAY_MS
  ): void => {
    if (fullDiagnosticsRefreshTimer) {
      clearTimeout(fullDiagnosticsRefreshTimer);
    }

    fullDiagnosticsRefreshTimer = setTimeout(() => {
      fullDiagnosticsRefreshTimer = undefined;
      refreshTrackedDiagnostics();
    }, delayMs);
  };

  const refreshDiagnostics = async (
    document: vscode.TextDocument,
    triggerReason = 'unknown'
  ): Promise<void> => daemon.withDeadline(performance.now() + diagnosticTimeBudgetMs(), () =>
  daemon.withRequestSource('diagnostic', async () => {
    activeDiagnosticScanRunningCount++;
    try {
    if (diagnosticsDisposed) {
      return;
    }
    if (!canRunDiagnostics()) {
      return;
    }
    const key = document.uri.toString();
    const shortPath = document.uri.fsPath.split('/').slice(-2).join('/');

    // Prevent overlapping scans of the same document from concurrent triggers
    if (activeDiagnosticScans.has(key)) {
      daemon.logDiagnostic(`[diagnostics:trigger] skip reason=${triggerReason} cause=active-scan ${shortPath}`);
      return;
    }

    const documentVersion = document.version;
    if (lastDiagnosedDocumentVersions.get(key) === documentVersion) {
      daemon.logDiagnostic(`[diagnostics:trigger] skip reason=${triggerReason} cause=same-version-at-fire v=${documentVersion} ${shortPath}`);
      return;
    }

    daemon.logDiagnostic(`[diagnostics:trigger] fire reason=${triggerReason} v=${documentVersion} ${shortPath}`);

    if (!shouldAnalyzeDocument(document, daemon.getState().workspaceRoot)) {
      if (!diagnosticsDisposed) {
        diagnosticCollection.delete(document.uri);
      }
      lastDiagnosedDocumentVersions.delete(key);
      return;
    }

    activeDiagnosticScans.add(key);
    try {
      await daemon.ensureStarted(document.uri);
    } catch {
      activeDiagnosticScans.delete(key);
      if (!diagnosticsDisposed) {
        diagnosticCollection.delete(document.uri);
      }
      return;
    }

    // Yield to the event loop before starting the synchronous document scan.
    // This ensures hover/definition/completion requests that arrived first
    // can be processed without being blocked by diagnostic scanning.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (diagnosticsDisposed || document.version !== documentVersion) {
      activeDiagnosticScans.delete(key);
      return;
    }

    // Restore partial results from a previous budget-exhausted scan of the
    // same document version, so we start with existing diagnostics instead
    // of re-resolving from scratch.
    const priorPartial = partialDiagnosticResults.get(key);
    const diagnostics: vscode.Diagnostic[] =
      priorPartial?.version === documentVersion ? [...priorPartial.diagnostics] : [];
    const seenRanges: Set<string> =
      priorPartial?.version === documentVersion ? new Set(priorPartial.seenRanges) : new Set();
    const diagnosticStartTime = Date.now();
    let diagnosticRequestCount = 0;
    let diagnosticBudgetLogged = false;
    let diagnosticPhase = 'setup';
    // Per-cycle perf counters. Logged as a `[diagnostics:perf]` summary
    // right before publish so captain-style trace analysis can see at a
    // glance where time/IPC/cache pressure went.
    let perfReceiverCacheHit = 0;
    let perfReceiverCacheMiss = 0;
    let perfReceiverCacheStaleInvalidated = 0;
    let perfLookupPathCacheHit = 0;
    let perfLookupPathCacheMiss = 0;
    let perfScanCacheHit = 0;
    let perfScanCacheMiss = 0;
    let perfReceiverIpcMs = 0;
    let perfLookupPathIpcMs = 0;
    // captain 옵션 3 관측 — phase 단위로 timeout 발동 횟수를 세서
    // [diagnostics:perf] 라인에 노출. captain 의 9.5s 폭주가 정말 차단됐는지,
    // 또 1.5s cap 이 너무 공격적이라 false-negative 가 많아졌는지 측정 가능.
    let perfReceiverTimeoutCount = 0;
    // Captain receiver-chain analysis: snapshot IPC stats at cycle start so
    // the perf summary can show a per-cycle delta by IPC method (which
    // resolveX call dominated the receiver-resolution time).
    const perfIpcBaseline = daemon.snapshotIpcStats();
    // Slow-receiver threshold: when an individual receiver resolution
    // takes longer than this, log its expression so trace analysis can
    // identify the offender. captain showed individual receivers at 4s+.
    const PERF_SLOW_RECEIVER_MS = 500;
    // captain regression (log.txt:374) — a single `company_user_relation_qs`
    // receiver took 7466ms, consuming most of the 10s diagnostic budget and
    // leaving 17 other receivers to fail with `cancelled-before-batch`. Per-
    // receiver Promise.race timeout so one runaway expression doesn't take
    // down the whole phase. Tunable via env var for incident response.
    const PER_RECEIVER_TIMEOUT_MS = Number(
      process.env.DJLS_RECEIVER_TRACE_TIMEOUT_MS ?? 1500
    ) || 1500;
    const beginDiagnosticPhase = (phase: string): number => {
      diagnosticPhase = phase;
      return performance.now();
    };
    const logDiagnosticPhase = (
      phase: string,
      startedAt: number,
      detail = ''
    ): void => {
      const phaseMs = performance.now() - startedAt;
      const totalMs = Date.now() - diagnosticStartTime;
      daemon.logDiagnostic(
        `[diagnostics:phase] ${phase} ${phaseMs.toFixed(0)}ms total=${totalMs}ms requests=${diagnosticRequestCount}${detail ? ` ${detail}` : ''}`
      );
    };
    // captain 옵션 3-a — phase 가 cancel-before-batch 로 일찍 끝날 때도
    // perf summary 가 동일하게 emit 되도록 헬퍼화. 정상 publish 와 같은
    // 포맷으로 emit 해야 recv-timeout / ipc-by-method 등 카운터가 그 cycle
    // 에서도 노출됨. captain 의 9171ms cap 우회 진단이 가능해짐.
    const emitPerfSummary = (): void => {
      const receiverCacheTotal = perfReceiverCacheHit + perfReceiverCacheMiss;
      const lookupCacheTotal = perfLookupPathCacheHit + perfLookupPathCacheMiss;
      const scanCacheTotal = perfScanCacheHit + perfScanCacheMiss;
      const cycleWallMs = Date.now() - diagnosticStartTime;
      const ipcDelta = daemon.diffIpcStats(perfIpcBaseline);
      const ipcBreakdown = ipcDelta.length === 0
        ? 'none'
        : ipcDelta
            .map((e) => `${e.method}=${e.count}/${e.totalMs.toFixed(0)}ms`)
            .join(',');
      daemon.logDiagnostic(
        `[diagnostics:perf] wall=${cycleWallMs}ms ` +
        `recv-cache=${perfReceiverCacheHit}/${receiverCacheTotal} ` +
        `recv-stale-invalidate=${perfReceiverCacheStaleInvalidated} ` +
        `recv-timeout=${perfReceiverTimeoutCount}/${PER_RECEIVER_TIMEOUT_MS}ms ` +
        `lookup-cache=${perfLookupPathCacheHit}/${lookupCacheTotal} ` +
        `scan-cache=${perfScanCacheHit}/${scanCacheTotal} ` +
        `recv-ipc-ms=${perfReceiverIpcMs.toFixed(0)} ` +
        `lookup-ipc-ms=${perfLookupPathIpcMs.toFixed(0)} ` +
        `requests=${diagnosticRequestCount} ` +
        `partial=${diagnosticBudgetLogged} ` +
        `ipc-by-method=[${ipcBreakdown}]`
      );
    };
    const isDiagnosticsCancelled = () => {
      if (diagnosticsDisposed || document.version !== documentVersion) {
        return true;
      }
      const elapsed = Date.now() - diagnosticStartTime;
      const budgetMs = diagnosticTimeBudgetMs();
      if (elapsed > budgetMs) {
        if (!diagnosticBudgetLogged) {
          diagnosticBudgetLogged = true;
          daemon.logDiagnostic(
            `[diagnostics] time budget exhausted (${elapsed}ms > ${budgetMs}ms, ${diagnosticRequestCount} requests, phase=${diagnosticPhase}) for ${document.uri.fsPath}`
          );
        }
        return true;
      }
      if (diagnosticRequestCount >= DIAGNOSTIC_REQUEST_BUDGET) {
        if (!diagnosticBudgetLogged) {
          diagnosticBudgetLogged = true;
          daemon.logDiagnostic(
            `[diagnostics] request budget exhausted (${diagnosticRequestCount}/${DIAGNOSTIC_REQUEST_BUDGET}, phase=${diagnosticPhase}) for ${document.uri.fsPath}`
          );
        }
        return true;
      }
      return false;
    };
    const trackRequest = (): void => { diagnosticRequestCount++; };

    // Determine visible range for prioritized scanning on large files
    const VISIBLE_RANGE_SCAN_THRESHOLD = 500; // lines
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === document.uri.toString()
    );
    const visibleRange = visibleEditor?.visibleRanges[0];
    const useVisibleRangeScan = document.lineCount >= VISIBLE_RANGE_SCAN_THRESHOLD && visibleRange != null;
    const allowFullDocumentDiagnostics =
      getExtensionSettings(document.uri).diagnosticsFullDocument;
    // Expand visible range by a margin to catch surrounding context.
    // Snap boundaries to a coarse grid so small visible-range drifts (a
    // few-line scroll or editor resize) produce identical scan cache keys.
    // Captain regression A: Cycle 1 scanned 143–290 and Cycle 2 scanned
    // 140–287 for the same document version, wasting ~1.5s rescanning.
    const VISIBLE_MARGIN = 50;
    const VISIBLE_RANGE_GRID = 50;
    const snapStart = (line: number): number =>
      Math.max(0, Math.floor(line / VISIBLE_RANGE_GRID) * VISIBLE_RANGE_GRID);
    const snapEnd = (line: number): number =>
      Math.min(
        document.lineCount,
        Math.ceil(line / VISIBLE_RANGE_GRID) * VISIBLE_RANGE_GRID,
      );
    const visStartLine = useVisibleRangeScan
      ? snapStart(visibleRange!.start.line - VISIBLE_MARGIN)
      : 0;
    const visEndLine = useVisibleRangeScan
      ? snapEnd(visibleRange!.end.line + VISIBLE_MARGIN)
      : document.lineCount;

    daemon.logDiagnostic(`[diagnostics:scan] starting sync scan for ${document.uri.fsPath.split('/').slice(-2).join('/')}${useVisibleRangeScan ? ` (visible-first: lines ${visStartLine}-${visEndLine})` : ''}`);
    const _scanStart = beginDiagnosticPhase('scan-visible');

    // Phase 1: scan visible range (or full doc for small files)
    const _scanCache = getScanCacheEntry(document);
    let _relationContexts: RelationDiagnosticContext[];
    let _lookupContexts: LookupDiagnosticContext[];
    let _visScanCacheHit = false;
    if (intervalsCover(_scanCache.scanned, visStartLine, visEndLine)) {
      _relationContexts = _scanCache.relations.filter((c) =>
        c.range.start.line >= visStartLine && c.range.start.line < visEndLine,
      );
      _lookupContexts = _scanCache.lookups.filter((c) =>
        c.range.start.line >= visStartLine && c.range.start.line < visEndLine,
      );
      _visScanCacheHit = true;
      perfScanCacheHit++;
    } else {
      perfScanCacheMiss++;
      _relationContexts = findRelationDiagnosticContexts(document, visStartLine, visEndLine);
      _lookupContexts = await findLookupDiagnosticContexts(document, isDiagnosticsCancelled, visStartLine, visEndLine, daemon);
      _scanCache.relations.push(..._relationContexts);
      _scanCache.lookups.push(..._lookupContexts);
      intervalsAdd(_scanCache.scanned, visStartLine, visEndLine);
    }
    daemon.logDiagnostic(`[diagnostics:scan] complete ${(performance.now() - _scanStart).toFixed(0)}ms relations=${_relationContexts.length} lookups=${_lookupContexts.length} cache=${_visScanCacheHit ? 'hit' : 'miss'}`);
    logDiagnosticPhase('scan-visible', _scanStart, `relations=${_relationContexts.length} lookups=${_lookupContexts.length} cache=${_visScanCacheHit ? 'hit' : 'miss'}`);

    // Deduplicate relation target resolution within a single scan.
    // The same model string (e.g. "User") may appear in many ForeignKey
    // declarations — resolve each unique value only once.
    const _relationResolveStart = beginDiagnosticPhase('relations-visible');
    let _relationDiagnosticsAdded = 0;
    const _relationResolutionCache = new Map<string, RelationTargetResolution>();
    for (const context of _relationContexts) {
      if (isDiagnosticsCancelled()) break;
      try {
        let resolution = _relationResolutionCache.get(context.value);
        if (!resolution) {
          resolution = await daemon.resolveRelationTarget(context.value, /* background */ true);
          _relationResolutionCache.set(context.value, resolution);
        }
        trackRequest();
        if (isDiagnosticsCancelled()) break;
        const diagnostic = buildRelationDiagnostic(context, resolution);
        if (!diagnostic) {
          continue;
        }

        const key = diagnostic.range.start.toString() + diagnostic.message;
        if (seenRanges.has(key)) {
          continue;
        }
        seenRanges.add(key);
        diagnostics.push(diagnostic);
        _relationDiagnosticsAdded++;
      } catch {
        continue;
      }
    }
    logDiagnosticPhase(
      'relations-visible',
      _relationResolveStart,
      `contexts=${_relationContexts.length} unique=${_relationResolutionCache.size} added=${_relationDiagnosticsAdded}`
    );

    // Pass 1: Resolve receivers and collect items needing daemon lookup
    const _lookupPending: Array<{
      context: LookupDiagnosticContext;
      receiver: OrmReceiverInfo;
      baseModelLabel: string;
      batchIdx: number;
    }> = [];
    const _batchItems: Array<{ baseModelLabel: string; value: string; method: string }> = [];
    const _receiverCache = getReceiverCacheForDocument(document);
    const _lookupResolutionCache = getLookupResolutionCacheForDocument(document);
    const resolveCachedLookupReceiverInfo = async (
      context: LookupDiagnosticContext
    ): Promise<OrmReceiverInfo | null> => {
      const receiverCacheKey = context.receiverExpression;
      const cached = _receiverCache.get(receiverCacheKey);
      if (cached) {
        const cachedResult = await cached;
        if (cachedResult !== null) {
          perfReceiverCacheHit++;
          return cachedResult;
        }
        // Stale-null check (captain regression D): the write-time guard only
        // invalidates when the root is already known at resolution. If the
        // surface delta arrives AFTER the resolution completes, the null
        // pins indefinitely and subsequent cycles return it. Re-check at
        // read time: if the root identifier is now a known model, drop the
        // entry and fall through to a fresh resolution.
        const normalized = normalizeReceiverExpression(
          context.receiverExpression || ''
        ) || (context.receiverExpression || '');
        const rootIdentifier = receiverRootIdentifier(normalized);
        const rootIsKnownNow = !!rootIdentifier && (
          daemon.hasModelByShortName(rootIdentifier) ||
          snakeToPascalCaseVariants(rootIdentifier).some((variant) =>
            daemon.hasModelByShortName(variant)
          )
        );
        if (!rootIsKnownNow) {
          return null;
        }
        _receiverCache.delete(receiverCacheKey);
        perfReceiverCacheStaleInvalidated++;
        // Fall through to the fresh-resolution path below.
      }

      perfReceiverCacheMiss++;
      const _perfReceiverIpcStart = performance.now();
      let request!: Promise<OrmReceiverInfo | null>;
      // captain regression — race the resolver against a per-receiver
      // timeout. Single runaway expressions (e.g. `company_user_relation_qs`
      // at 7.5s) used to pre-empt the entire diagnostic phase budget;
      // timeout returns null (≈unknown_root) so the next receiver can run.
      // captain 옵션 3 관측 — 어떤 receiver 처리 중 timeout 이 발동했는지
      // 분석할 수 있도록 file path / 라인 번호도 함께 emit. timeout fire 시
      // perfReceiverTimeoutCount 증가 → phase summary 에 합산 노출.
      const fileRel = (() => {
        const fsPath = document.uri.fsPath;
        return fsPath.length > 60 ? '...' + fsPath.slice(-57) : fsPath;
      })();
      const linePos = context.range.end.line + 1;
      const tracedResolve = (async (): Promise<OrmReceiverInfo | null> => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const timeoutPromise = new Promise<OrmReceiverInfo | null>(
          (resolve) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              perfReceiverTimeoutCount++;
              const expr = (context.receiverExpression || '')
                .replace(/\s+/g, ' ')
                .trim();
              const exprTruncated =
                expr.length > 100 ? expr.slice(0, 97) + '...' : expr;
              daemon.logDiagnostic(
                `[receiver-trace:timeout] elapsed=${PER_RECEIVER_TIMEOUT_MS}ms ` +
                `cap=${PER_RECEIVER_TIMEOUT_MS}ms ` +
                `file=${fileRel}:${linePos} ` +
                `expr=${JSON.stringify(exprTruncated)}`
              );
              resolve(null);
            }, PER_RECEIVER_TIMEOUT_MS);
          }
        );
        // captain #1 — receiver tracer 안에서도 deadline 인지하도록 Date.now()
        // 기반 deadline 전달. Promise.race 의 setTimeout 이 event loop 점유로
        // 늦게 fire 해도 receiver tracer 가 cooperative 하게 자체 cancel.
        const deadlineMs = Date.now() + PER_RECEIVER_TIMEOUT_MS;
        try {
          const raced = await Promise.race([
            resolveLookupReceiverInfoForReceiver(
              daemon,
              document,
              context.receiverExpression,
              context.range.end,
              deadlineMs,
            ),
            timeoutPromise,
          ]);
          // captain 관측: timeout 이 우승했더라도 underlying 이 늦게 끝났는지
          // background 에서 elapsed 를 측정해두면 cap 값 조정 근거가 됨.
          // (await Promise.race 가 끝났는데도 underlying 이 계속 돌면 무관한
          // background task — 결과 무시 OK).
          if (timedOut) {
            return null;
          }
          return raced ?? null;
        } finally {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
        }
      })();
      request = tracedResolve
        .then((receiver) => {
          const elapsed = performance.now() - _perfReceiverIpcStart;
          perfReceiverIpcMs += elapsed;
          if (elapsed > PERF_SLOW_RECEIVER_MS) {
            const expr = (context.receiverExpression || '').replace(/\s+/g, ' ').trim();
            const exprTruncated = expr.length > 100 ? expr.slice(0, 97) + '...' : expr;
            daemon.logDiagnostic(
              `[receiver-trace:slow] elapsed=${elapsed.toFixed(0)}ms resolved=${receiver != null} expr=${JSON.stringify(exprTruncated)}`
            );
          }
          const result = receiver ?? null;
          // Don't pin a stale `null` when the root identifier is a known
          // model (directly, or via the snake→PascalCase fuzzy variants).
          // The failure was likely a transient resolver state (daemon
          // mid-initialize, surface index still warming, BG cache miss),
          // and a later cycle may succeed. Permanent unresolvables
          // (unknown root, parser-polluted expressions) still get cached
          // because their root won't ever match a model name.
          if (result === null) {
            const rootIdentifier = receiverRootIdentifier(
              context.receiverExpression || ''
            );
            if (rootIdentifier) {
              const rootIsKnownModel =
                daemon.hasModelByShortName(rootIdentifier) ||
                snakeToPascalCaseVariants(rootIdentifier).some((variant) =>
                  daemon.hasModelByShortName(variant)
                );
              if (rootIsKnownModel && _receiverCache.get(receiverCacheKey) === request) {
                _receiverCache.delete(receiverCacheKey);
              }
            }
          }
          return result;
        })
        .catch((error) => {
          if (_receiverCache.get(receiverCacheKey) === request) {
            _receiverCache.delete(receiverCacheKey);
          }
          throw error;
        });
      _receiverCache.set(receiverCacheKey, request);
      trackRequest();
      return request;
    };
    const resolveCachedDiagnosticLookupPath = (
      baseModelLabel: string,
      value: string,
      method: string
    ): Promise<LookupPathResolution> => {
      const resolutionCacheKey = `${baseModelLabel}\u0000${method}\u0000${value}`;
      const cached = _lookupResolutionCache.get(resolutionCacheKey);
      if (cached) {
        perfLookupPathCacheHit++;
        return cached;
      }

      perfLookupPathCacheMiss++;
      const _perfLookupIpcStart = performance.now();
      let request!: Promise<LookupPathResolution>;
      request = daemon.resolveLookupPath(baseModelLabel, value, method, true)
        .then((resolution) => {
          perfLookupPathIpcMs += performance.now() - _perfLookupIpcStart;
          return resolution;
        })
        .catch((error) => {
          perfLookupPathIpcMs += performance.now() - _perfLookupIpcStart;
          if (_lookupResolutionCache.get(resolutionCacheKey) === request) {
            _lookupResolutionCache.delete(resolutionCacheKey);
          }
          throw error;
        });
      _lookupResolutionCache.set(resolutionCacheKey, request);
      trackRequest();
      return request;
    };
    const addDiagnosticIfNew = (diagnostic: vscode.Diagnostic | undefined): boolean => {
      if (!diagnostic) {
        return false;
      }
      const key = diagnostic.range.start.toString() + diagnostic.message;
      if (seenRanges.has(key)) {
        return false;
      }
      seenRanges.add(key);
      diagnostics.push(diagnostic);
      return true;
    };
    // Pre-validate all lookup contexts in batches, yielding between
    // batches to avoid blocking the event loop.
    const _validationStart = beginDiagnosticPhase('validate-lookups-visible');
    const _docTextForValidation = getDocumentText(document);
    const VALIDATION_BATCH_SIZE = 15;
    const _validatedLookupContexts: LookupDiagnosticContext[] = [];
    for (let batchStart = 0; batchStart < _lookupContexts.length; batchStart += VALIDATION_BATCH_SIZE) {
      if (isDiagnosticsCancelled()) break;
      if (batchStart > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (isDiagnosticsCancelled()) break;
      }
      const batch = _lookupContexts.slice(batchStart, batchStart + VALIDATION_BATCH_SIZE);
      _validatedLookupContexts.push(...validateLookupContexts(batch, _docTextForValidation, isDiagnosticsCancelled));
    }
    logDiagnosticPhase(
      'validate-lookups-visible',
      _validationStart,
      `input=${_lookupContexts.length} valid=${_validatedLookupContexts.length}`
    );

    const _receiverResolveStart = beginDiagnosticPhase('receivers-visible');
    let _receiverMisses = 0;
    let _virtualResolved = 0;
    const _receiverMissSamples = new Set<string>();
    const _receiverMissReasonCounts = new Map<string, number>();
    const VISIBLE_NO_RECV_SAMPLE_LIMIT = 5;
    // 옵션 3-c — receiver 추적을 phase 안에서 병렬 처리. 시리얼 await loop 은
    // captain user/app_user.py:141 처럼 6 slow × 1500ms cap = 9s 누적으로 phase
    // budget 소진. Promise.all 로 동시에 시작하면 worst-case = max(cap, fast) =
    // 1500ms 한 번. daemon BG fallback worker 가 inflight 18개 동시 처리 부하는
    // 짧고, captain 측에서 이미 inflight=6/peak=7 관찰 — 안전 범위.
    const _receiverResolutions = await Promise.all(
      _validatedLookupContexts.map(async (context) => {
        if (isDiagnosticsCancelled()) {
          return { context, receiver: null as OrmReceiverInfo | null };
        }
        try {
          const receiver = await resolveCachedLookupReceiverInfo(context);
          return { context, receiver };
        } catch {
          return { context, receiver: null as OrmReceiverInfo | null };
        }
      }),
    );
    // 결과 처리는 시리얼 (cache effect / sample collection 일관성 유지). 동시
    // 시작 → 동기 후처리 패턴.
    for (const { context, receiver: lookupReceiver } of _receiverResolutions) {
      if (isDiagnosticsCancelled()) break;
      if (!lookupReceiver) {
        _receiverMisses++;
        const reason = classifyNoRecvReason(daemon, context.receiverExpression || '');
        _receiverMissReasonCounts.set(reason, (_receiverMissReasonCounts.get(reason) ?? 0) + 1);
        if (_receiverMissSamples.size < VISIBLE_NO_RECV_SAMPLE_LIMIT) {
          const raw = (context.receiverExpression || '').replace(/\s+/g, ' ').trim();
          if (raw) {
            const truncated = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
            _receiverMissSamples.add(`${truncated}#${reason}`);
          }
        }
        continue;
      }

      const virtualRes = resolveVirtualLookupPath(lookupReceiver, context.value, context.method);
      if (virtualRes?.resolved) {
        // Virtual lookup resolved successfully — skip daemon
        _virtualResolved++;
        continue;
      }
      // Phantom receiver short-circuit: same rationale as the phase2
      // branch — synthesizing a manager with a bare PascalCase label
      // means the daemon has no record of the model. Calling
      // resolveLookupPath wastes hundreds of ms per call.
      if (lookupReceiver.synthetic === 'phantom-objects') {
        continue;
      }
      // virtualRes is null or { resolved: false } — need daemon resolution

      _lookupPending.push({
        context, receiver: lookupReceiver,
        baseModelLabel: lookupReceiver.modelLabel,
        batchIdx: _batchItems.length,
      });
      _batchItems.push({
        baseModelLabel: lookupReceiver.modelLabel,
        value: context.value,
        method: context.method,
      });
    }
    const _visibleNoRecvReasonsPart = _receiverMissReasonCounts.size > 0
      ? ` noRecvReasons=${[..._receiverMissReasonCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => `${reason}:${count}`)
          .join(',')}`
      : '';
    const _visibleNoRecvSamplesPart = _receiverMissSamples.size > 0
      ? ` noRecvSamples=[${[..._receiverMissSamples].map((s) => `"${s}"`).join(',')}]`
      : '';
    logDiagnosticPhase(
      'receivers-visible',
      _receiverResolveStart,
      `validated=${_validatedLookupContexts.length} pending=${_lookupPending.length} batchItems=${_batchItems.length} receivers=${_receiverCache.size} missing=${_receiverMisses} virtual=${_virtualResolved}`
      + _visibleNoRecvReasonsPart
      + _visibleNoRecvSamplesPart
    );

    // Pass 2: Batch resolve lookup paths
    if (isDiagnosticsCancelled()) {
      // captain 옵션 3-a — cancel 직전에도 perf summary 를 emit 해서 cap 발동
      // 카운터가 노출되도록. captain log.txt:144 의 `cancelled-before-batch`
      // 직후 [diagnostics:perf] 가 없어서 9171ms cap 우회 측정이 불가능했음.
      emitPerfSummary();
      logDiagnosticPhase('cancelled-before-batch', performance.now(), `diagnostics=${diagnostics.length}`);
      // If the cancellation was caused by budget exhaustion (not by disposal
      // or version change), mark the version so tracked-refresh storms do not
      // keep retrying the same heavy scan. Disposal/version-change paths are
      // intentionally left unmarked so the next valid refresh can run.
      if (diagnosticBudgetLogged && !diagnosticsDisposed && document.version === documentVersion) {
        partialDiagnosticResults.set(key, {
          version: documentVersion,
          diagnostics: [...diagnostics],
          seenRanges: new Set(seenRanges),
          budgetExhausted: true,
        });
        lastDiagnosedDocumentVersions.set(key, documentVersion);
      }
      // Clear active-scan even on disposal/version-change so subsequent
      // tracked-refresh triggers are not silently dropped.
      activeDiagnosticScans.delete(key);
      return;
    }
    const _batchResolveStart = beginDiagnosticPhase('batch-lookups-visible');
    let _batchRes: import('../protocol').LookupPathResolution[] | undefined;
    let _batchMode = 'below-threshold';
    // Only use batch when there are enough items to justify the overhead,
    // and batch size is manageable for the daemon's single-threaded processing.
    // Batch only when enough items exist — small files use individual calls
    // which return results incrementally (important for waitForDiagnostics timeout)
    const BATCH_THRESHOLD = 50;
    if (_batchItems.length >= BATCH_THRESHOLD) {
      _batchMode = 'fallback';
      try {
        _batchRes = await daemon.resolveLookupPathBatch(_batchItems);
        trackRequest();
        if (!Array.isArray(_batchRes) || _batchRes.length !== _batchItems.length) {
          _batchRes = undefined;
        }
        if (_batchRes) {
          for (const [index, item] of _batchItems.entries()) {
            const resolutionCacheKey = `${item.baseModelLabel}\u0000${item.method}\u0000${item.value}`;
            _lookupResolutionCache.set(
              resolutionCacheKey,
              Promise.resolve(_batchRes[index])
            );
          }
          _batchMode = 'batch';
        }
      } catch {
        // fall back to individual
        _batchMode = 'error-fallback';
      }
    }
    logDiagnosticPhase(
      'batch-lookups-visible',
      _batchResolveStart,
      `items=${_batchItems.length} threshold=${BATCH_THRESHOLD} mode=${_batchMode}`
    );

    // Pass 3: Build diagnostics
    const _buildLookupStart = beginDiagnosticPhase('build-lookups-visible');
    const _lookupDiagnosticsBefore = diagnostics.length;
    await runWithConcurrency(_lookupPending, DIAGNOSTIC_LOOKUP_PARALLELISM, isDiagnosticsCancelled, async ({
      context,
      receiver,
      baseModelLabel,
      batchIdx,
    }) => {
      if (isDiagnosticsCancelled()) return;
      try {
        let resolution = _batchRes?.[batchIdx];
        if (!resolution) {
          resolution = await resolveCachedDiagnosticLookupPath(
            baseModelLabel,
            context.value,
            context.method
          );
        }
        if (isDiagnosticsCancelled()) return;
        if (!resolution.resolved && resolution.reason !== 'relation_required') {
          const partialCompletions = {
            items: mergeLookupCompletionItems(
              (await listLookupPathCompletionsFast(
                daemon,
                baseModelLabel,
                context.value,
                context.method,
                false
              )).items,
              virtualLookupCompletionItems(receiver, context.value, context.method)
            ),
            resolved: true,
          };
          if (
            hasSuppressingPartialLookupCompletion(
              context.value,
              partialCompletions.items
            )
          ) return;
        }
        const diagnostic = buildLookupDiagnostic(context, baseModelLabel, resolution);
        addDiagnosticIfNew(diagnostic);
      } catch {
        return;
      }
    });
    logDiagnosticPhase(
      'build-lookups-visible',
      _buildLookupStart,
      `pending=${_lookupPending.length} added=${diagnostics.length - _lookupDiagnosticsBefore} cache=${_lookupResolutionCache.size}`
    );

    // Phase 2: If we used visible-range scanning, publish partial results
    // immediately for responsiveness, then scan the remaining lines.
    if (
      useVisibleRangeScan &&
      allowFullDocumentDiagnostics &&
      !isDiagnosticsCancelled()
    ) {
      const _phase2Start = beginDiagnosticPhase('phase2-remaining');
      const _phase2DiagnosticsBefore = diagnostics.length;
      if (!diagnosticsDisposed && document.version === documentVersion) {
        diagnosticCollection.set(document.uri, [...diagnostics]);
      }

      // Incrementally publish diagnostics every N new items so the user
      // sees results trickle in rather than waiting for the full scan.
      const INCREMENTAL_PUBLISH_INTERVAL = 50;
      let phase2NewDiagCount = 0;
      const incrementalPublish = () => {
        phase2NewDiagCount++;
        if (phase2NewDiagCount % INCREMENTAL_PUBLISH_INTERVAL === 0) {
          if (!diagnosticsDisposed && document.version === documentVersion) {
            diagnosticCollection.set(document.uri, [...diagnostics]);
          }
        }
      };

      // Scan remaining lines (before and after visible range)
      const remainingRanges: Array<[number, number]> = [];
      if (visStartLine > 0) remainingRanges.push([0, visStartLine]);
      if (visEndLine < document.lineCount) remainingRanges.push([visEndLine, document.lineCount]);

      for (const [rStart, rEnd] of remainingRanges) {
        if (isDiagnosticsCancelled()) break;

        const _phase2ScanStart = beginDiagnosticPhase(`phase2-scan:${rStart}-${rEnd}`);
        const scanCache = getScanCacheEntry(document);
        let extraRelations: RelationDiagnosticContext[];
        let extraLookups: LookupDiagnosticContext[];
        let _scanCacheHit = false;
        if (intervalsCover(scanCache.scanned, rStart, rEnd)) {
          extraRelations = scanCache.relations.filter((c) =>
            c.range.start.line >= rStart && c.range.start.line < rEnd,
          );
          extraLookups = scanCache.lookups.filter((c) =>
            c.range.start.line >= rStart && c.range.start.line < rEnd,
          );
          _scanCacheHit = true;
          perfScanCacheHit++;
        } else {
          perfScanCacheMiss++;
          extraRelations = findRelationDiagnosticContexts(document, rStart, rEnd);
          extraLookups = await findLookupDiagnosticContexts(document, isDiagnosticsCancelled, rStart, rEnd, daemon);
          scanCache.relations.push(...extraRelations);
          scanCache.lookups.push(...extraLookups);
          intervalsAdd(scanCache.scanned, rStart, rEnd);
        }
        logDiagnosticPhase(
          `phase2-scan:${rStart}-${rEnd}`,
          _phase2ScanStart,
          `relations=${extraRelations.length} lookups=${extraLookups.length} cache=${_scanCacheHit ? 'hit' : 'miss'}`
        );

        const _phase2RelationStart = beginDiagnosticPhase(`phase2-relations:${rStart}-${rEnd}`);
        let _phase2RelationAdded = 0;
        for (const context of extraRelations) {
          if (isDiagnosticsCancelled()) break;
          try {
            let resolution = _relationResolutionCache.get(context.value);
            if (!resolution) {
              resolution = await daemon.resolveRelationTarget(context.value, true);
              _relationResolutionCache.set(context.value, resolution);
            }
            trackRequest();
            if (isDiagnosticsCancelled()) break;
            const diagnostic = buildRelationDiagnostic(context, resolution);
            if (addDiagnosticIfNew(diagnostic)) {
              _phase2RelationAdded++;
              incrementalPublish();
            }
          } catch { continue; }
        }
        logDiagnosticPhase(
          `phase2-relations:${rStart}-${rEnd}`,
          _phase2RelationStart,
          `contexts=${extraRelations.length} added=${_phase2RelationAdded} unique=${_relationResolutionCache.size}`
        );

        // Process extra lookup contexts through the same pipeline
        const _phase2LookupStart = beginDiagnosticPhase(`phase2-lookups:${rStart}-${rEnd}`);
        const extraDocText = getDocumentText(document);
        const extraValidated = validateLookupContexts(extraLookups, extraDocText, isDiagnosticsCancelled);
        let _phase2LookupAdded = 0;
        let _exitCancelled = 0;
        let _exitNoReceiver = 0;
        let _exitVirtualResolved = 0;
        let _exitResolvedOk = 0;
        let _exitPartialSuppress = 0;
        let _exitDedup = 0;
        let _exitNullDiagOther = 0;
        let _exitException = 0;
        let _exitTimeout = 0;
        const _noReceiverSamples = new Set<string>();
        const _noReceiverReasonCounts = new Map<string, number>();
        const NO_RECEIVER_SAMPLE_LIMIT = 5;
        // Per-context time budget: prevents a single slow daemon round-trip
        // from monopolising the overall diagnostic budget. Captain trace
        // showed phase2-lookups spending 7s on 12 contexts because a few
        // BG IPCs were stuck — at concurrency=4, 4 slow contexts can
        // consume the entire budget. Capping each context bounds the
        // worst-case wall time to roughly `cap * ceil(N/concurrency)`.
        const PHASE2_PER_CONTEXT_TIMEOUT_MS = (() => {
          const override = parseInt(
            process.env.DJLS_DIAGNOSTIC_PER_CONTEXT_TIMEOUT_MS ?? '',
            10
          );
          return Number.isFinite(override) && override > 0 ? override : 1500;
        })();
        // Margin reserved before the hard budget so an in-flight context's
        // timeout always fires before the global budget exhaust trigger.
        // Without this, a context awaiting a 1200ms BG IPC that started
        // 1500ms before budget end will run 700ms past budget and trigger
        // the "time budget exhausted" log → publish.partial=true. Keeping
        // the per-context cap = remaining-margin pushes all in-flight
        // resolutions to terminate (or timeout) before the hard cutoff.
        const PHASE2_BUDGET_MARGIN_MS = 150;
        // Stop scheduling NEW work once we're inside this fraction of the
        // budget. In-flight contexts are still given the adaptive cap to
        // wind down cleanly.
        const PHASE2_SOFT_STOP_FRACTION = 0.85;
        const computeAdaptiveCap = (): number => {
          const elapsed = Date.now() - diagnosticStartTime;
          const budgetMs = diagnosticTimeBudgetMs();
          const remaining = budgetMs - elapsed - PHASE2_BUDGET_MARGIN_MS;
          if (remaining <= 0) return 1;
          return Math.min(PHASE2_PER_CONTEXT_TIMEOUT_MS, remaining);
        };
        const isPhase2SoftStop = (): boolean => {
          const elapsed = Date.now() - diagnosticStartTime;
          const budgetMs = diagnosticTimeBudgetMs();
          return elapsed > budgetMs * PHASE2_SOFT_STOP_FRACTION;
        };
        const TIMEOUT_SENTINEL: unique symbol = Symbol('phase2-context-timeout');
        type WithTimeout<T> = T | typeof TIMEOUT_SENTINEL;
        const raceWithTimeout = <T,>(p: Promise<T>): Promise<WithTimeout<T>> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const cap = computeAdaptiveCap();
          const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>(
            (resolve) => {
              timer = setTimeout(
                () => resolve(TIMEOUT_SENTINEL),
                cap,
              );
            }
          );
          return Promise.race([p, timeoutPromise]).finally(() => {
            if (timer !== undefined) clearTimeout(timer);
          });
        };

        await runWithConcurrency(extraValidated, DIAGNOSTIC_LOOKUP_PARALLELISM, isDiagnosticsCancelled, async (context) => {
          // Soft-stop: once we're past PHASE2_SOFT_STOP_FRACTION of the
          // budget, stop dispatching new contexts. In-flight ones still
          // finish or time out via the adaptive cap, but no new IPC fires
          // — that prevents the budget-exhaust trigger entirely on
          // captain-class workloads where input >> processable count.
          if (isPhase2SoftStop()) { _exitCancelled++; return; }
          if (isDiagnosticsCancelled()) { _exitCancelled++; return; }
          try {
            const lookupReceiver = await raceWithTimeout(
              resolveCachedLookupReceiverInfo(context)
            );
            if (lookupReceiver === TIMEOUT_SENTINEL) { _exitTimeout++; return; }
            if (isDiagnosticsCancelled()) { _exitCancelled++; return; }
            if (!lookupReceiver) {
              _exitNoReceiver++;
              const reason = classifyNoRecvReason(daemon, context.receiverExpression || '');
              _noReceiverReasonCounts.set(reason, (_noReceiverReasonCounts.get(reason) ?? 0) + 1);
              if (_noReceiverSamples.size < NO_RECEIVER_SAMPLE_LIMIT) {
                const raw = (context.receiverExpression || '').replace(/\s+/g, ' ').trim();
                if (raw) {
                  const truncated = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
                  _noReceiverSamples.add(`${truncated}#${reason}`);
                }
              }
              return;
            }
            const virtualRes = resolveVirtualLookupPath(lookupReceiver, context.value, context.method);
            if (virtualRes?.resolved) { _exitVirtualResolved++; return; }
            // Phantom receiver short-circuit: the modelLabel was synthesized
            // from a bare PascalCase identifier the daemon has no record of.
            // Calling resolveLookupPath against this label costs hundreds
            // of ms (sometimes seconds) for daemon to confirm it doesn't
            // know the model. Skip the IPC — the diagnostic engine treats
            // this as "lookup unresolved against an unknown model" which
            // produces no spurious warnings.
            if (lookupReceiver.synthetic === 'phantom-objects') {
              _exitNullDiagOther++;
              return;
            }
            const resolution = await raceWithTimeout(
              resolveCachedDiagnosticLookupPath(
                lookupReceiver.modelLabel,
                context.value,
                context.method
              )
            );
            if (resolution === TIMEOUT_SENTINEL) { _exitTimeout++; return; }
            if (isDiagnosticsCancelled()) { _exitCancelled++; return; }
            if (!resolution.resolved && resolution.reason !== 'relation_required') {
              const partialCompletions = {
	                items: mergeLookupCompletionItems(
	                  (await listLookupPathCompletionsFast(daemon, lookupReceiver.modelLabel, context.value, context.method, false)).items,
	                  virtualLookupCompletionItems(lookupReceiver, context.value, context.method)
	                ),
                resolved: true,
              };
              if (
                hasSuppressingPartialLookupCompletion(
                  context.value,
                  partialCompletions.items
                )
              ) { _exitPartialSuppress++; return; }
            }
            const diagnostic = buildLookupDiagnostic(context, lookupReceiver.modelLabel, resolution);
            if (!diagnostic) {
              if (resolution.resolved) _exitResolvedOk++;
              else _exitNullDiagOther++;
              return;
            }
            if (addDiagnosticIfNew(diagnostic)) {
              _phase2LookupAdded++;
              incrementalPublish();
            } else {
              _exitDedup++;
            }
          } catch { _exitException++; return; }
        });
        const _noRecvReasonsPart = _noReceiverReasonCounts.size > 0
          ? ` noRecvReasons=${[..._noReceiverReasonCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => `${reason}:${count}`)
              .join(',')}`
          : '';
        const _noRecvSamplesPart = _noReceiverSamples.size > 0
          ? ` noRecvSamples=[${[..._noReceiverSamples].map((s) => `"${s}"`).join(',')}]`
          : '';
        logDiagnosticPhase(
          `phase2-lookups:${rStart}-${rEnd}`,
          _phase2LookupStart,
          `input=${extraLookups.length} valid=${extraValidated.length} added=${_phase2LookupAdded}`
          + ` exit=cancelled:${_exitCancelled},noRecv:${_exitNoReceiver},virtual:${_exitVirtualResolved}`
          + `,resolvedOk:${_exitResolvedOk},partialSuppress:${_exitPartialSuppress}`
          + `,dedup:${_exitDedup},nullDiag:${_exitNullDiagOther},err:${_exitException}`
          + `,timeout:${_exitTimeout}`
          + ` seenRangesSize=${seenRanges.size}`
          + _noRecvReasonsPart
          + _noRecvSamplesPart
        );
      }
      logDiagnosticPhase(
        'phase2-remaining',
        _phase2Start,
        `ranges=${remainingRanges.length} added=${diagnostics.length - _phase2DiagnosticsBefore} published=${phase2NewDiagCount}`
      );
    }

    // Yield before heavy synchronous scan to let hover/definition respond.
    const _directFieldStart = beginDiagnosticPhase('direct-fields-visible');
    let _directFieldContextCount = 0;
    let _directFieldAdded = 0;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!isDiagnosticsCancelled()) {
      const directFieldContexts = findDirectFieldDiagnosticContexts(document, visStartLine, visEndLine);
      _directFieldContextCount = directFieldContexts.length;
      for (const context of directFieldContexts) {
        if (isDiagnosticsCancelled()) break;
        try {
          const baseModelLabel = await resolveBaseModelLabelForReceiver(
            daemon,
            document,
            context.receiverExpression,
            context.range.end
          );
          trackRequest();
          if (isDiagnosticsCancelled()) break;
          if (!baseModelLabel) {
            continue;
          }

          const resolution = await daemon.resolveLookupPath(
            baseModelLabel,
            context.value,
            'filter',
            /* background */ true
          );
          trackRequest();
          if (isDiagnosticsCancelled()) break;
          const diagnostic = buildDirectFieldDiagnostic(
            context,
            baseModelLabel,
            resolution
          );
          if (addDiagnosticIfNew(diagnostic)) {
            _directFieldAdded++;
          }
        } catch {
          continue;
        }
      }
    }
    logDiagnosticPhase(
      'direct-fields-visible',
      _directFieldStart,
      `contexts=${_directFieldContextCount} added=${_directFieldAdded}`
    );

    const _schemaFieldStart = beginDiagnosticPhase('schema-fields-visible');
    let _schemaFieldContextCount = 0;
    let _schemaFieldAdded = 0;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!isDiagnosticsCancelled()) {
      const schemaFieldContexts = findSchemaFieldDiagnosticContexts(document, visStartLine, visEndLine);
      _schemaFieldContextCount = schemaFieldContexts.length;
      for (const context of schemaFieldContexts) {
        if (isDiagnosticsCancelled()) break;
        try {
          const baseModelLabel = await resolveMetaOwnerModelLabel(
            daemon,
            document,
            context.range.end
          );
          trackRequest();
          if (isDiagnosticsCancelled()) break;
          if (!baseModelLabel) {
            continue;
          }

          const resolution = await daemon.resolveLookupPath(
            baseModelLabel,
            context.value,
            'filter',
            /* background */ true
          );
          trackRequest();
          if (isDiagnosticsCancelled()) break;
          const diagnostic = buildSchemaFieldDiagnostic(
            context,
            baseModelLabel,
            resolution
          );
          if (addDiagnosticIfNew(diagnostic)) {
            _schemaFieldAdded++;
          }
        } catch {
          continue;
        }
      }
    }
    logDiagnosticPhase(
      'schema-fields-visible',
      _schemaFieldStart,
      `contexts=${_schemaFieldContextCount} added=${_schemaFieldAdded}`
    );

    const _metaConstraintStart = beginDiagnosticPhase('meta-constraints-visible');
    let _metaConstraintContextCount = 0;
    let _metaConstraintAdded = 0;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!isDiagnosticsCancelled()) {
      const metaConstraintContexts = findMetaConstraintLookupDiagnosticContexts(document, visStartLine, visEndLine);
      _metaConstraintContextCount = metaConstraintContexts.length;
      for (const context of metaConstraintContexts) {
        if (isDiagnosticsCancelled()) break;
        try {
          const baseModelLabel = await resolveMetaOwnerModelLabel(
            daemon,
            document,
            context.range.end
          );
          trackRequest();
          if (isDiagnosticsCancelled()) break;
          if (!baseModelLabel) {
            continue;
          }

          const resolution = await daemon.resolveLookupPath(
            baseModelLabel,
            context.value,
            'filter',
            /* background */ true
          );
          trackRequest();
          if (isDiagnosticsCancelled()) break;
          const diagnostic = buildLookupDiagnostic(
            {
              receiverExpression: '',
              method: 'filter',
              value: context.value,
              range: context.range,
            },
            baseModelLabel,
            resolution
          );
          if (addDiagnosticIfNew(diagnostic)) {
            _metaConstraintAdded++;
          }
        } catch {
          continue;
        }
      }
    }
    logDiagnosticPhase(
      'meta-constraints-visible',
      _metaConstraintStart,
      `contexts=${_metaConstraintContextCount} added=${_metaConstraintAdded}`
    );

    const _bulkUpdateStart = beginDiagnosticPhase('bulk-update-visible');
    let _bulkUpdateContextCount = 0;
    let _bulkUpdateAdded = 0;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!isDiagnosticsCancelled()) {
      const bulkUpdateContexts = findBulkUpdateFieldDiagnosticContexts(document, visStartLine, visEndLine);
      _bulkUpdateContextCount = bulkUpdateContexts.length;
      for (const context of bulkUpdateContexts) {
        if (isDiagnosticsCancelled()) break;
        try {
          const baseModelLabel = await resolveBaseModelLabelForReceiver(
            daemon,
            document,
            context.receiverExpression,
            context.range.end
          );
          trackRequest();
          if (isDiagnosticsCancelled()) break;
          if (!baseModelLabel) {
            continue;
          }

          const resolution = await daemon.resolveLookupPath(
            baseModelLabel,
            context.value,
            'filter',
            /* background */ true
          );
          trackRequest();
          if (isDiagnosticsCancelled()) break;
          const diagnostic = buildBulkUpdateFieldDiagnostic(
            context,
            baseModelLabel,
            resolution
          );
          if (addDiagnosticIfNew(diagnostic)) {
            _bulkUpdateAdded++;
          }
        } catch {
          continue;
        }
      }
    }
    logDiagnosticPhase(
      'bulk-update-visible',
      _bulkUpdateStart,
      `contexts=${_bulkUpdateContextCount} added=${_bulkUpdateAdded}`
    );

    // Publish whatever diagnostics we have, even if the budget was exhausted.
    // Returning early would discard all partial results, leaving the user
    // with zero ORM diagnostics until the next document change.
    const _publishStart = beginDiagnosticPhase('publish');
    if (diagnosticsDisposed || document.version !== documentVersion) {
      activeDiagnosticScans.delete(key);
      return;
    }

    // Per-cycle perf summary. Captain-style production trace analysis often
    // needs to know "where did the budget go" — wall-time alone doesn't
    // distinguish slow IPCs from cache miss explosions. This one-line dump
    // shows cache effectiveness and IPC time consumed in the cycle.
    // 헬퍼는 cancel-before-batch 경로에서도 호출되어 옵션 3 cap 발동 여부를
    // 노출. 정의는 위쪽 closure 에 있음.
    emitPerfSummary();

    diagnosticCollection.set(document.uri, diagnostics);
    logDiagnosticPhase(
      'publish',
      _publishStart,
      `diagnostics=${diagnostics.length} partial=${diagnosticBudgetLogged}`
    );

    if (diagnosticBudgetLogged) {
      // Budget was exhausted — save partial results so the next scan of
      // the same version can reuse them instead of re-resolving everything.
      partialDiagnosticResults.set(key, {
        version: documentVersion,
        diagnostics: [...diagnostics],
        seenRanges: new Set(seenRanges),
        budgetExhausted: true,
      });
    }
    // Mark this version as handled — even on budget exhaustion — so tracked
    // refreshes from visible-editors-changed do not re-fire the same heavy
    // scan repeatedly on a single document version. Edits bump the version,
    // and daemon-state transitions clear this map explicitly, so genuine
    // re-validation paths still work.
    lastDiagnosedDocumentVersions.set(key, documentVersion);
    if (!diagnosticBudgetLogged) {
      partialDiagnosticResults.delete(key);
    }
    activeDiagnosticScans.delete(key);
    } finally {
      activeDiagnosticScanRunningCount--;
    }
  }));

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    pythonSelector,
    {
      async provideCompletionItems(document, position, token) {
        daemon.logDiagnostic(`[completion:enter] ${document.uri.fsPath.split('/').slice(-2).join('/')}:${position.line}:${position.character}`);
        activeCompletionCount++;
        try {
        if (providersDisposed || token.isCancellationRequested) {
          return undefined;
        }
        const compStart = performance.now();
        const COMP_TIMEOUT_MS = 3_000;
        const compAbort = new AbortController();
        token.onCancellationRequested(() => compAbort.abort());
        const compTimeout = setTimeout(() => compAbort.abort(), COMP_TIMEOUT_MS);
        const tokenAbort = new Promise<undefined>((resolve) => {
          token.onCancellationRequested(() => resolve(undefined));
        });
        const compResult = await Promise.race([
        daemon.withDeadline(compStart + COMP_TIMEOUT_MS, () =>
        daemon.withAbortSignal(compAbort.signal, () =>
        daemon.withRequestSource('completion', async () => {
        const relationContext = relationCompletionContext(document, position);
        if (relationContext) {
          try {
            await daemon.ensureStarted(document.uri);
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            const result = await daemon.listRelationTargets(relationContext.prefix);
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }

            return result.items.map((item) => {
              const completion = new vscode.CompletionItem(
                {
                  label: item.label,
                  description: 'Django',
                },
                vscode.CompletionItemKind.Class
              );
              completion.detail = `${item.module} (${item.source})`;
              completion.insertText = item.label;
              completion.filterText = item.label;
              completion.sortText = `\u0000django-${item.label}`;
              completion.range = relationContext.range;
              completion.documentation = buildRelationTargetMarkdown(item);
              return completion;
            });
          } catch {
            return undefined;
          }
        }

        const lookupContext =
          lookupCompletionContext(document, position) ??
          prefetchLookupCompletionContext(document, position) ??
          lookupDictKeyCompletionContext(document, position) ??
          expressionPathCompletionContext(document, position) ??
          fExpressionCompletionContext(document, position) ??
          keywordLookupCompletionContext(document, position);
        const directFieldContext = directFieldKeywordCompletionContext(
          document,
          position
        );
        const metaConstraintLookupContext = metaConstraintLookupCompletionContext(
          document,
          position
        );
        const schemaFieldContext = schemaFieldCompletionContext(document, position);
        const bulkUpdateFieldContext = bulkUpdateFieldListCompletionContext(
          document,
          position
        );

        try {
          await daemon.ensureStarted(document.uri);
          if (token.isCancellationRequested) {
            return cancelledCompletionResult(token);
          }
          if (lookupContext) {
            // Share the hover receiver cache: receiver resolution for a deep,
            // cross-module chain is expensive and can be aborted under contention
            // (diagnostics firing on each keystroke). Reusing a prior hover/
            // completion resolution at the same document version avoids re-running
            // (and re-failing) it. Version-keyed + daemon-state-cleared.
            const recvCacheKey =
              `lookupRecvInfo:${lookupContext.receiverExpression}@L${position.line}`;
            const cachedRecv = getCachedOrmReceiver(document, recvCacheKey);
            let lookupReceiver: OrmReceiverInfo | undefined;
            if (cachedRecv) {
              // Reuse only a cached SUCCESS; a cached miss (undefined) is retried.
              lookupReceiver = cachedRecv;
            } else {
              // Use resolveLookupReceiverInfoForReceiver (NOT a bare
              // resolveExpressionOrmReceiverLocal short-circuit): it runs the same
              // local fast-path internally AND then applies the virtual-field
              // enrichment (assignment-chain + inline annotate scan). The bare
              // local resolver returns an un-enriched receiver, which dropped
              // annotations like a `.values().annotate(_sum=...)` alias.
              lookupReceiver = await resolveLookupReceiverInfoForReceiver(
                daemon,
                document,
                lookupContext.receiverExpression,
                position
              );
              // Only cache a successful, NON-aborted resolution; a contention-
              // aborted result (possibly an incomplete model_class with no virtual
              // fields) must be retried — not stuck — on the next completion.
              if (lookupReceiver && !daemon.isAborted()) {
                setCachedOrmReceiver(document, recvCacheKey, lookupReceiver);
              }
            }
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            if (!lookupReceiver) {
              daemon.logDiagnostic(
                `[completion:lookup] receiver-unresolved receiverExpression=${JSON.stringify(
                  lookupContext.receiverExpression
                )} method=${lookupContext.method} prefix=${JSON.stringify(
                  lookupContext.prefix
                )}`
              );
              return undefined;
            }

            const baseModelLabel = lookupReceiver.modelLabel;
            daemon.logDiagnostic(
              `[completion:lookup:resolved] model=${baseModelLabel} method=${lookupContext.method} prefix=${JSON.stringify(
                lookupContext.prefix
              )}`
            );
            const result = await listLookupPathCompletionsFast(
              daemon,
              baseModelLabel,
              lookupContext.prefix,
              lookupContext.method
            );
            // Captain regression P3: daemon (and local index) had no record
            // of db.Company even though Pylance resolved the receiver. Both
            // `listLookupPathCompletionsLocal` and the BG IPC came back
            // with 0 items, so the user got an empty completion popup on
            // `Company.objects.filter(<cursor>)`. Synthesize a small set of
            // universal Django ORM lookup items so completion remains
            // useful as a last resort.
            const virtualItems = virtualLookupCompletionItems(
              lookupReceiver,
              lookupContext.prefix,
              lookupContext.method,
            );
            let fallbackItems: LookupPathItem[] = [];
            const totalKnownItems = result.items.length + virtualItems.length;
            if (totalKnownItems === 0) {
              fallbackItems = genericDjangoLookupFallbackItems(
                baseModelLabel,
                lookupContext.prefix,
                lookupContext.method,
              );
            }
            daemon.logDiagnostic(
              `[completion:lookup:daemon] model=${baseModelLabel} rawItems=${result.items.length} virtual=${virtualItems.length} fallback=${fallbackItems.length} truncated=${Boolean(
                result.truncated
              )}`
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            const mergedLookupItems = mergeLookupCompletionItems(
              [...result.items, ...fallbackItems],
              virtualItems,
            );
            const sortedItems = prioritizeLookupCompletionItems(
              mergedLookupItems,
              lookupContext.method
            );
            const completions = sortedItems.map((item, index) => {
              const completion = new vscode.CompletionItem(
                lookupCompletionLabel(item),
                lookupCompletionKind(item)
              );
              completion.detail = lookupCompletionDetail(item);
              completion.insertText = lookupCompletionInsertText(
                lookupContext.method,
                item
              );
              completion.filterText = lookupFilterText(lookupContext.prefix, item);
              completion.sortText = lookupCompletionSortText(
                lookupContext.method,
                item,
                index
              );
              completion.preselect = shouldPreselectLookupCompletion(
                lookupContext.method,
                item,
                index
              );
              completion.range = lookupContext.range;
              completion.documentation = buildLookupItemMarkdown(
                item,
                lookupContext.method,
                baseModelLabel
              );
              completion.command = lookupCompletionCommand(
                lookupContext.method,
                item
              );
              return completion;
            });

            // Always mark as incomplete so VS Code re-invokes the provider on
            // each keystroke. Filtering an existing complete list cannot add
            // items the earlier prefix did not produce (e.g. operators that
            // only appear once the prefix ends with `__`), so "complete" lists
            // silently drop operators like `exact`/`contains` when users type
            // past a relation segment in real sessions.
            daemon.logDiagnostic(
              `[completion:lookup] prefix=${JSON.stringify(
                lookupContext.prefix
              )} items=${completions.length} truncated=${Boolean(
                result.truncated
              )}`
            );
            return new vscode.CompletionList(completions, true);
          }

          if (directFieldContext) {
            const localReceiver = resolveExpressionOrmReceiverLocal(
              daemon,
              document,
              directFieldContext.receiverExpression,
              document.offsetAt(position),
              new Set()
            );
            const baseModelLabel =
              localReceiver?.modelLabel ??
              (await resolveBaseModelLabelForReceiver(
                daemon,
                document,
                directFieldContext.receiverExpression,
                position
              ));
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            if (!baseModelLabel) {
              return undefined;
            }

            const result = await listLookupPathCompletionsFast(
              daemon,
              baseModelLabel,
              directFieldContext.prefix,
              'filter'
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            const items = result.items.filter(
              (item) => !item.lookupOperator && !item.name.includes('__')
            );
            const sortedItems = prioritizeLookupCompletionItems(items, 'filter');

            return sortedItems.map((item, index) => {
              const completion = new vscode.CompletionItem(
                lookupCompletionLabel(item),
                lookupCompletionKind(item)
              );
              completion.detail = lookupCompletionDetail(item);
              completion.insertText = item.name;
              completion.filterText = item.name;
              completion.range = directFieldContext.range;
              completion.sortText = lookupCompletionSortText(
                'filter',
                item,
                index
              );
              completion.preselect = shouldPreselectLookupCompletion(
                'filter',
                item,
                index
              );
              completion.documentation = buildLookupItemMarkdown(
                item,
                'filter',
                baseModelLabel
              );
              return completion;
            });
          }

          if (metaConstraintLookupContext) {
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            if (!baseModelLabel) {
              return undefined;
            }

            const result = await listLookupPathCompletionsFast(
              daemon,
              baseModelLabel,
              metaConstraintLookupContext.prefix,
              'filter'
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            const sortedItems = prioritizeLookupCompletionItems(
              result.items,
              'filter'
            );

            return sortedItems.map((item, index) => {
              const completion = new vscode.CompletionItem(
                lookupCompletionLabel(item),
                lookupCompletionKind(item)
              );
              completion.detail = lookupCompletionDetail(item);
              completion.insertText = lookupCompletionInsertText('filter', item);
              completion.filterText = lookupFilterText(
                metaConstraintLookupContext.prefix,
                item
              );
              completion.range = metaConstraintLookupContext.range;
              completion.sortText = lookupCompletionSortText(
                'filter',
                item,
                index
              );
              completion.preselect = shouldPreselectLookupCompletion(
                'filter',
                item,
                index
              );
              completion.documentation = buildLookupItemMarkdown(
                item,
                'filter',
                baseModelLabel
              );
              completion.command = lookupCompletionCommand('filter', item);
              return completion;
            });
          }

          if (schemaFieldContext) {
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            if (!baseModelLabel) {
              return undefined;
            }

            const result = await listLookupPathCompletionsFast(
              daemon,
              baseModelLabel,
              schemaFieldContext.prefix,
              'filter'
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            const items = result.items.filter(
              (item) => !item.lookupOperator && !item.name.includes('__')
            );
            const sortedItems = prioritizeLookupCompletionItems(items, 'filter');

            return sortedItems.map((item, index) => {
              const completion = new vscode.CompletionItem(
                lookupCompletionLabel(item),
                lookupCompletionKind(item)
              );
              completion.detail = lookupCompletionDetail(item);
              completion.insertText = item.name;
              completion.filterText = item.name;
              completion.range = schemaFieldContext.range;
              completion.sortText = lookupCompletionSortText(
                'filter',
                item,
                index
              );
              completion.documentation = buildLookupItemMarkdown(
                item,
                'filter',
                baseModelLabel
              );
              return completion;
            });
          }

          if (bulkUpdateFieldContext) {
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              bulkUpdateFieldContext.receiverExpression,
              position
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            if (!baseModelLabel) {
              return undefined;
            }

            const result = await listLookupPathCompletionsFast(
              daemon,
              baseModelLabel,
              bulkUpdateFieldContext.prefix,
              'filter'
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            const items = result.items.filter(
              (item) => !item.lookupOperator && !item.name.includes('__')
            );
            const sortedItems = prioritizeLookupCompletionItems(items, 'filter');

            return sortedItems.map((item, index) => {
              const completion = new vscode.CompletionItem(
                lookupCompletionLabel(item),
                lookupCompletionKind(item)
              );
              completion.detail = lookupCompletionDetail(item);
              completion.insertText = item.name;
              completion.filterText = item.name;
              completion.range = bulkUpdateFieldContext.range;
              completion.sortText = lookupCompletionSortText(
                'filter',
                item,
                index
              );
              completion.documentation = buildLookupItemMarkdown(
                item,
                'filter',
                baseModelLabel
              );
              return completion;
            });
          }

          const memberContext = await resolveOrmMemberCompletionContext(
            daemon,
            document,
            position
          );
          if (token.isCancellationRequested) {
            return cancelledCompletionResult(token);
          }
          if (memberContext) {
            const classSource =
              memberContext.receiver.classSource ??
              (memberContext.receiver.kind === 'instance'
                ? await resolveClassDefinitionForExpression(
                    daemon,
                    document,
                    memberContext.receiverExpression,
                    document.offsetAt(position),
                    new Set()
                  )
                : undefined) ??
              (memberContext.receiver.kind === 'instance'
                ? await resolveClassDefinitionForModelLabel(
                    daemon,
                    memberContext.receiver.modelLabel
                  )
                : undefined);
            const canUseLocalOrmMemberCompletions =
              memberContext.receiver.kind !== 'instance' ||
              Boolean(classSource) ||
              memberContext.receiverExpression.includes('.');
            const result =
              (canUseLocalOrmMemberCompletions
                ? daemon.listOrmMemberCompletionsLocal(
                    memberContext.receiver.modelLabel,
                    memberContext.receiver.kind,
                    '',
                    memberContext.receiver.managerName
                  )
                : undefined) ??
              daemon.listOrmMemberCompletionsNative(
                memberContext.receiver.modelLabel,
                memberContext.receiver.kind,
                '',
                memberContext.receiver.managerName
              ) ??
              await daemon.listOrmMemberCompletions(
                memberContext.receiver.modelLabel,
                memberContext.receiver.kind,
                '',
                memberContext.receiver.managerName
              );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            const mergedItems = mergeVirtualOrmMemberItems(
              mergeOrmMemberItemsByName(
                result.items,
                await listStaticQuerySetOrmMemberItems(
                  daemon,
                  memberContext.receiver,
                  memberContext.prefix
                )
              ),
              memberContext.receiver
            );
            const sortedItems = prioritizeDirectClassInstanceMemberItems(
              prioritizeOrmMemberCompletionItems(
                mergedItems,
                memberContext.receiver,
                memberContext.prefix
              ),
              memberContext.receiver,
              classSource,
              memberContext.prefix
            );
            const completions = sortedItems.map((item, index) => {
              const completion = new vscode.CompletionItem(
                ormMemberCompletionLabel(item, memberContext.receiver),
                ormMemberCompletionKind(item, memberContext.receiver)
              );
              completion.detail = ormMemberCompletionDetail(
                item,
                memberContext.receiver
              );
              completion.insertText = item.name;
              completion.filterText = item.name;
              completion.range = memberContext.range;
              completion.sortText = ormMemberCompletionSortText(
                item,
                memberContext.receiver,
                index,
                memberContext.prefix
              );
              completion.preselect = shouldPreselectOrmMemberCompletion(
                item,
                memberContext.receiver,
                index,
                memberContext.prefix
              );
              completion.documentation = buildOrmMemberMarkdown(
                item,
                memberContext.receiver
              );
              return completion;
            });

            if (!classSource) {
              return completions;
            }

            const existingItemsByName = new Map(
              sortedItems.map((item, index) => [item.name, { item, index }])
            );
            const classItems = await listClassInstanceMemberItems(
              daemon,
              classSource
            );
            for (const [index, item] of classItems.entries()) {
              const existing = existingItemsByName.get(item.name);
              const shouldOverrideExisting =
                item.kind === 'property' &&
                existing?.item.memberKind !== 'property';
              if (
                (!shouldOverrideExisting && existing) ||
                (memberContext.prefix &&
                  !item.name.startsWith(memberContext.prefix))
              ) {
                continue;
              }

              const completion = new vscode.CompletionItem(
                classMemberCompletionLabel(item),
                classMemberCompletionKind(item)
              );
              completion.detail = classMemberCompletionDetail(item);
              completion.insertText = item.name;
              completion.filterText = item.name;
              completion.range = memberContext.range;
              completion.sortText = classMemberCompletionSortText(
                item,
                memberContext.prefix,
                index
              );
              completion.documentation = buildClassMemberMarkdown(
                memberContext.receiver,
                classSource,
                item
              );
              if (shouldOverrideExisting && existing) {
                completions[existing.index] = completion;
                continue;
              }
              completions.push(completion);
            }

            return completions;
          }

          const classInstanceContext = await resolveClassInstanceCompletionContext(
            daemon,
            document,
            position
          );
          if (token.isCancellationRequested) {
            return cancelledCompletionResult(token);
          }
          if (!classInstanceContext) {
            return undefined;
          }

          const classItems = await listClassInstanceMemberItems(
            daemon,
            classInstanceContext.classSource
          );
          if (token.isCancellationRequested) {
            return cancelledCompletionResult(token);
          }
          const filteredItems = classItems.filter((item) =>
            item.name.startsWith(classInstanceContext.prefix)
          );

          return filteredItems.map((item) => {
            const completion = new vscode.CompletionItem(
              classMemberCompletionLabel(item),
              classMemberCompletionKind(item)
            );
            completion.detail = classMemberCompletionDetail(item);
            completion.insertText = item.name;
            completion.filterText = item.name;
            completion.range = classInstanceContext.range;
            return completion;
          });
        } catch {
          return undefined;
        }
        }))),
        disposalSignal.catch(() => undefined),
        tokenAbort,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), COMP_TIMEOUT_MS)),
        ]);
        compAbort.abort();
        clearTimeout(compTimeout);
        return compResult;
        } catch (error) {
          daemon.logDiagnostic(`[completion:error] ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        } finally {
          activeCompletionCount--;
        }
      },
    },
    "'",
    '"',
    '.',
    '_',
    '(',
    ','
  );

  const signatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
    pythonSelector,
    {
      async provideSignatureHelp(document, position, token) {
        if (providersDisposed || token.isCancellationRequested) {
          return undefined;
        }
        const sigTokenAbort = new Promise<undefined>((resolve) => {
          token.onCancellationRequested(() => resolve(undefined));
        });
        return Promise.race([
        daemon.withRequestSource('signature', async () => {
          const signatureContext = directFieldSignatureHelpContext(
            document,
            position
          );
          if (!signatureContext) {
            return undefined;
          }

          try {
            await daemon.ensureStarted(document.uri);
            if (token.isCancellationRequested) {
              return undefined;
            }

            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              signatureContext.receiverExpression,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const result = await listLookupPathCompletionsFast(
              daemon,
              baseModelLabel,
              '',
              'filter'
            );
            if (token.isCancellationRequested) {
              return undefined;
            }

            return buildDirectFieldSignatureHelp(
              baseModelLabel,
              signatureContext.method,
              result.items,
              signatureContext
            );
          } catch {
            return undefined;
          }
        }),
        disposalSignal.catch(() => undefined),
        sigTokenAbort,
        ]);
      },
    },
    {
      triggerCharacters: ['(', ','],
      retriggerCharacters: [','],
    }
  );

  const hoverProvider = vscode.languages.registerHoverProvider(
    pythonSelector,
    {
      async provideHover(document, position, token) {
        daemon.logDiagnostic(`[hover:enter] ${document.uri.fsPath.split('/').slice(-2).join('/')}:${position.line}:${position.character}`);
        try {
        if (providersDisposed || token.isCancellationRequested) {
          daemon.logDiagnostic(`[hover] skip disposed=${providersDisposed} cancelled=${token.isCancellationRequested}`);
          return undefined;
        }
        const hoverStart = performance.now();
        // Race hover body against disposal signal + token cancellation so that
        // tab switches immediately abort in-flight daemon awaits.
        const tokenAbort = new Promise<undefined>((resolve) => {
          token.onCancellationRequested(() => resolve(undefined));
        });
        // Hard timeout: if all resolution paths haven't completed within this
        // budget, bail out.  Most successful hovers complete in <200ms; the
        // timeout protects against event-loop starvation when many concurrent
        // hovers / diagnostics contend for CPU.
        // Hover must stay snappy. Receivers that can't be resolved (e.g.
        // custom-queryset-method / function-call chains like
        // `get_emps(hrm).annotate_status_at()`) otherwise burn the full budget
        // every hover and return nothing. 1.2s caps that waste; resolvable
        // hovers complete in well under 200ms. Repeat hovers are also cached
        // (see lookupRecvInfo cache below), so the cap only bites the first
        // hover of an unresolvable expression.
        const HOVER_HARD_TIMEOUT_MS = 1_200;
        const hoverTimeout = new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), HOVER_HARD_TIMEOUT_MS);
        });
        // AbortController: when the hover is cancelled (token, timeout, or
        // disposal), abort the signal.  This propagates into cachedRequest()
        // via AsyncLocalStorage so orphaned resolution bodies immediately
        // stop issuing new IPC calls.
        const hoverAbort = new AbortController();
        token.onCancellationRequested(() => hoverAbort.abort());
        const abortOnTimeout = setTimeout(() => hoverAbort.abort(), HOVER_HARD_TIMEOUT_MS);
        const hoverDeadline = hoverStart + HOVER_HARD_TIMEOUT_MS;
        const hoverResult = await Promise.race([
        daemon.withDeadline(hoverDeadline, () =>
        daemon.withAbortSignal(hoverAbort.signal, () =>
        daemon.withRequestSource('hover', async () => {
        const isCancelled = () =>
          providersDisposed ||
          token.isCancellationRequested ||
          hoverAbort.signal.aborted ||
          (performance.now() - hoverStart) >= HOVER_HARD_TIMEOUT_MS;
        const ensureStarted = createEnsureStartedOnce(daemon, document.uri);
        // Slow-hover phase tracking: only logs when total elapsed > 200ms
        const phaseTimings: Array<[string, number]> = [];
        let lastPhaseTime = performance.now();
        const markPhase = (name: string): void => {
          const now = performance.now();
          phaseTimings.push([name, now - lastPhaseTime]);
          lastPhaseTime = now;
        };
        const logSlowPhases = (): void => {
          const totalElapsed = performance.now() - hoverStart;
          if (totalElapsed < 200) return;
          const parts = phaseTimings
            .filter(([, ms]) => ms >= 5)
            .map(([name, ms]) => `${name}=${ms.toFixed(0)}ms`);
          if (parts.length > 0) {
            const shortPath = document.uri.fsPath.split('/').slice(-2).join('/');
            daemon.logDiagnostic(`[hover:slow] ${shortPath}:${position.line}:${position.character} phases: ${parts.join(', ')}`);
          }
        };
        const relationLiteral = relationHoverLiteral(document, position);
        if (relationLiteral) {
          try {
            await ensureStarted();
            if (isCancelled()) { logSlowPhases(); return undefined; }
            const resolution = await daemon.resolveRelationTarget(relationLiteral.value);
            if (isCancelled()) { logSlowPhases(); return undefined; }
            markPhase('relation');
            const relationHover = buildRelationHover(relationLiteral.value, resolution);
            if (relationHover) {
              logSlowPhases();
              return relationHover;
            }
          } catch {
            logSlowPhases();
            return undefined;
          }
        }

        if (isCancelled()) { logSlowPhases(); return undefined; }

        const lookupLiteral =
          lookupHoverLiteral(document, position) ??
          valuesStringLookupHoverLiteral(document, position) ??
          prefetchLookupLiteral(document, position) ??
          lookupDictKeyHoverLiteral(document, position) ??
          expressionPathHoverLiteral(document, position) ??
          fExpressionHoverLiteral(document, position) ??
          keywordLookupLiteral(document, position);
        const directFieldLiteral = directFieldKeywordLiteral(document, position);
        const metaConstraintLookupLiteralAtPosition = metaConstraintLookupLiteral(
          document,
          position
        );
        const schemaFieldLiteral = schemaFieldHoverLiteral(document, position);
        const bulkUpdateFieldLiteral = bulkUpdateFieldListHoverLiteral(
          document,
          position
        );
        if (lookupLiteral) {
          try {
            await ensureStarted();
            if (isCancelled()) { return undefined; }
            // Cache the (often expensive, often unresolvable) receiver lookup
            // per document-version + expression + line, so hovering repeatedly
            // around the same line is instant instead of re-running the deep
            // assignment/function-source analysis every time. Version-keyed and
            // cleared on daemon-state change, so it self-invalidates on edits
            // and on warmup->ready.
            const recvCacheKey =
              `lookupRecvInfo:${lookupLiteral.receiverExpression}@L${position.line}`;
            const cachedRecv = getCachedOrmReceiver(document, recvCacheKey);
            let lookupReceiver: OrmReceiverInfo | undefined;
            if (cachedRecv !== null) {
              lookupReceiver = cachedRecv;
            } else {
              lookupReceiver = await resolveLookupReceiverInfoForReceiver(
                daemon,
                document,
                lookupLiteral.receiverExpression,
                position
              );
              // Do NOT cache a resolution that was aborted mid-flight (daemon busy
              // with diagnostics during editing): it may be incomplete — e.g. the
              // chain/virtual-field walk bailed early, yielding a bare model_class
              // with no virtual fields — and caching it would persist that failure
              // (result=none) for the whole document version. Let it retry when idle.
              if (!daemon.isAborted()) {
                setCachedOrmReceiver(document, recvCacheKey, lookupReceiver);
              }
            }
            if (!lookupReceiver) {
              return undefined;
            }

            const baseModelLabel = lookupReceiver.modelLabel;
            if (isCancelled()) { return undefined; }
            const resolution =
              resolveVirtualLookupPath(
                lookupReceiver,
                lookupLiteral.value,
                lookupLiteral.method
              ) ??
              (await daemon.resolveLookupPath(
                baseModelLabel,
                lookupLiteral.value,
                lookupLiteral.method
              ));
            if (isCancelled()) { return undefined; }
            const lookupHover = buildLookupHover(
              lookupLiteral.value,
              lookupLiteral.method,
              baseModelLabel,
              resolution
            );
            if (lookupHover) {
              return lookupHover;
            }
          } catch {
            return undefined;
          }
        }

        if (directFieldLiteral) {
          try {
            await ensureStarted();
            if (isCancelled()) { return undefined; }
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              directFieldLiteral.receiverExpression,
              position
            );
            if (isCancelled()) { return undefined; }
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              directFieldLiteral.value,
              'filter'
            );
            if (isCancelled()) { return undefined; }
            return buildLookupHover(
              directFieldLiteral.value,
              directFieldLiteral.method,
              baseModelLabel,
              resolution
            );
          } catch {
            return undefined;
          }
        }

        if (metaConstraintLookupLiteralAtPosition) {
          try {
            await ensureStarted();
            if (isCancelled()) { return undefined; }
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (isCancelled()) { return undefined; }
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              metaConstraintLookupLiteralAtPosition.value,
              'filter'
            );
            if (isCancelled()) { return undefined; }
            return buildLookupHover(
              metaConstraintLookupLiteralAtPosition.value,
              'filter',
              baseModelLabel,
              resolution
            );
          } catch {
            return undefined;
          }
        }

        if (schemaFieldLiteral) {
          try {
            await ensureStarted();
            if (isCancelled()) { return undefined; }
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (isCancelled()) { return undefined; }
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              schemaFieldLiteral.value,
              'filter'
            );
            if (isCancelled()) { return undefined; }
            return buildLookupHover(
              schemaFieldLiteral.value,
              'filter',
              baseModelLabel,
              resolution
            );
          } catch {
            return undefined;
          }
        }

        if (bulkUpdateFieldLiteral) {
          try {
            await ensureStarted();
            if (isCancelled()) { return undefined; }
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              bulkUpdateFieldLiteral.receiverExpression,
              position
            );
            if (isCancelled()) { return undefined; }
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              bulkUpdateFieldLiteral.value,
              'filter'
            );
            if (isCancelled()) { return undefined; }
            return buildLookupHover(
              bulkUpdateFieldLiteral.value,
              'filter',
              baseModelLabel,
              resolution
            );
          } catch {
            return undefined;
          }
        }

        if (isCancelled()) { daemon.logDiagnostic(`[hover:bail] cancelled-before-literals`); logSlowPhases(); return undefined; }

        markPhase('literals');
        daemon.logDiagnostic(`[hover:stage] entering ormMemberCtx aborted=${daemon.isAborted()}`);
        try {
          await ensureStarted();
          if (isCancelled()) { logSlowPhases(); return undefined; }
          const memberContext = await resolveOrmMemberAccessContext(
            daemon,
            document,
            position
          );
          markPhase('ormMemberCtx');
          if (isCancelled()) { logSlowPhases(); return undefined; }
          if (memberContext) {
            const virtualResolution = resolveVirtualOrmMember(
              memberContext.receiver,
              memberContext.memberName
            );
            if (virtualResolution) {
            const memberHover = await buildOrmMemberHover(
              daemon,
              document,
              position,
              memberContext,
              memberContext.memberName,
              memberContext.receiver,
              virtualResolution
            );
              if (memberHover) {
                return memberHover;
              }
            }

            if (
              memberContext.receiver.kind !== 'instance' &&
              FAST_LOCAL_ORM_MEMBER_HOVER_NAMES.has(memberContext.memberName)
            ) {
              const localResolution = daemon.resolveOrmMemberLocal(
                memberContext.receiver.modelLabel,
                memberContext.receiver.kind,
                memberContext.memberName
              );
              if (localResolution) {
                const memberHover = await buildOrmMemberHover(
                  daemon,
                  document,
                  position,
                  memberContext,
                  memberContext.memberName,
                  memberContext.receiver,
                  localResolution
                );
                if (memberHover) {
                  return memberHover;
                }
              }
            }

            if (isCancelled()) { return undefined; }
            const resolution = await daemon.resolveOrmMember(
              memberContext.receiver.modelLabel,
              memberContext.receiver.kind,
              memberContext.memberName,
              memberContext.receiver.managerName
            );
            if (isCancelled()) { return undefined; }
            const memberHover = await buildOrmMemberHover(
              daemon,
              document,
              position,
              memberContext,
              memberContext.memberName,
              memberContext.receiver,
              resolution
            );
            if (memberHover) {
              return memberHover;
            }

            if (isCancelled()) { return undefined; }
            const annotatedMemberHover = await buildAnnotatedReceiverMemberHover(
              daemon,
              document,
              position,
              memberContext.receiver,
              memberContext.memberName
            );
            if (annotatedMemberHover) {
              return annotatedMemberHover;
            }
          }
        } catch {
          logSlowPhases();
          return undefined;
        }

        markPhase('ormMember');
        daemon.logDiagnostic(`[hover:stage] entering import aborted=${daemon.isAborted()}`);
        if (isCancelled()) { daemon.logDiagnostic(`[hover:bail] cancelled-before-import`); logSlowPhases(); return undefined; }

        const hoverWordRange = document.getWordRangeAtPosition(
          position,
          /[A-Za-z_][\w]*/
        );
        const hoverLineText = hoverWordRange
          ? document.lineAt(hoverWordRange.start.line).text
          : '';
        const isMemberNameHover =
          Boolean(hoverWordRange) &&
          hoverWordRange!.start.character > 0 &&
          hoverLineText[hoverWordRange!.start.character - 1] === '.';
        const hoverWord = hoverWordRange ? document.getText(hoverWordRange) : '';
        if (
          !isMemberNameHover &&
          (hoverWord === 'self' || hoverWord === 'cls' || /^[a-z_]/.test(hoverWord))
        ) {
          const fastAssignedHover = buildFastAssignedOrmInstanceHover(
            daemon,
            document,
            position
          );
          if (fastAssignedHover) {
            logSlowPhases();
            return fastAssignedHover;
          }
          try {
            await ensureStarted();
            if (!isCancelled()) {
              const ormInstanceHover = await resolveReceiverInstanceHoverAtPosition(
                daemon,
                document,
                position
              );
              if (ormInstanceHover) {
                logSlowPhases();
                return ormInstanceHover;
              }
            }
          } catch {
            logSlowPhases();
            return undefined;
          }
        }

        try {
          await ensureStarted();
          if (isCancelled()) { logSlowPhases(); return undefined; }
          const importReference = await resolveImportReferenceAtPosition(
            daemon,
            document,
            position
          );
          if (importReference) {
            if (isCancelled()) { return undefined; }
            const importHover = await buildImportHover(
              daemon,
              importReference
            );
            if (importHover) {
              return importHover;
            }
          }
        } catch {
          logSlowPhases();
          return undefined;
        }

        markPhase('import');
        if (isCancelled()) { logSlowPhases(); return undefined; }

        try {
          await ensureStarted();
          if (isCancelled()) { logSlowPhases(); return undefined; }
          const typeHintHoverTarget = await resolveTypeHintHoverTargetAtPosition(
            daemon,
            document,
            position
          );
          if (typeHintHoverTarget) {
            const typeHintHover = buildTypeHintHover(typeHintHoverTarget);
            if (typeHintHover) {
              return typeHintHover;
            }
          }
        } catch {
          logSlowPhases();
          return undefined;
        }

        markPhase('typeHint');
        if (isCancelled()) { logSlowPhases(); return undefined; }

        try {
          await ensureStarted();
          if (isCancelled()) { logSlowPhases(); return undefined; }
          const classHoverTarget =
            await resolveClassHoverTargetAtPosition(
              daemon,
              document,
              position
            );
          if (classHoverTarget) {
            const classHover = buildClassHover(
              classHoverTarget
            );
            if (classHover) {
              return classHover;
            }
          }
        } catch {
          logSlowPhases();
          return undefined;
        }

        markPhase('classHover');
        daemon.logDiagnostic(`[hover:stage] entering instanceHover aborted=${daemon.isAborted()}`);
        if (!isCancelled()) {
          try {
            await ensureStarted();
            if (!isCancelled()) {
              const ormInstanceHover = await resolveReceiverInstanceHoverAtPosition(
                daemon,
                document,
                position
              );
              if (ormInstanceHover) {
                logSlowPhases();
                return ormInstanceHover;
              }
            }
          } catch {
            logSlowPhases();
            return undefined;
          }
        }

        markPhase('instanceHover');
        logSlowPhases();
        return undefined;
        }))),
        disposalSignal.catch(() => undefined),
        tokenAbort,
        hoverTimeout,
        ]);
        hoverAbort.abort();
        clearTimeout(abortOnTimeout);
        const elapsed = (performance.now() - hoverStart).toFixed(0);
        const timedOut = !hoverResult && Number(elapsed) >= HOVER_HARD_TIMEOUT_MS;
        const shortPath = document.uri.fsPath.split('/').slice(-2).join('/');
        daemon.logDiagnostic(`[hover] ${shortPath}:${position.line}:${position.character} ${elapsed}ms result=${hoverResult ? 'hover' : 'none'} disposed=${providersDisposed}${timedOut ? ' TIMEOUT' : ''}`);
        return hoverResult;
        } catch (error) {
          daemon.logDiagnostic(`[hover:error] ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      },
    }
  );

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    pythonSelector,
    {
      async provideDefinition(document, position, token) {
        daemon.logDiagnostic(`[definition:enter] ${document.uri.fsPath.split('/').slice(-2).join('/')}:${position.line}:${position.character}`);
        try {
        if (providersDisposed || token.isCancellationRequested) {
          return undefined;
        }
        const defStart = performance.now();
        const DEF_TIMEOUT_MS = 3_000;
        const defAbort = new AbortController();
        token.onCancellationRequested(() => defAbort.abort());
        const defTimeout = setTimeout(() => defAbort.abort(), DEF_TIMEOUT_MS);
        const defResult = await Promise.race([
        daemon.withDeadline(defStart + DEF_TIMEOUT_MS, () =>
        daemon.withAbortSignal(defAbort.signal, () =>
        daemon.withRequestSource('definition', async () => {
        const isDefCancelled = () => providersDisposed || token.isCancellationRequested || defAbort.signal.aborted || (performance.now() - defStart) >= DEF_TIMEOUT_MS;
        const ensureStarted = createEnsureStartedOnce(daemon, document.uri);
        const relationLiteral = relationHoverLiteral(document, position);
        if (relationLiteral) {
          try {
            await ensureStarted();
            if (isDefCancelled()) { return undefined; }
            const resolution = await daemon.resolveRelationTarget(relationLiteral.value);
            if (isDefCancelled()) { return undefined; }
            const location =
              await definitionLocationFromRelationResolutionWithFallback(
                daemon,
                resolution
              );
            if (location) {
              return location;
            }
          } catch {
            return undefined;
          }
        }

        if (isDefCancelled()) { return undefined; }

        const lookupLiteral =
          lookupHoverLiteral(document, position) ??
          valuesStringLookupHoverLiteral(document, position) ??
          prefetchLookupLiteral(document, position) ??
          lookupDictKeyHoverLiteral(document, position) ??
          expressionPathHoverLiteral(document, position) ??
          fExpressionHoverLiteral(document, position) ??
          keywordLookupLiteral(document, position);
        const directFieldLiteral = directFieldKeywordLiteral(document, position);
        const metaConstraintLookupLiteralAtPosition = metaConstraintLookupLiteral(
          document,
          position
        );
        const schemaFieldLiteral = schemaFieldHoverLiteral(document, position);
        const bulkUpdateFieldLiteral = bulkUpdateFieldListHoverLiteral(
          document,
          position
        );
        if (lookupLiteral) {
          try {
            await ensureStarted();
            if (isDefCancelled()) { return undefined; }
            const lookupReceiver = await resolveLookupReceiverInfoForReceiver(
              daemon,
              document,
              lookupLiteral.receiverExpression,
              position
            );
            if (isDefCancelled()) { return undefined; }
            if (!lookupReceiver) {
              return undefined;
            }

            const baseModelLabel = lookupReceiver.modelLabel;
            const resolution =
              resolveVirtualLookupPath(
                lookupReceiver,
                lookupLiteral.value,
                lookupLiteral.method
              ) ??
              (await daemon.resolveLookupPath(
                baseModelLabel,
                lookupLiteral.value,
                lookupLiteral.method
              ));
            if (isDefCancelled()) { return undefined; }
            const location = await definitionLocationFromLookupResolutionWithFallback(
              daemon,
              resolution
            );
            if (location) {
              return location;
            }
          } catch {
            return undefined;
          }
        }

        if (isDefCancelled()) { return undefined; }

        if (directFieldLiteral) {
          try {
            await ensureStarted();
            if (isDefCancelled()) { return undefined; }
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              directFieldLiteral.receiverExpression,
              position
            );
            if (isDefCancelled()) { return undefined; }
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              directFieldLiteral.value,
              'filter'
            );
            if (isDefCancelled()) { return undefined; }
            return definitionLocationFromLookupResolutionWithFallback(
              daemon,
              resolution
            );
          } catch {
            return undefined;
          }
        }

        if (isDefCancelled()) { return undefined; }

        if (metaConstraintLookupLiteralAtPosition) {
          try {
            await ensureStarted();
            if (isDefCancelled()) { return undefined; }
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (isDefCancelled()) { return undefined; }
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              metaConstraintLookupLiteralAtPosition.value,
              'filter'
            );
            if (isDefCancelled()) { return undefined; }
            return definitionLocationFromLookupResolutionWithFallback(
              daemon,
              resolution
            );
          } catch {
            return undefined;
          }
        }

        if (isDefCancelled()) { return undefined; }

        if (schemaFieldLiteral) {
          try {
            await ensureStarted();
            if (isDefCancelled()) { return undefined; }
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (isDefCancelled()) { return undefined; }
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              schemaFieldLiteral.value,
              'filter'
            );
            if (isDefCancelled()) { return undefined; }
            const location = await definitionLocationFromLookupResolutionWithFallback(
              daemon,
              resolution
            );
            if (location) {
              return location;
            }

            // Fallback: if the daemon resolved the field but lacks source
            // location info, search for the field assignment in the parent
            // model class within the current document.
            if (resolution.resolved) {
              const metaClass = findEnclosingClassDefinition(
                document,
                document.offsetAt(position)
              );
              if (metaClass) {
                const ownerClass = findEnclosingParentClassDefinition(
                  document,
                  metaClass
                );
                if (ownerClass) {
                  const fieldPattern = new RegExp(
                    String.raw`^(\s+)${escapeRegExp(schemaFieldLiteral.value)}\s*=`
                  );
                  for (
                    let line = ownerClass.line + 1;
                    line < metaClass.line;
                    line++
                  ) {
                    const lineText = document.lineAt(line).text;
                    if (fieldPattern.test(lineText)) {
                      const col = lineText.indexOf(schemaFieldLiteral.value);
                      return new vscode.Location(
                        document.uri,
                        new vscode.Position(line, col)
                      );
                    }
                  }
                }
              }
            }
            return undefined;
          } catch {
            return undefined;
          }
        }

        if (isDefCancelled()) { return undefined; }

        if (bulkUpdateFieldLiteral) {
          try {
            await ensureStarted();
            if (isDefCancelled()) { return undefined; }
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              bulkUpdateFieldLiteral.receiverExpression,
              position
            );
            if (isDefCancelled()) { return undefined; }
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              bulkUpdateFieldLiteral.value,
              'filter'
            );
            if (isDefCancelled()) { return undefined; }
            return definitionLocationFromLookupResolutionWithFallback(
              daemon,
              resolution
            );
          } catch {
            return undefined;
          }
        }

        if (isDefCancelled()) { return undefined; }

        try {
          await ensureStarted();
          if (isDefCancelled()) { return undefined; }
          const memberContext = await resolveOrmMemberAccessContext(
            daemon,
            document,
            position
          );
          if (isDefCancelled()) { return undefined; }
          if (memberContext) {
            const virtualResolution = resolveVirtualOrmMember(
              memberContext.receiver,
              memberContext.memberName
            );
            if (virtualResolution) {
              const virtualLocation = definitionLocationFromOrmMemberResolution(
                virtualResolution
              );
              if (virtualLocation) {
                return virtualLocation;
              }
            }

            const resolution = await daemon.resolveOrmMember(
              memberContext.receiver.modelLabel,
              memberContext.receiver.kind,
              memberContext.memberName,
              memberContext.receiver.managerName
            );
            if (isDefCancelled()) { return undefined; }
            const location = definitionLocationFromOrmMemberResolution(resolution);
            if (location) {
              return location;
            }
          }
        } catch {
          return undefined;
        }

        if (isDefCancelled()) { return undefined; }

        try {
          await ensureStarted();
          if (isDefCancelled()) { return undefined; }
          const importReference = await resolveImportReferenceAtPosition(
            daemon,
            document,
            position
          );
          if (isDefCancelled()) { return undefined; }
          if (!importReference) {
            return undefined;
          }
          const location = await definitionLocationFromImportReference(
            daemon,
            importReference
          );
          if (isDefCancelled()) { return undefined; }
          if (location) {
            return location;
          }
        } catch {
          return undefined;
        }

        return undefined;
        }))),
        disposalSignal.catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DEF_TIMEOUT_MS)),
        ]);
        defAbort.abort();
        clearTimeout(defTimeout);
        return defResult;
        } catch (error) {
          daemon.logDiagnostic(`[definition:error] ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      },
    }
  );

  const inlayHintsProvider = vscode.languages.registerInlayHintsProvider(
    pythonSelector,
    {
      async provideInlayHints(document, range, token) {
        if (providersDisposed || token.isCancellationRequested) {
          return undefined;
        }
        if (!areLookupInlayHintsEnabled(document.uri)) {
          return undefined;
        }
        const candidates = collectInlayLookupCandidates(document, range);
        if (candidates.length === 0) {
          return [];
        }
        const ensureStarted = createEnsureStartedOnce(daemon, document.uri);
        try {
          await ensureStarted();
        } catch {
          return [];
        }
        if (providersDisposed || token.isCancellationRequested) {
          return [];
        }
        // Background, diagnostic-sourced resolution: we never need source
        // locations for a hint, so the native fast path answers directly
        // without a Python IPC fallback.
        return daemon.withRequestSource('diagnostic', async () => {
          const hints: vscode.InlayHint[] = [];
          const memo = new Map<string, string | undefined>();
          // Receiver resolution is the expensive step (backward expression /
          // binding scans). Many lookups in a viewport share the same receiver
          // expression (e.g. the same queryset), so memoize per expression to
          // avoid re-resolving it dozens of times per inlay pass.
          const receiverMemo = new Map<
            string,
            OrmReceiverInfo | undefined
          >();
          for (const candidate of candidates) {
            if (providersDisposed || token.isCancellationRequested) {
              break;
            }
            const literal = keywordLookupLiteral(document, candidate.probe);
            if (!literal) {
              continue;
            }
            try {
              let receiver: OrmReceiverInfo | undefined;
              if (receiverMemo.has(literal.receiverExpression)) {
                receiver = receiverMemo.get(literal.receiverExpression);
              } else {
                receiver = await resolveLookupReceiverInfoForReceiver(
                  daemon,
                  document,
                  literal.receiverExpression,
                  candidate.probe
                );
                receiverMemo.set(literal.receiverExpression, receiver);
              }
              if (!receiver) {
                continue;
              }
              const memoKey = `${receiver.modelLabel}|${literal.method}|${literal.value}`;
              let label: string | undefined;
              if (memo.has(memoKey)) {
                label = memo.get(memoKey);
              } else {
                const resolution =
                  resolveVirtualLookupPath(
                    receiver,
                    literal.value,
                    literal.method
                  ) ??
                  (await daemon.resolveLookupPath(
                    receiver.modelLabel,
                    literal.value,
                    literal.method,
                    true
                  ));
                label = inlayTypeLabelForResolution(resolution);
                memo.set(memoKey, label);
              }
              if (!label) {
                continue;
              }
              const hint = new vscode.InlayHint(
                candidate.anchor,
                `: ${label}`,
                vscode.InlayHintKind.Type
              );
              hint.paddingLeft = true;
              hints.push(hint);
            } catch {
              // Skip this candidate; never let one failure drop the rest.
            }
          }
          return hints;
        });
      },
    }
  );

  if (canRunDiagnostics()) {
    scheduleTrackedDiagnosticsRefresh();
  }

  return [
    completionProvider,
    signatureHelpProvider,
    hoverProvider,
    definitionProvider,
    inlayHintsProvider,
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (diagnosticsDisposed) {
        return;
      }
      if (!canRunDiagnostics()) {
        return;
      }
      if (!isVisibleDocument(document)) {
        return;
      }
      scheduleDiagnosticsRefresh(document, 200, 'open');
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (diagnosticsDisposed) {
        return;
      }
      if (!canRunDiagnostics()) {
        return;
      }
      if (!isVisibleDocument(event.document)) {
        return;
      }
      scheduleDiagnosticsRefresh(event.document, EDIT_DIAGNOSTIC_DEBOUNCE_MS, 'edit');
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      if (diagnosticsDisposed) {
        return;
      }
      if (!canRunDiagnostics()) {
        return;
      }
      // Delay diagnostics refresh on tab switch to let hover requests
      // settle first and avoid flooding the event loop.
      daemon.logDiagnostic('[diagnostics:trigger] tracked-refresh source=visible-editors-changed delay=500ms');
      scheduleTrackedDiagnosticsRefresh(500);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (!diagnosticsDisposed) {
        diagnosticCollection.delete(document.uri);
      }
      const key = document.uri.toString();
      lastDiagnosedDocumentVersions.delete(key);
      partialDiagnosticResults.delete(key);
      _ormReceiverCacheByDocument.delete(key);
      _scanCacheAcrossRegistrations.delete(key);
      const timer = diagnosticTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        diagnosticTimers.delete(key);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId === 'python') {
        resetProviderResolutionCaches();
      }
    }),
    daemon.onDidChangeState((snapshot) => {
      if (diagnosticsDisposed) {
        return;
      }
      resetProviderResolutionCaches();
      if (!diagnosticsEnabled) {
        diagnosticCollection.clear();
        lastDiagnosedDocumentVersions.clear();
        return;
      }

      if (snapshot.phase === 'starting') {
        return;
      }

      if (snapshot.phase === 'stopped' || snapshot.phase === 'error') {
        clearScheduledDiagnostics();
        diagnosticCollection.clear();
        lastDiagnosedDocumentVersions.clear();
        partialDiagnosticResults.clear();
        return;
      }

      daemon.logDiagnostic(`[diagnostics:trigger] tracked-refresh source=daemon-state phase=${snapshot.phase} delay=0ms`);
      // Daemon capability changed (ready/degraded). Allow one fresh
      // validation pass even for versions previously marked as
      // budget-exhausted — the daemon may now produce different results.
      lastDiagnosedDocumentVersions.clear();
      partialDiagnosticResults.clear();
      // Daemon model graph may have shifted; drop receiver/lookup caches
      // so the next cycle re-resolves with the updated state.
      clearLookupResolutionAndReceiverCachesAcrossRegistrations();
      scheduleTrackedDiagnosticsRefresh(0);
    }),
    new vscode.Disposable(() => {
      providersDisposed = true;
      diagnosticsDisposed = true;
      fireDisposalSignal?.();
      clearScheduledDiagnostics();
      lastDiagnosedDocumentVersions.clear();
      partialDiagnosticResults.clear();
      activeDiagnosticScans.clear();
      diagnosticCollection.dispose();
    }),
  ];
}

function lookupCompletionLabel(
  item: LookupPathItem
): string | vscode.CompletionItemLabel {
  const detail = lookupCompletionLabelDetail(item);
  const description = lookupCompletionDescription(item);
  if (!detail && !description) {
    return item.name;
  }

  return {
    label: item.name,
    detail,
    description,
  };
}

function lookupCompletionKind(item: LookupPathItem): vscode.CompletionItemKind {
  if (
    item.fieldKind === 'lookup_operator' ||
    item.fieldKind === 'lookup_transform'
  ) {
    return vscode.CompletionItemKind.Operator;
  }

  return vscode.CompletionItemKind.Field;
}

function lookupCompletionDetail(item: LookupPathItem): string {
  if (item.fieldKind === 'lookup_operator') {
    return `Django lookup · ${lookupCompletionOwnerField(item) ?? lookupCompletionShortModelLabel(item.modelLabel)}`;
  }
  if (item.fieldKind === 'lookup_transform') {
    return `Django transform · ${lookupCompletionOwnerField(item) ?? lookupCompletionShortModelLabel(item.modelLabel)}`;
  }

  return `${lookupCompletionDisplayFieldKind(item.fieldKind)} · ${lookupCompletionShortModelLabel(item.modelLabel)}${item.relatedModelLabel ? ` -> ${lookupCompletionShortModelLabel(item.relatedModelLabel)}` : ''}`;
}

function lookupCompletionLabelDetail(item: LookupPathItem): string | undefined {
  if (
    item.fieldKind === 'lookup_operator' ||
    item.fieldKind === 'lookup_transform'
  ) {
    return undefined;
  }

  const displayFieldKind = lookupCompletionDisplayFieldKind(item.fieldKind);
  return displayFieldKind ? ` (${displayFieldKind})` : undefined;
}

function lookupCompletionDescription(item: LookupPathItem): string | undefined {
  if (item.fieldKind === 'lookup_operator') {
    return lookupCompletionOwnerField(item)
      ? `lookup · ${lookupCompletionOwnerField(item)}`
      : 'Django lookup';
  }
  if (item.fieldKind === 'lookup_transform') {
    return lookupCompletionOwnerField(item)
      ? `transform · ${lookupCompletionOwnerField(item)}`
      : 'Django transform';
  }

  const ownerModel = lookupCompletionShortModelLabel(item.modelLabel);
  if (item.relatedModelLabel) {
    return `${ownerModel} -> ${lookupCompletionShortModelLabel(item.relatedModelLabel)}`;
  }

  return ownerModel;
}

function buildDirectFieldSignatureHelp(
  baseModelLabel: string,
  method: string,
  items: LookupPathItem[],
  context: {
    activeArgumentIndex: number;
    activeKeywordText?: string;
  }
): vscode.SignatureHelp | undefined {
  const fieldItems = prioritizeLookupCompletionItems(
    items.filter(
      (item) => !item.lookupOperator && !item.name.includes('__')
    ),
    'filter'
  );
  if (fieldItems.length === 0) {
    return undefined;
  }

  const parameterEntries = fieldItems.map((item) => ({
    item,
    label: directFieldSignatureParameterLabel(item),
  }));
  const returnLabel =
    method === 'update'
      ? 'int'
      : lookupCompletionShortModelLabel(baseModelLabel);
  const signatureInformation = new vscode.SignatureInformation(
    `${method}(*, ${parameterEntries
      .map((entry) => entry.label)
      .join(', ')}) -> ${returnLabel}`
  );
  signatureInformation.documentation = new vscode.MarkdownString(
    `Django ORM ${method} fields for \`${baseModelLabel}\`.`
  );
  signatureInformation.parameters = parameterEntries.map((entry) => {
    const parameter = new vscode.ParameterInformation(entry.label);
    parameter.documentation = directFieldSignatureParameterDocumentation(
      entry.item
    );
    return parameter;
  });

  const signatureHelp = new vscode.SignatureHelp();
  signatureHelp.signatures = [signatureInformation];
  signatureHelp.activeSignature = 0;
  signatureHelp.activeParameter = resolveActiveDirectFieldSignatureParameter(
    parameterEntries,
    context
  );
  return signatureHelp;
}

function directFieldSignatureParameterLabel(item: LookupPathItem): string {
  const displayFieldKind =
    lookupCompletionDisplayFieldKind(item.fieldKind) ?? item.fieldKind;
  return item.relatedModelLabel
    ? `${item.name}: ${displayFieldKind} -> ${lookupCompletionShortModelLabel(
        item.relatedModelLabel
      )}`
    : `${item.name}: ${displayFieldKind}`;
}

function directFieldSignatureParameterDocumentation(
  item: LookupPathItem
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${item.name}**\n\n`);
  markdown.appendMarkdown(`Field kind: \`${item.fieldKind}\`\n\n`);
  markdown.appendMarkdown(`Owner model: \`${item.modelLabel}\``);
  if (item.relatedModelLabel) {
    markdown.appendMarkdown(`\n\nRelated model: \`${item.relatedModelLabel}\``);
  }
  return markdown;
}

function resolveActiveDirectFieldSignatureParameter(
  entries: Array<{ item: LookupPathItem; label: string }>,
  context: {
    activeArgumentIndex: number;
    activeKeywordText?: string;
  }
): number {
  if (entries.length === 0) {
    return 0;
  }

  const activeKeywordText = context.activeKeywordText?.trim();
  if (activeKeywordText) {
    const exactIndex = entries.findIndex(
      (entry) => entry.item.name === activeKeywordText
    );
    if (exactIndex >= 0) {
      return exactIndex;
    }

    const prefixMatches = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.item.name.startsWith(activeKeywordText));
    if (prefixMatches.length === 1) {
      return prefixMatches[0].index;
    }
  }

  return Math.min(context.activeArgumentIndex, entries.length - 1);
}

function lookupCompletionOwnerField(item: LookupPathItem): string | undefined {
  const fieldPath = item.fieldPath ?? item.name;
  const fieldName = fieldPath.split('__').filter(Boolean).at(-1);
  if (!fieldName) {
    return undefined;
  }

  return `${lookupCompletionShortModelLabel(item.modelLabel)}.${fieldName}`;
}

function lookupCompletionShortModelLabel(modelLabel: string): string {
  const trimmed = modelLabel.trim();
  if (!trimmed) {
    return modelLabel;
  }

  const segments = trimmed.split('.');
  return segments[segments.length - 1] ?? modelLabel;
}

function lookupCompletionDisplayFieldKind(fieldKind: string): string {
  return fieldKind.replace(/^reverse_/, '');
}

function lookupCompletionInsertText(
  method: string,
  item: LookupPathItem
): string {
  if (!lookupCompletionCanContinue(method, item)) {
    return item.name;
  }

  return item.name.endsWith('__') ? item.name : `${item.name}__`;
}

function lookupCompletionCommand(
  method: string,
  item: LookupPathItem
): vscode.Command | undefined {
  if (!lookupCompletionCanContinue(method, item)) {
    return undefined;
  }

  return {
    title: 'Continue Django ORM lookup',
    command: 'editor.action.triggerSuggest',
  };
}

function lookupCompletionCanContinue(
  method: string,
  item: LookupPathItem
): boolean {
  if (item.fieldKind === 'lookup_operator') {
    return false;
  }
  if (item.fieldKind === 'lookup_transform') {
    return true;
  }

  return (
    item.isRelation ||
    Boolean(item.relatedModelLabel) ||
    DJANGO_FIELD_PRIORITY_METHODS.has(method)
  );
}

function prioritizeLookupCompletionItems(
  items: LookupPathItem[],
  method: string
): LookupPathItem[] {
  if (!DJANGO_FIELD_PRIORITY_METHODS.has(method)) {
    return items;
  }

  return [...items].sort((left, right) => {
    const priorityDifference =
      lookupCompletionPriority(left) - lookupCompletionPriority(right);
    if (priorityDifference !== 0) {
      return priorityDifference;
    }

    const secondaryDifference =
      lookupCompletionSecondaryPriority(left) -
      lookupCompletionSecondaryPriority(right);
    if (secondaryDifference !== 0) {
      return secondaryDifference;
    }

    return left.name.localeCompare(right.name);
  });
}

function lookupCompletionPriority(item: LookupPathItem): number {
  const pathDepth = item.name.split('__').length - 1;
  if (
    item.fieldKind === 'lookup_operator' ||
    item.fieldKind === 'lookup_transform'
  ) {
    return pathDepth > 0 ? 1 : 2;
  }

  if (pathDepth > 0) {
    return 3 + pathDepth;
  }

  return item.isRelation ? 1 : 0;
}

function lookupCompletionSecondaryPriority(item: LookupPathItem): number {
  if (
    item.fieldKind === 'lookup_operator' ||
    item.fieldKind === 'lookup_transform'
  ) {
    return LOOKUP_OPERATOR_PRIORITY.get(operatorBaseName(item.name)) ?? 999;
  }

  return 0;
}

function operatorBaseName(name: string): string {
  const segments = name.split('__');
  return segments[segments.length - 1] ?? name;
}

function lookupCompletionSortText(
  method: string,
  item: LookupPathItem,
  index: number
): string | undefined {
  return `\u0000django-${lookupCompletionPriority(item)
    .toString()
    .padStart(4, '0')}-${lookupCompletionSecondaryPriority(item)
    .toString()
    .padStart(4, '0')}-${index.toString().padStart(4, '0')}-${item.name}`;
}

function shouldPreselectLookupCompletion(
  method: string,
  item: LookupPathItem,
  index: number
): boolean {
  return (
    item.fieldKind !== 'lookup_operator' &&
    item.fieldKind !== 'lookup_transform' &&
    index === 0
  );
}

function prioritizeOrmMemberCompletionItems(
  items: OrmMemberItem[],
  receiver: OrmReceiverInfo,
  prefix = ''
): OrmMemberItem[] {
  return [...items]
    .map((item, index) => ({
      item,
      index,
    }))
    .sort((left, right) => {
      const prefixDifference =
        ormMemberCompletionPrefixPriority(left.item, prefix) -
        ormMemberCompletionPrefixPriority(right.item, prefix);
      if (prefixDifference !== 0) {
        return prefixDifference;
      }

      const priorityDifference =
        ormMemberCompletionPriority(left.item, receiver) -
        ormMemberCompletionPriority(right.item, receiver);
      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      if (receiver.kind === 'instance') {
        return left.index - right.index;
      }

      return left.item.name.localeCompare(right.item.name);
    })
    .map((entry) => entry.item);
}

function prioritizeDirectClassInstanceMemberItems(
  items: OrmMemberItem[],
  receiver: OrmReceiverInfo,
  classSource: ClassDefinitionSource | undefined,
  prefix = ''
): OrmMemberItem[] {
  if (receiver.kind !== 'instance' || !classSource || prefix.trim()) {
    return items;
  }

  const directMemberRank = new Map<string, number>();
  for (const [index, item] of directClassInstanceMemberItems(classSource).entries()) {
    if (item.kind === 'method') {
      continue;
    }
    if (!directMemberRank.has(item.name)) {
      directMemberRank.set(item.name, index);
    }
  }

  if (directMemberRank.size === 0) {
    return items;
  }

  return [...items]
    .map((item, index) => ({
      item,
      index,
      directRank: directMemberRank.get(item.name),
    }))
    .sort((left, right) => {
      if (left.directRank != null || right.directRank != null) {
        if (left.directRank == null) {
          return 1;
        }
        if (right.directRank == null) {
          return -1;
        }
        if (left.directRank !== right.directRank) {
          return left.directRank - right.directRank;
        }
      }

      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

function ormMemberCompletionPrefixPriority(
  item: OrmMemberItem,
  prefix: string
): number {
  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix) {
    return 0;
  }

  if (item.name === normalizedPrefix) {
    return 0;
  }

  if (item.name.startsWith(normalizedPrefix)) {
    return 1;
  }

  return 2;
}

function ormMemberCompletionPriority(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): number {
  if (receiver.kind === 'instance') {
    if (
      (item.memberKind === 'field' || item.memberKind === 'relation') &&
      (item.name === 'id' || item.name === 'pk')
    ) {
      return 1;
    }
    if (item.memberKind === 'field' || item.memberKind === 'relation') {
      return 0;
    }
    if (item.memberKind === 'reverse_relation') {
      return 2;
    }
    if (item.memberKind === 'manager') {
      return 3;
    }
    return 4;
  }

  if (item.memberKind === 'method') {
    return 0;
  }
  if (item.memberKind === 'manager') {
    return 1;
  }
  if (item.memberKind === 'field' || item.memberKind === 'relation') {
    return 2;
  }
  if (item.memberKind === 'reverse_relation') {
    return 3;
  }
  return 4;
}

function ormMemberCompletionLabel(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): string | vscode.CompletionItemLabel {
  const detail = ormMemberCompletionLabelDetail(item);
  const description = ormMemberCompletionDescription(item, receiver);
  if (!detail && !description) {
    return item.name;
  }

  return {
    label: item.name,
    detail,
    description,
  };
}

function ormMemberCompletionLabelDetail(
  item: OrmMemberItem
): string | undefined {
  const returnSummary = ormMemberCompletionReturnSummary(item);
  if (
    (item.memberKind === 'method' ||
      item.memberKind === 'manager' ||
      item.memberKind === 'property') &&
    returnSummary
  ) {
    return ` -> ${returnSummary}`;
  }

  const shouldInlineFieldKind =
    item.memberKind === 'field' ||
    item.memberKind === 'relation' ||
    item.memberKind === 'reverse_relation' ||
    item.source === ANNOTATED_MEMBER_SOURCE;
  if (!shouldInlineFieldKind) {
    return undefined;
  }

  const displayFieldKind = item.fieldKind
    ? lookupCompletionDisplayFieldKind(item.fieldKind)
    : item.detail;
  return displayFieldKind ? ` (${displayFieldKind})` : undefined;
}

function ormMemberCompletionDescription(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): string | undefined {
  const isFieldLike =
    item.memberKind === 'field' ||
    item.memberKind === 'relation' ||
    item.memberKind === 'reverse_relation' ||
    item.source === ANNOTATED_MEMBER_SOURCE;
  if (isFieldLike) {
    const ownerModel = lookupCompletionShortModelLabel(item.modelLabel);
    if (
      item.returnModelLabel &&
      item.returnModelLabel !== item.modelLabel &&
      (item.memberKind === 'relation' || item.memberKind === 'reverse_relation')
    ) {
      return `${ownerModel} -> ${lookupCompletionShortModelLabel(item.returnModelLabel)}`;
    }
    return ownerModel;
  }

  if (
    receiver.kind !== 'instance' &&
    (item.memberKind === 'method' ||
      item.memberKind === 'manager' ||
      item.memberKind === 'property')
  ) {
    const ownerModel = lookupCompletionShortModelLabel(item.modelLabel);
    if (
      item.returnModelLabel &&
      item.returnKind &&
      item.returnKind !== 'scalar' &&
      item.returnKind !== 'unknown'
    ) {
      const returnModel = lookupCompletionShortModelLabel(item.returnModelLabel);
      return returnModel === ownerModel
        ? ownerModel
        : `${ownerModel} -> ${returnModel}`;
    }
    return ownerModel;
  }

  return undefined;
}

function ormMemberCompletionReturnSummary(
  item: OrmMemberItem
): string | undefined {
  if (!item.returnKind || item.returnKind === 'unknown') {
    return undefined;
  }

  const returnModel = item.returnModelLabel
    ? lookupCompletionShortModelLabel(item.returnModelLabel)
    : undefined;
  if (item.returnKind === 'instance' || item.returnKind === 'model_class') {
    return returnModel;
  }

  if (item.returnKind === 'queryset' && returnModel) {
    return `QuerySet[${returnModel}]`;
  }

  if (item.returnKind === 'manager' && returnModel) {
    return `Manager[${returnModel}]`;
  }

  if (item.returnKind === 'related_manager' && returnModel) {
    return `RelatedManager[${returnModel}]`;
  }

  return returnModel;
}

function ormMemberCompletionKind(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): vscode.CompletionItemKind {
  if (item.memberKind === 'method') {
    return vscode.CompletionItemKind.Method;
  }
  if (item.memberKind === 'property') {
    return vscode.CompletionItemKind.Property;
  }
  if (item.memberKind === 'manager') {
    return vscode.CompletionItemKind.Property;
  }
  if (receiver.kind === 'instance' && item.memberKind === 'relation') {
    return vscode.CompletionItemKind.Field;
  }
  if (item.memberKind === 'relation' || item.memberKind === 'reverse_relation') {
    return vscode.CompletionItemKind.Reference;
  }
  return vscode.CompletionItemKind.Field;
}

function ormMemberCompletionDetail(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): string {
  if (
    (item.source === 'builtin' || item.source === 'local') &&
    (item.memberKind === 'method' ||
      item.memberKind === 'manager' ||
      item.memberKind === 'property')
  ) {
    const parts: string[] = [item.detail];
    if (receiver.classSource) {
      parts.push(receiver.classSource.classDef.name);
    }
    parts.push(lookupCompletionShortModelLabel(item.modelLabel));
    const returnSummary = ormMemberCompletionReturnSummary(item);
    if (returnSummary) {
      parts.push(`returns ${returnSummary}`);
    }
    return parts.join(' · ');
  }

  const parts: string[] = [];
  if (
    receiver.kind === 'instance' &&
    (item.memberKind === 'field' ||
      item.memberKind === 'relation' ||
      item.memberKind === 'reverse_relation')
  ) {
    parts.push('Django model field');
  }
  parts.push(item.detail, item.modelLabel);
  if (item.returnKind && item.returnKind !== 'scalar' && item.returnKind !== 'unknown') {
    const returnLabel = item.returnModelLabel
      ? `${item.returnKind} -> ${item.returnModelLabel}`
      : item.returnKind;
    parts.push(returnLabel);
  }
  return parts.join(' · ');
}

function ormMemberCompletionSortText(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo,
  index: number,
  prefix = ''
): string {
  return `\u0000\u0000django-${ormMemberCompletionPrefixPriority(item, prefix)
    .toString()
    .padStart(4, '0')}-${ormMemberCompletionPriority(item, receiver)
    .toString()
    .padStart(4, '0')}-${ormMemberCompletionSecondaryPriority(item, receiver)
    .toString()
    .padStart(4, '0')}-${index
    .toString()
    .padStart(4, '0')}-${item.name}`;
}

function ormMemberCompletionSecondaryPriority(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): number {
  if (receiver.kind === 'instance') {
    return 0;
  }

  if (item.memberKind !== 'method') {
    return 0;
  }

  const preferredPriority = PREFERRED_MANAGER_MEMBER_METHOD_PRIORITY.get(item.name);
  if (preferredPriority !== undefined) {
    return preferredPriority;
  }

  if (item.name.startsWith('a')) {
    return 500;
  }

  return 100;
}

function shouldPreselectOrmMemberCompletion(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo,
  index: number,
  prefix = ''
): boolean {
  if (receiver.kind === 'instance') {
    if (index !== 0) {
      return false;
    }
    return item.memberKind === 'field' || item.memberKind === 'relation';
  }

  if (
    item.memberKind === 'method' &&
    PREFERRED_MANAGER_MEMBER_METHOD_PRIORITY.has(item.name)
  ) {
    if (prefix.trim() && !item.name.startsWith(prefix.trim())) {
      return false;
    }
    return true;
  }

  if (index !== 0) {
    return false;
  }

  return item.memberKind === 'manager';
}

function classMemberCompletionKind(
  item: ClassMemberItem
): vscode.CompletionItemKind {
  if (item.kind === 'method') {
    return vscode.CompletionItemKind.Method;
  }

  if (item.kind === 'property') {
    return vscode.CompletionItemKind.Property;
  }

  return vscode.CompletionItemKind.Field;
}

function classMemberCompletionLabel(
  item: ClassMemberItem
): string | vscode.CompletionItemLabel {
  const detail = classMemberCompletionLabelDetail(item);
  const description = classMemberCompletionDescription(item);
  if (!detail && !description) {
    return item.name;
  }

  return {
    label: item.name,
    detail,
    description,
  };
}

function classMemberCompletionLabelDetail(
  item: ClassMemberItem
): string | undefined {
  if (!item.typeAnnotation) {
    return undefined;
  }

  return item.kind === 'method'
    ? ` -> ${item.typeAnnotation}`
    : ` (${item.typeAnnotation})`;
}

function classMemberCompletionDescription(
  item: ClassMemberItem
): string | undefined {
  return item.ownerClassName;
}

function classMemberCompletionDetail(item: ClassMemberItem): string {
  return item.detail;
}

function classMemberCompletionSortText(
  item: ClassMemberItem,
  prefix: string,
  index: number
): string {
  const normalizedPrefix = prefix.trim();
  const prefixPriority =
    !normalizedPrefix ? 0
    : item.name === normalizedPrefix ? 0
    : item.name.startsWith(normalizedPrefix) ? 1
    : 2;
  return `\u0000django-class-${prefixPriority
    .toString()
    .padStart(4, '0')}-${index.toString().padStart(4, '0')}-${item.name}`;
}

function buildClassMemberMarkdown(
  receiver: OrmReceiverInfo,
  classSource: ClassDefinitionSource,
  item: ClassMemberItem
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${item.name}**\n\n`);
  markdown.appendMarkdown(`Receiver kind: \`${receiver.kind}\`\n\n`);
  markdown.appendMarkdown(`Receiver model: \`${receiver.modelLabel}\`\n\n`);
  markdown.appendMarkdown(
    `Defined on: \`${qualifiedClassSymbol(
      classSource.document,
      classSource.classDef.name
    )}\``
  );
  appendImportFilePath(markdown, item.filePath);
  markdown.appendMarkdown(`\n\nDetail: \`${item.detail}\``);
  if (item.typeAnnotation) {
    markdown.appendMarkdown(`\n\nType annotation: \`${item.typeAnnotation}\``);
  }
  return markdown;
}

async function buildAnnotatedReceiverMemberHover(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position,
  receiver: OrmReceiverInfo,
  memberName: string
): Promise<vscode.Hover | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const classSource = receiver.classSource;
  if (!classSource) {
    return undefined;
  }

  const classItems = await listClassInstanceMemberItems(daemon, classSource);
  const item = classItems.find((candidate) => candidate.name === memberName);
  if (!item) {
    return undefined;
  }

  const markdown = buildClassMemberMarkdown(receiver, classSource, item);
  if (item.typeAnnotation) {
    const modelLabel = await resolveModelLabelFromTypeAnnotation(
      daemon,
      classSource.document,
      item.typeAnnotation,
      classSource.beforeOffset
    );
    if (modelLabel) {
      markdown.appendMarkdown(`\n\nResolved return model: \`${modelLabel}\``);
    }
  }
  const memberRange = document.getWordRangeAtPosition(
    position,
    /[A-Za-z_][\w]*/
  );
  return new vscode.Hover(markdown, memberRange);
}

function relationCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): { prefix: string; range: vscode.Range } | undefined {
  const lineText = document.lineAt(position.line).text;
  const prefixText = lineText.slice(0, position.character);
  const match = prefixText.match(RELATION_COMPLETION_PATTERN);

  if (!match) {
    return undefined;
  }

  const currentValue = match[2];
  const range = new vscode.Range(
    position.line,
    position.character - currentValue.length,
    position.line,
    position.character
  );

  return {
    prefix: currentValue,
    range,
  };
}

function lookupCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupContext | undefined {
  const lineText = document.lineAt(position.line).text;
  const prefixText = lineText.slice(0, position.character);
  const match = prefixText.match(LOOKUP_COMPLETION_PATTERN);

  if (!match) {
    // Multi-line / wrapped string-lookup call (`pd.DataFrame(qs.values(\n  "a__|`):
    // the method name is on an earlier line, so LOOKUP_COMPLETION_PATTERN (current
    // line only) misses it. Detect a bare field-path string under the cursor and
    // find the enclosing values()/only()/... call across lines.
    return bareStringLookupCompletionContext(document, position, prefixText);
  }

  const [, method, , currentValue] = match;
  const callContext = querysetStringCallContext(
    getDocumentText(document),
    document.offsetAt(position)
  );
  if (!callContext || callContext.method !== method) {
    return undefined;
  }

  const replacementLength = lookupReplacementLength(currentValue);

  const range = new vscode.Range(
    position.line,
    position.character - replacementLength,
    position.line,
    position.character
  );

  return {
    receiverExpression: callContext.receiverExpression,
    method,
    prefix: currentValue,
    range,
  };
}

function bareStringLookupCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  prefixText: string
): LookupContext | undefined {
  // The cursor must sit just after an open quote + (partial) field path:
  // `"`, `"tmeta`, `"tmeta__`, `"tmeta__th`, etc.
  const openMatch = prefixText.match(/(['"])([A-Za-z_]?[\w]*(?:__[\w]*)*)$/);
  if (!openMatch) {
    return undefined;
  }
  const currentValue = openMatch[2] ?? '';
  const callContext = querysetStringCallContext(
    getDocumentText(document),
    document.offsetAt(position)
  );
  if (!callContext || !STRING_LOOKUP_METHODS.has(callContext.method)) {
    return undefined;
  }

  const replacementLength = lookupReplacementLength(currentValue);
  const range = new vscode.Range(
    position.line,
    position.character - replacementLength,
    position.line,
    position.character
  );

  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    prefix: currentValue,
    range,
  };
}

function prefetchLookupCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupContext | undefined {
  const lineText = document.lineAt(position.line).text;
  const prefixText = lineText.slice(0, position.character);
  const match = prefixText.match(PREFETCH_LOOKUP_COMPLETION_PATTERN);
  if (!match) {
    return undefined;
  }

  const currentValue = match[2] ?? '';
  const callContext = prefetchLookupCallContext(
    getDocumentText(document),
    document.offsetAt(position)
  );
  if (!callContext) {
    return undefined;
  }

  const replacementLength = lookupReplacementLength(currentValue);
  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    prefix: currentValue,
    range: new vscode.Range(
      position.line,
      position.character - replacementLength,
      position.line,
      position.character
    ),
  };
}

function lookupDictKeyCompletionMatch(
  document: vscode.TextDocument,
  position: vscode.Position
): { currentValue: string; startCharacter: number } | undefined {
  const lineText = document.lineAt(position.line).text;
  const prefixText = lineText.slice(0, position.character);
  const match = prefixText.match(LOOKUP_DICT_KEY_COMPLETION_PATTERN);
  if (!match) {
    return undefined;
  }

  const currentValue = match[2] ?? '';
  return {
    currentValue,
    startCharacter: position.character - currentValue.length,
  };
}

function lookupDictKeyCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupContext | undefined {
  const match = lookupDictKeyCompletionMatch(document, position);
  if (!match || isDynamicLookupDictKey(match.currentValue)) {
    return undefined;
  }

  const startOffset = document.offsetAt(
    new vscode.Position(position.line, match.startCharacter)
  );
  const callContext = unpackedLookupDictCallContext(
    getDocumentText(document),
    startOffset,
    document.offsetAt(position)
  );
  if (!callContext) {
    return undefined;
  }

  const replacementLength = lookupReplacementLength(match.currentValue);
  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    prefix: match.currentValue,
    range: new vscode.Range(
      position.line,
      position.character - replacementLength,
      position.line,
      position.character
    ),
  };
}

function fExpressionCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupContext | undefined {
  const lineText = document.lineAt(position.line).text;
  const prefixText = lineText.slice(0, position.character);
  const match = prefixText.match(F_EXPRESSION_COMPLETION_PATTERN);
  if (!match) {
    return undefined;
  }

  const currentValue = match[2] ?? '';
  const callContext = fExpressionCallContext(
    getDocumentText(document),
    document.offsetAt(position)
  );
  if (!callContext) {
    return undefined;
  }

  const replacementLength = lookupReplacementLength(currentValue);
  const range = new vscode.Range(
    position.line,
    position.character - replacementLength,
    position.line,
    position.character
  );

  return {
    receiverExpression: callContext.receiverExpression,
    method: F_EXPRESSION_METHOD,
    prefix: currentValue,
    range,
  };
}

function expressionPathCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupContext | undefined {
  const lineText = document.lineAt(position.line).text;
  const prefixText = lineText.slice(0, position.character);
  const match = prefixText.match(EXPRESSION_STRING_COMPLETION_PATTERN);
  if (!match) {
    return undefined;
  }

  const currentValue = match[2] ?? '';
  const cursorOffset = document.offsetAt(position);
  const tokenStartOffset = cursorOffset - currentValue.length;
  const tokenEndOffset = expressionStringTokenEndOffset(
    getDocumentText(document),
    cursorOffset
  );
  const callContext = expressionStringArgumentCallContext(
    getDocumentText(document),
    tokenStartOffset,
    tokenEndOffset
  );
  if (!callContext) {
    return undefined;
  }

  const replacementLength = lookupReplacementLength(currentValue);
  const range = new vscode.Range(
    position.line,
    position.character - replacementLength,
    position.line,
    position.character
  );

  return {
    receiverExpression: callContext.receiverExpression,
    method: expressionPathMethodName(callContext.expressionName),
    prefix: currentValue,
    range,
  };
}

function keywordLookupCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupContext | undefined {
  if (lookupDictKeyCompletionMatch(document, position)) {
    return undefined;
  }

  const fullText = getDocumentText(document);
  const cursorOffset = document.offsetAt(position);
  const prefixText = fullText.slice(0, cursorOffset);
  const tokenStartOffset = scanKeywordTokenStart(prefixText);
  const currentValue = prefixText.slice(tokenStartOffset);
  if (!isLookupKeywordCandidate(currentValue)) {
    return undefined;
  }

  const callContext = querysetKeywordCallContext(fullText, tokenStartOffset, cursorOffset);
  if (!callContext) {
    return undefined;
  }

  const replacementLength = lookupReplacementLength(currentValue);
  const rangeStart = document.positionAt(cursorOffset - replacementLength);
  const range = new vscode.Range(rangeStart, position);

  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    prefix: currentValue,
    range,
  };
}

function directFieldKeywordCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): DirectFieldKeywordContext | undefined {
  const fullText = getDocumentText(document);
  const cursorOffset = document.offsetAt(position);
  const prefixText = fullText.slice(0, cursorOffset);
  const tokenStartOffset = scanKeywordTokenStart(prefixText);
  const currentValue = prefixText.slice(tokenStartOffset);

  if (!isDirectFieldKeywordCandidate(currentValue)) {
    return undefined;
  }

  const callContext = querysetDirectFieldKeywordCallContext(
    fullText,
    tokenStartOffset,
    cursorOffset
  );
  if (!callContext) {
    return undefined;
  }

  const rangeStart = document.positionAt(cursorOffset - currentValue.length);
  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    prefix: currentValue,
    range: new vscode.Range(rangeStart, position),
  };
}

function directFieldSignatureHelpContext(
  document: vscode.TextDocument,
  position: vscode.Position
):
  | {
      receiverExpression: string;
      method: string;
      activeArgumentIndex: number;
      activeKeywordText?: string;
    }
  | undefined {
  const text = getDocumentText(document);
  const cursorOffset = document.offsetAt(position);
  const openParenOffset = findEnclosingCallOpenParenOffset(text, cursorOffset);
  if (openParenOffset === undefined) {
    return undefined;
  }

  const callContext = parseQuerysetCallee(
    text,
    openParenOffset,
    ORM_FIELD_SIGNATURE_METHODS
  );
  if (!callContext) {
    return undefined;
  }

  const currentArgumentStartOffset = findCurrentArgumentStartOffset(
    text,
    openParenOffset,
    cursorOffset
  );
  const previousArgumentsText = text.slice(
    openParenOffset + 1,
    currentArgumentStartOffset
  );
  const activeArgumentIndex = splitTopLevelExpressions(
    previousArgumentsText
  ).length;
  const currentArgumentText = text
    .slice(currentArgumentStartOffset, cursorOffset)
    .trim();

  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    activeArgumentIndex,
    activeKeywordText:
      directFieldSignatureKeywordText(currentArgumentText) ?? undefined,
  };
}

function directFieldSignatureKeywordText(
  currentArgumentText: string
): string | undefined {
  const trimmedArgument = currentArgumentText.trim();
  if (!trimmedArgument) {
    return undefined;
  }

  const equalsIndex = findTopLevelEqualsIndex(trimmedArgument);
  const rawKeyword =
    equalsIndex >= 0
      ? trimmedArgument.slice(0, equalsIndex)
      : trimmedArgument;
  const keyword = rawKeyword.trim();
  if (!/^[A-Za-z_][\w]*$/.test(keyword)) {
    return undefined;
  }

  return keyword;
}

function schemaFieldCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): SchemaFieldContext | undefined {
  const lineText = document.lineAt(position.line).text;
  const prefixText = lineText.slice(0, position.character);
  const match = prefixText.match(SCHEMA_FIELD_LIST_COMPLETION_PATTERN);
  if (!match) {
    return undefined;
  }

  const currentValue = match[2] ?? '';
  return {
    prefix: currentValue,
    range: new vscode.Range(
      position.line,
      position.character - currentValue.length,
      position.line,
      position.character
    ),
  };
}

function metaConstraintLookupCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): MetaConstraintLookupContext | undefined {
  if (lookupDictKeyCompletionMatch(document, position)) {
    return undefined;
  }

  const fullText = getDocumentText(document);
  const cursorOffset = document.offsetAt(position);
  const prefixText = fullText.slice(0, cursorOffset);
  const tokenStartOffset = scanKeywordTokenStart(prefixText);
  const currentValue = prefixText.slice(tokenStartOffset);
  if (!isLookupKeywordCandidate(currentValue)) {
    return undefined;
  }

  const callContext = qExpressionKeywordCallContext(
    fullText,
    tokenStartOffset,
    cursorOffset
  );
  if (!callContext) {
    return undefined;
  }

  const replacementLength = lookupReplacementLength(currentValue);
  const rangeStart = document.positionAt(cursorOffset - replacementLength);
  return {
    prefix: currentValue,
    range: new vscode.Range(rangeStart, position),
  };
}

function bulkUpdateFieldListCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): BulkUpdateFieldListContext | undefined {
  const lineText = document.lineAt(position.line).text;
  const prefixText = lineText.slice(0, position.character);
  const match = prefixText.match(BULK_UPDATE_FIELD_LIST_COMPLETION_PATTERN);
  if (!match) {
    return undefined;
  }

  const callContext = bulkUpdateFieldListCallContext(
    getDocumentText(document),
    document.offsetAt(position)
  );
  if (!callContext) {
    return undefined;
  }

  const currentValue = match[2] ?? '';
  return {
    receiverExpression: callContext.receiverExpression,
    prefix: currentValue,
    range: new vscode.Range(
      position.line,
      position.character - currentValue.length,
      position.line,
      position.character
    ),
  };
}

/**
 * Hover detection for a field-path string that sits on a DIFFERENT line from its
 * enclosing `.values()/.only()/.defer()/.order_by()/...` call — the multi-line
 * argument-list case (`qs.values(\n  "salary_account__institution__name",\n ...)`).
 * `lookupHoverLiteral` only matches `method("value")` on a single line, so it
 * misses these. Here we extract the quoted field path under the cursor and find
 * the enclosing string-lookup call via querysetStringCallContext (which walks
 * backward across lines), so the path resolves like any other lookup.
 */
function valuesStringLookupHoverLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupLiteral | undefined {
  const lineText = document.lineAt(position.line).text;
  const literal = quotedFieldPathAtPosition(lineText, position.character);
  if (!literal) {
    return undefined;
  }
  const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));
  const callContext = querysetStringCallContext(
    getDocumentText(document),
    lineStartOffset + literal.start
  );
  if (!callContext) {
    return undefined;
  }
  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    value: literal.content,
  };
}

/**
 * The quoted ORM-field-path string literal (e.g. "a__b__c") whose content
 * contains `character`, or undefined. Returns the content (without quotes) and
 * the in-line start offset of the content.
 */
function quotedFieldPathAtPosition(
  lineText: string,
  character: number
): { content: string; start: number } | undefined {
  const re = /(['"])([A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(lineText)) !== null) {
    const contentStart = match.index + 1;
    const contentEnd = contentStart + match[2].length;
    if (character >= contentStart && character <= contentEnd) {
      return { content: match[2], start: contentStart };
    }
  }
  return undefined;
}

function lookupHoverLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupLiteral | undefined {
  const lineText = document.lineAt(position.line).text;
  const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));

  for (const match of lineText.matchAll(LOOKUP_HOVER_PATTERN)) {
    const [, method, , value] = match;
    const prefix = match[0];
    const localOffset = prefix.lastIndexOf(value);
    const start = (match.index ?? 0) + localOffset;
    const end = start + value.length;

    if (position.character >= start && position.character <= end) {
      const callContext = querysetStringCallContext(
        getDocumentText(document),
        lineStartOffset + start
      );
      if (!callContext || callContext.method !== method) {
        return undefined;
      }

      return {
        receiverExpression: callContext.receiverExpression,
        method,
        value,
      };
    }
  }

  return undefined;
}

function prefetchLookupLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupLiteral | undefined {
  const lineText = document.lineAt(position.line).text;
  const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));

  for (const match of lineText.matchAll(PREFETCH_LOOKUP_HOVER_PATTERN)) {
    const value = match[2];
    const prefix = match[0];
    const localOffset = prefix.lastIndexOf(value);
    const start = (match.index ?? 0) + localOffset;
    const end = start + value.length;

    if (position.character < start || position.character > end) {
      continue;
    }

    const callContext = prefetchLookupCallContext(
      getDocumentText(document),
      lineStartOffset + start
    );
    if (!callContext) {
      return undefined;
    }

    return {
      receiverExpression: callContext.receiverExpression,
      method: callContext.method,
      value,
    };
  }

  return undefined;
}

function lookupDictKeyHoverMatchAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
):
  | {
      value: string;
      start: number;
      end: number;
    }
  | undefined {
  const lineText = document.lineAt(position.line).text;
  for (const match of lineText.matchAll(LOOKUP_DICT_KEY_HOVER_PATTERN)) {
    const value = match[2];
    const prefix = match[0];
    const localOffset = prefix.lastIndexOf(value);
    const start = (match.index ?? 0) + localOffset;
    const end = start + value.length;
    if (position.character >= start && position.character <= end) {
      return {
        value,
        start,
        end,
      };
    }
  }

  return undefined;
}

function lookupDictKeyHoverLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupLiteral | undefined {
  const match = lookupDictKeyHoverMatchAtPosition(document, position);
  if (!match || isDynamicLookupDictKey(match.value)) {
    return undefined;
  }

  const startOffset = document.offsetAt(
    new vscode.Position(position.line, match.start)
  );
  const endOffset = document.offsetAt(new vscode.Position(position.line, match.end));
  const callContext = unpackedLookupDictCallContext(
    getDocumentText(document),
    startOffset,
    endOffset
  );
  if (!callContext) {
    return undefined;
  }

  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    value: match.value,
  };
}

function fExpressionHoverLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupLiteral | undefined {
  const lineText = document.lineAt(position.line).text;
  const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));

  for (const match of lineText.matchAll(F_EXPRESSION_HOVER_PATTERN)) {
    const value = match[2];
    const prefix = match[0];
    const localOffset = prefix.lastIndexOf(value);
    const start = (match.index ?? 0) + localOffset;
    const end = start + value.length;

    if (position.character < start || position.character > end) {
      continue;
    }

    const callContext = fExpressionCallContext(
      getDocumentText(document),
      lineStartOffset + start
    );
    if (!callContext) {
      return undefined;
    }

    return {
      receiverExpression: callContext.receiverExpression,
      method: F_EXPRESSION_METHOD,
      value,
    };
  }

  return undefined;
}

function expressionPathHoverLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupLiteral | undefined {
  const lineText = document.lineAt(position.line).text;
  const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));

  for (const match of lineText.matchAll(EXPRESSION_STRING_HOVER_PATTERN)) {
    const value = match[2];
    const start = (match.index ?? 0) + 1;
    const end = start + value.length;

    if (position.character < start || position.character > end) {
      continue;
    }

    const callContext = expressionStringArgumentCallContext(
      getDocumentText(document),
      lineStartOffset + start,
      lineStartOffset + end + 1
    );
    if (!callContext) {
      return undefined;
    }

    return {
      receiverExpression: callContext.receiverExpression,
      method: expressionPathMethodName(callContext.expressionName),
      value,
    };
  }

  return undefined;
}

function keywordLookupLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupLiteral | undefined {
  if (lookupDictKeyHoverMatchAtPosition(document, position)) {
    return undefined;
  }

  const fullText = getDocumentText(document);
  const wordRange = document.getWordRangeAtPosition(
    position,
    /[A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*/
  );
  if (!wordRange) {
    return undefined;
  }

  const value = document.getText(wordRange);
  if (!isLookupKeywordCandidate(value)) {
    return undefined;
  }

  const startOffset = document.offsetAt(wordRange.start);
  const endOffset = document.offsetAt(wordRange.end);
  const callContext = querysetKeywordCallContext(
    fullText,
    startOffset,
    endOffset
  );
  if (!callContext) {
    return undefined;
  }

  const argumentText = fullText.slice(
    callContext.argumentStartOffset,
    callContext.argumentEndOffset
  );
  const equalsIndex = findTopLevelEqualsIndex(argumentText);
  if (equalsIndex < 0) {
    return undefined;
  }

  const rawKey = argumentText.slice(0, equalsIndex);
  const trimmedKey = rawKey.trim();
  const rawKeyOffset = rawKey.indexOf(trimmedKey);
  if (!trimmedKey || rawKeyOffset < 0 || value !== trimmedKey) {
    return undefined;
  }

  const keyStartOffset = callContext.argumentStartOffset + rawKeyOffset;
  const keyEndOffset = keyStartOffset + trimmedKey.length;
  if (
    startOffset < keyStartOffset ||
    endOffset > keyEndOffset
  ) {
    return undefined;
  }

  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    value: trimmedKey,
  };
}

function directFieldKeywordLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): DirectFieldKeywordLiteral | undefined {
  const fullText = getDocumentText(document);
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const value = document.getText(wordRange);
  if (!isDirectFieldKeywordCandidate(value)) {
    return undefined;
  }

  const startOffset = document.offsetAt(wordRange.start);
  const endOffset = document.offsetAt(wordRange.end);
  const callContext = querysetDirectFieldKeywordCallContext(
    fullText,
    startOffset,
    endOffset
  );
  if (!callContext) {
    return undefined;
  }

  const argumentText = fullText.slice(
    callContext.argumentStartOffset,
    callContext.argumentEndOffset
  );
  const equalsIndex = findTopLevelEqualsIndex(argumentText);
  if (equalsIndex < 0) {
    return undefined;
  }

  const rawKey = argumentText.slice(0, equalsIndex);
  const trimmedKey = rawKey.trim();
  const rawKeyOffset = rawKey.indexOf(trimmedKey);
  if (!trimmedKey || rawKeyOffset < 0 || value !== trimmedKey) {
    return undefined;
  }

  const keyStartOffset = callContext.argumentStartOffset + rawKeyOffset;
  const keyEndOffset = keyStartOffset + trimmedKey.length;
  if (startOffset < keyStartOffset || endOffset > keyEndOffset) {
    return undefined;
  }

  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
    value: trimmedKey,
  };
}

function schemaFieldHoverLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): SchemaFieldLiteral | undefined {
  const lineText = document.lineAt(position.line).text;
  const wordRange = document.getWordRangeAtPosition(position, /[-A-Za-z_][\w-]*/);
  if (!wordRange) {
    return undefined;
  }

  const word = document.getText(wordRange);
  const start = wordRange.start.character;
  const end = wordRange.end.character;
  const quote = lineText[start - 1];
  if ((quote !== "'" && quote !== '"') || lineText[end] !== quote) {
    return undefined;
  }

  const prefixText = lineText.slice(0, start - 1);
  if (!/\b(?:fields|include)\s*=\s*\[[^\]]*$/.test(prefixText)) {
    return undefined;
  }

  return { value: word };
}

function metaConstraintLookupLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): MetaConstraintLookupLiteral | undefined {
  if (lookupDictKeyHoverMatchAtPosition(document, position)) {
    return undefined;
  }

  const fullText = getDocumentText(document);
  const wordRange = document.getWordRangeAtPosition(
    position,
    /[A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*/
  );
  if (!wordRange) {
    return undefined;
  }

  const value = document.getText(wordRange);
  if (!isLookupKeywordCandidate(value)) {
    return undefined;
  }

  const startOffset = document.offsetAt(wordRange.start);
  const endOffset = document.offsetAt(wordRange.end);
  const callContext = qExpressionKeywordCallContext(
    fullText,
    startOffset,
    endOffset
  );
  if (!callContext) {
    return undefined;
  }

  const argumentText = fullText.slice(
    callContext.argumentStartOffset,
    callContext.argumentEndOffset
  );
  const equalsIndex = findTopLevelEqualsIndex(argumentText);
  if (equalsIndex < 0) {
    return undefined;
  }

  const rawKey = argumentText.slice(0, equalsIndex);
  const trimmedKey = rawKey.trim();
  const rawKeyOffset = rawKey.indexOf(trimmedKey);
  if (!trimmedKey || rawKeyOffset < 0 || value !== trimmedKey) {
    return undefined;
  }

  const keyStartOffset = callContext.argumentStartOffset + rawKeyOffset;
  const keyEndOffset = keyStartOffset + trimmedKey.length;
  if (startOffset < keyStartOffset || endOffset > keyEndOffset) {
    return undefined;
  }

  return { value: trimmedKey };
}

function bulkUpdateFieldListHoverLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): BulkUpdateFieldListLiteral | undefined {
  const lineText = document.lineAt(position.line).text;
  const lineStartOffset = document.offsetAt(new vscode.Position(position.line, 0));

  for (const match of lineText.matchAll(BULK_UPDATE_FIELD_LIST_HOVER_PATTERN)) {
    const value = match[2];
    const prefix = match[0];
    const localOffset = prefix.lastIndexOf(value);
    const start = (match.index ?? 0) + localOffset;
    const end = start + value.length;

    if (position.character < start || position.character > end) {
      continue;
    }

    const callContext = bulkUpdateFieldListCallContext(
      getDocumentText(document),
      lineStartOffset + start
    );
    if (!callContext) {
      return undefined;
    }

    return {
      receiverExpression: callContext.receiverExpression,
      value,
    };
  }

  return undefined;
}

function relationHoverLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): { value: string } | undefined {
  const lineText = document.lineAt(position.line).text;
  for (const match of lineText.matchAll(RELATION_HOVER_PATTERN)) {
    const value = match[2];
    const prefix = match[0];
    const localOffset = prefix.lastIndexOf(value);
    const start = (match.index ?? 0) + localOffset;
    const end = start + value.length;

    if (position.character >= start && position.character < end) {
      return { value };
    }
  }

  return undefined;
}

function importReferenceAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): ImportReference | undefined {
  const positionOffset = document.offsetAt(position);
  const statement = collectParsedImportStatements(document).find(
    (candidate) =>
      candidate.startOffset <= positionOffset && positionOffset < candidate.endOffset
  );
  if (!statement) {
    return undefined;
  }

  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const hoveredWord = document.getText(wordRange);

  if (statement.kind === 'from') {
    if (!statement.moduleName) {
      return undefined;
    }

    for (const spec of statement.symbolSpecs) {
      if (
        hoveredWord === spec.importedName &&
        positionOffset >= spec.importedStartOffset &&
        positionOffset < spec.importedEndOffset
      ) {
        return {
          kind: 'symbol',
          moduleName: statement.moduleName,
          symbol: spec.importedName,
        };
      }

      if (
        spec.aliasName &&
        hoveredWord === spec.aliasName &&
        spec.aliasStartOffset !== undefined &&
        spec.aliasEndOffset !== undefined &&
        positionOffset >= spec.aliasStartOffset &&
        positionOffset < spec.aliasEndOffset
      ) {
        return {
          kind: 'symbol',
          moduleName: statement.moduleName,
          symbol: spec.importedName,
        };
      }
    }

    return undefined;
  }

  for (const spec of statement.moduleSpecs) {
    if (
      positionOffset >= spec.importedStartOffset &&
      positionOffset < spec.importedEndOffset &&
      spec.importedModule.split('.').includes(hoveredWord)
    ) {
      return {
        kind: 'module',
        moduleName: spec.importedModule,
      };
    }

    if (
      spec.aliasName &&
      hoveredWord === spec.aliasName &&
      spec.aliasStartOffset !== undefined &&
      spec.aliasEndOffset !== undefined &&
      positionOffset >= spec.aliasStartOffset &&
      positionOffset < spec.aliasEndOffset
    ) {
      return {
        kind: 'module',
        moduleName: spec.importedModule,
      };
    }
  }

  return undefined;
}

async function resolveImportReferenceAtPosition(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<ImportReference | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const directReference = importReferenceAtPosition(document, position);
  if (directReference) {
    return directReference;
  }

  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const hoveredWord = document.getText(wordRange);
  const beforeOffset = document.offsetAt(wordRange.start);
  const bindings = collectImportBindings(document, beforeOffset);

  const moduleMemberReference = await resolveImportedModuleMemberReference(
    daemon,
    document,
    wordRange,
    bindings,
    hoveredWord
  );
  if (moduleMemberReference) {
    return moduleMemberReference;
  }

  const moduleName = await resolveImportedModuleAlias(
    daemon,
    bindings,
    hoveredWord
  );
  if (moduleName) {
    return {
      kind: 'module',
      moduleName,
    };
  }

  const directBinding = bindings.symbols.get(hoveredWord);
  if (!directBinding) {
    return undefined;
  }

  return {
    kind: 'symbol',
    moduleName: directBinding.moduleName,
    symbol: directBinding.symbolName,
  };
}

async function resolveTypeHintHoverTargetAtPosition(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<TypeHintHoverTarget | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const annotationSegment = typeAnnotationSegmentAtPosition(document, position);
  if (!annotationSegment) {
    return undefined;
  }

  const referenceText = classReferenceExpressionAtPosition(document, position);
  if (!referenceText) {
    return undefined;
  }

  const beforeOffset = document.offsetAt(
    new vscode.Position(position.line, annotationSegment.start)
  );
  const classSource = await resolveClassDefinitionSource(
    daemon,
    document,
    referenceText,
    beforeOffset
  );
  if (classSource) {
    const category = await resolveClassHoverCategory(
      daemon,
      classSource,
      new Set()
    );
    return {
      kind: 'class',
      source: classSource,
      category,
      referenceText,
      specialKind: await resolveSpecialClassKind(
        daemon,
        classSource,
        new Set()
      ),
    };
  }

  const canonicalName = await canonicalTypeAnnotationName(
    daemon,
    document,
    referenceText,
    beforeOffset
  );
  const category = typeHintCategory(canonicalName);
  if (!category) {
    return undefined;
  }

  return {
    kind: 'type',
    canonicalName,
    category,
    referenceText,
  };
}

async function resolveClassHoverTargetAtPosition(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<ClassHoverTarget | undefined> {
  if (daemon.isAborted()) { daemon.logDiagnostic(`[classHover:aborted] ${position.line}:${position.character}`); return undefined; }
  const classDefinition = classDefinitionAtPosition(document, position);
  const referenceText = classDefinition
    ? classDefinition.name
    : classReferenceExpressionAtPosition(document, position);
  if (!referenceText) {
    return undefined;
  }

  const referenceName = referenceText.split('.').at(-1);
  if (!referenceName || !/^[A-Z]/.test(referenceName)) {
    return undefined;
  }

  const beforeOffset = classDefinition
    ? document.offsetAt(new vscode.Position(classDefinition.line, 0))
    : document.offsetAt(position);
  const source = await resolveClassDefinitionSource(
    daemon,
    document,
    referenceText,
    beforeOffset
  );
  if (!source) {
    return undefined;
  }

  return {
    source,
    category: await resolveClassHoverCategory(daemon, source, new Set()),
    specialKind: await resolveSpecialClassKind(daemon, source, new Set()),
    referenceText,
    fromDefinition: Boolean(classDefinition),
  };
}

async function resolveImportedModuleMemberReference(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  wordRange: vscode.Range,
  bindings: ImportBindings,
  memberName: string
): Promise<ImportReference | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const lineText = document.lineAt(wordRange.start.line).text;
  if (
    wordRange.start.character === 0 ||
    lineText[wordRange.start.character - 1] !== '.'
  ) {
    return undefined;
  }

  let objectEnd = wordRange.start.character - 1;
  let objectStart = objectEnd;
  while (objectStart > 0 && /[A-Za-z0-9_]/.test(lineText[objectStart - 1] ?? '')) {
    objectStart -= 1;
  }

  const objectName = lineText.slice(objectStart, objectEnd);
  if (!/^[A-Za-z_][\w]*$/.test(objectName)) {
    return undefined;
  }

  const moduleName = await resolveImportedModuleAlias(
    daemon,
    bindings,
    objectName
  );
  if (!moduleName) {
    return undefined;
  }

  return {
    kind: 'symbol',
    moduleName,
    symbol: memberName,
  };
}

function buildRelationHover(
  value: string,
  resolution: RelationTargetResolution
): vscode.Hover | undefined {
  if (!resolution.resolved || !resolution.target) {
    return undefined;
  }

  const markdown = buildRelationTargetMarkdown(resolution.target);
  markdown.appendMarkdown(`\n\nResolved from string reference \`${value}\`.`);
  return new vscode.Hover(markdown);
}

async function buildImportHover(
  daemon: AnalysisDaemon,
  reference: ImportReference
): Promise<vscode.Hover | undefined> {
  if (daemon.isAborted()) { return undefined; }
  if (reference.kind === 'module') {
    return buildModuleImportHover(
      reference.moduleName,
      await daemon.resolveModule(reference.moduleName)
    );
  }

  const target = await resolveImportedSymbolOrModule(
    daemon,
    reference.moduleName,
    reference.symbol
  );
  if (!target) {
    return undefined;
  }

  if (target.kind === 'module') {
    return buildModuleImportHover(target.moduleName, target.resolution);
  }

  return buildSymbolImportHover(daemon, target.resolution);
}

function buildTypeHintHover(
  target: TypeHintHoverTarget
): vscode.Hover | undefined {
  if (target.kind === 'class') {
    return buildTypeHintClassHover(target);
  }

  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Type Hint**\n\n`);
  markdown.appendMarkdown(`Type: \`${target.canonicalName}\``);
  markdown.appendMarkdown(`\n\nCategory: \`${target.category}\``);
  markdown.appendMarkdown(
    `\n\nResolved from type hint \`${target.referenceText}\`.`
  );
  return new vscode.Hover(markdown);
}

function buildTypeHintClassHover(
  target: Extract<TypeHintHoverTarget, { kind: 'class' }>
): vscode.Hover | undefined {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Type Hint Class**\n\n`);

  const moduleName = moduleNameForDocument(target.source.document);
  if (moduleName) {
    markdown.appendMarkdown(`defined in \`${moduleName}\`.`);
  }

  markdown.appendMarkdown(
    `\n\nResolved symbol: \`${qualifiedClassSymbol(
      target.source.document,
      target.source.classDef.name
    )}\``
  );
  appendImportFilePath(markdown, target.source.document.uri.fsPath);
  markdown.appendMarkdown(`\n\nClass category: \`${target.category}\``);

  if (target.specialKind) {
    markdown.appendMarkdown(`\n\nClass kind: \`${target.specialKind}\``);
  }

  markdown.appendMarkdown(
    `\n\nResolved from type hint \`${target.referenceText}\`.`
  );
  return new vscode.Hover(markdown);
}

function buildClassHover(
  target: ClassHoverTarget
): vscode.Hover | undefined {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${classHoverTitle(target)}**\n\n`);

  const moduleName = moduleNameForDocument(target.source.document);
  if (moduleName) {
    markdown.appendMarkdown(`Defined in \`${moduleName}\`.`);
  }

  markdown.appendMarkdown(
    `\n\nResolved symbol: \`${qualifiedClassSymbol(
      target.source.document,
      target.source.classDef.name
    )}\``
  );
  appendImportFilePath(markdown, target.source.document.uri.fsPath);
  markdown.appendMarkdown(`\n\nClass category: \`${target.category}\``);
  if (target.specialKind) {
    markdown.appendMarkdown(`\n\nClass kind: \`${target.specialKind}\``);
  }
  markdown.appendMarkdown(
    `\n\nResolved from ${
      target.fromDefinition ? 'class definition' : 'class reference'
    } \`${target.referenceText}\`.`
  );
  return new vscode.Hover(markdown);
}

async function resolveReceiverInstanceHoverAtPosition(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Hover | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const receiverExpression = receiverExpressionPrefixAtPosition(
    document,
    position
  );
  if (!receiverExpression) {
    return undefined;
  }

  const beforeOffset = document.offsetAt(receiverExpression.range.end);

  const ormReceiver = await resolveOrmReceiverAtOffset(
    daemon,
    document,
    receiverExpression.expression,
    beforeOffset,
    new Set()
  );
  const classSource = await resolveClassDefinitionForExpression(
    daemon,
    document,
    receiverExpression.expression,
    beforeOffset,
    new Set()
  );

  if (classSource) {
    const category = await resolveClassHoverCategory(
      daemon,
      classSource,
      new Set()
    );
    const specialKind = await resolveSpecialClassKind(
      daemon,
      classSource,
      new Set()
    );
    return buildReceiverInstanceHover(
      receiverExpression.expression,
      receiverExpression.range,
      classSource,
      ormReceiver?.kind,
      category,
      specialKind,
      ormReceiver?.modelLabel
    );
  }

  if (!ormReceiver || ormReceiver.kind !== 'instance') {
    return undefined;
  }

  const targets = await listAllRelationTargets(daemon);
  const target = targets.items.find((item) => item.label === ormReceiver.modelLabel);
  if (!target) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(
    `**${receiverExpression.expression}**: \`${target.objectName}\` instance\n\n`
  );
  markdown.appendMarkdown(`Model: \`${target.label}\`\n\n`);
  markdown.appendMarkdown(`Module: \`${target.module}\``);
  appendImportFilePath(markdown, target.filePath);
  return new vscode.Hover(markdown, receiverExpression.range);
}

function buildFastAssignedOrmInstanceHover(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Hover | undefined {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const variableName = document.getText(wordRange);
  if (!/^[a-z_][\w]*$/.test(variableName)) {
    return undefined;
  }

  const receiver = resolveAssignedOrmReceiverLocal(
    daemon,
    document,
    variableName,
    document.offsetAt(wordRange.end),
    new Set()
  );
  if (!receiver || receiver.kind !== 'instance') {
    return undefined;
  }

  const objectName = receiver.modelLabel.split('.').at(-1) ?? receiver.modelLabel;
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(
    `**${variableName}**: \`${objectName}\` instance\n\n`
  );
  markdown.appendMarkdown(`Model: \`${receiver.modelLabel}\``);
  return new vscode.Hover(markdown, wordRange);
}

function resolveAssignedOrmReceiverLocal(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number,
  visited: Set<string>
): OrmReceiverInfo | undefined {
  const visitKey = `${document.uri.toString()}:fast-assigned:${variableName}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 100) {
    return undefined;
  }
  visited.add(visitKey);

  const assignment = findNearestAssignedExpression(
    document,
    variableName,
    beforeOffset
  );
  if (!assignment) {
    return undefined;
  }

  return resolveExpressionOrmReceiverLocal(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    visited
  );
}

function resolveExpressionOrmReceiverLocal(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number,
  visited: Set<string>
): OrmReceiverInfo | undefined {
  const normalizedExpression = normalizeReceiverExpression(expression);
  if (!normalizedExpression || isMalformedReceiverExpression(normalizedExpression)) {
    return undefined;
  }

  const fastPath = tryFastPathReceiverKind(daemon, normalizedExpression);
  if (fastPath) {
    return fastPath;
  }

  const annotatedSelfMemberReceiver =
    resolveSelfMemberReceiverFromTypeAnnotationLocal(
      daemon,
      document,
      normalizedExpression,
      beforeOffset
    );
  if (annotatedSelfMemberReceiver) {
    return annotatedSelfMemberReceiver;
  }

  const parsedCall = parseCalledExpression(normalizedExpression);
  if (parsedCall?.kind === 'member') {
    const objectReceiver = resolveExpressionOrmReceiverLocal(
      daemon,
      document,
      parsedCall.objectExpression,
      beforeOffset,
      visited
    );
    if (!objectReceiver) {
      return undefined;
    }
    const returnKind = inferBuiltinManagerOrQuerysetReturnKind(
      parsedCall.memberName
    );
    if (returnKind) {
      const virtualFields = propagateVirtualFields(
        objectReceiver,
        returnKind,
        parsedCall.memberName,
        normalizedExpression
      );
      return {
        kind: returnKind,
        modelLabel: objectReceiver.modelLabel,
        managerName: objectReceiver.managerName,
        virtualFields,
      };
    }
  }

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (memberAccess) {
    const objectReceiver = resolveExpressionOrmReceiverLocal(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      visited
    );
    if (!objectReceiver) {
      return undefined;
    }

    const memberResolution = daemon.resolveOrmMemberLocal(
      objectReceiver.modelLabel,
      objectReceiver.kind,
      memberAccess.memberName
    );
    if (memberResolution?.resolved && memberResolution.item) {
      return receiverFromOrmMemberResolution(
        memberResolution,
        objectReceiver,
        memberAccess.memberName
      );
    }
    return undefined;
  }

  const rootIdentifier = receiverRootIdentifier(normalizedExpression);
  if (!rootIdentifier) {
    return undefined;
  }

  return resolveAssignedOrmReceiverLocal(
    daemon,
    document,
    rootIdentifier,
    beforeOffset,
    visited
  );
}

function resolveSelfMemberReceiverFromTypeAnnotationLocal(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number
): OrmReceiverInfo | undefined {
  const memberAccess = splitTopLevelMemberAccess(expression);
  if (
    !memberAccess ||
    (memberAccess.objectExpression !== 'self' &&
      memberAccess.objectExpression !== 'cls')
  ) {
    return undefined;
  }

  const classDef = findEnclosingClassDefinition(document, beforeOffset);
  if (!classDef) {
    return undefined;
  }

  const typeAnnotation = findClassAttributeTypeAnnotation(
    document,
    classDef,
    memberAccess.memberName
  );
  if (!typeAnnotation) {
    return undefined;
  }

  return resolveDirectReceiverFromTypeAnnotationLocal(
    daemon,
    typeAnnotation.annotation
  );
}

function resolveDirectReceiverFromTypeAnnotationLocal(
  daemon: AnalysisDaemon,
  annotation: string
): OrmReceiverInfo | undefined {
  const normalizedAnnotation = normalizeTypeAnnotation(annotation);
  if (!normalizedAnnotation) {
    return undefined;
  }

  const genericType = parseGenericTypeAnnotation(normalizedAnnotation);
  if (genericType && genericType.args[0]) {
    const baseName = stripStringLiteralQuotes(genericType.base).split('.').at(-1);
    const modelLabel = resolveModelLabelFromTypeAnnotationLocal(
      daemon,
      genericType.args[0]
    );
    if (!baseName || !modelLabel) {
      return undefined;
    }

    if (baseName === 'QuerySet') {
      return { kind: 'queryset', modelLabel };
    }
    if (baseName === 'Manager' || baseName === 'BaseManager') {
      return { kind: 'manager', modelLabel };
    }
    if (baseName === 'RelatedManager' || baseName === 'ManyRelatedManager') {
      return { kind: 'related_manager', modelLabel };
    }
  }

  // Root-cause fix (custom QuerySet/Manager class in an annotation): a bare
  // custom class name like `HrmEmpQuerySet` / `HrmEmpManager` (e.g. from
  // `def get_emps(...) -> HrmEmpQuerySet`) maps by convention to its model
  // `<Model>`. Gated on the residual resolving to a KNOWN model so a real
  // model literally named e.g. `FooManager` is not mis-stripped.
  const bareName = stripStringLiteralQuotes(normalizedAnnotation)
    .split('.')
    .at(-1);
  const suffixMatch = bareName?.match(
    /^(.+?)(QuerySet|RelatedManager|ManyRelatedManager|BaseManager|Manager)$/
  );
  if (suffixMatch && suffixMatch[1]) {
    const residual = suffixMatch[1];
    const residualLabel =
      daemon.findModelLabelByShortName(residual) ??
      daemon.modelLabelByName.get(residual);
    if (residualLabel) {
      const suffix = suffixMatch[2];
      const kind: OrmReceiverKind =
        suffix === 'QuerySet'
          ? 'queryset'
          : suffix === 'RelatedManager' || suffix === 'ManyRelatedManager'
          ? 'related_manager'
          : 'manager';
      return { kind, modelLabel: residualLabel };
    }
  }

  const modelLabel = resolveModelLabelFromTypeAnnotationLocal(
    daemon,
    normalizedAnnotation
  );
  return modelLabel ? { kind: 'instance', modelLabel } : undefined;
}

function resolveModelLabelFromTypeAnnotationLocal(
  daemon: AnalysisDaemon,
  annotation: string
): string | undefined {
  for (const candidate of splitTopLevelTypeAlternatives(annotation)) {
    const strippedCandidate = stripStringLiteralQuotes(
      normalizeTypeAnnotation(candidate)
    );
    if (!strippedCandidate) {
      continue;
    }

    const genericType = parseGenericTypeAnnotation(strippedCandidate);
    if (genericType && genericType.args[0]) {
      const nestedLabel = resolveModelLabelFromTypeAnnotationLocal(
        daemon,
        genericType.args[0]
      );
      if (nestedLabel) {
        return nestedLabel;
      }
    }

    const simpleName = strippedCandidate.includes('.')
      ? strippedCandidate.split('.').at(-1)!
      : strippedCandidate;
    const localLabel =
      daemon.findModelLabelByShortName(simpleName) ??
      daemon.modelLabelByName.get(simpleName);
    if (localLabel) {
      return localLabel;
    }
    // Custom QuerySet/Manager class-name convention: `<Model>QuerySet` /
    // `<Model>Manager` -> `<Model>` (e.g. a `def f(...) -> HrmEmpQuerySet`
    // annotation maps to the `HrmEmp` model). Gated on the residual resolving
    // to a known model so a real model named e.g. `FooManager` is not stripped.
    const suffixMatch = simpleName.match(
      /^(.+?)(QuerySet|RelatedManager|ManyRelatedManager|BaseManager|Manager)$/
    );
    if (suffixMatch && suffixMatch[1]) {
      const residualLabel =
        daemon.findModelLabelByShortName(suffixMatch[1]) ??
        daemon.modelLabelByName.get(suffixMatch[1]);
      if (residualLabel) {
        return residualLabel;
      }
    }
  }

  return undefined;
}

function buildReceiverInstanceHover(
  expression: string,
  range: vscode.Range,
  classSource: ClassDefinitionSource,
  receiverKind: OrmReceiverKind | undefined,
  category: ClassHoverCategory,
  specialKind?: SpecialClassKind,
  modelLabel?: string
): vscode.Hover {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(
    `**${expression}**: \`${classSource.classDef.name}\` ${receiverHoverKindLabel(
      receiverKind,
      specialKind
    )}\n\n`
  );

  const moduleName = moduleNameForDocument(classSource.document);
  if (moduleName) {
    markdown.appendMarkdown(`Defined in \`${moduleName}\`.`);
  }

  markdown.appendMarkdown(
    `\n\nResolved symbol: \`${qualifiedClassSymbol(
      classSource.document,
      classSource.classDef.name
    )}\``
  );
  if (modelLabel) {
    markdown.appendMarkdown(`\n\nModel: \`${modelLabel}\``);
  }
  appendImportFilePath(markdown, classSource.document.uri.fsPath);
  markdown.appendMarkdown(`\n\nClass category: \`${category}\``);
  if (specialKind) {
    markdown.appendMarkdown(`\n\nClass kind: \`${specialKind}\``);
  }

  return new vscode.Hover(markdown, range);
}

function receiverHoverKindLabel(
  receiverKind: OrmReceiverKind | undefined,
  specialKind?: SpecialClassKind
): string {
  if (specialKind === 'related_manager' || receiverKind === 'related_manager') {
    return 'related manager';
  }

  if (specialKind === 'queryset' || receiverKind === 'queryset') {
    return 'queryset';
  }

  if (specialKind === 'manager' || receiverKind === 'manager') {
    return 'manager';
  }

  if (receiverKind === 'model_class') {
    return 'model class';
  }

  return 'instance';
}

async function buildSymbolImportHover(
  daemon: AnalysisDaemon,
  resolution: ExportOriginResolution
): Promise<vscode.Hover | undefined> {
  if (!resolution.resolved || !resolution.originModule) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Imported Symbol**\n\n`);

  const qualifiedSymbol = resolution.originSymbol
    ? `${resolution.originModule}.${resolution.originSymbol}`
    : resolution.originModule;

  if (resolution.originModule === resolution.requestedModule) {
    markdown.appendMarkdown(`Imported from \`${resolution.requestedModule}\`.`);
  } else {
    markdown.appendMarkdown(
      `Imported from \`${resolution.requestedModule}\`, defined in \`${resolution.originModule}\`.`
    );
  }

  markdown.appendMarkdown(`\n\nResolved symbol: \`${qualifiedSymbol}\``);
  appendImportFilePath(markdown, resolution.originFilePath);

  const importedClassHoverTarget = await resolveImportedClassHoverTarget(
    daemon,
    resolution
  );
  if (importedClassHoverTarget) {
    markdown.appendMarkdown(`\n\nSymbol kind: \`class\``);
    markdown.appendMarkdown(`\n\nDefined in \`${resolution.originModule}\`.`);
    markdown.appendMarkdown(
      `\n\nClass category: \`${importedClassHoverTarget.category}\``
    );
    if (importedClassHoverTarget.specialKind) {
      markdown.appendMarkdown(
        `\n\nClass kind: \`${importedClassHoverTarget.specialKind}\``
      );
    }
  }

  if (resolution.viaModules.length > 1) {
    markdown.appendMarkdown(
      `\n\nResolution path: \`${resolution.viaModules.join(' -> ')}\``
    );
  }

  return new vscode.Hover(markdown);
}

async function resolveImportedClassHoverTarget(
  daemon: AnalysisDaemon,
  resolution: ExportOriginResolution
): Promise<ClassHoverTarget | undefined> {
  if (daemon.isAborted()) { return undefined; }
  if (!resolution.originFilePath || !resolution.originSymbol) {
    return undefined;
  }

  const document = await vscode.workspace.openTextDocument(
    resolution.originFilePath
  );
  const classDef = findClassDefinition(document, resolution.originSymbol);
  if (!classDef) {
    return undefined;
  }

  const source = {
    document,
    classDef,
    beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
  };

  return {
    source,
    category: await resolveClassHoverCategory(daemon, source, new Set()),
    specialKind: await resolveSpecialClassKind(daemon, source, new Set()),
    referenceText: resolution.symbol,
    fromDefinition: false,
  };
}

function buildModuleImportHover(
  moduleName: string,
  resolution: ModuleResolution
): vscode.Hover | undefined {
  if (!resolution.resolved) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Imported Module**\n\n`);
  markdown.appendMarkdown(`Module: \`${moduleName}\``);
  appendImportFilePath(markdown, resolution.filePath);
  return new vscode.Hover(markdown);
}

function classHoverTitle(target: ClassHoverTarget): string {
  if (target.specialKind) {
    return specialClassHoverTitle(target.specialKind);
  }

  return target.category === 'django' ? 'Django Class' : 'Class';
}

function specialClassHoverTitle(kind: SpecialClassKind): string {
  if (kind === 'queryset') {
    return 'QuerySet Class';
  }

  if (kind === 'related_manager') {
    return 'Related Manager Class';
  }

  return 'Manager Class';
}

function qualifiedClassSymbol(
  document: vscode.TextDocument,
  className: string
): string {
  const moduleName = moduleNameForDocument(document);
  return moduleName ? `${moduleName}.${className}` : className;
}

function appendImportFilePath(
  markdown: vscode.MarkdownString,
  filePath: string | undefined
): void {
  if (!filePath) {
    return;
  }

  markdown.appendMarkdown(`\n\nFile: \`${displayImportFilePath(filePath)}\``);
}

function displayImportFilePath(filePath: string): string {
  const configuredRoot = getExtensionSettings(vscode.Uri.file(filePath)).workspaceRoot;
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))
    ?.uri.fsPath;
  const candidateRoots = [configuredRoot, workspaceRoot].filter(
    (value): value is string => Boolean(value)
  );

  for (const rootPath of candidateRoots) {
    const relativePath = path.relative(path.resolve(rootPath), path.resolve(filePath));
    if (
      relativePath &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    ) {
      return relativePath.split(path.sep).join('/');
    }
  }

  return vscode.workspace.asRelativePath(filePath, false);
}

/**
 * Append the inferred terminal type of a resolved lookup chain to the hover.
 *
 * For `A__B__C` this surfaces C's concrete Python type (e.g. `int`), and for
 * transform chains like `pubdate__year` the POST-transform type. Prefers the
 * resolver-provided `terminalType` (the only source that survives transforms,
 * since the matched `target` keeps the pre-transform field kind); falls back
 * to mapping the matched field kind client-side so plain chains still get a
 * type even from older daemon/native builds that predate `terminalType`.
 *
 * Relation terminals are skipped — their type is the related model, already
 * surfaced via the "Related model" line.
 */
function appendTerminalTypeMarkdown(
  markdown: vscode.MarkdownString,
  resolution: LookupPathResolution
): void {
  const target = resolution.target;
  if (!target) {
    return;
  }
  if (
    target.fieldKind === 'lookup_operator' ||
    target.fieldKind === 'lookup_transform'
  ) {
    return;
  }

  const terminalType = resolution.terminalType;

  // A chain ending in a comparison lookup (filter/exclude/Q: `__contains`,
  // `__in`, `__isnull`, `__gte`, …) is a BOOLEAN PREDICATE — the condition
  // evaluates to `bool`, and only the value you pass (the operand) carries a
  // field-determined type. Surface both, rather than the terminal field type,
  // which would be misleading for a predicate.
  if (terminalType?.lookupOperator) {
    markdown.appendMarkdown('\n\nPredicate: `bool`');
    if (terminalType.operandPythonType) {
      markdown.appendMarkdown(
        `\n\nOperand type: \`${terminalType.operandPythonType}\``
      );
    }
    return;
  }

  // No comparison operator: the chain denotes a VALUE. For a relation terminal
  // (e.g. `...__company`) that value is the related model.
  if (target.isRelation) {
    if (target.relatedModelLabel) {
      const isCollection =
        target.fieldKind.includes('ManyToMany') ||
        target.relationDirection === 'reverse';
      markdown.appendMarkdown(
        `\n\nResulting type: \`${target.relatedModelLabel}\`${
          isCollection ? ' (related manager)' : ' (model instance)'
        }`
      );
    }
    return;
  }

  // Scalar terminal (field C, or a transform output like `__year` used in
  // values()/annotate()): surface its concrete python type.
  let outputFieldKind: string | undefined;
  let pythonType: string | undefined;
  let isTransformed = false;
  if (terminalType) {
    outputFieldKind = terminalType.outputFieldKind;
    pythonType = terminalType.pythonType;
    isTransformed = terminalType.isTransformed;
  } else if (target.pythonType) {
    outputFieldKind = target.outputFieldKind ?? target.fieldKind;
    pythonType = target.pythonType;
  } else if (target.fieldKind) {
    outputFieldKind = target.fieldKind;
    pythonType = pythonTypeForKind(target.fieldKind);
  }

  if (!pythonType) {
    return;
  }

  markdown.appendMarkdown(`\n\nResulting type: \`${pythonType}\``);
  if (
    isTransformed &&
    outputFieldKind &&
    outputFieldKind !== target.fieldKind
  ) {
    markdown.appendMarkdown(
      ` _(transformed: \`${target.fieldKind}\` → \`${outputFieldKind}\`)_`
    );
  }
}

function buildLookupHover(
  value: string,
  method: string,
  baseModelLabel: string,
  resolution: LookupPathResolution
): vscode.Hover | undefined {
  if (!resolution.resolved || !resolution.target) {
    return undefined;
  }

  const markdown = buildLookupItemMarkdown(
    resolution.target,
    method,
    baseModelLabel
  );
  if (resolution.lookupOperator) {
    markdown.appendMarkdown(
      `\n\nLookup operator: \`${resolution.lookupOperator}\``
    );
  }
  appendTerminalTypeMarkdown(markdown, resolution);
  if (resolution.resolvedSegments && resolution.resolvedSegments.length > 0) {
    markdown.appendMarkdown(
      `\n\nResolved path: \`${resolution.resolvedSegments
        .map((segment) => segment.name)
        .join('__')}\``
    );
  }
  markdown.appendMarkdown(`\n\nResolved from lookup path \`${value}\`.`);
  return new vscode.Hover(markdown);
}

function buildRelationTargetMarkdown(
  item: RelationTargetItem
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${item.label}**\n\n`);
  markdown.appendMarkdown(`Module: \`${item.module}\`\n\n`);
  markdown.appendMarkdown(
    `Resolved symbol: \`${relationTargetQualifiedSymbol(item)}\`\n\n`
  );
  markdown.appendMarkdown(`Import hint: \`${relationTargetImportHint(item)}\`\n\n`);
  markdown.appendMarkdown(`Source: \`${item.source}\``);
  appendImportFilePath(markdown, item.filePath);

  if (item.fieldNames.length > 0) {
    markdown.appendMarkdown(
      `\n\nFields: \`${item.fieldNames.slice(0, 8).join('`, `')}\``
    );
  }

  if (item.relationNames.length > 0) {
    markdown.appendMarkdown(
      `\n\nRelations: \`${item.relationNames.slice(0, 8).join('`, `')}\``
    );
  }

  if (item.reverseRelationNames.length > 0) {
    markdown.appendMarkdown(
      `\n\nReverse: \`${item.reverseRelationNames.slice(0, 8).join('`, `')}\``
    );
  }

  return markdown;
}

function relationTargetQualifiedSymbol(item: RelationTargetItem): string {
  return `${item.module}.${item.objectName}`;
}

function relationTargetImportHint(item: RelationTargetItem): string {
  return `from ${item.module} import ${item.objectName}`;
}

function buildLookupItemMarkdown(
  item: LookupPathItem,
  method: string,
  baseModelLabel: string
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${item.name}**\n\n`);
  markdown.appendMarkdown(`Method: \`${lookupMethodLabel(method)}\`\n\n`);
  markdown.appendMarkdown(`Base model: \`${baseModelLabel}\`\n\n`);
  markdown.appendMarkdown(`Owner model: \`${item.modelLabel}\`\n\n`);
  if (item.fieldPath) {
    markdown.appendMarkdown(`Field path: \`${item.fieldPath}\`\n\n`);
  }
  if (item.fieldKind === 'lookup_operator') {
    markdown.appendMarkdown(`Lookup operator: \`${item.lookupOperator ?? item.name}\``);
    return markdown;
  }
  if (item.fieldKind === 'lookup_transform') {
    markdown.appendMarkdown(`Lookup transform: \`${item.name}\``);
    return markdown;
  }

  markdown.appendMarkdown(`Field kind: \`${item.fieldKind}\``);

  if (item.relatedModelLabel) {
    markdown.appendMarkdown(`\n\nRelated model: \`${item.relatedModelLabel}\``);
  }

  if (item.relationDirection) {
    markdown.appendMarkdown(`\n\nRelation direction: \`${item.relationDirection}\``);
  }

  return markdown;
}

function cancelledCompletionResult(
  token: vscode.CancellationToken
): undefined {
  if (token.isCancellationRequested) {
    return undefined;
  }

  return undefined;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  isCancelled: () => boolean,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (!isCancelled()) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function resetProviderResolutionCaches(): void {
  allRelationTargetsCache = new WeakMap<AnalysisDaemon, Promise<RelationTargetsResult>>();
  staticQuerySetClassSourceCache = new WeakMap<
    AnalysisDaemon,
    Map<string, Promise<ClassDefinitionSource | undefined>>
  >();
  customMethodVirtualFieldsCache = new WeakMap<
    AnalysisDaemon,
    Map<string, Promise<VirtualOrmField[]>>
  >();
  functionReceiverCache = new WeakMap<
    AnalysisDaemon,
    Map<string, Promise<OrmReceiverInfo | undefined>>
  >();
  functionModelLabelCache = new WeakMap<
    AnalysisDaemon,
    Map<string, Promise<string | undefined>>
  >();
  modelSubclassRelationCache.clear();
  // Clear the per-document receiver cache too, so a daemon-state change
  // (e.g. warmup -> ready) re-resolves receivers that were cached as
  // unresolvable during the cold-start window. (It is already version-keyed
  // for edits; this covers the daemon-readiness transition.)
  _ormReceiverCacheByDocument.clear();
}

async function listAllRelationTargets(
  daemon: AnalysisDaemon
): Promise<RelationTargetsResult> {
  const cached = allRelationTargetsCache.get(daemon);
  if (cached) {
    return cached;
  }

  const request = daemon.listRelationTargets('');
  allRelationTargetsCache.set(daemon, request);
  try {
    return await request;
  } catch (error) {
    if (allRelationTargetsCache.get(daemon) === request) {
      allRelationTargetsCache.delete(daemon);
    }
    throw error;
  }
}

async function resolveClassDefinitionForModelLabel(
  daemon: AnalysisDaemon,
  modelLabel: string
): Promise<ClassDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const targets = await listAllRelationTargets(daemon);
  const target = targets.items.find((item) => item.label === modelLabel);
  if (!target?.filePath) {
    return undefined;
  }

  const document = await vscode.workspace.openTextDocument(target.filePath);
  const classDef = findClassDefinition(document, target.objectName);
  if (!classDef) {
    return undefined;
  }

  return {
    document,
    classDef,
    beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
  };
}

async function listLookupPathCompletionsFast(
  daemon: AnalysisDaemon,
  baseModelLabel: string,
  prefix: string,
  method: string,
  allowColdMissRetry = true
): Promise<LookupPathCompletionsResult> {
  // Empty prefix means "enumerate every top-level field/relation" — a real
  // model should never produce 0 items for that, so treat empty results as
  // "fast path didn't actually have the data" and fall through to the slower
  // but authoritative IPC daemon. This matters on very large workspaces where
  // the native index can report resolved=true with no field detail.
  const requiresCompleteEnumeration = prefix.length === 0;

  const local = daemon.listLookupPathCompletionsLocal(baseModelLabel, prefix, method);
  if (local && local.resolved && (local.items.length > 0 || !requiresCompleteEnumeration)) {
    daemon.logDiagnostic(
      `[completion:lookup:layer] local model=${baseModelLabel} items=${local.items.length} truncated=${Boolean(
        local.truncated
      )}`
    );
    return local;
  }
  if (local) {
    daemon.logDiagnostic(
      `[completion:lookup:layer] local-skipped model=${baseModelLabel} resolved=${Boolean(
        local.resolved
      )} items=${local.items.length} reason=${local.reason ?? 'unresolved'}`
    );
  }

  const native = daemon.listLookupPathCompletionsNative(baseModelLabel, prefix, method);
  if (native && native.resolved && (native.items.length > 0 || !requiresCompleteEnumeration)) {
    daemon.logDiagnostic(
      `[completion:lookup:layer] native model=${baseModelLabel} items=${native.items.length} truncated=${Boolean(
        native.truncated
      )}`
    );
    return native;
  }
  if (native) {
    daemon.logDiagnostic(
      `[completion:lookup:layer] native-skipped model=${baseModelLabel} resolved=${Boolean(
        native.resolved
      )} items=${native.items.length} reason=${native.reason ?? 'unresolved'}`
    );
  }

  const ipc = await daemon.listLookupPathCompletions(baseModelLabel, prefix, method);
  daemon.logDiagnostic(
    `[completion:lookup:layer] ipc model=${baseModelLabel} items=${ipc.items.length} resolved=${Boolean(
      ipc.resolved
    )} truncated=${Boolean(ipc.truncated)}`
  );
  if (allowColdMissRetry && ipc.items.length === 0 && prefix.includes('__')) {
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    const retryLocal = daemon.listLookupPathCompletionsLocal(
      baseModelLabel,
      prefix,
      method
    );
    if (retryLocal && retryLocal.resolved && retryLocal.items.length > 0) {
      daemon.logDiagnostic(
        `[completion:lookup:layer] retry-local model=${baseModelLabel} items=${retryLocal.items.length} truncated=${Boolean(
          retryLocal.truncated
        )}`
      );
      return retryLocal;
    }

    const retryNative = daemon.listLookupPathCompletionsNative(
      baseModelLabel,
      prefix,
      method
    );
    if (retryNative && retryNative.resolved && retryNative.items.length > 0) {
      daemon.logDiagnostic(
        `[completion:lookup:layer] retry-native model=${baseModelLabel} items=${retryNative.items.length} truncated=${Boolean(
          retryNative.truncated
        )}`
      );
      return retryNative;
    }

    const retryIpc = await daemon.listLookupPathCompletions(
      baseModelLabel,
      prefix,
      method
    );
    daemon.logDiagnostic(
      `[completion:lookup:layer] retry-ipc model=${baseModelLabel} items=${retryIpc.items.length} resolved=${Boolean(
        retryIpc.resolved
      )} truncated=${Boolean(retryIpc.truncated)}`
    );
    if (retryIpc.items.length > 0 || retryIpc.resolved) {
      return retryIpc;
    }
  }
  return ipc;
}

function mergeLookupCompletionItems(
  baseItems: LookupPathItem[],
  additionalItems: LookupPathItem[]
): LookupPathItem[] {
  if (additionalItems.length === 0) {
    return baseItems;
  }

  const merged = [...baseItems];
  const seenKeys = new Set(
    baseItems.map((item) => `${item.name}:${item.lookupOperator ?? ''}`)
  );
  for (const item of additionalItems) {
    const key = `${item.name}:${item.lookupOperator ?? ''}`;
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    merged.push(item);
  }

  return merged;
}

function hasSuppressingPartialLookupCompletion(
  value: string,
  items: LookupPathItem[]
): boolean {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return items.length > 0;
  }

  const currentSegment =
    trimmedValue.split('__').filter(Boolean).at(-1)?.toLowerCase() ??
    trimmedValue.toLowerCase();
  if (!currentSegment) {
    return items.length > 0;
  }

  return items.some((item) => {
    const itemName = item.name.toLowerCase();
    const fieldSegment =
      item.fieldPath?.split('__').filter(Boolean).at(-1)?.toLowerCase() ??
      itemName;
    return (
      itemName.startsWith(currentSegment) ||
      fieldSegment.startsWith(currentSegment)
    );
  });
}

function virtualLookupCompletionItems(
  receiver: OrmReceiverInfo,
  prefix: string,
  method: string
): LookupPathItem[] {
  const virtualFields = receiver.virtualFields ?? [];
  if (virtualFields.length === 0) {
    return [];
  }

  const normalizedPrefix = normalizeVirtualLookupPrefix(prefix, method);
  const segments = normalizedPrefix.split('__').filter(Boolean);
  const endsWithSeparator = normalizedPrefix.endsWith('__');

  if (segments.length === 0) {
    return virtualFields
      .filter((field) => field.name.startsWith(''))
      .map((field) => virtualFieldToLookupPathItem(field, receiver.modelLabel));
  }

  if (segments.length === 1 && !endsWithSeparator) {
    return virtualFields
      .filter((field) => field.name.startsWith(segments[0]))
      .map((field) => virtualFieldToLookupPathItem(field, receiver.modelLabel));
  }

  const fieldName = segments[0];
  const virtualField = virtualFields.find((field) => field.name === fieldName);
  if (!virtualField) {
    return [];
  }

  if (!supportsVirtualLookupOperators(method)) {
    return [];
  }

  const operatorPrefix =
    segments.length <= 1
      ? ''
      : endsWithSeparator
        ? ''
        : segments.slice(1).join('__');
  if (segments.length > 2) {
    return [];
  }

  return [...VIRTUAL_LOOKUP_OPERATORS]
    .filter((operator) => operator.startsWith(operatorPrefix))
    .map((operator) =>
      virtualLookupOperatorItem(
        receiver.modelLabel,
        virtualField,
        operator
      )
    );
}

function resolveVirtualLookupPath(
  receiver: OrmReceiverInfo,
  value: string,
  method: string
): LookupPathResolution | undefined {
  const virtualFields = receiver.virtualFields ?? [];
  if (virtualFields.length === 0) {
    return undefined;
  }

  const normalizedValue = normalizeVirtualLookupPrefix(value, method).trim();
  if (!normalizedValue) {
    return undefined;
  }

  const segments = normalizedValue.split('__').filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  const virtualField = virtualFields.find((field) => field.name === segments[0]);
  if (!virtualField) {
    return undefined;
  }

  const target = virtualFieldToLookupPathItem(virtualField, receiver.modelLabel);
  const resolvedSegments = [target];

  if (segments.length === 1) {
    return {
      resolved: true,
      target,
      resolvedSegments,
      baseModelLabel: receiver.modelLabel,
    };
  }

  if (!supportsVirtualLookupOperators(method)) {
    return {
      resolved: false,
      reason: 'non_relation_intermediate',
      resolvedSegments,
      missingSegment: segments[1],
      baseModelLabel: receiver.modelLabel,
    };
  }

  if (segments.length > 2) {
    return {
      resolved: false,
      reason: 'invalid_lookup_operator',
      resolvedSegments,
      missingSegment: segments[2],
      baseModelLabel: receiver.modelLabel,
    };
  }

  const operator = segments[1];
  if (![...VIRTUAL_LOOKUP_OPERATORS].includes(operator as (typeof VIRTUAL_LOOKUP_OPERATORS)[number])) {
    return {
      resolved: false,
      reason: 'invalid_lookup_operator',
      resolvedSegments,
      missingSegment: operator,
      baseModelLabel: receiver.modelLabel,
    };
  }

  return {
    resolved: true,
    target,
    resolvedSegments,
    baseModelLabel: receiver.modelLabel,
    lookupOperator: operator,
  };
}

function normalizeVirtualLookupPrefix(value: string, method: string): string {
  const trimmed = value.trim();
  if (method === 'order_by' && trimmed.startsWith('-')) {
    return trimmed.slice(1);
  }
  return trimmed;
}

function supportsVirtualLookupOperators(method: string): boolean {
  return LOOKUP_OPERATOR_METHODS.has(method);
}

function virtualLookupOperatorItem(
  ownerModelLabel: string,
  field: VirtualOrmField,
  operator: string
): LookupPathItem {
  return {
    ...virtualFieldToLookupPathItem(field, ownerModelLabel),
    name: operator,
    fieldKind: 'lookup_operator',
    lookupOperator: operator,
  };
}

function lookupMethodLabel(method: string): string {
  if (method === F_EXPRESSION_METHOD) {
    return 'F() expression';
  }

  if (method.startsWith(EXPRESSION_PATH_METHOD_PREFIX)) {
    return `${method.slice(EXPRESSION_PATH_METHOD_PREFIX.length)}() expression`;
  }

  return method;
}

async function buildOrmMemberHover(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position,
  memberContext: OrmMemberAccessContext,
  memberName: string,
  receiver: OrmReceiverInfo,
  resolution: OrmMemberResolution
): Promise<vscode.Hover | undefined> {
  if (daemon.isAborted()) { return undefined; }
  if (!resolution.resolved || !resolution.item) {
    return undefined;
  }

  const markdown = buildOrmMemberMarkdown(resolution.item, receiver);
  if (
    resolution.item.source !== 'builtin' ||
    resolution.item.memberKind !== 'method'
  ) {
    try {
      await appendResolvedReturnTypeMetadata(
        markdown,
        daemon,
        document,
        memberContext,
        document.offsetAt(position)
      );
    } catch {
      // Keep the fast ORM hover even if annotation enrichment fails.
    }
  }
  markdown.appendMarkdown(`\n\nResolved from member access \`${memberName}\`.`);
  const memberRange = document.getWordRangeAtPosition(
    position,
    /[A-Za-z_][\w]*/
  );
  return new vscode.Hover(markdown, memberRange);
}

async function appendResolvedReturnTypeMetadata(
  markdown: vscode.MarkdownString,
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  memberContext: OrmMemberAccessContext,
  beforeOffset: number
): Promise<void> {
  const typeAnnotation = await resolveTypeAnnotationForMemberAccess(
    daemon,
    document,
    memberContext.receiverExpression,
    memberContext.memberName,
    beforeOffset,
    new Set()
  );
  if (!typeAnnotation) {
    return;
  }

  const normalizedAnnotation = normalizeTypeAnnotation(typeAnnotation.annotation);
  if (!normalizedAnnotation) {
    return;
  }

  markdown.appendMarkdown(`\n\nReturn annotation: \`${normalizedAnnotation}\``);

  const classSource = await resolveClassDefinitionFromTypeAnnotation(
    daemon,
    typeAnnotation.document,
    normalizedAnnotation,
    typeAnnotation.offset
  );
  if (!classSource) {
    return;
  }

  markdown.appendMarkdown(
    `\n\nResolved return symbol: \`${qualifiedClassSymbol(
      classSource.document,
      classSource.classDef.name
    )}\``
  );

  const modelLabel = await resolveModelLabelFromTypeAnnotation(
    daemon,
    typeAnnotation.document,
    normalizedAnnotation,
    typeAnnotation.offset
  );
  if (modelLabel) {
    markdown.appendMarkdown(`\n\nReturn annotation model: \`${modelLabel}\``);
  }

  const category = await resolveClassHoverCategory(daemon, classSource, new Set());
  markdown.appendMarkdown(`\n\nReturn class category: \`${category}\``);

  const specialKind = await resolveSpecialClassKind(daemon, classSource, new Set());
  if (specialKind) {
    markdown.appendMarkdown(`\n\nReturn class kind: \`${specialKind}\``);
  }
}

function buildOrmMemberMarkdown(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${item.name}**\n\n`);

  // Show signature as code block for builtin methods
  if (item.signature && item.source === 'builtin') {
    markdown.appendCodeblock(
      `${item.name}${item.signature}`,
      'python'
    );
    markdown.appendMarkdown(`${item.detail}\n\n`);
    markdown.appendMarkdown(`---\n\n`);
  }

  markdown.appendMarkdown(`Receiver kind: \`${receiver.kind}\`\n\n`);
  markdown.appendMarkdown(`Receiver model: \`${receiver.modelLabel}\`\n\n`);
  if (receiver.classSource) {
    markdown.appendMarkdown(
      `Receiver class: \`${qualifiedClassSymbol(
        receiver.classSource.document,
        receiver.classSource.classDef.name
      )}\`\n\n`
    );
  }
  if (receiver.specialKind) {
    markdown.appendMarkdown(`Receiver class kind: \`${receiver.specialKind}\`\n\n`);
  }
  if (receiver.managerName) {
    markdown.appendMarkdown(`Receiver manager: \`${receiver.managerName}\`\n\n`);
  }
  markdown.appendMarkdown(`Member kind: \`${item.memberKind}\`\n\n`);
  markdown.appendMarkdown(`Owner model: \`${item.modelLabel}\`\n\n`);
  markdown.appendMarkdown(`Detail: \`${item.detail}\``);

  if (item.fieldKind) {
    markdown.appendMarkdown(`\n\nField kind: \`${item.fieldKind}\``);
  }

  if (item.returnKind) {
    markdown.appendMarkdown(`\n\nReturn kind: \`${item.returnKind}\``);
  }

  if (item.returnModelLabel) {
    markdown.appendMarkdown(`\n\nReturn model: \`${item.returnModelLabel}\``);
  }

  if (item.managerName) {
    markdown.appendMarkdown(`\n\nManager: \`${item.managerName}\``);
  }

  markdown.appendMarkdown(`\n\nSource: \`${item.source}\``);
  return markdown;
}

function mergeVirtualOrmMemberItems(
  items: OrmMemberItem[],
  receiver: OrmReceiverInfo
): OrmMemberItem[] {
  const virtualItems = virtualOrmMemberItems(receiver);
  if (virtualItems.length === 0) {
    return items;
  }

  const merged = [...items];
  const existingNames = new Set(items.map((item) => item.name));
  for (const item of virtualItems) {
    if (existingNames.has(item.name)) {
      continue;
    }
    merged.push(item);
  }

  return merged;
}

function mergeOrmMemberItemsByName(
  primaryItems: OrmMemberItem[],
  additionalItems: OrmMemberItem[]
): OrmMemberItem[] {
  if (additionalItems.length === 0) {
    return primaryItems;
  }

  const merged = [...primaryItems];
  const names = new Set(primaryItems.map((item) => item.name));
  for (const item of additionalItems) {
    if (names.has(item.name)) {
      continue;
    }
    names.add(item.name);
    merged.push(item);
  }
  return merged;
}

function virtualOrmMemberItems(receiver: OrmReceiverInfo): OrmMemberItem[] {
  const virtualFields = receiver.virtualFields ?? [];
  if (virtualFields.length === 0) {
    return [];
  }

  return virtualFields
    .filter((field) => receiver.kind === 'instance' ? field.instanceAvailable : false)
    .map((field) => virtualFieldToOrmMemberItem(field, receiver.modelLabel));
}

function resolveVirtualOrmMember(
  receiver: OrmReceiverInfo,
  memberName: string
): OrmMemberResolution | undefined {
  const item = virtualOrmMemberItems(receiver).find((entry) => entry.name === memberName);
  if (!item) {
    return undefined;
  }

  return {
    resolved: true,
    item,
  };
}

function virtualFieldToOrmMemberItem(
  field: VirtualOrmField,
  modelLabel: string
): OrmMemberItem {
  return {
    name: field.name,
    memberKind: 'field',
    modelLabel,
    receiverKind: 'instance',
    detail: field.detail,
    source: field.source,
    returnKind: 'scalar',
    fieldKind: field.fieldKind,
    filePath: field.filePath,
    line: field.line,
    column: field.column,
    isRelation: false,
  };
}

function virtualFieldToLookupPathItem(
  field: VirtualOrmField,
  modelLabel: string
): LookupPathItem {
  return {
    name: field.name,
    modelLabel,
    filePath: field.filePath,
    line: field.line,
    column: field.column,
    fieldKind: field.fieldKind,
    isRelation: false,
    source: field.source,
  };
}

/**
 * Universal Django ORM lookup items emitted when the daemon has no record
 * of the target model AND no virtual fields are available. Every Django
 * model has `pk` (the primary key alias) and almost all have `id` — these
 * suffice to keep the completion popup useful when the lookup path
 * resolver came up empty (captain regression P3: db.Company unresolved
 * but Pylance had typed the receiver).
 */
function genericDjangoLookupFallbackItems(
  modelLabel: string,
  prefix: string,
  method: string,
): LookupPathItem[] {
  void method;
  const normalizedPrefix = prefix.trim();
  const candidates = ['pk', 'id'];
  return candidates
    .filter((name) => name.startsWith(normalizedPrefix))
    .map((name) => ({
      name,
      modelLabel,
      fieldKind: 'AutoField',
      isRelation: false,
      source: 'generic-fallback',
    }));
}

function createEnsureStartedOnce(
  daemon: AnalysisDaemon,
  scope: vscode.ConfigurationScope
): () => Promise<void> {
  let pending: Promise<void> | undefined;

  return async () => {
    if (!pending) {
      pending = daemon.ensureStarted(scope).catch((error) => {
        pending = undefined;
        throw error;
      });
    }

    await pending;
  };
}

function definitionLocationFromRelationResolution(
  resolution: RelationTargetResolution
): vscode.Location | undefined {
  if (!resolution.resolved || !resolution.target) {
    return undefined;
  }

  return locationFromFilePosition(
    resolution.target.filePath,
    resolution.target.line,
    resolution.target.column
  );
}

async function definitionLocationFromRelationResolutionWithFallback(
  daemon: AnalysisDaemon,
  resolution: RelationTargetResolution
): Promise<vscode.Location | undefined> {
  const directLocation = definitionLocationFromRelationResolution(resolution);
  if (directLocation) {
    return directLocation;
  }

  if (!resolution.resolved || !resolution.target?.label) {
    return undefined;
  }

  const classSource = await resolveClassDefinitionForModelLabel(
    daemon,
    resolution.target.label
  );
  if (!classSource) {
    return undefined;
  }

  return new vscode.Location(
    classSource.document.uri,
    new vscode.Position(classSource.classDef.line, 0)
  );
}

function definitionLocationFromExportResolution(
  resolution: ExportOriginResolution
): vscode.Location | undefined {
  if (!resolution.resolved) {
    return undefined;
  }

  return locationFromFilePosition(
    resolution.originFilePath,
    resolution.originLine,
    resolution.originColumn
  );
}

function definitionLocationFromModuleResolution(
  resolution: ModuleResolution
): vscode.Location | undefined {
  if (!resolution.resolved) {
    return undefined;
  }

  return locationFromFilePosition(
    resolution.filePath,
    resolution.line,
    resolution.column
  );
}

async function definitionLocationFromImportReference(
  daemon: AnalysisDaemon,
  reference: ImportReference
): Promise<vscode.Location | undefined> {
  if (reference.kind === 'module') {
    return definitionLocationFromModuleResolution(
      await daemon.resolveModule(reference.moduleName)
    );
  }

  const target = await resolveImportedSymbolOrModule(
    daemon,
    reference.moduleName,
    reference.symbol
  );
  if (!target) {
    return undefined;
  }

  return target.kind === 'module'
    ? definitionLocationFromModuleResolution(target.resolution)
    : definitionLocationFromExportResolution(target.resolution);
}

async function resolveImportedSymbolOrModule(
  daemon: AnalysisDaemon,
  moduleName: string,
  symbol: string
): Promise<
  | { kind: 'symbol'; resolution: ExportOriginResolution }
  | { kind: 'module'; moduleName: string; resolution: ModuleResolution }
  | undefined
> {
  if (daemon.isAborted()) { return undefined; }
  const exportResolution = await daemon.resolveExportOrigin(moduleName, symbol);
  if (exportResolution.resolved) {
    return {
      kind: 'symbol',
      resolution: exportResolution,
    };
  }

  const importedModuleName = [moduleName, symbol].filter(Boolean).join('.');
  const moduleResolution = await daemon.resolveModule(importedModuleName);
  if (!moduleResolution.resolved) {
    return undefined;
  }

  return {
    kind: 'module',
    moduleName: importedModuleName,
    resolution: moduleResolution,
  };
}

function definitionLocationFromLookupResolution(
  resolution: LookupPathResolution
): vscode.Location | undefined {
  if (!resolution.resolved || !resolution.target) {
    return undefined;
  }

  return locationFromFilePosition(
    resolution.target.filePath,
    resolution.target.line,
    resolution.target.column
  );
}

async function definitionLocationFromLookupResolutionWithFallback(
  daemon: AnalysisDaemon,
  resolution: LookupPathResolution
): Promise<vscode.Location | undefined> {
  const directLocation = definitionLocationFromLookupResolution(resolution);
  if (directLocation) {
    return directLocation;
  }

  if (!resolution.resolved || !resolution.target?.modelLabel) {
    return undefined;
  }

  const classSource = await resolveClassDefinitionForModelLabel(
    daemon,
    resolution.target.modelLabel
  );
  if (!classSource) {
    return undefined;
  }

  const fallbackFieldNames = [resolution.target.name];
  if (resolution.target.name === 'pk') {
    fallbackFieldNames.push('id');
  } else if (resolution.target.name.endsWith('_id')) {
    fallbackFieldNames.push(resolution.target.name.slice(0, -3));
  }

  for (const fieldName of fallbackFieldNames) {
    const fieldLocation = findClassAttributeAssignment(
      classSource.document,
      classSource.classDef,
      fieldName
    );
    if (fieldLocation) {
      return fieldLocation;
    }
  }

  return new vscode.Location(
    classSource.document.uri,
    new vscode.Position(classSource.classDef.line, 0)
  );
}

function definitionLocationFromOrmMemberResolution(
  resolution: OrmMemberResolution
): vscode.Location | undefined {
  if (!resolution.resolved || !resolution.item) {
    return undefined;
  }

  return locationFromFilePosition(
    resolution.item.filePath,
    resolution.item.line,
    resolution.item.column
  );
}

function locationFromFilePosition(
  filePath: string | undefined,
  line: number | undefined,
  column: number | undefined
): vscode.Location | undefined {
  if (!filePath || !line || !column) {
    return undefined;
  }

  const position = new vscode.Position(line - 1, column - 1);
  return new vscode.Location(vscode.Uri.file(filePath), position);
}

function isPythonDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'python' && document.uri.scheme === 'file';
}

function shouldAnalyzeDocument(
  document: vscode.TextDocument,
  workspaceRoot: string | undefined
): boolean {
  if (!isPythonDocument(document)) {
    return false;
  }

  if (!workspaceRoot) {
    return true;
  }

  const relativePath = path.relative(
    path.resolve(workspaceRoot),
    path.resolve(document.uri.fsPath)
  );
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

/**
 * Validate raw lookup contexts by resolving their call-context (receiver
 * expression + method).  Contexts that fail validation are filtered out.
 * This is shared between Phase 1 and Phase 2 diagnostic scanning.
 */
function validateLookupContexts(
  contexts: LookupDiagnosticContext[],
  docText: string,
  isCancelled: () => boolean,
): LookupDiagnosticContext[] {
  const validated: LookupDiagnosticContext[] = [];
  for (const context of contexts) {
    if (isCancelled()) break;
    const ctx = context as LookupDiagnosticContext & {
      _needsCallContextValidation?: boolean;
      _absoluteStart?: number;
      _absoluteEnd?: number;
      _isPrefetch?: boolean;
      _isDictKey?: boolean;
      _isFExpression?: boolean;
      _isExpressionPath?: boolean;
    };
    if (ctx._needsCallContextValidation && ctx._absoluteStart !== undefined) {
      let callContext: { receiverExpression: string; method: string } | undefined;
      if (ctx._isDictKey && ctx._absoluteEnd !== undefined) {
        const dictCtx = unpackedLookupDictCallContext(docText, ctx._absoluteStart, ctx._absoluteEnd);
        callContext = dictCtx ? { receiverExpression: dictCtx.receiverExpression, method: dictCtx.method } : undefined;
      } else if (ctx._isFExpression) {
        const fCtx = fExpressionCallContext(docText, ctx._absoluteStart);
        callContext = fCtx ? { receiverExpression: fCtx.receiverExpression, method: F_EXPRESSION_METHOD } : undefined;
      } else if (ctx._isExpressionPath && ctx._absoluteEnd !== undefined) {
        const exprCtx = expressionStringArgumentCallContext(docText, ctx._absoluteStart, ctx._absoluteEnd);
        callContext = exprCtx ? { receiverExpression: exprCtx.receiverExpression, method: expressionPathMethodName(exprCtx.expressionName) } : undefined;
      } else if (ctx._isPrefetch) {
        callContext = prefetchLookupCallContext(docText, ctx._absoluteStart) ?? undefined;
      } else {
        const lookupCtx = querysetStringCallContext(docText, ctx._absoluteStart);
        callContext = lookupCtx && lookupCtx.method === context.method ? lookupCtx : undefined;
      }
      if (!callContext) continue;
      context.receiverExpression = callContext.receiverExpression;
      context.method = callContext.method;
    }
    validated.push(context);
  }
  return validated;
}

function findRelationDiagnosticContexts(
  document: vscode.TextDocument,
  startLine = 0,
  endLine = document.lineCount
): RelationDiagnosticContext[] {
  const contexts: RelationDiagnosticContext[] = [];

  for (let line = startLine; line < endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    for (const match of lineText.matchAll(RELATION_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      contexts.push({
        value,
        range: new vscode.Range(line, start, line, start + value.length),
      });
    }
  }

  return contexts;
}

async function findLookupDiagnosticContexts(
  document: vscode.TextDocument,
  isCancelled: () => boolean,
  startLine = 0,
  endLine = document.lineCount,
  daemonForLogging?: AnalysisDaemon,
): Promise<LookupDiagnosticContext[]> {
  const contexts: LookupDiagnosticContext[] = [];
  const seen = new Set<string>();
  // captain 첫 cycle phase2-scan:350-2498 5.3s 폭주 분석 (log.txt L80):
  //   2148 lines / chunk=250 → 8 yields × ~600ms = 4.8s
  //   원인: setTimeout(0) 은 macrotask 라 background daemon IPC drain 과 시리얼
  //   wait. registry build 등 다른 IPC 가 macrotask 큐 점유.
  // Fix: (1) chunk 250 → 1000 (yield 횟수 1/4 로 축소)
  //      (2) setTimeout(0) → Promise.resolve() (microtask 즉시 yield)
  //   trade-off: cancellation latency 가 ~50ms → ~200ms (1000 lines 처리 후 체크)
  //   — 사용자 체감 가능 한계 안. microtask burst 가 옵션 3 setTimeout cap 발화
  //   막을 수 있지만, #1 fix 의 Date.now() deadline 이 우회로 안전.
  const SCAN_CHUNK_LINES = 1000;
  const lineCount = endLine - startLine;
  const isSmallFile = lineCount < 500;

  // E — captain phase2-scan 5.3s 정체 분석용 timing. 임계 (1초+) 초과 시
  // [phase2-scan:breakdown] stderr emit. 정상 케이스 영향 없음.
  // 단순한 단위로 시작 — VSCode API (lineAt/offsetAt) vs regex 본체.
  const _scanStart = performance.now();
  let _timeLineAt = 0;        // document.lineAt() VSCode API
  let _timeOffsetAt = 0;      // document.offsetAt() + new Position
  let _matchCount = 0;        // 매칭된 lookup 개수

  for (let line = startLine; line < endLine; line += 1) {
    // Yield every SCAN_CHUNK_LINES to keep event loop responsive
    // Skip yielding for small files where synchronous scan is fast enough
    if (!isSmallFile && line > 0 && line % SCAN_CHUNK_LINES === 0) {
      // microtask yield — macrotask wait 없이 즉시 다음 tick
      await Promise.resolve();
      if (isCancelled()) { return contexts; }
    }
    const _tL = performance.now();
    const lineText = document.lineAt(line).text;
    _timeLineAt += performance.now() - _tL;
    const _tO = performance.now();
    const lineStartOffset = document.offsetAt(new vscode.Position(line, 0));
    _timeOffsetAt += performance.now() - _tO;
    const excludedWordRanges: Array<{ start: number; end: number }> = [];

    // captain 측정 (log L87) — regex_other=2661ms / 2198 lines / matches=0:
    // matchAll generator iterator 자체가 line 당 0.24ms 누적. lookup method
    // 이름이 없는 line 은 matchAll skip 가능. lightweight indexOf prefilter.
    // false-negative 안전: 각 regex 의 mandatory substring 정확히 추출.
    const hasLookupMethodHint =
      lineText.indexOf('.values(') >= 0 ||
      lineText.indexOf('.values_list(') >= 0 ||
      lineText.indexOf('.order_by(') >= 0 ||
      lineText.indexOf('.only(') >= 0 ||
      lineText.indexOf('.defer(') >= 0 ||
      lineText.indexOf('.select_related(') >= 0 ||
      lineText.indexOf('.prefetch_related(') >= 0;
    const hasPrefetchHint = lineText.indexOf('Prefetch(') >= 0;
    const hasFExpressionHint = lineText.indexOf('F(') >= 0;
    // captain 다음 측정: DICT_KEY + EXPRESSION_STRING regex 도 quote 필수.
    // captain 의 코멘트/empty/simple code line 은 quote 없음 → matchAll skip.
    const hasQuote =
      lineText.indexOf('"') >= 0 || lineText.indexOf("'") >= 0;

    if (hasLookupMethodHint) for (const match of lineText.matchAll(LOOKUP_HOVER_PATTERN)) {
      const [, method, , value] = match;
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;

      const range = new vscode.Range(line, start, line, start + value.length);
      const key = `${range.start.line}:${range.start.character}:${value}:${method}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      _matchCount++;

      // Defer expensive querysetStringCallContext to the async processing
      // loop.  The receiver expression is resolved lazily to avoid blocking
      // the event loop during the synchronous document scan.
      contexts.push({
        receiverExpression: '',
        method,
        value,
        range,
        _needsCallContextValidation: true,
        _absoluteStart: lineStartOffset + start,
      } as LookupDiagnosticContext & { _needsCallContextValidation?: boolean; _absoluteStart?: number });
    }

    if (hasPrefetchHint) for (const match of lineText.matchAll(PREFETCH_LOOKUP_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;

      const range = new vscode.Range(line, start, line, start + value.length);
      const key = `${range.start.line}:${range.start.character}:${value}:prefetch`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      contexts.push({
        receiverExpression: '',
        method: 'prefetch',
        value,
        range,
        _needsCallContextValidation: true,
        _absoluteStart: lineStartOffset + start,
        _isPrefetch: true,
      } as LookupDiagnosticContext & { _needsCallContextValidation?: boolean; _absoluteStart?: number; _isPrefetch?: boolean });
    }

    if (hasQuote) for (const match of lineText.matchAll(LOOKUP_DICT_KEY_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      const end = start + value.length;
      excludedWordRanges.push({ start, end });

      if (isDynamicLookupDictKey(value)) {
        continue;
      }

      const range = new vscode.Range(line, start, line, end);
      const dictKey = `${range.start.line}:${range.start.character}:${value}:dict`;
      if (seen.has(dictKey)) {
        continue;
      }
      seen.add(dictKey);
      contexts.push({
        receiverExpression: '',
        method: '',
        value,
        range,
        _needsCallContextValidation: true,
        _absoluteStart: lineStartOffset + start,
        _absoluteEnd: lineStartOffset + end,
        _isDictKey: true,
      } as LookupDiagnosticContext & { _needsCallContextValidation?: boolean; _absoluteStart?: number; _absoluteEnd?: number; _isDictKey?: boolean });
    }

    if (hasFExpressionHint) for (const match of lineText.matchAll(F_EXPRESSION_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      const absoluteStart = lineStartOffset + start;
      const range = new vscode.Range(line, start, line, start + value.length);
      const fKey = `${range.start.line}:${range.start.character}:${value}:f_expr`;
      if (seen.has(fKey)) {
        continue;
      }
      seen.add(fKey);
      contexts.push({
        receiverExpression: '',
        method: F_EXPRESSION_METHOD,
        value,
        range,
        _needsCallContextValidation: true,
        _absoluteStart: absoluteStart,
        _isFExpression: true,
      } as LookupDiagnosticContext & { _needsCallContextValidation?: boolean; _absoluteStart?: number; _isFExpression?: boolean });
    }

    if (hasQuote) for (const match of lineText.matchAll(EXPRESSION_STRING_HOVER_PATTERN)) {
      const value = match[2];
      const start = (match.index ?? 0) + 1;
      const absoluteStart = lineStartOffset + start;
      const absoluteEnd = absoluteStart + value.length + 1;
      const range = new vscode.Range(line, start, line, start + value.length);
      const exprKey = `${range.start.line}:${range.start.character}:${value}:expr`;
      if (seen.has(exprKey)) {
        continue;
      }
      seen.add(exprKey);
      contexts.push({
        receiverExpression: '',
        method: '',
        value,
        range,
        _needsCallContextValidation: true,
        _absoluteStart: absoluteStart,
        _absoluteEnd: absoluteEnd,
        _isExpressionPath: true,
      } as LookupDiagnosticContext & { _needsCallContextValidation?: boolean; _absoluteStart?: number; _absoluteEnd?: number; _isExpressionPath?: boolean });
    }

    // captain 분석: 이 identifier regex 가 매 word 마다 keywordLookupLiteral
    // 호출 → vscode getWordRangeAtPosition + getText + offsetAt 등 API 다수.
    // 2198 lines × 10+ identifier = 20000+ vscode API call. 진짜 hotspot.
    // keyword argument 는 `name=value` 패턴 — line 에 `=` 가 없으면 skip.
    // false-negative 안전: keyword arg 가 다른 형식으로 표현될 수 없음.
    const hasEqualsKeyword = lineText.indexOf('=') >= 0;
    if (hasEqualsKeyword) for (const match of lineText.matchAll(/[A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*/g)) {
      const start = match.index ?? 0;
      const value = match[0];
      // captain identifier regex hotspot 차단: keywordLookupLiteral 안의
      // vscode API 호출 다수 (getWordRangeAtPosition, getText, offsetAt × 2,
      // querysetKeywordCallContext) — 매 word 마다. captain workspace 측정:
      // bare-field keyword (filter(name='x'))=4684, __operator (filter(x__lte=1))=1155
      // 즉 80% 가 bare-field. 단순 `value.includes('__')` prefilter 는 80%
      // 진단 누락 (regression). 대신 identifier 직후가 `=` (not `==`) 인지
      // lookahead — keyword arg 형태인지 검증. 일반 identifier (locals, var
      // 등) 는 직후가 `=` 아님 → skip. captain 의 keywordLookupLiteral 호출
      // 빈도 ~95%+ 감소 추정.
      const afterEnd = start + value.length;
      let lookahead = afterEnd;
      while (lookahead < lineText.length && lineText[lookahead] === ' ') {
        lookahead++;
      }
      const nextChar = lineText[lookahead];
      const nextNextChar = lineText[lookahead + 1];
      // `=` 인데 `==` (비교) 가 아니면 keyword arg 후보.
      if (nextChar !== '=' || nextNextChar === '=') {
        continue;
      }
      if (
        excludedWordRanges.some(
          (range) => start >= range.start && start < range.end
        )
      ) {
        continue;
      }
      const position = new vscode.Position(
        line,
        start + Math.floor(value.length / 2)
      );
      const context = keywordLookupLiteral(document, position);
      if (!context) {
        continue;
      }

      const range = new vscode.Range(line, start, line, start + value.length);
      const key = `${range.start.line}:${range.start.character}:${context.value}:${context.method}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      contexts.push({
        ...context,
        range,
      });
    }
  }

  // E — captain phase2-scan 5.3s 정체 분석. 임계 1000ms 초과 시 stderr emit.
  const _scanTotal = performance.now() - _scanStart;
  const _SCAN_SLOW_LOG_MS = Number(
    process.env.DJLS_PHASE2_SCAN_SLOW_LOG_MS ?? 1000
  ) || 1000;
  if (_SCAN_SLOW_LOG_MS > 0 && _scanTotal >= _SCAN_SLOW_LOG_MS) {
    const linesProcessed = endLine - startLine;
    const regexAndOther = _scanTotal - _timeLineAt - _timeOffsetAt;
    const breakdownMsg =
      `[phase2-scan:breakdown] lines=${linesProcessed} matches=${_matchCount} ` +
      `total=${_scanTotal.toFixed(0)}ms ` +
      `lineAt=${_timeLineAt.toFixed(0)}ms ` +
      `offsetAt=${_timeOffsetAt.toFixed(0)}ms ` +
      `regex_other=${regexAndOther.toFixed(0)}ms`;
    // captain log.txt 캡처는 daemon.logDiagnostic 으로만 들어감 (vscode OUTPUT
    // 채널). console.error 는 Developer Console 로 가서 캡처 안 됨.
    if (daemonForLogging) {
      daemonForLogging.logDiagnostic(breakdownMsg);
    } else {
      // eslint-disable-next-line no-console
      console.error(breakdownMsg);
    }
  }

  return contexts;
}

function findDirectFieldDiagnosticContexts(
  document: vscode.TextDocument,
  startLine = 0,
  endLine = document.lineCount
): DirectFieldDiagnosticContext[] {
  const contexts: DirectFieldDiagnosticContext[] = [];
  const seen = new Set<string>();
  // Only scan lines that contain .create( or .update( to avoid O(words × filesize)
  const DIRECT_CALL_LINE_PATTERN = /\.(?:create|update)\s*\(/;

  for (let line = startLine; line < endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    if (!DIRECT_CALL_LINE_PATTERN.test(lineText)) {
      continue;
    }

    for (const match of lineText.matchAll(/[A-Za-z_][\w]*/g)) {
      const start = match.index ?? 0;
      const value = match[0];
      const position = new vscode.Position(
        line,
        start + Math.floor(value.length / 2)
      );
      const context = directFieldKeywordLiteral(document, position);
      if (!context) {
        continue;
      }

      const range = new vscode.Range(line, start, line, start + value.length);
      const key = `${range.start.line}:${range.start.character}:${context.value}:${context.method}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      contexts.push({
        ...context,
        range,
      });
    }
  }

  return contexts;
}

function findSchemaFieldDiagnosticContexts(
  document: vscode.TextDocument,
  startLine = 0,
  endLine = document.lineCount
): SchemaFieldDiagnosticContext[] {
  const contexts: SchemaFieldDiagnosticContext[] = [];
  const seen = new Set<string>();

  for (let line = startLine; line < endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    for (const match of lineText.matchAll(/[-A-Za-z_][\w-]*/g)) {
      const value = match[0];
      const start = match.index ?? 0;
      const context = schemaFieldHoverLiteral(
        document,
        new vscode.Position(line, start + Math.floor(value.length / 2))
      );
      if (!context) {
        continue;
      }

      const key = `${line}:${start}:${context.value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      contexts.push({
        value: context.value,
        range: new vscode.Range(line, start, line, start + context.value.length),
      });
    }
  }

  return contexts;
}

function findMetaConstraintLookupDiagnosticContexts(
  document: vscode.TextDocument,
  startLine = 0,
  endLine = document.lineCount
): MetaConstraintLookupDiagnosticContext[] {
  const contexts: MetaConstraintLookupDiagnosticContext[] = [];
  const seen = new Set<string>();

  for (let line = startLine; line < endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    for (const match of lineText.matchAll(/[A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*/g)) {
      const value = match[0];
      const start = match.index ?? 0;
      const context = metaConstraintLookupLiteral(
        document,
        new vscode.Position(line, start + Math.floor(value.length / 2))
      );
      if (!context) {
        continue;
      }

      const key = `${line}:${start}:${context.value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      contexts.push({
        value: context.value,
        range: new vscode.Range(line, start, line, start + context.value.length),
      });
    }
  }

  return contexts;
}

function findBulkUpdateFieldDiagnosticContexts(
  document: vscode.TextDocument,
  startLine = 0,
  endLine = document.lineCount
): BulkUpdateFieldListDiagnosticContext[] {
  const contexts: BulkUpdateFieldListDiagnosticContext[] = [];
  const seen = new Set<string>();

  for (let line = startLine; line < endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    for (const match of lineText.matchAll(/[-A-Za-z_][\w-]*/g)) {
      const value = match[0];
      const start = match.index ?? 0;
      const context = bulkUpdateFieldListHoverLiteral(
        document,
        new vscode.Position(line, start + Math.floor(value.length / 2))
      );
      if (!context) {
        continue;
      }

      const key = `${line}:${start}:${context.value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      contexts.push({
        receiverExpression: context.receiverExpression,
        value: context.value,
        range: new vscode.Range(line, start, line, start + context.value.length),
      });
    }
  }

  return contexts;
}

function buildRelationDiagnostic(
  context: RelationDiagnosticContext,
  resolution: RelationTargetResolution
): vscode.Diagnostic | undefined {
  if (resolution.resolved) {
    return undefined;
  }

  if (resolution.reason === 'self_requires_context') {
    return undefined;
  }

  let message: string | undefined;
  let severity = vscode.DiagnosticSeverity.Error;

  if (resolution.reason === 'ambiguous_object_name') {
    message = `Ambiguous Django model reference \`${context.value}\`. Use \`app_label.ModelName\`.`;
    severity = vscode.DiagnosticSeverity.Warning;
  } else if (resolution.reason === 'not_found') {
    message = `Unknown Django model reference \`${context.value}\`.`;
  }

  if (!message) {
    return undefined;
  }

  const diagnostic = new vscode.Diagnostic(context.range, message, severity);
  diagnostic.source = 'Django ORM Intellisense';
  return diagnostic;
}

function buildLookupDiagnostic(
  context: LookupDiagnosticContext,
  baseModelLabel: string,
  resolution: LookupPathResolution
): vscode.Diagnostic | undefined {
  let message: string | undefined;
  if (
    resolution.resolved &&
    RELATION_ONLY_LOOKUP_METHODS.has(context.method) &&
    resolution.target &&
    !resolution.target.isRelation
  ) {
    message = `\`${context.method}\` only accepts relation paths, but \`${context.value}\` resolves to a non-relation field.`;
  } else if (resolution.resolved) {
    return undefined;
  } else if (resolution.reason === 'empty') {
    return undefined;
  } else if (resolution.reason === 'segment_not_found' && resolution.missingSegment) {
    message = `Unknown ORM lookup segment \`${resolution.missingSegment}\` in \`${context.value}\` for \`${baseModelLabel}\`.`;
  } else if (
    resolution.reason === 'invalid_lookup_operator' &&
    resolution.missingSegment
  ) {
    message = `Unknown Django lookup operator \`${resolution.missingSegment}\` in \`${context.value}\`.`;
  } else if (resolution.reason === 'non_relation_intermediate') {
    const lastSegment =
      resolution.resolvedSegments?.at(-1)?.name ?? context.value.split('__').slice(-2, -1)[0];
    message = `\`${lastSegment}\` is not a relation on \`${baseModelLabel}\`, so \`${context.value}\` cannot continue past it.`;
  } else if (resolution.reason === 'relation_required') {
    message = `\`${context.method}\` only accepts relation paths, but \`${context.value}\` resolves to a non-relation field.`;
  }

  if (!message) {
    return undefined;
  }

  const diagnostic = new vscode.Diagnostic(
    context.range,
    message,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = 'Django ORM Intellisense';
  return diagnostic;
}

function buildDirectFieldDiagnostic(
  context: DirectFieldDiagnosticContext,
  baseModelLabel: string,
  resolution: LookupPathResolution
): vscode.Diagnostic | undefined {
  if (
    resolution.resolved &&
    resolution.target &&
    !resolution.lookupOperator &&
    !context.value.includes('__')
  ) {
    return undefined;
  }

  const diagnostic = new vscode.Diagnostic(
    context.range,
    `Unknown model field \`${context.value}\` for \`${baseModelLabel}\` in \`${context.method}()\`.`,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = 'Django ORM Intellisense';
  return diagnostic;
}

function buildSchemaFieldDiagnostic(
  context: SchemaFieldDiagnosticContext,
  baseModelLabel: string,
  resolution: LookupPathResolution
): vscode.Diagnostic | undefined {
  if (
    resolution.resolved &&
    resolution.target &&
    !resolution.lookupOperator &&
    !context.value.includes('__')
  ) {
    return undefined;
  }

  const diagnostic = new vscode.Diagnostic(
    context.range,
    `Unknown schema field \`${context.value}\` for \`${baseModelLabel}\`.`,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = 'Django ORM Intellisense';
  return diagnostic;
}

function buildBulkUpdateFieldDiagnostic(
  context: BulkUpdateFieldListDiagnosticContext,
  baseModelLabel: string,
  resolution: LookupPathResolution
): vscode.Diagnostic | undefined {
  if (
    resolution.resolved &&
    resolution.target &&
    !resolution.lookupOperator &&
    !context.value.includes('__')
  ) {
    return undefined;
  }

  const diagnostic = new vscode.Diagnostic(
    context.range,
    `Unknown bulk_update field \`${context.value}\` for \`${baseModelLabel}\`.`,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = 'Django ORM Intellisense';
  return diagnostic;
}

async function resolveOrmMemberCompletionContext(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<OrmMemberCompletionContext | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const prefixContext = ormMemberPrefixContext(document, position);
  if (!prefixContext) {
    return undefined;
  }

  const endOffset = document.offsetAt(position);
  const candidates = ormMemberExpressionCandidates(
    document,
    prefixContext.startOffset,
    endOffset
  );
  let sawScopedCandidate = false;
  for (const candidate of candidates) {
    const parsedAccess = parseTrailingMemberAccessCandidate(
      candidate.text,
      prefixContext.prefix
    );
    if (!parsedAccess) {
      continue;
    }
    if (candidate.source === 'top_level' && sawScopedCandidate) {
      return undefined;
    }

    const candidateVisited = new Set<string>();
    const dynamicReceiver = await resolveDynamicInstanceReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      candidateVisited
    );
    const staticReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      candidateVisited
    );
    const annotatedReceiver = await resolveAnnotatedReceiverForExpression(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset
    );
    const receiver = await preferReceiverAnnotation(
      daemon,
      preferMemberReceiver(staticReceiver, dynamicReceiver),
      annotatedReceiver
    );
    if (!receiver) {
      if (candidate.source !== 'top_level') {
        sawScopedCandidate = true;
      }
      continue;
    }

    return {
      receiverExpression: parsedAccess.receiverExpression,
      prefix: prefixContext.prefix,
      range: prefixContext.range,
      receiver,
    };
  }

  return undefined;
}

async function resolveClassInstanceCompletionContext(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<ClassInstanceCompletionContext | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const prefixContext = ormMemberPrefixContext(document, position);
  if (!prefixContext) {
    return undefined;
  }

  const endOffset = document.offsetAt(position);
  const candidates = ormMemberExpressionCandidates(
    document,
    prefixContext.startOffset,
    endOffset
  );
  let sawScopedCandidate = false;
  for (const candidate of candidates) {
    const parsedAccess = parseTrailingMemberAccessCandidate(
      candidate.text,
      prefixContext.prefix
    );
    if (!parsedAccess) {
      continue;
    }
    if (candidate.source === 'top_level' && sawScopedCandidate) {
      return undefined;
    }

    const classSource = await resolveClassDefinitionForExpression(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      new Set()
    );
    if (!classSource) {
      if (candidate.source !== 'top_level') {
        sawScopedCandidate = true;
      }
      continue;
    }

    return {
      receiverExpression: parsedAccess.receiverExpression,
      prefix: prefixContext.prefix,
      range: prefixContext.range,
      classSource,
    };
  }

  return undefined;
}

async function resolveOrmMemberAccessContext(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<OrmMemberAccessContext | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const memberName = document.getText(wordRange);
  const lineText = document.lineAt(wordRange.start.line).text;
  if (
    wordRange.start.character === 0 ||
    lineText[wordRange.start.character - 1] !== '.'
  ) {
    return undefined;
  }

  const startOffset = document.offsetAt(wordRange.start);
  const endOffset = document.offsetAt(wordRange.end);
  const candidates = ormMemberExpressionCandidates(
    document,
    startOffset,
    endOffset
  );
  let sawScopedCandidate = false;
  for (const candidate of candidates) {
    if (daemon.isAborted()) { return undefined; }
    const parsedAccess = parseTrailingMemberAccessCandidate(
      candidate.text,
      memberName
    );
    if (!parsedAccess) {
      continue;
    }
    if (candidate.source === 'top_level' && sawScopedCandidate) {
      return undefined;
    }

    const candidateVisited = new Set<string>();
    const dynamicReceiver = await resolveDynamicInstanceReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      candidateVisited
    );
    const staticReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      candidateVisited
    );
    const annotatedReceiver = await resolveAnnotatedReceiverForExpression(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset
    );
    const receiver = await preferReceiverAnnotation(
      daemon,
      preferMemberReceiver(staticReceiver, dynamicReceiver),
      annotatedReceiver
    );
    if (!receiver) {
      if (candidate.source !== 'top_level') {
        sawScopedCandidate = true;
      }
      continue;
    }

    return {
      receiverExpression: parsedAccess.receiverExpression,
      memberName,
      receiver,
    };
  }

  return undefined;
}

function ormMemberPrefixContext(
  document: vscode.TextDocument,
  position: vscode.Position
): { prefix: string; range: vscode.Range; startOffset: number } | undefined {
  const lineText = document.lineAt(position.line).text;
  let startCharacter = position.character;

  while (startCharacter > 0 && /[A-Za-z0-9_]/.test(lineText[startCharacter - 1])) {
    startCharacter -= 1;
  }

  if (startCharacter === 0 || lineText[startCharacter - 1] !== '.') {
    return undefined;
  }

  const range = new vscode.Range(
    position.line,
    startCharacter,
    position.line,
    position.character
  );
  return {
    prefix: lineText.slice(startCharacter, position.character),
    range,
    startOffset: document.offsetAt(range.start),
  };
}

function ormMemberExpressionCandidates(
  document: vscode.TextDocument,
  tokenStartOffset: number,
  endOffset: number
): OrmMemberExpressionCandidate[] {
  const endPosition = document.positionAt(endOffset);
  const sameLineCandidate = compactPythonExpression(
    stripTrailingComment(
      document.lineAt(endPosition.line).text.slice(0, endPosition.character)
    ).trim()
  );
  const windowStartOffset = Math.max(0, endOffset - 4_000);
  const rawWindow = document.getText(
    new vscode.Range(
      document.positionAt(windowStartOffset),
      document.positionAt(endOffset)
    )
  );
  const localTokenStart = tokenStartOffset - windowStartOffset;
  const localEndOffset = endOffset - windowStartOffset;
  const candidateStarts = expressionCandidateStartGroups(
    rawWindow,
    localTokenStart
  );

  const structuralCandidates = [...candidateStarts.structural]
    .sort((left, right) => right - left)
    .map((start) =>
      buildOrmMemberExpressionCandidate(
        rawWindow,
        start,
        localEndOffset,
        'structural'
      )
    );
  const topLevelCandidates = [...candidateStarts.topLevel]
    .sort((left, right) => right - left)
    .map((start) =>
      buildOrmMemberExpressionCandidate(
        rawWindow,
        start,
        localEndOffset,
        'top_level'
      )
    );

  const candidates: OrmMemberExpressionCandidate[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: OrmMemberExpressionCandidate): void => {
    if (!candidate.text || seen.has(candidate.text)) {
      return;
    }
    seen.add(candidate.text);
    candidates.push(candidate);
  };

  pushCandidate({
    text: sameLineCandidate,
    source: 'same_line',
  });
  for (const candidate of structuralCandidates) {
    pushCandidate(candidate);
  }
  for (const candidate of topLevelCandidates) {
    pushCandidate(candidate);
  }

  return candidates;
}

function buildOrmMemberExpressionCandidate(
  rawWindow: string,
  start: number,
  end: number,
  source: OrmMemberExpressionCandidate['source']
): OrmMemberExpressionCandidate {
  return {
    text: compactPythonExpression(
      rawWindow
        .slice(start, end)
        .split('\n')
        .map((line) => stripTrailingComment(line))
        .join('\n')
        .trim()
    ),
    source,
  };
}

function expressionCandidateStartGroups(
  text: string,
  beforeOffset: number
): { structural: Set<number>; topLevel: Set<number> } {
  const structural = new Set<number>();
  const topLevel = new Set<number>([0]);
  const parenStack: number[] = [];
  const bracketStack: number[] = [];
  const braceStack: number[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let activeQuote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < beforeOffset; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (activeQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      activeQuote = char;
      continue;
    }

    const keywordStart = keywordExpressionCandidateStart(text, index);
    if (keywordStart !== undefined && keywordStart < beforeOffset) {
      structural.add(keywordStart);
    }

    if (char === '(') {
      parenStack.push(index);
      parenDepth += 1;
      continue;
    }

    if (char === '[') {
      bracketStack.push(index);
      bracketDepth += 1;
      continue;
    }

    if (char === '{') {
      braceStack.push(index);
      braceDepth += 1;
      continue;
    }

    if (char === ')' && parenDepth > 0) {
      parenDepth -= 1;
      parenStack.pop();
      continue;
    }

    if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      bracketStack.pop();
      continue;
    }

    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1;
      braceStack.pop();
      continue;
    }

    if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      '\n;=,:'.includes(char)
    ) {
      topLevel.add(index + 1);
    }
  }

  for (const index of [...parenStack, ...bracketStack, ...braceStack]) {
    structural.add(index + 1);
  }

  return {
    structural,
    topLevel,
  };
}

function keywordExpressionCandidateStart(
  text: string,
  index: number
): number | undefined {
  for (const keyword of ['return', 'await', 'if']) {
    if (!text.startsWith(keyword, index)) {
      continue;
    }

    const previousChar = index > 0 ? text[index - 1] : undefined;
    if (previousChar && /[A-Za-z0-9_]/.test(previousChar)) {
      continue;
    }

    const whitespaceIndex = index + keyword.length;
    if (whitespaceIndex >= text.length || !/\s/.test(text[whitespaceIndex])) {
      continue;
    }

    let candidateStart = whitespaceIndex;
    while (candidateStart < text.length && /\s/.test(text[candidateStart])) {
      candidateStart += 1;
    }

    if (
      candidateStart >= text.length ||
      !/[A-Za-z_(\[{]/.test(text[candidateStart])
    ) {
      continue;
    }

    return candidateStart;
  }

  return undefined;
}

function parseTrailingMemberAccessCandidate(
  candidate: string,
  memberName: string
): { receiverExpression: string; memberName: string } | undefined {
  if (!memberName) {
    if (!candidate.endsWith('.')) {
      return undefined;
    }

    const receiverExpression = candidate.slice(0, -1);
    return receiverExpression
      ? isPlausibleMemberReceiverExpression(receiverExpression)
        ? { receiverExpression, memberName }
        : undefined
      : undefined;
  }

  const memberAccess = splitTopLevelMemberAccess(candidate);
  if (!memberAccess || memberAccess.memberName !== memberName) {
    return undefined;
  }

  if (!isPlausibleMemberReceiverExpression(memberAccess.objectExpression)) {
    return undefined;
  }

  return {
    receiverExpression: memberAccess.objectExpression,
    memberName: memberAccess.memberName,
  };
}

function isPlausibleMemberReceiverExpression(value: string): boolean {
  const normalized = normalizeReceiverExpression(value);
  return Boolean(normalized) && /^[A-Za-z_]/.test(normalized);
}

const _ormReceiverCacheByDocument = new Map<string, { version: number; entries: Map<string, OrmReceiverInfo | undefined> }>();

function getCachedOrmReceiver(
  document: vscode.TextDocument,
  expression: string
): OrmReceiverInfo | undefined | null {
  const docKey = document.uri.toString();
  const docCache = _ormReceiverCacheByDocument.get(docKey);
  if (!docCache || docCache.version !== document.version) {
    return null;
  }
  if (docCache.entries.has(expression)) {
    return docCache.entries.get(expression)!;
  }
  return null;
}

function setCachedOrmReceiver(
  document: vscode.TextDocument,
  expression: string,
  result: OrmReceiverInfo | undefined
): void {
  const docKey = document.uri.toString();
  let docCache = _ormReceiverCacheByDocument.get(docKey);
  if (!docCache || docCache.version !== document.version) {
    docCache = { version: document.version, entries: new Map() };
    _ormReceiverCacheByDocument.set(docKey, docCache);
  }
  docCache.entries.set(expression, result);
}

async function resolveOrmReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
    return undefined;
  }
  // Same captain guard as `resolveLookupReceiverAtOffset`: a receiver that
  // contains top-level commas or kwarg `=` was sliced incorrectly by the
  // scanner. Resolving it would burn seconds in BG IPC waits. Reject up
  // front and cache the rejection so subsequent identical receivers in
  // the same cycle don't redo the work.
  if (isMalformedReceiverExpression(normalizedExpression)) {
    return undefined;
  }

  const cacheKey = `${normalizedExpression}@${beforeOffset}`;
  const cached = getCachedOrmReceiver(document, cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await resolveOrmReceiverAtOffsetCore(
    daemon,
    document,
    receiverExpression,
    beforeOffset,
    visited
  );

  setCachedOrmReceiver(document, cacheKey, result);
  return result;
}

async function resolveOrmReceiverAtOffsetCore(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
    return undefined;
  }

  if (daemon.isAborted()) { return undefined; }

  const visitKey = `${document.uri.toString()}:orm:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 100) {
    return undefined;
  }
  visited.add(visitKey);


  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (memberAccess) {
    const dynamicObjectReceiver = await resolveDynamicInstanceReceiverAtOffset(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      visited
    );
    const staticObjectReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      visited
    );
    const objectReceiver = preferMemberReceiver(
      staticObjectReceiver,
      dynamicObjectReceiver
    );
    const annotatedMemberReceiver = await resolveAnnotatedReceiverForMemberAccess(
      daemon,
      document,
      memberAccess.objectExpression,
      memberAccess.memberName,
      beforeOffset,
      visited
    );
    if (objectReceiver) {
      const virtualResolution = resolveVirtualOrmMember(
        objectReceiver,
        memberAccess.memberName
      );
      if (virtualResolution) {
        const resolvedReceiver = receiverFromOrmMemberResolution(
          virtualResolution,
          objectReceiver,
          memberAccess.memberName
        );
        if (resolvedReceiver) {
          return resolvedReceiver;
        }
      }

      // Try local surface index first (O(1), no IPC) for chain resolution.
      // Falls back to daemon IPC if member not found in local index.
      const localRes = daemon.resolveOrmMemberLocal(
        objectReceiver.modelLabel,
        objectReceiver.kind,
        memberAccess.memberName
      );
      if (localRes) {
        const localReceiver = receiverFromOrmMemberResolution(
          localRes, objectReceiver, memberAccess.memberName
        );
        if (localReceiver) {
          return await preferAnnotatedMemberReceiver(
            daemon,
            localReceiver, annotatedMemberReceiver, objectReceiver
          );
        }
      }

      const resolution = await daemon.resolveOrmMember(
        objectReceiver.modelLabel,
        objectReceiver.kind,
        memberAccess.memberName,
        objectReceiver.managerName
      );
      const resolvedReceiver = receiverFromOrmMemberResolution(
        resolution,
        objectReceiver,
        memberAccess.memberName
      );
      if (resolvedReceiver) {
        return await preferAnnotatedMemberReceiver(
          daemon,
          resolvedReceiver,
          annotatedMemberReceiver,
          objectReceiver
        );
      }
    }
    if (annotatedMemberReceiver) {
      return annotatedMemberReceiver;
    }
  }

  if (/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?$/.test(normalizedExpression)) {
    const modelLabel = await resolveModelLabelFromSymbol(
      daemon,
      document,
      normalizedExpression,
      beforeOffset
    );
    if (modelLabel) {
      return {
        kind: 'model_class',
        modelLabel,
      };
    }
  }

  const callResolvedReceiver = await resolveOrmReceiverFromCallExpression(
    daemon,
    document,
    normalizedExpression,
    beforeOffset,
    visited
  );
  if (callResolvedReceiver) {
    return callResolvedReceiver;
  }

  const rootIdentifier = receiverRootIdentifier(normalizedExpression);
  if (!rootIdentifier) {
    return undefined;
  }

  const loopTargetReceiver = await resolveOrmReceiverFromLoopTarget(
    daemon,
    document,
    rootIdentifier,
    beforeOffset,
    visited
  );
  if (loopTargetReceiver) {
    return loopTargetReceiver;
  }

  const annotatedReceiver = await resolveAnnotatedReceiverForIdentifier(
    daemon,
    document,
    rootIdentifier,
    beforeOffset
  );
  if (annotatedReceiver) {
    return annotatedReceiver;
  }

  const tupleAssignedReceiver = await resolveTupleAssignedReceiverAtOffset(
    daemon,
    document,
    rootIdentifier,
    beforeOffset,
    visited
  );
  if (tupleAssignedReceiver) {
    return tupleAssignedReceiver;
  }

  const assignment = findNearestAssignedExpression(
    document,
    rootIdentifier,
    beforeOffset
  );
  if (!assignment) {
    // Fallback: snake_case variable name → PascalCase model name convention,
    // with light pluralization variants (vendors → Vendor,
    // directors_meeting → DirectorMeeting) so collection-style parameter
    // names still resolve to the underlying instance model.
    for (const pascalName of snakeToPascalCaseVariants(rootIdentifier)) {
      const fallbackLabel = daemon.modelLabelByName.get(pascalName);
      if (fallbackLabel) {
        return { kind: 'instance', modelLabel: fallbackLabel };
      }
    }
    return undefined;
  }

  const assignmentReceiver = await resolveOrmReceiverAtOffset(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    visited
  );
  if (assignmentReceiver) {
    return assignmentReceiver;
  }

  // Fallback: assignment resolution failed; try snake_case → PascalCase
  // along with light pluralization variants.
  for (const pascalName of snakeToPascalCaseVariants(rootIdentifier)) {
    const fallbackLabel = daemon.modelLabelByName.get(pascalName);
    if (fallbackLabel) {
      return { kind: 'instance', modelLabel: fallbackLabel };
    }
  }
  return undefined;
}

function preferMemberReceiver(
  staticReceiver: OrmReceiverInfo | undefined,
  dynamicReceiver: OrmReceiverInfo | undefined
): OrmReceiverInfo | undefined {
  if (staticReceiver?.virtualFields?.length) {
    return staticReceiver;
  }

  if (
    staticReceiver &&
    staticReceiver.kind !== 'instance' &&
    staticReceiver.kind !== 'unknown' &&
    staticReceiver.kind !== 'scalar'
  ) {
    return staticReceiver;
  }

  if (
    staticReceiver &&
    dynamicReceiver &&
    staticReceiver.kind === dynamicReceiver.kind &&
    staticReceiver.modelLabel === dynamicReceiver.modelLabel
  ) {
    return mergeReceiverMetadata(staticReceiver, dynamicReceiver);
  }

  if (
    staticReceiver &&
    dynamicReceiver &&
    staticReceiver.kind === dynamicReceiver.kind &&
    staticReceiver.modelLabel !== dynamicReceiver.modelLabel
  ) {
    return staticReceiver;
  }

  return dynamicReceiver ?? staticReceiver;
}

function preferLookupChainReceiver(
  lookupReceiver: OrmReceiverInfo | undefined,
  ormReceiver: OrmReceiverInfo | undefined
): OrmReceiverInfo | undefined {
  if (
    lookupReceiver &&
    ormReceiver &&
    lookupReceiver.kind === 'instance' &&
    ormReceiver.kind === 'instance' &&
    lookupReceiver.modelLabel !== ormReceiver.modelLabel
  ) {
    return ormReceiver;
  }

  return preferMemberReceiver(lookupReceiver, ormReceiver);
}

async function preferAnnotatedMemberReceiver(
  daemon: AnalysisDaemon,
  resolvedReceiver: OrmReceiverInfo | undefined,
  annotatedReceiver: OrmReceiverInfo | undefined,
  objectReceiver: OrmReceiverInfo
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  if (!annotatedReceiver) {
    return resolvedReceiver;
  }

  if (!resolvedReceiver) {
    return annotatedReceiver;
  }

  if (
    resolvedReceiver.modelLabel === objectReceiver.modelLabel &&
    annotatedReceiver.modelLabel !== objectReceiver.modelLabel
  ) {
    return annotatedReceiver;
  }

  const preferredAnnotatedModelLabel = await resolvePreferredAnnotatedModelLabel(
    daemon,
    resolvedReceiver,
    annotatedReceiver
  );
  if (preferredAnnotatedModelLabel) {
    return mergeReceiverMetadata(
      overrideReceiverModelLabel(resolvedReceiver, preferredAnnotatedModelLabel),
      annotatedReceiver
    );
  }

  if (
    annotatedReceiver.modelLabel === resolvedReceiver.modelLabel &&
    annotatedReceiver.kind !== resolvedReceiver.kind
  ) {
    return mergeReceiverMetadata(annotatedReceiver, resolvedReceiver);
  }

  return mergeReceiverMetadata(resolvedReceiver, annotatedReceiver);
}

async function preferReceiverAnnotation(
  daemon: AnalysisDaemon,
  resolvedReceiver: OrmReceiverInfo | undefined,
  annotatedReceiver: OrmReceiverInfo | undefined
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  if (!annotatedReceiver) {
    return resolvedReceiver;
  }

  if (!resolvedReceiver) {
    return annotatedReceiver;
  }

  const preferredAnnotatedModelLabel = await resolvePreferredAnnotatedModelLabel(
    daemon,
    resolvedReceiver,
    annotatedReceiver
  );
  if (preferredAnnotatedModelLabel) {
    return mergeReceiverMetadata(
      overrideReceiverModelLabel(resolvedReceiver, preferredAnnotatedModelLabel),
      annotatedReceiver
    );
  }

  if (
    annotatedReceiver.modelLabel === resolvedReceiver.modelLabel &&
    annotatedReceiver.kind !== resolvedReceiver.kind
  ) {
    return mergeReceiverMetadata(annotatedReceiver, resolvedReceiver);
  }

  return mergeReceiverMetadata(resolvedReceiver, annotatedReceiver);
}

function overrideReceiverModelLabel(
  receiver: OrmReceiverInfo,
  modelLabel: string
): OrmReceiverInfo {
  if (receiver.modelLabel === modelLabel) {
    return receiver;
  }

  return {
    ...receiver,
    modelLabel,
  };
}

async function resolvePreferredAnnotatedModelLabel(
  daemon: AnalysisDaemon,
  resolvedReceiver: OrmReceiverInfo,
  annotatedReceiver: OrmReceiverInfo
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  if (resolvedReceiver.modelLabel === annotatedReceiver.modelLabel) {
    return undefined;
  }

  return (await isModelLabelSubclassOf(
    daemon,
    resolvedReceiver.modelLabel,
    annotatedReceiver.modelLabel,
    new Set()
  ))
    ? annotatedReceiver.modelLabel
    : undefined;
}

function mergeReceiverMetadata(
  primaryReceiver: OrmReceiverInfo | undefined,
  secondaryReceiver: OrmReceiverInfo | undefined
): OrmReceiverInfo | undefined {
  if (!primaryReceiver) {
    return secondaryReceiver;
  }

  if (!secondaryReceiver) {
    return primaryReceiver;
  }

  const virtualFields = dedupeVirtualFields([
    ...(primaryReceiver.virtualFields ?? []),
    ...(secondaryReceiver.virtualFields ?? []),
  ]);

  return {
    ...primaryReceiver,
    managerName: primaryReceiver.managerName ?? secondaryReceiver.managerName,
    classSource: primaryReceiver.classSource ?? secondaryReceiver.classSource,
    specialKind: primaryReceiver.specialKind ?? secondaryReceiver.specialKind,
    virtualFields: virtualFields.length > 0 ? virtualFields : undefined,
  };
}

async function resolveDynamicInstanceReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
    return undefined;
  }

  if (daemon.isAborted()) { return undefined; }

  const visitKey = `${document.uri.toString()}:dynamic-instance:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 100) {
    return undefined;
  }
  visited.add(visitKey);

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (memberAccess) {
    const dynamicObjectReceiver = await resolveDynamicInstanceReceiverAtOffset(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      visited
    );
    const staticObjectReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      visited
    );
    const objectReceiver = preferMemberReceiver(
      staticObjectReceiver,
      dynamicObjectReceiver
    );
    if (objectReceiver) {
      const virtualResolution = resolveVirtualOrmMember(
        objectReceiver,
        memberAccess.memberName
      );
      if (virtualResolution) {
        const resolvedReceiver = receiverFromOrmMemberResolution(
          virtualResolution,
          objectReceiver,
          memberAccess.memberName
        );
        if (resolvedReceiver) {
          return resolvedReceiver;
        }
      }

      const localRes2 = daemon.resolveOrmMemberLocal(
        objectReceiver.modelLabel, objectReceiver.kind, memberAccess.memberName
      );
      if (localRes2) {
        const lr = receiverFromOrmMemberResolution(localRes2, objectReceiver, memberAccess.memberName);
        if (lr) return lr;
      }
      const resolution = await daemon.resolveOrmMember(
        objectReceiver.modelLabel,
        objectReceiver.kind,
        memberAccess.memberName,
        objectReceiver.managerName
      );
      const resolvedReceiver = receiverFromOrmMemberResolution(
        resolution,
        objectReceiver,
        memberAccess.memberName
      );
      if (resolvedReceiver) {
        return resolvedReceiver;
      }
    }
  }

  const modelLabel = await resolveBaseModelLabelForReceiverAtOffset(
    daemon,
    document,
    normalizedExpression,
    beforeOffset,
    new Set()
  );
  if (!modelLabel) {
    return undefined;
  }

  return {
    kind: 'instance',
    modelLabel,
  };
}

async function resolveOrmReceiverFromCallExpression(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const parsedCall = parseCalledExpression(expression);
  if (!parsedCall) {
    return undefined;
  }

  const chainedReceiver = await resolveOrmReceiverFromCallChain(
    daemon,
    document,
    expression,
    beforeOffset,
    visited
  );
  if (chainedReceiver) {
    return chainedReceiver;
  }

  if (parsedCall.kind === 'function') {
    const functionSource = await resolveFunctionDefinitionSource(
      daemon,
      document,
      parsedCall.functionName,
      beforeOffset
    );
    if (!functionSource) {
      return undefined;
    }

    return resolveOrmReceiverFromFunctionSource(
      daemon,
      functionSource,
      visited
    );
  }

  if (parsedCall.objectExpression === 'self' || parsedCall.objectExpression === 'cls') {
    const classDef = findEnclosingClassDefinition(document, beforeOffset);
    if (!classDef) {
      return undefined;
    }

    return resolveOrmReceiverFromClassMethodSource(
      daemon,
      {
        document,
        classDef,
        beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
      },
      parsedCall.memberName,
      visited
    );
  }

  if (parsedCall.objectExpression === 'super()') {
    const classDef = findEnclosingClassDefinition(document, beforeOffset);
    if (!classDef) {
      return undefined;
    }

    return resolveOrmReceiverFromBaseClasses(
      daemon,
      {
        document,
        classDef,
        beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
      },
      parsedCall.memberName,
      visited,
      new Set()
    );
  }

  const objectReceiver = await resolveOrmReceiverAtOffset(
    daemon,
    document,
    parsedCall.objectExpression,
    beforeOffset,
    visited
  );
  if (objectReceiver) {
    // Fast path for custom annotation methods (`annotate_*` / `with_*`): mirror
    // the one in resolveLookupReceiverFromCallExpression. This parallel resolver
    // is invoked alongside the lookup-chain resolver on every assignment/member
    // step, and without this it falls through to
    // resolveOrmReceiverFromClassMethodSource which resolves the method's `-> Self`
    // return annotation (resolveExportOrigin(typing, Self) + class hierarchy
    // walks) — ~1–2s per deep self-reassignment chain, the dominant remaining
    // timeout. Such a method is a queryset operation regardless of how the object
    // receiver was (mis)classified (instance/model_class/queryset), so we only
    // require a known model and resolve directly as a same-model queryset with
    // memoized virtual fields. Underscore-gated so the builtin exact `annotate(...)`
    // is untouched.
    if (
      /^(annotate_|with_)/.test(parsedCall.memberName) &&
      objectReceiver.modelLabel
    ) {
      const inherited = objectReceiver.virtualFields ?? [];
      const added = await resolveVirtualFieldsFromCustomMethod(
        daemon,
        objectReceiver,
        parsedCall.memberName
      );
      const virtualFields = dedupeVirtualFields([...inherited, ...added]);
      return {
        kind: 'queryset',
        modelLabel: objectReceiver.modelLabel,
        virtualFields: virtualFields.length > 0 ? virtualFields : undefined,
      };
    }

    const virtualResolution = resolveVirtualOrmMember(
      objectReceiver,
      parsedCall.memberName
    );
    if (virtualResolution) {
      const resolvedReceiver = receiverFromOrmMemberResolution(
        virtualResolution,
        objectReceiver,
        parsedCall.memberName,
        expression
      );
      if (resolvedReceiver) {
        return resolvedReceiver;
      }
    }

    const resolution =
      daemon.resolveOrmMemberLocal(
        objectReceiver.modelLabel,
        objectReceiver.kind,
        parsedCall.memberName
      ) ??
      (await daemon.resolveOrmMember(
        objectReceiver.modelLabel,
        objectReceiver.kind,
        parsedCall.memberName,
        objectReceiver.managerName
      ));
    const resolvedReceiver = receiverFromOrmMemberResolution(
      resolution,
      objectReceiver,
      parsedCall.memberName,
      expression
    );
    if (resolvedReceiver) {
      const sourceResolvedReceiver = await resolveReceiverFromOrmMemberSource(
        daemon,
        resolution.item,
        visited
      );
      return mergeReceiverVirtualFields(resolvedReceiver, sourceResolvedReceiver);
    }
  }

  const classSource = await resolveClassDefinitionForExpression(
    daemon,
    document,
    parsedCall.objectExpression,
    beforeOffset,
    visited
  );
  if (!classSource) {
    return undefined;
  }

  return resolveOrmReceiverFromClassMethodSource(
    daemon,
    classSource,
    parsedCall.memberName,
    visited
  );
}

async function resolveOrmReceiverFromCallChain(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const chain = collectOrmMemberChain(expression);
  if (!chain) {
    return undefined;
  }

  const hasUnsafe = chain.members.some(
    (member) => member === 'annotate' || member === 'alias'
  );
  if (hasUnsafe) {
    return undefined;
  }

  const SAFE_CHAIN_METHODS = new Set([
    'objects',
    'all',
    'filter',
    'exclude',
    'get',
    'aggregate',
    'update',
    'create',
    'get_or_create',
    'update_or_create',
    'values',
    'values_list',
    'order_by',
    'only',
    'defer',
    'select_related',
    'prefetch_related',
    'distinct',
    'reverse',
    'none',
    'union',
    'intersection',
    'difference',
    'using',
    'first',
    'last',
    'earliest',
    'latest',
    'count',
    'exists',
    'bulk_create',
    'bulk_update',
    'in_bulk',
    'iterator',
    'delete',
    'dates',
    'datetimes',
    'raw',
    'get_queryset',
    'exclude_deleted',
  ]);
  if (chain.members.some((member) => !SAFE_CHAIN_METHODS.has(member))) {
    return undefined;
  }

  let baseReceiver: OrmReceiverInfo | undefined;
  if (/^[A-Za-z_][\w]*$/.test(chain.baseExpression)) {
    const baseLabel = daemon.modelLabelByName.get(chain.baseExpression);
    if (baseLabel) {
      baseReceiver = {
        kind: 'model_class',
        modelLabel: baseLabel,
      };
    }
  }

  if (!baseReceiver) {
    const dynamicBaseReceiver = await resolveDynamicInstanceReceiverAtOffset(
      daemon,
      document,
      chain.baseExpression,
      beforeOffset,
      new Set(visited)
    );
    const staticBaseReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      chain.baseExpression,
      beforeOffset,
      new Set(visited)
    );
    baseReceiver = preferMemberReceiver(
      staticBaseReceiver,
      dynamicBaseReceiver
    );
  }

  if (!baseReceiver) {
    return undefined;
  }

  const localResult = daemon.resolveOrmMemberChainLocal(
    baseReceiver.modelLabel,
    baseReceiver.kind,
    chain.members,
    baseReceiver.managerName
  );
  if (
    localResult.resolved &&
    localResult.modelLabel &&
    localResult.receiverKind &&
    isOrmReceiverKind(localResult.receiverKind)
  ) {
    return {
      kind: localResult.receiverKind,
      modelLabel: localResult.modelLabel,
      managerName: localResult.managerName,
    };
  }

  const ipcResult = await daemon.resolveOrmMemberChain(
    baseReceiver.modelLabel,
    baseReceiver.kind,
    chain.members,
    baseReceiver.managerName
  );
  if (
    ipcResult.resolved &&
    ipcResult.modelLabel &&
    ipcResult.receiverKind &&
    isOrmReceiverKind(ipcResult.receiverKind)
  ) {
    return {
      kind: ipcResult.receiverKind,
      modelLabel: ipcResult.modelLabel,
      managerName: ipcResult.managerName,
    };
  }

  return undefined;
}

async function resolveOrmReceiverFromFunctionSource(
  daemon: AnalysisDaemon,
  functionSource: FunctionDefinitionSource,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  return memoizeFunctionBodyResolution(
    daemon,
    functionReceiverCache,
    functionSource,
    visited,
    (bodyVisited) =>
      resolveOrmReceiverFromFunctionSourceUncached(daemon, functionSource, bodyVisited)
  );
}

/**
 * Shared memo wrapper for the two expensive "what does this function return"
 * analyses (resolveOrmReceiverFromFunctionSource / resolveModelLabelFromFunctionSource).
 * A function's return is call-site-independent, so the result is shared across all
 * callers via a per-daemon, document-version-keyed PROMISE cache (concurrent
 * callers await one in-flight computation — never a sentinel that would hand a
 * sibling a spurious `undefined`). Self/mutual recursion is broken WITHOUT
 * deadlock by threading per-stack function-recursion keys through `visited`: a
 * re-entrant call sees its own key already present and returns undefined. The
 * body is analysed under a FRESH visited seeded with only those recursion keys,
 * so the cached value never depends on how deep the first caller's chain was.
 */
async function memoizeFunctionBodyResolution<T>(
  daemon: AnalysisDaemon,
  cache: WeakMap<AnalysisDaemon, Map<string, Promise<T | undefined>>>,
  functionSource: FunctionDefinitionSource,
  visited: Set<string>,
  compute: (bodyVisited: Set<string>) => Promise<T | undefined>
): Promise<T | undefined> {
  const uri = functionSource.document.uri.toString();
  const recursionKey = `${FUNCTION_RECURSION_KEY_PREFIX}${uri}::${functionSource.functionDef.line}`;
  if (visited.has(recursionKey)) {
    // Self/mutual recursion up the current stack — bail rather than await our
    // own (or an ancestor's) still-pending promise.
    return undefined;
  }

  let perDaemon = cache.get(daemon);
  if (!perDaemon) {
    perDaemon = new Map();
    cache.set(daemon, perDaemon);
  }
  const cacheKey = `${uri}::${functionSource.document.version}::${functionSource.functionDef.line}`;
  const cachedPromise = perDaemon.get(cacheKey);
  if (cachedPromise) {
    return cachedPromise;
  }

  // Fresh body visited: carry forward ONLY the function-recursion keys (so
  // self/mutual recursion is still detected) and drop the caller's expression
  // keys (so the result is independent of the caller's chain depth / size cap).
  const bodyVisited = new Set(
    [...visited].filter((k) => k.startsWith(FUNCTION_RECURSION_KEY_PREFIX))
  );
  bodyVisited.add(recursionKey);

  const computed = compute(bodyVisited);
  perDaemon.set(cacheKey, computed);
  try {
    const result = await computed;
    if (daemon.isAborted() && perDaemon.get(cacheKey) === computed) {
      // Don't persist a cancellation-induced miss (would stick later callers on
      // a model-only fallback until the next reset).
      perDaemon.delete(cacheKey);
    }
    return result;
  } catch (error) {
    if (perDaemon.get(cacheKey) === computed) {
      perDaemon.delete(cacheKey);
    }
    throw error;
  }
}

async function resolveOrmReceiverFromFunctionSourceUncached(
  daemon: AnalysisDaemon,
  functionSource: FunctionDefinitionSource,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const returnExpressions = collectReturnExpressions(
    functionSource.document,
    functionSource.functionDef
  );
  const resolvedReceivers = new Map<string, OrmReceiverInfo>();
  for (const returnExpression of returnExpressions) {
    const resolvedReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      functionSource.document,
      returnExpression.expression,
      returnExpression.offset,
      visited
    );
    if (!resolvedReceiver) {
      continue;
    }
    resolvedReceivers.set(receiverInfoKey(resolvedReceiver), resolvedReceiver);
  }

  if (resolvedReceivers.size === 1) {
    return [...resolvedReceivers.values()][0];
  }

  return resolveReceiverFromFunctionReturnAnnotation(daemon, functionSource);
}

async function resolveOrmReceiverFromClassMethodSource(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const methodSource = await resolveMethodDefinitionInClassHierarchy(
    daemon,
    classSource,
    methodName,
    new Set()
  );
  if (!methodSource) {
    return undefined;
  }

  return resolveOrmReceiverFromFunctionSource(daemon, methodSource, visited);
}

async function resolveOrmReceiverFromBaseClasses(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string,
  visited: Set<string>,
  visitedClasses: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const methodSource = await resolveMethodDefinitionFromBaseClasses(
    daemon,
    classSource,
    methodName,
    visitedClasses
  );
  if (!methodSource) {
    return undefined;
  }

  return resolveOrmReceiverFromFunctionSource(daemon, methodSource, visited);
}

function receiverFromOrmMemberResolution(
  resolution: OrmMemberResolution,
  sourceReceiver?: OrmReceiverInfo,
  memberName?: string,
  expression?: string
): OrmReceiverInfo | undefined {
  if (!resolution.resolved || !resolution.item) {
    return undefined;
  }

  return receiverFromOrmMemberItem(
    resolution.item,
    sourceReceiver,
    memberName,
    expression
  );
}

function receiverFromOrmMemberItem(
  item: OrmMemberItem,
  sourceReceiver?: OrmReceiverInfo,
  memberName?: string,
  expression?: string
): OrmReceiverInfo | undefined {
  if (!item.returnKind || !isOrmReceiverKind(item.returnKind)) {
    return undefined;
  }
  if (item.returnKind === 'scalar' || item.returnKind === 'unknown') {
    return undefined;
  }

  const modelLabel = item.returnModelLabel ?? item.modelLabel;
  if (!modelLabel) {
    return undefined;
  }

  return {
    kind: item.returnKind,
    modelLabel,
    managerName:
      item.returnKind === 'manager'
        ? item.managerName ?? item.name
        : item.managerName,
    virtualFields: propagateVirtualFields(
      sourceReceiver,
      item.returnKind,
      memberName,
      expression
    ),
  };
}

function mergeReceiverVirtualFields(
  baseReceiver: OrmReceiverInfo,
  sourceReceiver: OrmReceiverInfo | undefined
): OrmReceiverInfo {
  if (!sourceReceiver?.virtualFields?.length) {
    return baseReceiver;
  }

  return {
    ...baseReceiver,
    virtualFields: dedupeVirtualFields([
      ...(baseReceiver.virtualFields ?? []),
      ...sourceReceiver.virtualFields,
    ]),
  };
}

async function resolveReceiverFromOrmMemberSource(
  daemon: AnalysisDaemon,
  item: OrmMemberItem | undefined,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  if (!item?.filePath || !item.line) {
    return undefined;
  }

  const source = await resolveFunctionDefinitionSourceFromFile(
    item.filePath,
    item.name,
    item.line
  );
  if (!source) {
    return undefined;
  }

  const directAnnotatedReceiver = resolveDirectAnnotatedReceiverFromFunctionSource(
    item,
    source
  );
  if (directAnnotatedReceiver) {
    return directAnnotatedReceiver;
  }

  return resolveOrmReceiverFromFunctionSource(daemon, source, visited);
}

function propagateVirtualFields(
  sourceReceiver: OrmReceiverInfo | undefined,
  returnKind: OrmReceiverKind,
  memberName: string | undefined,
  expression: string | undefined
): VirtualOrmField[] | undefined {
  const inheritedFields = sourceReceiver?.virtualFields ?? [];
  const nextFields = [...inheritedFields];

  if (memberName === 'annotate' || memberName === 'alias') {
    nextFields.push(
      ...parseVirtualFieldsFromAnnotatedCall(expression, memberName === 'annotate')
    );
  }

  const mergedFields = dedupeVirtualFields(nextFields);
  if (mergedFields.length === 0) {
    return undefined;
  }

  if (
    returnKind === 'queryset' &&
    memberName &&
    QUERYSET_ANNOTATION_PRESERVING_METHODS.has(memberName)
  ) {
    return mergedFields;
  }

  if (
    returnKind === 'instance' &&
    memberName &&
    INSTANCE_ANNOTATION_PRESERVING_METHODS.has(memberName)
  ) {
    return mergedFields.filter((field) => field.instanceAvailable);
  }

  return undefined;
}

function dedupeVirtualFields(fields: VirtualOrmField[]): VirtualOrmField[] {
  const byName = new Map<string, VirtualOrmField>();
  for (const field of fields) {
    const existing = byName.get(field.name);
    if (!existing) {
      byName.set(field.name, field);
      continue;
    }

    byName.set(field.name, {
      ...field,
      instanceAvailable: existing.instanceAvailable || field.instanceAvailable,
    });
  }

  return [...byName.values()];
}

/**
 * Extract virtual (annotated) field names that a CUSTOM QuerySet method adds via
 * `.annotate(...)` / `.alias(...)` in its body, so that `filter(_x__...)` on
 * those fields resolves. Resolves the model's custom QuerySet/Manager class by
 * the `<Model>QuerySet` / `<Model>Manager` naming convention — looked up in the
 * MODEL's own module so cross-file class definitions resolve — finds the method
 * in its hierarchy, and scans the body. Gated on annotation-adding method names
 * (`annotate_*` / `with_*`) so ordinary chainable custom methods do not pay for
 * class/method resolution.
 */
async function resolveVirtualFieldsFromCustomMethod(
  daemon: AnalysisDaemon,
  objectReceiver: OrmReceiverInfo,
  methodName: string
): Promise<VirtualOrmField[]> {
  if (daemon.isAborted()) {
    return [];
  }
  if (!/^(annotate|with_)/.test(methodName)) {
    return [];
  }
  const modelLabel = objectReceiver.modelLabel;
  if (!modelLabel) {
    return [];
  }
  // Memoize per (modelLabel, methodName): the extraction is deterministic and
  // expensive (class resolution + document open + body scan), and a deep self-
  // reassignment chain re-requests the same methods hundreds of times. The cache
  // is cleared on daemon-state change via resetProviderResolutionCaches().
  let perDaemon = customMethodVirtualFieldsCache.get(daemon);
  if (!perDaemon) {
    perDaemon = new Map();
    customMethodVirtualFieldsCache.set(daemon, perDaemon);
  }
  const cacheKey = `${modelLabel}::${methodName}`;
  const cached = perDaemon.get(cacheKey);
  if (cached) {
    return cached;
  }
  const computed = resolveVirtualFieldsFromCustomMethodUncached(
    daemon,
    objectReceiver,
    methodName,
    modelLabel
  );
  perDaemon.set(cacheKey, computed);
  try {
    return await computed;
  } catch (error) {
    // Do not poison the cache with a rejected promise.
    if (perDaemon.get(cacheKey) === computed) {
      perDaemon.delete(cacheKey);
    }
    throw error;
  }
}

async function resolveVirtualFieldsFromCustomMethodUncached(
  daemon: AnalysisDaemon,
  objectReceiver: OrmReceiverInfo,
  methodName: string,
  modelLabel: string
): Promise<VirtualOrmField[]> {
  const shortModel = modelLabel.includes('.')
    ? modelLabel.split('.').at(-1)!
    : modelLabel;

  const modelClassSource = await resolveClassDefinitionForModelLabel(
    daemon,
    modelLabel
  );
  if (!modelClassSource || daemon.isAborted()) {
    return [];
  }

  // Resolve the custom QuerySet/Manager class IN THE MODEL'S MODULE (where it is
  // defined/imported), by convention name.
  let querysetClassSource: ClassDefinitionSource | undefined;
  for (const className of [`${shortModel}QuerySet`, `${shortModel}Manager`]) {
    querysetClassSource = await resolveClassDefinitionFromTypeAnnotation(
      daemon,
      modelClassSource.document,
      className,
      modelClassSource.beforeOffset
    );
    if (querysetClassSource || daemon.isAborted()) {
      break;
    }
  }
  if (!querysetClassSource) {
    return [];
  }

  const methodSource = await resolveMethodDefinitionInClassHierarchy(
    daemon,
    querysetClassSource,
    methodName,
    new Set()
  );
  if (!methodSource) {
    return [];
  }

  return extractAnnotatedVirtualFieldsFromMethodBody(methodSource);
}

/**
 * Replace the CONTENT of Python string literals (single/double/triple-quoted,
 * honoring backslash escapes) and `#` comments with spaces, preserving length
 * and every index so downstream regex / paren-matching / offset slicing stay
 * aligned. The quote and `#` delimiters themselves are kept; only the bytes
 * inside are neutralized. This stops `.annotate(`-like substrings that live
 * INSIDE a string literal or comment (e.g. `filter(note=".annotate(evil=1)")`,
 * `.extra(where=[...])`, RawSQL) from being mis-parsed as real annotate calls.
 */
function maskPythonStringsAndComments(text: string): string {
  const out = text.split('');
  const n = out.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      while (i < n && text[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text[i + 1] === c && text[i + 2] === c;
      const quoteLen = triple ? 3 : 1;
      i += quoteLen; // keep the opening delimiter(s) as-is
      while (i < n) {
        if (text[i] === '\\') {
          if (i < n) { out[i] = ' '; }
          if (i + 1 < n) { out[i + 1] = ' '; }
          i += 2;
          continue;
        }
        if (triple) {
          if (text[i] === c && text[i + 1] === c && text[i + 2] === c) {
            i += 3; // keep closing delimiters
            break;
          }
        } else {
          if (text[i] === c) {
            i += 1;
            break;
          }
          if (text[i] === '\n') {
            i += 1; // unterminated single-line literal
            break;
          }
        }
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Scan a method body for `.annotate(...)` / `.alias(...)` calls and return the
 * virtual fields they define (reusing the same kwarg parser the direct-call
 * path uses). String literals and comments are masked first so an annotate-like
 * substring inside a SQL string / docstring / comment is not mistaken for a real
 * annotation.
 */
function extractAnnotatedVirtualFieldsFromMethodBody(
  source: FunctionDefinitionSource
): VirtualOrmField[] {
  const { document, functionDef } = source;
  const endLine = Math.min(functionDef.endLine, document.lineCount - 1);
  let body = '';
  for (let line = functionDef.line; line <= endLine; line += 1) {
    body += `${document.lineAt(line).text}\n`;
  }
  return extractAnnotatedVirtualFieldsFromText(body);
}

/**
 * Shared annotate/alias kwarg extractor over a raw code string. Drives the
 * regex and paren matcher off a string/comment-masked copy (so no match begins
 * inside a literal), then slices the real kwarg text from the original using the
 * masked bounds.
 */
function extractAnnotatedVirtualFieldsFromText(text: string): VirtualOrmField[] {
  const masked = maskPythonStringsAndComments(text);
  const fields: VirtualOrmField[] = [];
  const callRe = /\.(annotate|alias)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(masked)) !== null) {
    const isAnnotate = match[1] === 'annotate';
    const openParenIndex = masked.indexOf('(', match.index);
    if (openParenIndex < 0) {
      continue;
    }
    const closeParenIndex = findMatchingClosingDelimiter(
      masked,
      openParenIndex,
      '(',
      ')'
    );
    if (closeParenIndex === undefined) {
      continue;
    }
    const argsText = text.slice(openParenIndex + 1, closeParenIndex);
    fields.push(
      ...parseVirtualFieldsFromAnnotatedCall(
        `q.${match[1]}(${argsText})`,
        isAnnotate
      )
    );
  }
  return dedupeVirtualFields(fields);
}

/**
 * Extract every annotated virtual field added by a single chain expression like
 * `get_emps(hrm).annotate_status_at().filter(...).annotate(_x=Sum(...))`:
 *  - builtin `.annotate(...)` / `.alias(...)` → parse the kwargs directly;
 *  - custom `.annotate_*()` / `.with_*()` methods → resolve the method body
 *    (memoized) for the model.
 * Used by the path-independent chain collector below so virtual fields survive
 * regardless of which receiver resolver (instance / model_class / queryset /
 * daemon member-chain) ultimately produced the receiver.
 */
async function extractVirtualFieldsFromChainExpression(
  daemon: AnalysisDaemon,
  modelLabel: string,
  expression: string
): Promise<VirtualOrmField[]> {
  if (daemon.isAborted() || !expression) {
    return [];
  }
  // Builtin .annotate(...)/.alias(...) — string/comment-masked so an annotate
  // substring inside a literal does not mint a phantom field.
  const fields: VirtualOrmField[] = [
    ...extractAnnotatedVirtualFieldsFromText(expression),
  ];
  // Custom annotate_*/with_* methods — scan the masked text so a method-like name
  // inside a string literal is not resolved as a real custom method.
  const masked = maskPythonStringsAndComments(expression);
  const callRe = /\.(annotate_[A-Za-z0-9_]*|with_[A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(masked)) !== null) {
    if (daemon.isAborted()) {
      break;
    }
    const added = await resolveVirtualFieldsFromCustomMethod(
      daemon,
      { kind: 'queryset', modelLabel },
      match[1]
    );
    fields.push(...added);
  }
  return fields;
}

/**
 * Path-independent virtual-field collector. Walks the FULL assignment history of
 * a bare variable receiver — `x = get_emps(hrm)`, `x = x.annotate_*()...`,
 * `x = x.filter(...)` (self-reassignment chains, conditionals, etc.) — and
 * accumulates every annotated virtual field added along the way.
 *
 * Receiver resolution has many code paths (local, IPC member-chain, dynamic
 * instance, fast-path) and most of them drop client-side virtualFields — e.g. a
 * helper annotated `-> <Model>QuerySet` (generic `QuerySet[T_co]`) resolves to an
 * `instance`, and a trailing `.filter()` is resolved via the daemon member-chain
 * which carries no virtualFields. Rather than thread virtualFields through every
 * path, we resolve the receiver's MODEL however we can and then attach the
 * annotated fields here, independent of the path that produced the model.
 */
async function collectVirtualFieldsForReceiverExpression(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  modelLabel: string,
  deadlineMs?: number
): Promise<VirtualOrmField[]> {
  if (daemon.isAborted() || isReceiverDeadlineExpired(deadlineMs)) {
    return [];
  }
  let variableName = receiverRootIdentifier(receiverExpression);
  // Only bare-variable receivers have an assignment history to walk.
  if (!variableName || variableName !== normalizeReceiverExpression(receiverExpression)) {
    return [];
  }

  const collected: VirtualOrmField[] = [];
  let offset = beforeOffset;
  const seen = new Set<string>();
  for (let depth = 0; depth < 48; depth += 1) {
    if (daemon.isAborted() || isReceiverDeadlineExpired(deadlineMs)) {
      break;
    }
    const assignment = findNearestAssignedExpression(document, variableName, offset);
    if (!assignment) {
      break;
    }
    const guardKey = `${variableName}@${assignment.offset}`;
    if (seen.has(guardKey)) {
      break;
    }
    seen.add(guardKey);

    collected.push(
      ...(await extractVirtualFieldsFromChainExpression(
        daemon,
        modelLabel,
        assignment.expression
      ))
    );

    const root = receiverRootIdentifier(assignment.expression);
    offset = assignment.offset;
    if (root && root !== variableName) {
      // The RHS is rooted at a different identifier. If it is another local
      // variable, keep walking from it; otherwise (a function call / model /
      // attribute) we have reached the origin binding.
      if (findNearestAssignedExpression(document, root, assignment.offset)) {
        variableName = root;
      } else {
        break;
      }
    }
    // Self-reassignment (`x = x...`): keep the same variable; offset advanced to
    // this assignment's line so findNearestAssignedExpression moves strictly
    // upward (its same-line self-ref guard handles the boundary).
  }

  return dedupeVirtualFields(collected);
}

function parseVirtualFieldsFromAnnotatedCall(
  expression: string | undefined,
  instanceAvailable: boolean
): VirtualOrmField[] {
  if (!expression) {
    return [];
  }

  const callDetails = parseCallExpressionDetails(expression);
  if (!callDetails || callDetails.parsedCall.kind !== 'member') {
    return [];
  }

  if (
    callDetails.parsedCall.memberName !== 'annotate' &&
    callDetails.parsedCall.memberName !== 'alias'
  ) {
    return [];
  }

  const fields: VirtualOrmField[] = [];
  for (const argument of splitTopLevelExpressions(callDetails.argsText)) {
    const equalsIndex = findTopLevelEqualsIndex(argument);
    if (equalsIndex <= 0) {
      continue;
    }

    const name = argument.slice(0, equalsIndex).trim();
    const value = argument.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z_][\w]*$/.test(name) || !value) {
      continue;
    }

    fields.push(buildVirtualFieldFromExpression(name, value, instanceAvailable));
  }

  return fields;
}

function buildVirtualFieldFromExpression(
  name: string,
  expression: string,
  instanceAvailable: boolean
): VirtualOrmField {
  const call = parseCallExpressionDetails(expression);
  const expressionName =
    call?.parsedCall.kind === 'function'
      ? call.parsedCall.functionName
      : call?.parsedCall.kind === 'member'
        ? call.parsedCall.memberName
        : undefined;

  return {
    name,
    detail: expressionName
      ? `Annotated ${expressionName}() expression`
      : 'Annotated expression',
    fieldKind: inferVirtualFieldKind(expressionName),
    source: ANNOTATED_MEMBER_SOURCE,
    instanceAvailable,
    expressionName,
  };
}

function inferVirtualFieldKind(expressionName: string | undefined): string {
  switch (expressionName) {
    case 'Count':
      return 'IntegerField';
    case 'Exists':
      return 'BooleanField';
    case 'Avg':
    case 'Sum':
    case 'Min':
    case 'Max':
      return 'annotation';
    default:
      return 'annotation';
  }
}

async function resolveFunctionDefinitionSourceFromFile(
  filePath: string,
  functionName: string,
  line: number
): Promise<FunctionDefinitionSource | undefined> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const targetLine = Math.max(0, line - 1);
    const directMatch = findFunctionDefinitionAtLine(document, functionName, targetLine);
    const functionDef = directMatch ?? findNearestNamedFunctionDefinition(document, functionName, targetLine);
    if (!functionDef) {
      return undefined;
    }

    return {
      document,
      functionDef,
      beforeOffset: document.offsetAt(new vscode.Position(functionDef.line, 0)),
    };
  } catch {
    return undefined;
  }
}

function findFunctionDefinitionAtLine(
  document: vscode.TextDocument,
  functionName: string,
  line: number
): PythonFunctionDefinition | undefined {
  if (line < 0 || line >= document.lineCount) {
    return undefined;
  }

  const functionDef = parseFunctionDefinitionAtLine(document, line);
  if (!functionDef || functionDef.name !== functionName) {
    return undefined;
  }

  return functionDef;
}

function findNearestNamedFunctionDefinition(
  document: vscode.TextDocument,
  functionName: string,
  line: number
): PythonFunctionDefinition | undefined {
  for (let radius = 1; radius <= 4; radius += 1) {
    const before = findFunctionDefinitionAtLine(document, functionName, line - radius);
    if (before) {
      return before;
    }

    const after = findFunctionDefinitionAtLine(document, functionName, line + radius);
    if (after) {
      return after;
    }
  }

  return undefined;
}

function resolveDirectAnnotatedReceiverFromFunctionSource(
  item: OrmMemberItem,
  source: FunctionDefinitionSource
): OrmReceiverInfo | undefined {
  const returnExpressions = collectReturnExpressions(
    source.document,
    source.functionDef
  );
  if (returnExpressions.length !== 1) {
    return undefined;
  }

  const expression = normalizeReceiverExpression(returnExpressions[0].expression);
  const parsedCall = parseCalledExpression(expression);
  if (!parsedCall || parsedCall.kind !== 'member') {
    return undefined;
  }

  if (
    parsedCall.objectExpression !== 'self' &&
    parsedCall.objectExpression !== 'cls' &&
    parsedCall.objectExpression !== 'super()'
  ) {
    return undefined;
  }

  if (parsedCall.memberName !== 'annotate' && parsedCall.memberName !== 'alias') {
    return undefined;
  }

  return {
    kind: 'queryset',
    modelLabel: item.modelLabel,
    virtualFields: parseVirtualFieldsFromAnnotatedCall(
      expression,
      parsedCall.memberName === 'annotate'
    ),
  };
}

async function resolveTupleAssignedReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const assignment = findNearestTupleAssignedExpression(
    document,
    variableName,
    beforeOffset
  );
  if (!assignment || assignment.tupleIndex !== 0) {
    return undefined;
  }

  const parsedCall = parseCalledExpression(
    normalizeReceiverExpression(assignment.expression)
  );
  if (!parsedCall || parsedCall.kind !== 'member') {
    return undefined;
  }

  if (
    parsedCall.memberName !== 'get_or_create' &&
    parsedCall.memberName !== 'update_or_create'
  ) {
    return undefined;
  }

  const sourceReceiver = await resolveOrmReceiverAtOffset(
    daemon,
    document,
    parsedCall.objectExpression,
    assignment.offset,
    visited
  );
  if (!sourceReceiver) {
    return undefined;
  }

  return {
    kind: 'instance',
    modelLabel: sourceReceiver.modelLabel,
  };
}

async function resolveBulkCreateIterableElementReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedExpression = normalizeReceiverExpression(expression);
  if (!normalizedExpression) {
    return undefined;
  }

  const parsedCall = parseCalledExpression(normalizedExpression);
  if (parsedCall?.kind === 'member' && parsedCall.memberName === 'bulk_create') {
    const sourceReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      parsedCall.objectExpression,
      beforeOffset,
      visited
    );
    const sourceModelLabel =
      sourceReceiver?.modelLabel ??
      (await resolveBaseModelLabelForReceiverAtOffset(
        daemon,
        document,
        parsedCall.objectExpression,
        beforeOffset,
        new Set()
      ));
    if (!sourceModelLabel) {
      return undefined;
    }

    return {
      kind: 'instance',
      modelLabel: sourceModelLabel,
    };
  }

  const rootIdentifier = receiverRootIdentifier(normalizedExpression);
  if (!rootIdentifier) {
    return undefined;
  }

  const assignment = findNearestAssignedExpression(
    document,
    rootIdentifier,
    beforeOffset
  );
  if (!assignment) {
    return undefined;
  }

  return resolveBulkCreateIterableElementReceiverAtOffset(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    visited
  );
}

async function resolveOrmReceiverFromLoopTarget(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const iterableBinding = findNearestIterableBindingExpression(
    document,
    variableName,
    beforeOffset
  );
  if (!iterableBinding) {
    return undefined;
  }

  const iterableReceiver = await resolveOrmReceiverAtOffset(
    daemon,
    document,
    iterableBinding.expression,
    iterableBinding.offset,
    visited
  );
  const resolvedLoopReceiver = receiverFromIterableReceiver(iterableReceiver);
  if (resolvedLoopReceiver) {
    return resolvedLoopReceiver;
  }

  const bulkCreateLoopReceiver =
    await resolveBulkCreateIterableElementReceiverAtOffset(
      daemon,
      document,
      iterableBinding.expression,
      iterableBinding.offset,
      visited
    );
  if (bulkCreateLoopReceiver) {
    return bulkCreateLoopReceiver;
  }

  const iterableIdentifier = receiverRootIdentifier(iterableBinding.expression);
  if (!iterableIdentifier) {
    return undefined;
  }

  const iterableTypeAnnotation = findTypeAnnotationForIdentifier(
    document,
    iterableIdentifier,
    iterableBinding.offset
  );
  if (!iterableTypeAnnotation) {
    return undefined;
  }

  return resolveIterableElementReceiverFromTypeAnnotation(
    daemon,
    document,
    iterableTypeAnnotation.annotation,
    iterableTypeAnnotation.offset
  );
}

function receiverFromIterableReceiver(
  receiver: OrmReceiverInfo | undefined
): OrmReceiverInfo | undefined {
  if (!receiver) {
    return undefined;
  }

  if (receiver.kind === 'queryset' || receiver.kind === 'related_manager') {
    return {
      kind: 'instance',
      modelLabel: receiver.modelLabel,
    };
  }

  return undefined;
}

function receiverInfoKey(receiver: OrmReceiverInfo): string {
  return `${receiver.kind}:${receiver.modelLabel}:${receiver.managerName ?? ''}:${(receiver.virtualFields ?? [])
    .map((field) => field.name)
    .sort()
    .join(',')}:${receiver.classSource?.document.uri.toString() ?? ''}:${receiver.classSource?.classDef.name ?? ''}`;
}

function isOrmReceiverKind(value: string): value is OrmReceiverKind {
  return (
    value === 'model_class' ||
    value === 'instance' ||
    value === 'manager' ||
    value === 'queryset' ||
    value === 'related_manager' ||
    value === 'scalar' ||
    value === 'unknown'
  );
}

async function resolveBaseModelLabelForReceiver(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  position: vscode.Position
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  return resolveBaseModelLabelForReceiverAtOffset(
    daemon,
    document,
    receiverExpression,
    document.offsetAt(position),
    new Set()
  );
}

// captain #1 fix — Date.now() 기반 cooperative deadline.
// setTimeout 콜백은 event loop 점유 / micro-task burst 시 늦게 fire (capBypass
// E2E 가 확인). Date.now() 비교는 시스템 시계 직접 읽기라 영향 없음. receiver
// tracer chain 의 각 진입점에서 expired 체크 + 조기 return.
function isReceiverDeadlineExpired(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

/**
 * captain 옵션 C — client-side fast-path receiver kind 인식.
 *
 * captain log.txt L104 의 noRecvSamples 분석:
 *   "Model.objects" (root_matched), "Model.objects.filter(...)" 등 대다수가
 *   단순 chain. root 가 hasModelByShortName 통과하면 IPC 없이 receiver kind
 *   즉시 추론 가능. captain 첫 cycle 의 resolveExportOrigin/resolveRelationTarget
 *   폭주(16s)가 이 fast-path 로 우회됨.
 *
 * 지원 패턴:
 *   `Model`              → model_class
 *   `Model.objects`      → manager (managerName='objects')
 *   `Model.objects.filter(...)`, `Model.objects.exclude(...)` → queryset
 *   `Model.objects.get(...)`, `.create(...)` 등 instance-returning → instance
 *
 * 미지원 패턴 (fallback IPC chain) — self.X_set, 임시 변수, transform chain 등.
 */
function tryFastPathReceiverKind(
  daemon: AnalysisDaemon,
  receiverExpression: string,
): OrmReceiverInfo | undefined {
  const normalized = normalizeReceiverExpression(receiverExpression);
  if (!normalized) return undefined;

  // 단순 dotted chain 만 처리. self/cls/super 는 제외 (receiverRootIdentifier 가 막음).
  const rootIdentifier = receiverRootIdentifier(normalized);
  if (!rootIdentifier) return undefined;

  // root 가 알려진 model 인지 확인. snake→Pascal fuzzy 도 시도.
  let modelLabel = daemon.findModelLabelByShortName(rootIdentifier);
  if (!modelLabel) {
    for (const variant of snakeToPascalCaseVariants(rootIdentifier)) {
      if (variant !== rootIdentifier) {
        modelLabel = daemon.findModelLabelByShortName(variant);
        if (modelLabel) break;
      }
    }
  }
  if (!modelLabel) return undefined;

  // root 뒤의 chain segments 분석. 매우 단순한 dotted chain 만.
  // `Model.objects` → ['objects']
  // `Model.objects.filter(...)` → ['objects', 'filter(...)']
  const remainder = normalized.slice(rootIdentifier.length);
  if (remainder === '') {
    return { kind: 'model_class', modelLabel };
  }
  if (!remainder.startsWith('.')) return undefined;
  const segments = remainder.slice(1).split('.');
  // 모든 segment 가 단순 식별자 또는 `name(...)` 형태인지 확인.
  // 복잡한 indexing / subscript / 멀티-라인 표현식은 fallback.
  const segmentPattern = /^[A-Za-z_]\w*(\([^()]*\))?$/;
  for (const seg of segments) {
    if (!segmentPattern.test(seg)) return undefined;
  }

  // segment chain 별 receiver kind 추론.
  let receiverKind: OrmReceiverInfo['kind'] = 'model_class';
  let managerName: string | undefined;
  for (const seg of segments) {
    const isCall = seg.endsWith(')');
    const name = isCall ? seg.slice(0, seg.indexOf('(')) : seg;

    if (receiverKind === 'model_class') {
      // .objects, .somemanager → manager
      // captain managerName 가장 흔한 'objects' 만 확정. 다른 이름은 fallback.
      if (name === 'objects') {
        receiverKind = 'manager';
        managerName = 'objects';
      } else {
        return undefined;  // 알 수 없는 model_class attribute — IPC 로 검증 필요
      }
      continue;
    }

    if (receiverKind === 'manager' || receiverKind === 'queryset') {
      // QuerySet/Manager builtin methods 의 return kind 매핑.
      const queryReturn = inferBuiltinManagerOrQuerysetReturnKind(name);
      if (queryReturn === undefined) {
        return undefined;  // 알 수 없는 method — IPC fallback
      }
      receiverKind = queryReturn;
      continue;
    }

    // instance, related_manager 등 chain 후속 — fallback
    return undefined;
  }

  return {
    kind: receiverKind,
    modelLabel,
    ...(managerName !== undefined ? { managerName } : {}),
  };
}

/**
 * Manager/QuerySet builtin method 의 return kind 매핑. BUILTIN_QUERYSET_METHODS
 * 와 BUILTIN_MANAGER_METHODS 에서 확정적으로 알려진 것만. fast-path 안전성
 * 우선이라 unknown 은 undefined 반환 (IPC fallback).
 */
function inferBuiltinManagerOrQuerysetReturnKind(
  methodName: string,
): OrmReceiverInfo['kind'] | undefined {
  // 가장 흔한 lookup-accepting QuerySet methods. captain log 의 대다수 사용.
  const querysetReturning: ReadonlySet<string> = new Set([
    'filter', 'exclude', 'all', 'annotate', 'alias', 'order_by',
    'select_related', 'prefetch_related', 'only', 'defer', 'distinct',
    'using', 'reverse', 'extra', 'union', 'intersection', 'difference',
    'none', 'select_for_update',
    // .values()/.values_list() return a ValuesQuerySet — still a queryset that
    // accepts a trailing .annotate(_x=...) whose alias must resolve as a lookup.
    'values', 'values_list',
  ]);
  const instanceReturning: ReadonlySet<string> = new Set([
    'first', 'last', 'get', 'earliest', 'latest', 'create',
  ]);
  if (querysetReturning.has(methodName)) return 'queryset';
  if (instanceReturning.has(methodName)) return 'instance';
  return undefined;
}

async function resolveLookupReceiverInfoForReceiver(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  position: vscode.Position,
  deadlineMs?: number,
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted() || isReceiverDeadlineExpired(deadlineMs)) {
    return undefined;
  }
  // 옵션 C — fast-path. captain 의 단순 Model.objects.X chain 이 IPC 4번 거치지
  // 않고 즉시 OrmReceiverInfo 반환. captain L135 ipc-by-method 의
  // resolveExportOrigin=56/16696ms, resolveRelationTarget=5/16432ms 폭주를
  // 첫 cycle 부터 우회.
  const beforeOffset = document.offsetAt(position);
  const fastPath = tryFastPathReceiverKind(daemon, receiverExpression);
  if (fastPath) {
    // Simple `Model.objects.X` fast-path receivers have no variable assignment
    // history, so they need no virtual-field enrichment.
    return fastPath;
  }
  const localReceiver = resolveExpressionOrmReceiverLocal(
    daemon,
    document,
    receiverExpression,
    beforeOffset,
    new Set()
  );
  const resolved =
    localReceiver ??
    (await resolveLookupReceiverInfoForReceiverAtOffset(
      daemon,
      document,
      receiverExpression,
      beforeOffset,
      new Set(),
      deadlineMs,
    ));
  if (!resolved || !resolved.modelLabel) {
    return resolved;
  }
  // Path-independent enrichment: whatever path produced the receiver model,
  // attach the annotated virtual fields collected from the variable's full
  // assignment chain. This is what makes `x = x.annotate_*()...; x = x.filter()`
  // resolve `_status`/`_job_role_name`/etc. even when the receiver resolves to an
  // `instance`/`model_class` (e.g. a generic `-> QuerySet[T_co]` helper) or the
  // trailing filters were resolved via the daemon member-chain (no virtualFields).
  const chainVirtualFields = await collectVirtualFieldsForReceiverExpression(
    daemon,
    document,
    receiverExpression,
    beforeOffset,
    resolved.modelLabel,
    deadlineMs
  );
  // Also scan the receiver EXPRESSION itself for inline annotate calls — a direct
  // chain like `Model.objects.values("x").annotate(_sum=Sum(...))` is not a bare
  // variable, so the assignment-chain collector above sees nothing, yet `_sum`
  // must still resolve (builtin annotate after .values() otherwise falls to
  // kind=instance with no virtual fields).
  const inlineVirtualFields = await extractVirtualFieldsFromChainExpression(
    daemon,
    resolved.modelLabel,
    receiverExpression
  );
  const allChainVirtualFields = dedupeVirtualFields([
    ...chainVirtualFields,
    ...inlineVirtualFields,
  ]);
  if (allChainVirtualFields.length === 0) {
    return resolved;
  }
  return {
    ...resolved,
    virtualFields: dedupeVirtualFields([
      ...(resolved.virtualFields ?? []),
      ...allChainVirtualFields,
    ]),
  };
}

async function resolveLookupReceiverInfoForReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  visited: Set<string>,
  deadlineMs?: number,
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted() || isReceiverDeadlineExpired(deadlineMs)) {
    return undefined;
  }
  const resolvedReceiver = await resolveLookupReceiverAtOffset(
    daemon,
    document,
    receiverExpression,
    beforeOffset,
    visited
  );
  // captain #1 — 매 await 후 deadline 재체크. 단일 receiver tracer 가 안에서
  // 다단계 IPC 누적해도 cap 우회 방지.
  if (isReceiverDeadlineExpired(deadlineMs)) {
    return undefined;
  }
  if (resolvedReceiver) {
    return resolvedReceiver;
  }

  const modelLabel = await resolveBaseModelLabelForReceiverAtOffset(
    daemon,
    document,
    receiverExpression,
    beforeOffset,
    new Set()
  );
  if (!modelLabel) {
    return undefined;
  }

  return {
    kind: 'model_class',
    modelLabel,
  };
}

async function resolveBaseModelLabelForReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
    return undefined;
  }

  const visitKey = `${document.uri.toString()}:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 100) {
    return undefined;
  }
  visited.add(visitKey);

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  const resolvedReceiver = await resolveLookupReceiverAtOffset(
    daemon,
    document,
    normalizedExpression,
    beforeOffset,
    new Set()
  );
  if (resolvedReceiver) {
    return resolvedReceiver.modelLabel;
  }

  if (memberAccess) {
    const annotatedMemberReceiver = await resolveAnnotatedReceiverForMemberAccess(
      daemon,
      document,
      memberAccess.objectExpression,
      memberAccess.memberName,
      beforeOffset,
      new Set()
    );
    if (annotatedMemberReceiver) {
      return annotatedMemberReceiver.modelLabel;
    }
  }

  const callResolvedLabel = await resolveModelLabelFromCallExpression(
    daemon,
    document,
    normalizedExpression,
    beforeOffset,
    visited
  );
  if (callResolvedLabel) {
    return callResolvedLabel;
  }

  for (const symbolCandidate of directModelSymbolCandidates(normalizedExpression)) {
    const resolvedLabel = await resolveModelLabelFromSymbol(
      daemon,
      document,
      symbolCandidate,
      beforeOffset
    );
    if (resolvedLabel) {
      return resolvedLabel;
    }
  }

  const rootIdentifier = receiverRootIdentifier(normalizedExpression);
  if (!rootIdentifier) {
    return undefined;
  }

  const assignment = findNearestAssignedExpression(
    document,
    rootIdentifier,
    beforeOffset
  );
  if (!assignment) {
    // Mirror the snake→PascalCase fallback that resolveOrmReceiverAtOffsetCore
    // already uses for member-access receivers. Without this, an unannotated
    // collection-style parameter referenced directly as the queryset call
    // receiver (e.g. `vendors.filter(...)`) lands in noRecv even though
    // `Vendor` exists in the model graph.
    for (const pascalName of snakeToPascalCaseVariants(rootIdentifier)) {
      const fallbackLabel = daemon.modelLabelByName.get(pascalName);
      if (fallbackLabel) {
        return fallbackLabel;
      }
    }
    return undefined;
  }

  const assignedLabel = await resolveBaseModelLabelForReceiverAtOffset(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    visited
  );
  if (assignedLabel) {
    return assignedLabel;
  }
  for (const pascalName of snakeToPascalCaseVariants(rootIdentifier)) {
    const fallbackLabel = daemon.modelLabelByName.get(pascalName);
    if (fallbackLabel) {
      return fallbackLabel;
    }
  }
  return undefined;
}

function asLookupReceiver(
  receiver: OrmReceiverInfo | undefined
): OrmReceiverInfo | undefined {
  if (!receiver || !LOOKUP_RECEIVER_KINDS.has(receiver.kind)) {
    return undefined;
  }

  return receiver;
}

/**
 * Time an awaited step inside the receiver-resolution chain. When the
 * elapsed time exceeds 500ms, emit a `[receiver-step:slow]` log so
 * captain-style trace analysis can isolate which specific sub-call is
 * eating the wall time. Cheap when steps are fast (a single
 * performance.now() pair); only logs when interesting. Gated on a
 * production-noise-control env var so the receiver path stays quiet in
 * normal runs.
 */
async function timeReceiverStep<T>(
  daemon: AnalysisDaemon,
  step: string,
  context: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (process.env.DJLS_DISABLE_RECEIVER_STEP_TRACE === '1') {
    return fn();
  }
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const elapsed = performance.now() - start;
    if (elapsed > 500) {
      const ctxTruncated = context.length > 80 ? context.slice(0, 77) + '...' : context;
      daemon.logDiagnostic(
        `[receiver-step:slow] step=${step} elapsed=${elapsed.toFixed(0)}ms ctx=${JSON.stringify(ctxTruncated)}`
      );
    }
  }
}

async function resolveLookupReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
    return undefined;
  }
  // Captain regression 2026-05-12 17:44: function-call argument lists like
  // `directors_meeting, user=self.user, context=self.context` were
  // reaching the resolver and spending 9.9s in resolveOrmReceiverAtOffset
  // before timing out — 10k+ slow-step traces consumed per session.
  // A valid receiver is a single Python expression; top-level commas or
  // kwarg `=` prove the scanner sliced garbage. Reject before the chain
  // wastes any wall time.
  if (isMalformedReceiverExpression(normalizedExpression)) {
    return undefined;
  }

  const visitKey = `${document.uri.toString()}:lookup:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 100) {
    return undefined;
  }
  visited.add(visitKey);

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (memberAccess) {
    const lookupObjectReceiver = await timeReceiverStep(
      daemon, 'memberAccess.recursive-lookup', normalizedExpression,
      () => resolveLookupReceiverAtOffset(
        daemon,
        document,
        memberAccess.objectExpression,
        beforeOffset,
        visited,
      ),
    );
    const ormObjectReceiver = await timeReceiverStep(
      daemon, 'memberAccess.orm-receiver', normalizedExpression,
      // Share `visited` (was `new Set()`) so the size cap bounds the WHOLE
      // member-access tree. Each chain level resolves its object expression up
      // to 3 ways; with fresh sets those re-explored the entire prefix from
      // scratch, making deep custom-method chains (e.g.
      // `M.objects.get_queryset().exclude_deleted().filter(...)`) blow up to
      // ~3^depth and hammer resolveRelationTarget tens of thousands of times
      // (10s receiver timeouts, 100% CPU). Sharing visited collapses it to
      // linear; the visitKey namespace prefixes keep the resolvers distinct.
      () => resolveOrmReceiverAtOffset(
        daemon,
        document,
        memberAccess.objectExpression,
        beforeOffset,
        visited,
      ),
    );
    const objectReceiver = preferLookupChainReceiver(
      lookupObjectReceiver,
      ormObjectReceiver
    );
    const annotatedMemberReceiver = asLookupReceiver(
      await timeReceiverStep(
        daemon, 'memberAccess.annotated', normalizedExpression,
        () => resolveAnnotatedReceiverForMemberAccess(
          daemon,
          document,
          memberAccess.objectExpression,
          memberAccess.memberName,
          beforeOffset,
          visited,
        ),
      )
    );
    if (objectReceiver) {
      const localRes4 = daemon.resolveOrmMemberLocal(
        objectReceiver.modelLabel, objectReceiver.kind, memberAccess.memberName
      );
      if (localRes4) {
        const lr = asLookupReceiver(receiverFromOrmMemberResolution(localRes4));
        if (lr) {
          return preferAnnotatedMemberReceiver(
            daemon,
            lr,
            annotatedMemberReceiver,
            objectReceiver
          );
        }
      }
      const resolution = await timeReceiverStep(
        daemon, 'memberAccess.resolveOrmMember', normalizedExpression,
        () => daemon.resolveOrmMember(
          objectReceiver.modelLabel,
          objectReceiver.kind,
          memberAccess.memberName,
          objectReceiver.managerName,
        ),
      );
      const resolvedReceiver = asLookupReceiver(
        receiverFromOrmMemberResolution(resolution)
      );
      if (resolvedReceiver) {
        return preferAnnotatedMemberReceiver(
          daemon,
          resolvedReceiver,
          annotatedMemberReceiver,
          objectReceiver
        );
      }
      // Synthesize `<model_class>.objects` as a manager receiver when both
      // local surface and BG IPC failed to resolve it. Django's metaclass
      // implicitly attaches `objects = Manager()` to every Model subclass,
      // so a model that exists in the graph is guaranteed to support
      // `.objects`. The outer `resolveBaseModelLabelForReceiverAtOffset`
      // fallback also catches this case but returns `kind: 'model_class'`;
      // this shortcut produces the more accurate `kind: 'manager'` shape
      // so downstream consumers that branch on receiver kind (e.g. method
      // completion) get the right behavior.
      if (
        objectReceiver.kind === 'model_class' &&
        memberAccess.memberName === 'objects'
      ) {
        return preferAnnotatedMemberReceiver(
          daemon,
          {
            kind: 'manager',
            modelLabel: objectReceiver.modelLabel,
            managerName: 'objects',
          },
          annotatedMemberReceiver,
          objectReceiver
        );
      }
    }
    if (annotatedMemberReceiver) {
      return annotatedMemberReceiver;
    }
    // Cold-daemon defensive fallback for `<KnownModel>.objects`. When the
    // recursive `resolveLookupReceiverAtOffset(objectExpression)` returned
    // undefined because the BG IPC was aborted/busy (captain trace: surface
    // index still being prebuilt during the first diagnostic cycle), the
    // parent call had no way to synthesize the manager receiver. But the
    // local `modelLabelByName` index is populated synchronously from the
    // surface delta, so a sync check here catches the case as soon as the
    // model name is known — no IPC required.
    if (
      !objectReceiver &&
      memberAccess.memberName === 'objects' &&
      /^[A-Za-z_][\w]*$/.test(memberAccess.objectExpression)
    ) {
      const directLabel = daemon.findModelLabelByShortName(memberAccess.objectExpression);
      if (directLabel) {
        return {
          kind: 'manager',
          modelLabel: directLabel,
          managerName: 'objects',
        };
      }
      // Final phantom fallback: the daemon has no record of this
      // identifier, BUT the `<PascalCase>.objects` shape strongly suggests
      // a Django model whose indexing got dropped/missed (captain trace
      // showed `CompanyQuestionThread.objects` permanently in unknown_root
      // every cycle even though it's a real workspace model). Synthesize a
      // phantom manager with the bare identifier as the label — downstream
      // daemon queries against that label may still come back unresolved,
      // but at least the lookup no longer falls into the generic
      // `unknown_root` noRecv bucket. PascalCase guard avoids hijacking
      // legitimate lowercase identifiers (instances/parameters) that have
      // their own resolution paths.
      if (/^[A-Z][A-Za-z0-9_]*$/.test(memberAccess.objectExpression)) {
        return {
          kind: 'manager',
          modelLabel: memberAccess.objectExpression,
          managerName: 'objects',
          synthetic: 'phantom-objects',
        };
      }
    }
  }

  if (/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?$/.test(normalizedExpression)) {
    // A bare local variable that has an assignment in scope must be resolved via
    // its assignment chain (below) — that path carries annotated virtual fields
    // and queryset transforms. resolveModelLabelFromSymbol would short-circuit to
    // a bare `model_class` (vfields=0) if the daemon happens to match the variable
    // NAME to a model/relation (observed: `hrm_emp_qs` resolving to db.HrmEmp via
    // a 213ms resolveRelationTarget, dropping every annotated field). Skip the
    // symbol shortcut when a local binding exists; the model_class fallback still
    // applies at the outer resolveBaseModelLabelForReceiverAtOffset if the chain
    // walk yields nothing.
    const hasLocalBinding =
      !normalizedExpression.includes('.') &&
      findNearestAssignedExpression(document, normalizedExpression, beforeOffset) !==
        undefined;
    if (!hasLocalBinding) {
      const modelLabel = await timeReceiverStep(
        daemon, 'modelLabelFromSymbol', normalizedExpression,
        () => resolveModelLabelFromSymbol(
          daemon,
          document,
          normalizedExpression,
          beforeOffset,
        ),
      );
      if (modelLabel) {
        return {
          kind: 'model_class',
          modelLabel,
        };
      }
    }
  }

  const callResolvedReceiver = await timeReceiverStep(
    daemon, 'callExpression', normalizedExpression,
    () => resolveLookupReceiverFromCallExpression(
      daemon,
      document,
      normalizedExpression,
      beforeOffset,
      visited,
    ),
  );
  if (callResolvedReceiver) {
    return callResolvedReceiver;
  }

  const rootIdentifier = receiverRootIdentifier(normalizedExpression);
  if (!rootIdentifier) {
    return undefined;
  }

  const loopTargetReceiver = asLookupReceiver(
    await timeReceiverStep(
      daemon, 'loopTarget', normalizedExpression,
      () => resolveOrmReceiverFromLoopTarget(
        daemon,
        document,
        rootIdentifier,
        beforeOffset,
        visited,
      ),
    )
  );
  if (loopTargetReceiver) {
    return loopTargetReceiver;
  }

  const annotatedReceiver = asLookupReceiver(
    await timeReceiverStep(
      daemon, 'annotatedIdentifier', normalizedExpression,
      () => resolveAnnotatedReceiverForIdentifier(
        daemon,
        document,
        rootIdentifier,
        beforeOffset,
      ),
    )
  );
  if (annotatedReceiver) {
    return annotatedReceiver;
  }

  const assignment = findNearestAssignedExpression(
    document,
    rootIdentifier,
    beforeOffset
  );
  if (!assignment) {
    // Bare-identifier receivers (e.g. `vendors.filter(...)` where `vendors`
    // is an unannotated parameter) reach this point with no assignment in
    // scope. Mirror the snake→PascalCase fallback used elsewhere so the
    // identifier resolves to an instance of the matching model rather than
    // landing in noRecv.
    for (const pascalName of snakeToPascalCaseVariants(rootIdentifier)) {
      const fallbackLabel = daemon.modelLabelByName.get(pascalName);
      if (fallbackLabel) {
        return { kind: 'instance', modelLabel: fallbackLabel };
      }
    }
    return undefined;
  }

  const assignedLookupReceiver = await resolveLookupReceiverAtOffset(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    visited
  );
  const assignedOrmReceiver = await resolveOrmReceiverAtOffset(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    new Set(visited)
  );
  const assignedReceiver = preferLookupChainReceiver(
    assignedLookupReceiver,
    assignedOrmReceiver
  );
  if (assignedReceiver) {
    return assignedReceiver;
  }
  for (const pascalName of snakeToPascalCaseVariants(rootIdentifier)) {
    const fallbackLabel = daemon.modelLabelByName.get(pascalName);
    if (fallbackLabel) {
      return { kind: 'instance', modelLabel: fallbackLabel };
    }
  }
  return undefined;
}

async function resolveLookupReceiverFromCallExpression(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const parsedCall = parseCalledExpression(expression);
  if (!parsedCall) {
    return undefined;
  }

  if (parsedCall.kind === 'function') {
    const functionSource = await resolveFunctionDefinitionSource(
      daemon,
      document,
      parsedCall.functionName,
      beforeOffset
    );
    if (!functionSource) {
      return undefined;
    }

    return asLookupReceiver(
      await resolveOrmReceiverFromFunctionSource(
        daemon,
        functionSource,
        visited
      )
    );
  }

  if (parsedCall.objectExpression === 'self' || parsedCall.objectExpression === 'cls') {
    const classDef = findEnclosingClassDefinition(document, beforeOffset);
    if (!classDef) {
      return undefined;
    }

    return asLookupReceiver(
      await resolveOrmReceiverFromClassMethodSource(
        daemon,
        {
          document,
          classDef,
          beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
        },
        parsedCall.memberName,
        visited
      )
    );
  }

  if (parsedCall.objectExpression === 'super()') {
    const classDef = findEnclosingClassDefinition(document, beforeOffset);
    if (!classDef) {
      return undefined;
    }

    return asLookupReceiver(
      await resolveOrmReceiverFromBaseClasses(
        daemon,
        {
          document,
          classDef,
          beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
        },
        parsedCall.memberName,
        visited,
        new Set()
      )
    );
  }

  const objectReceiver = await resolveLookupReceiverAtOffset(
    daemon,
    document,
    parsedCall.objectExpression,
    beforeOffset,
    visited
  );
  if (objectReceiver) {
    // Fast path for custom annotation methods (`annotate_*` / `with_*`): these
    // are essentially always project-defined chainable QuerySet methods the
    // daemon does not index, so `resolveOrmMember` would spend 40–226ms per call
    // only to return unresolved — and a deep self-reassignment chain
    // (`x = x.annotate_a().annotate_b()...`, 10+ links) repeats this for every
    // link on every lookup, blowing past the receiver-resolution timeout (4s+
    // observed). Such a method is a queryset operation regardless of how the
    // object receiver was (mis)classified — a function annotated `-> <Model>QuerySet`
    // can land as `instance`/`model_class`/`queryset` depending on the path — so
    // we only require a known model and resolve the result as a same-model
    // queryset, carrying inherited + body-extracted (memoized) virtual fields.
    // The underscore is required so the builtin exact `annotate(...)` (handled by
    // the direct-call annotate parser) is NOT intercepted here.
    if (
      /^(annotate_|with_)/.test(parsedCall.memberName) &&
      objectReceiver.modelLabel
    ) {
      const inherited = objectReceiver.virtualFields ?? [];
      const added = await resolveVirtualFieldsFromCustomMethod(
        daemon,
        objectReceiver,
        parsedCall.memberName
      );
      const virtualFields = dedupeVirtualFields([...inherited, ...added]);
      return {
        kind: 'queryset',
        modelLabel: objectReceiver.modelLabel,
        virtualFields: virtualFields.length > 0 ? virtualFields : undefined,
      };
    }

    const resolution =
      daemon.resolveOrmMemberLocal(
        objectReceiver.modelLabel,
        objectReceiver.kind,
        parsedCall.memberName
      ) ??
      (await daemon.resolveOrmMember(
        objectReceiver.modelLabel,
        objectReceiver.kind,
        parsedCall.memberName,
        objectReceiver.managerName
      ));
    const resolvedReceiver = asLookupReceiver(
      receiverFromOrmMemberResolution(
        resolution,
        objectReceiver,
        parsedCall.memberName,
        expression
      )
    );
    if (resolvedReceiver) {
      const sourceResolvedReceiver = asLookupReceiver(
        await resolveReceiverFromOrmMemberSource(
          daemon,
          resolution.item,
          visited
        )
      );
      return mergeReceiverVirtualFields(resolvedReceiver, sourceResolvedReceiver);
    }

    // Root-cause fix (custom QuerySet methods): when the object resolves to a
    // known queryset/manager/related_manager of a model, but the method is an
    // UNRECOGNIZED chainable one (a project custom QuerySet method like
    // `exclude_deleted_payroll_statements()` / `annotate_status_at()`, which
    // returns `Self`), treat the result as a same-model queryset instead of
    // giving up. Without this, such chains resolve to nothing (root_matched but
    // unresolved) and the deep fallbacks below burn seconds before timing out.
    // Standard type-changing methods (values/first/count/raw/contains/...) are
    // excluded so their distinct return shapes are not misrepresented.
    if (
      (objectReceiver.kind === 'queryset' ||
        objectReceiver.kind === 'manager' ||
        objectReceiver.kind === 'related_manager' ||
        // A function annotated `-> <Model>QuerySet` can resolve to a
        // `model_class` receiver (the QuerySet name maps to its model by
        // convention). A chainable custom method on it — `.annotate_*()` / any
        // lowercase non-type-changing method — is still a queryset operation, so
        // treat the result as a same-model queryset. Real classmethods were
        // already resolved above via resolveOrmMember; only UNRECOGNIZED methods
        // reach here, so this only ever recovers an under-classified collection
        // receiver (e.g. `get_emps(hrm) -> HrmEmpQuerySet`).
        objectReceiver.kind === 'model_class') &&
      /^[a-z_][a-z0-9_]*$/.test(parsedCall.memberName) &&
      !TYPE_CHANGING_QUERYSET_METHODS.has(parsedCall.memberName)
    ) {
      // Custom chainable methods preserve any virtual (annotated) fields from
      // the upstream receiver, and a custom `annotate_*`/`with_*` method may add
      // its own (extracted from its body). Carry both so `filter(_x__...)` on an
      // annotated field still resolves.
      const inherited = objectReceiver.virtualFields ?? [];
      const added = await resolveVirtualFieldsFromCustomMethod(
        daemon,
        objectReceiver,
        parsedCall.memberName
      );
      const virtualFields = dedupeVirtualFields([...inherited, ...added]);
      return {
        kind: 'queryset',
        modelLabel: objectReceiver.modelLabel,
        virtualFields: virtualFields.length > 0 ? virtualFields : undefined,
      };
    }
  }

  const classSource = await resolveClassDefinitionForExpression(
    daemon,
    document,
    parsedCall.objectExpression,
    beforeOffset,
    visited
  );
  if (!classSource) {
    return undefined;
  }

  return asLookupReceiver(
    await resolveOrmReceiverFromClassMethodSource(
      daemon,
      classSource,
      parsedCall.memberName,
      visited
    )
  );
}

async function resolveModelLabelFromCallExpression(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const chainedReceiver = await resolveOrmReceiverFromCallChain(
    daemon,
    document,
    expression,
    beforeOffset,
    visited
  );
  if (chainedReceiver) {
    return chainedReceiver.modelLabel;
  }

  const parsedCall = parseCalledExpression(expression);
  if (!parsedCall) {
    return undefined;
  }

  if (parsedCall.kind === 'function') {
    const functionSource = await resolveFunctionDefinitionSource(
      daemon,
      document,
      parsedCall.functionName,
      beforeOffset
    );
    if (!functionSource) {
      return undefined;
    }
    return resolveModelLabelFromFunctionSource(
      daemon,
      functionSource,
      visited
    );
  }

  if (parsedCall.objectExpression === 'self' || parsedCall.objectExpression === 'cls') {
    const classDef = findEnclosingClassDefinition(document, beforeOffset);
    if (!classDef) {
      return undefined;
    }

    return resolveModelLabelFromClassMethodSource(
      daemon,
      {
        document,
        classDef,
        beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
      },
      parsedCall.memberName,
      visited
    );
  }

  if (parsedCall.objectExpression === 'super()') {
    const classDef = findEnclosingClassDefinition(document, beforeOffset);
    if (!classDef) {
      return undefined;
    }

    return resolveModelLabelFromBaseClasses(
      daemon,
      {
        document,
        classDef,
        beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
      },
      parsedCall.memberName,
      visited,
      new Set()
    );
  }

  const objectReceiver = await resolveOrmReceiverAtOffset(
    daemon,
    document,
    parsedCall.objectExpression,
    beforeOffset,
    new Set(visited)
  );
  if (objectReceiver) {
    const localResolution = daemon.resolveOrmMemberLocal(
      objectReceiver.modelLabel,
      objectReceiver.kind,
      parsedCall.memberName
    );
    if (localResolution) {
      const localReceiver = receiverFromOrmMemberResolution(
        localResolution,
        objectReceiver,
        parsedCall.memberName,
        expression
      );
      if (localReceiver) {
        return localReceiver.modelLabel;
      }
    }

    const resolution = await daemon.resolveOrmMember(
      objectReceiver.modelLabel,
      objectReceiver.kind,
      parsedCall.memberName,
      objectReceiver.managerName
    );
    const resolvedReceiver = receiverFromOrmMemberResolution(
      resolution,
      objectReceiver,
      parsedCall.memberName,
      expression
    );
    if (resolvedReceiver) {
      return resolvedReceiver.modelLabel;
    }
  }

  const objectResolvedLabel = await resolveBaseModelLabelForReceiverAtOffset(
    daemon,
    document,
    parsedCall.objectExpression,
    beforeOffset,
    visited
  );
  if (objectResolvedLabel) {
    return objectResolvedLabel;
  }

  const classSource = await resolveClassDefinitionForExpression(
    daemon,
    document,
    parsedCall.objectExpression,
    beforeOffset,
    visited
  );
  if (!classSource) {
    return undefined;
  }

  return resolveModelLabelFromClassMethodSource(
    daemon,
    classSource,
    parsedCall.memberName,
    visited
  );
}

async function resolveModelLabelFromSymbol(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  symbol: string,
  beforeOffset: number
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  // Test-only hatch: simulate the captain race where the recursive object
  // receiver resolution returns undefined even though the model is locally
  // known. Production trigger is daemon-aborted state mid-cycle; tests can
  // force the same observable failure deterministically.
  if (process.env.DJLS_TEST_FORCE_RESOLVE_MODEL_LABEL_NULL === '1') {
    return undefined;
  }
  const simpleName = symbol.includes('.') ? symbol.split('.').at(-1)! : symbol;
  const localLabel = daemon.findModelLabelByShortName(simpleName);
  if (localLabel) {
    return localLabel;
  }

  const resolution = await daemon.resolveRelationTarget(symbol);
  if (resolution.resolved && resolution.target) {
    return resolution.target.label;
  }

  const importResolvedLabel = await resolveModelLabelFromImports(
    daemon,
    document,
    symbol,
    beforeOffset
  );
  if (importResolvedLabel) {
    return importResolvedLabel;
  }

  if (symbol.includes('.')) {
    const tailSymbol = symbol.split('.').at(-1);
    if (tailSymbol && tailSymbol !== symbol) {
      const tailResolution = await daemon.resolveRelationTarget(tailSymbol);
      if (tailResolution.resolved && tailResolution.target) {
        return tailResolution.target.label;
      }
    }
  }

  return undefined;
}

async function resolveModelLabelFromImports(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  symbol: string,
  beforeOffset: number
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const bindings = collectImportBindings(document, beforeOffset);
  const directBinding = bindings.symbols.get(symbol);
  if (directBinding) {
    return resolveModelLabelFromImportedSymbol(
      daemon,
      directBinding.moduleName,
      directBinding.symbolName
    );
  }

  const parts = symbol.split('.');
  if (parts.length < 2) {
    return undefined;
  }

  const moduleName = await resolveImportedModuleAlias(
    daemon,
    bindings,
    parts[0]
  );
  if (!moduleName) {
    return undefined;
  }

  return resolveModelLabelFromImportedSymbol(daemon, moduleName, parts[1]);
}

async function resolveModelLabelFromImportedSymbol(
  daemon: AnalysisDaemon,
  moduleName: string,
  symbolName: string
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const exportResolution = await daemon.resolveExportOrigin(moduleName, symbolName);
  const originModule = exportResolution.originModule ?? moduleName;
  const originSymbol = exportResolution.originSymbol ?? symbolName;
  const targets = await listAllRelationTargets(daemon);
  const exactModuleTarget = targets.items.find(
    (item) =>
      item.objectName === originSymbol &&
      item.module === originModule
  );
  if (exactModuleTarget) {
    return exactModuleTarget.label;
  }

  const sameNameTargets = targets.items.filter(
    (item) => item.objectName === originSymbol
  );
  if (sameNameTargets.length === 1) {
    return sameNameTargets[0].label;
  }

  return undefined;
}

async function resolveModelLabelFromFunctionSource(
  daemon: AnalysisDaemon,
  functionSource: FunctionDefinitionSource,
  visited: Set<string>
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  return memoizeFunctionBodyResolution(
    daemon,
    functionModelLabelCache,
    functionSource,
    visited,
    (bodyVisited) =>
      resolveModelLabelFromFunctionSourceUncached(daemon, functionSource, bodyVisited)
  );
}

async function resolveModelLabelFromFunctionSourceUncached(
  daemon: AnalysisDaemon,
  functionSource: FunctionDefinitionSource,
  visited: Set<string>
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }

  // Prefer the explicit return annotation FIRST — for ORM helpers like
  // `def get_emps(...) -> HrmEmpQuerySet` it is both reliable and cheap. The
  // whole-body return-expression analysis below previously ran first and cost
  // ~1.2s per call (recursively resolving every return), then still failed for
  // custom-QuerySet returns — the dominant remaining hover timeout. Body
  // inference stays as the fallback for un-annotated / `-> QuerySet` cases.
  const annotationLabel = await resolveModelLabelFromFunctionReturnAnnotation(
    daemon,
    functionSource
  );
  if (annotationLabel) {
    return annotationLabel;
  }
  if (daemon.isAborted()) { return undefined; }

  const returnExpressions = collectReturnExpressions(
    functionSource.document,
    functionSource.functionDef
  );
  const resolvedLabels = new Set<string>();
  for (const returnExpression of returnExpressions) {
    const resolvedLabel = await resolveBaseModelLabelForReceiverAtOffset(
      daemon,
      functionSource.document,
      returnExpression.expression,
      returnExpression.offset,
      visited
    );
    if (resolvedLabel) {
      resolvedLabels.add(resolvedLabel);
    }
  }

  if (resolvedLabels.size === 1) {
    return [...resolvedLabels.values()][0];
  }

  return undefined;
}

async function resolveModelLabelFromClassMethodSource(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string,
  visited: Set<string>
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const methodSource = await resolveMethodDefinitionInClassHierarchy(
    daemon,
    classSource,
    methodName,
    new Set()
  );
  if (!methodSource) {
    return undefined;
  }

  return resolveModelLabelFromFunctionSource(daemon, methodSource, visited);
}

async function resolveMethodDefinitionInClassHierarchy(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string,
  visitedClasses: Set<string>
): Promise<FunctionDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const visitKey = `${classSource.document.uri.toString()}:${classSource.classDef.name}`;
  if (visitedClasses.has(visitKey)) {
    return undefined;
  }
  visitedClasses.add(visitKey);

  const methodDef = findMethodDefinition(
    classSource.document,
    classSource.classDef,
    methodName
  );
  if (methodDef) {
    return {
      document: classSource.document,
      functionDef: methodDef,
      beforeOffset: classSource.document.offsetAt(
        new vscode.Position(methodDef.line, 0)
      ),
    };
  }

  return resolveMethodDefinitionFromBaseClasses(
    daemon,
    classSource,
    methodName,
    visitedClasses
  );
}

async function resolveMethodDefinitionFromBaseClasses(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string,
  visitedClasses: Set<string>
): Promise<FunctionDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  for (const baseExpression of classSource.classDef.baseExpressions) {
    const baseClassSource = await resolveClassDefinitionSource(
      daemon,
      classSource.document,
      baseExpression,
      classSource.beforeOffset
    );
    if (!baseClassSource) {
      continue;
    }

    const methodSource = await resolveMethodDefinitionInClassHierarchy(
      daemon,
      baseClassSource,
      methodName,
      visitedClasses
    );
    if (!methodSource) {
      continue;
    }
    return methodSource;
  }

  return undefined;
}

async function resolveModelLabelFromBaseClasses(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string,
  visited: Set<string>,
  visitedClasses: Set<string>
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const methodSource = await resolveMethodDefinitionFromBaseClasses(
    daemon,
    classSource,
    methodName,
    visitedClasses
  );
  if (!methodSource) {
    return undefined;
  }

  return resolveModelLabelFromFunctionSource(daemon, methodSource, visited);
}

async function resolveClassDefinitionForExpression(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<ClassDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedExpression = stripWrappingParentheses(expression.trim());
  if (!normalizedExpression) {
    return undefined;
  }

  if (normalizedExpression === 'self' || normalizedExpression === 'cls') {
    const classDef = findEnclosingClassDefinition(document, beforeOffset);
    if (!classDef) {
      return undefined;
    }
    return {
      document,
      classDef,
      beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
    };
  }

  if (/^[A-Za-z_][\w]*$/.test(normalizedExpression)) {
    const directClassSource = await resolveClassDefinitionSource(
      daemon,
      document,
      normalizedExpression,
      beforeOffset
    );
    if (directClassSource) {
      return directClassSource;
    }

    const typeAnnotation = findTypeAnnotationForIdentifier(
      document,
      normalizedExpression,
      beforeOffset
    );
    if (typeAnnotation) {
      const annotatedClassSource = await resolveClassDefinitionFromTypeAnnotation(
        daemon,
        document,
        typeAnnotation.annotation,
        typeAnnotation.offset
      );
      if (annotatedClassSource) {
        return annotatedClassSource;
      }
    }
  }

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (memberAccess) {
    const typeAnnotation = await resolveTypeAnnotationForMemberAccess(
      daemon,
      document,
      memberAccess.objectExpression,
      memberAccess.memberName,
      beforeOffset,
      visited
    );
    if (typeAnnotation) {
      const resolvedClassSource = await resolveClassDefinitionFromTypeAnnotation(
        daemon,
        typeAnnotation.document,
        typeAnnotation.annotation,
        typeAnnotation.offset
      );
      if (resolvedClassSource) {
        return resolvedClassSource;
      }
    }
  }

  const parsedCall = parseCalledExpression(normalizedExpression);
  if (parsedCall) {
    if (
      parsedCall.kind === 'function' &&
      /^[A-Za-z_][\w]*$/.test(parsedCall.functionName)
    ) {
      const directClassSource = await resolveClassDefinitionSource(
        daemon,
        document,
        parsedCall.functionName,
        beforeOffset
      );
      if (directClassSource) {
        return directClassSource;
      }

      const functionSource = await resolveFunctionDefinitionSource(
        daemon,
        document,
        parsedCall.functionName,
        beforeOffset
      );
      if (!functionSource) {
        return undefined;
      }

      return resolveClassDefinitionFromFunctionReturnAnnotation(
        daemon,
        functionSource
      );
    }

    if (parsedCall.kind !== 'member') {
      return undefined;
    }

    if (
      parsedCall.objectExpression === 'self' ||
      parsedCall.objectExpression === 'cls'
    ) {
      const classDef = findEnclosingClassDefinition(document, beforeOffset);
      if (!classDef) {
        return undefined;
      }

      return resolveClassDefinitionFromClassMethodSource(
        daemon,
        {
          document,
          classDef,
          beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
        },
        parsedCall.memberName
      );
    }

    if (parsedCall.objectExpression === 'super()') {
      const classDef = findEnclosingClassDefinition(document, beforeOffset);
      if (!classDef) {
        return undefined;
      }

      return resolveClassDefinitionFromBaseClasses(
        daemon,
        {
          document,
          classDef,
          beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
        },
        parsedCall.memberName,
        new Set()
      );
    }

    const objectClassSource = await resolveClassDefinitionForExpression(
      daemon,
      document,
      parsedCall.objectExpression,
      beforeOffset,
      visited
    );
    if (!objectClassSource) {
      return undefined;
    }

    return resolveClassDefinitionFromClassMethodSource(
      daemon,
      objectClassSource,
      parsedCall.memberName
    );
  }

  const rootIdentifier = receiverRootIdentifier(normalizedExpression);
  if (!rootIdentifier) {
    return undefined;
  }

  const assignment = findNearestAssignedExpression(
    document,
    rootIdentifier,
    beforeOffset
  );
  if (!assignment) {
    return undefined;
  }

  const visitKey = `${document.uri.toString()}:class:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey)) {
    return undefined;
  }
  visited.add(visitKey);

  return resolveClassDefinitionForExpression(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    visited
  );
}

async function resolveClassDefinitionSource(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  symbol: string,
  beforeOffset: number
): Promise<ClassDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const sameDocumentClass = findClassDefinition(document, symbol);
  if (sameDocumentClass) {
    return {
      document,
      classDef: sameDocumentClass,
      beforeOffset: document.offsetAt(
        new vscode.Position(sameDocumentClass.line, 0)
      ),
    };
  }

  const importedDefinition = await resolveImportedDefinitionDocument(
    daemon,
    document,
    symbol,
    beforeOffset
  );
  if (!importedDefinition) {
    return undefined;
  }

  const importedClass = findClassDefinition(
    importedDefinition.document,
    importedDefinition.symbolName
  );
  if (!importedClass) {
    return undefined;
  }

  return {
    document: importedDefinition.document,
    classDef: importedClass,
    beforeOffset: importedDefinition.document.offsetAt(
      new vscode.Position(importedClass.line, 0)
    ),
  };
}

async function resolveSpecialClassKind(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  visited: Set<string>
): Promise<SpecialClassKind | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const visitKey = `${classSource.document.uri.toString()}:${classSource.classDef.name}`;
  if (visited.has(visitKey)) {
    return undefined;
  }
  visited.add(visitKey);

  for (const baseExpression of classSource.classDef.baseExpressions) {
    const baseReference = baseClassReferenceExpression(baseExpression);
    if (!baseReference) {
      continue;
    }

    const canonicalBase = await canonicalTypeAnnotationName(
      daemon,
      classSource.document,
      baseReference,
      classSource.beforeOffset
    );
    const directKind = specialClassKindFromCanonicalName(canonicalBase);
    if (directKind) {
      return directKind;
    }

    const baseClassSource = await resolveClassDefinitionSource(
      daemon,
      classSource.document,
      baseReference,
      classSource.beforeOffset
    );
    if (!baseClassSource) {
      continue;
    }

    const inheritedKind = await resolveSpecialClassKind(
      daemon,
      baseClassSource,
      visited
    );
    if (inheritedKind) {
      return inheritedKind;
    }
  }

  return undefined;
}

async function resolveClassDefinitionFromClassMethodSource(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string
): Promise<ClassDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const methodSource = await resolveMethodDefinitionInClassHierarchy(
    daemon,
    classSource,
    methodName,
    new Set()
  );
  if (!methodSource) {
    return undefined;
  }

  return resolveClassDefinitionFromFunctionReturnAnnotation(daemon, methodSource);
}

async function resolveClassDefinitionFromModelLabel(
  daemon: AnalysisDaemon,
  modelLabel: string
): Promise<ClassDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const targets = await listAllRelationTargets(daemon);
  const target = targets.items.find((item) => item.label === modelLabel);
  if (!target?.filePath || !target.objectName) {
    return undefined;
  }

  const targetDocument = await vscode.workspace.openTextDocument(target.filePath);
  const classDef = findClassDefinition(targetDocument, target.objectName);
  if (!classDef) {
    return undefined;
  }

  return {
    document: targetDocument,
    classDef,
    beforeOffset: targetDocument.offsetAt(new vscode.Position(classDef.line, 0)),
  };
}

async function isModelLabelSubclassOf(
  daemon: AnalysisDaemon,
  candidateLabel: string,
  baseLabel: string,
  visited: Set<string>
): Promise<boolean> {
  if (candidateLabel === baseLabel) {
    return true;
  }

  const cacheKey = `${candidateLabel}=>${baseLabel}`;
  const cached = modelSubclassRelationCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const classSource = await resolveClassDefinitionFromModelLabel(
    daemon,
    candidateLabel
  );
  if (!classSource) {
    modelSubclassRelationCache.set(cacheKey, false);
    return false;
  }

  const result = await isClassSourceSubclassOfModelLabel(
    daemon,
    classSource,
    baseLabel,
    visited
  );
  modelSubclassRelationCache.set(cacheKey, result);
  return result;
}

async function isClassSourceSubclassOfModelLabel(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  baseLabel: string,
  visited: Set<string>
): Promise<boolean> {
  const visitKey = `${classSource.document.uri.toString()}:${classSource.classDef.name}=>${baseLabel}`;
  if (visited.has(visitKey)) {
    return false;
  }
  visited.add(visitKey);

  for (const baseExpression of classSource.classDef.baseExpressions) {
    const directBaseLabel = await resolveModelLabelFromTypeAnnotation(
      daemon,
      classSource.document,
      baseExpression,
      classSource.beforeOffset
    );
    if (directBaseLabel === baseLabel) {
      return true;
    }

    if (
      directBaseLabel &&
      await isModelLabelSubclassOf(daemon, directBaseLabel, baseLabel, visited)
    ) {
      return true;
    }

    const baseReference = baseClassReferenceExpression(baseExpression);
    if (!baseReference) {
      continue;
    }

    const baseClassSource = await resolveClassDefinitionSource(
      daemon,
      classSource.document,
      baseReference,
      classSource.beforeOffset
    );
    if (!baseClassSource) {
      continue;
    }

    if (
      await isClassSourceSubclassOfModelLabel(
        daemon,
        baseClassSource,
        baseLabel,
        visited
      )
    ) {
      return true;
    }
  }

  return false;
}

async function resolveClassDefinitionFromBaseClasses(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string,
  visitedClasses: Set<string>
): Promise<ClassDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const methodSource = await resolveMethodDefinitionFromBaseClasses(
    daemon,
    classSource,
    methodName,
    visitedClasses
  );
  if (!methodSource) {
    return undefined;
  }

  return resolveClassDefinitionFromFunctionReturnAnnotation(daemon, methodSource);
}

async function listClassInstanceMemberItems(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource
): Promise<ClassMemberItem[]> {
  const items = new Map<string, ClassMemberItem>();
  await collectClassInstanceMemberItems(
    daemon,
    classSource,
    items,
    new Set()
  );
  return [...items.values()];
}

async function listStaticQuerySetOrmMemberItems(
  daemon: AnalysisDaemon,
  receiver: OrmReceiverInfo,
  prefix: string
): Promise<OrmMemberItem[]> {
  if (
    receiver.kind !== 'queryset' &&
    receiver.kind !== 'manager' &&
    receiver.kind !== 'related_manager'
  ) {
    return [];
  }

  const querySetClassSource = await resolveQuerySetClassSourceForModelLabel(
    daemon,
    receiver.modelLabel
  );
  if (!querySetClassSource) {
    return [];
  }

  const normalizedPrefix = prefix.trim();
  const classItems = await listClassInstanceMemberItems(
    daemon,
    querySetClassSource
  );
  const ormItems: OrmMemberItem[] = [];
  for (const item of classItems) {
    if (
      item.kind !== 'method' &&
      item.kind !== 'property'
    ) {
      continue;
    }
    if (normalizedPrefix && !item.name.startsWith(normalizedPrefix)) {
      continue;
    }

    const returnReceiver = item.typeAnnotation
      ? await resolveDirectReceiverFromTypeAnnotation(
          daemon,
          querySetClassSource.document,
          item.typeAnnotation,
          querySetClassSource.beforeOffset
        )
      : undefined;
    ormItems.push({
      name: item.name,
      memberKind: item.kind === 'property' ? 'property' : 'method',
      modelLabel: receiver.modelLabel,
      receiverKind: receiver.kind,
      detail: item.detail,
      source: 'local',
      returnKind: returnReceiver?.kind ?? 'unknown',
      returnModelLabel: returnReceiver?.modelLabel,
      filePath: item.filePath,
      line: item.line,
      column: item.column,
      isRelation: false,
    });
  }

  return ormItems;
}

async function resolveQuerySetClassSourceForModelLabel(
  daemon: AnalysisDaemon,
  modelLabel: string
): Promise<ClassDefinitionSource | undefined> {
  let cache = staticQuerySetClassSourceCache.get(daemon);
  if (!cache) {
    cache = new Map();
    staticQuerySetClassSourceCache.set(daemon, cache);
  }

  const cached = cache.get(modelLabel);
  if (cached) {
    return cached;
  }

  const request = resolveQuerySetClassSourceForModelLabelUncached(
    daemon,
    modelLabel
  );
  cache.set(modelLabel, request);
  return request;
}

async function resolveQuerySetClassSourceForModelLabelUncached(
  daemon: AnalysisDaemon,
  modelLabel: string
): Promise<ClassDefinitionSource | undefined> {
  const modelClassSource = await resolveClassDefinitionForModelLabel(
    daemon,
    modelLabel
  );
  if (!modelClassSource) {
    return undefined;
  }

  for (const managerExpression of managerAssignmentExpressions(modelClassSource)) {
    const details = parseCallExpressionDetails(managerExpression);
    const managerReference =
      details?.parsedCall.kind === 'function'
        ? details.parsedCall.functionName
        : details?.parsedCall.kind === 'member'
        ? `${details.parsedCall.objectExpression}.${details.parsedCall.memberName}`
        : managerExpression;
    const managerClassSource = await resolveClassDefinitionSource(
      daemon,
      modelClassSource.document,
      managerReference,
      modelClassSource.beforeOffset
    );
    if (!managerClassSource) {
      continue;
    }

    const querySetClassSource = await resolveQuerySetClassSourceFromManagerClass(
      daemon,
      managerClassSource,
      new Set()
    );
    if (querySetClassSource) {
      return querySetClassSource;
    }
  }

  return undefined;
}

async function resolveQuerySetClassSourceFromManagerClass(
  daemon: AnalysisDaemon,
  managerClassSource: ClassDefinitionSource,
  visitedClasses: Set<string>
): Promise<ClassDefinitionSource | undefined> {
  const visitKey = `${managerClassSource.document.uri.toString()}:${managerClassSource.classDef.name}`;
  if (visitedClasses.has(visitKey)) {
    return undefined;
  }
  visitedClasses.add(visitKey);

  for (const baseExpression of managerClassSource.classDef.baseExpressions) {
    const details = parseCallExpressionDetails(baseExpression);
    if (
      details?.parsedCall.kind === 'member' &&
      details.parsedCall.memberName === 'from_queryset'
    ) {
      const firstArgument = splitTopLevelExpressions(details.argsText)[0];
      if (firstArgument) {
        const querySetClassSource = await resolveClassDefinitionSource(
          daemon,
          managerClassSource.document,
          firstArgument,
          managerClassSource.beforeOffset
        );
        if (querySetClassSource) {
          return querySetClassSource;
        }
      }
    }

    const baseReference = baseClassReferenceExpression(baseExpression);
    if (!baseReference) {
      continue;
    }
    const baseManagerClassSource = await resolveClassDefinitionSource(
      daemon,
      managerClassSource.document,
      baseReference,
      managerClassSource.beforeOffset
    );
    if (!baseManagerClassSource) {
      continue;
    }
    const inheritedQuerySetClassSource =
      await resolveQuerySetClassSourceFromManagerClass(
        daemon,
        baseManagerClassSource,
        visitedClasses
      );
    if (inheritedQuerySetClassSource) {
      return inheritedQuerySetClassSource;
    }
  }

  return undefined;
}

function managerAssignmentExpressions(
  classSource: ClassDefinitionSource
): string[] {
  const expressions: string[] = [];
  const { document, classDef } = classSource;

  for (let line = classDef.line + 1; line <= classDef.endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    const trimmed = stripTrailingComment(lineText).trim();
    if (!trimmed) {
      continue;
    }

    const lineOffset = document.offsetAt(new vscode.Position(line, lineText.length));
    const enclosingClass = findEnclosingClassDefinition(document, lineOffset);
    if (
      !enclosingClass ||
      enclosingClass.line !== classDef.line ||
      enclosingClass.name !== classDef.name
    ) {
      continue;
    }
    if (findEnclosingFunctionDefinition(document, lineOffset)) {
      continue;
    }

    const assignment = trimmed.match(
      /^([A-Za-z_][\w]*)\s*(?::\s*[^=]+)?=\s*(.+)$/
    );
    if (!assignment) {
      continue;
    }
    const expression = assignment[2].trim();
    if (!parseCallExpressionDetails(expression)) {
      continue;
    }
    expressions.push(expression);
  }

  return expressions;
}

async function collectClassInstanceMemberItems(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  items: Map<string, ClassMemberItem>,
  visitedClasses: Set<string>
): Promise<void> {
  const visitKey = `${classSource.document.uri.toString()}:${classSource.classDef.name}`;
  if (visitedClasses.has(visitKey)) {
    return;
  }
  visitedClasses.add(visitKey);

  for (const item of directClassInstanceMemberItems(classSource)) {
    if (!items.has(item.name)) {
      items.set(item.name, item);
    }
  }

  for (const baseExpression of classSource.classDef.baseExpressions) {
    const baseReference = baseClassReferenceExpression(baseExpression);
    if (!baseReference) {
      continue;
    }

    const baseClassSource = await resolveClassDefinitionSource(
      daemon,
      classSource.document,
      baseReference,
      classSource.beforeOffset
    );
    if (!baseClassSource) {
      continue;
    }

    await collectClassInstanceMemberItems(
      daemon,
      baseClassSource,
      items,
      visitedClasses
    );
  }
}

function directClassInstanceMemberItems(
  classSource: ClassDefinitionSource
): ClassMemberItem[] {
  const items = new Map<string, ClassMemberItem>();
  const { document, classDef } = classSource;
  const qualifiedClassName = qualifiedClassSymbol(document, classDef.name);

  for (let line = classDef.line + 1; line <= classDef.endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    const trimmed = stripTrailingComment(lineText).trim();
    if (!trimmed) {
      continue;
    }

    const lineOffset = document.offsetAt(new vscode.Position(line, lineText.length));
    const enclosingClass = findEnclosingClassDefinition(document, lineOffset);
    if (
      !enclosingClass ||
      enclosingClass.line !== classDef.line ||
      enclosingClass.name !== classDef.name
    ) {
      continue;
    }

    const enclosingFunction = findEnclosingFunctionDefinition(document, lineOffset);
    const functionDef = parseFunctionDefinitionAtLine(document, line);
    if (functionDef && !enclosingFunction) {
      const decorators = collectFunctionDecorators(document, line);
      const kind = hasPropertyDecorator(decorators) ? 'property' : 'method';
      const typeAnnotation = classMemberDisplayTypeAnnotation(
        functionDef.returnAnnotation
      );
      items.set(functionDef.name, {
        name: functionDef.name,
        kind,
        detail: classMemberItemDetail(
          kind,
          qualifiedClassName,
          typeAnnotation
        ),
        ownerClassName: classDef.name,
        typeAnnotation,
        filePath: document.uri.fsPath,
        line: line + 1,
        column: memberColumn(lineText, functionDef.name),
      });
      continue;
    }

    if (!enclosingFunction) {
      const classAttributeMatch = trimmed.match(
        /^([A-Za-z_][\w]*)\s*(?::\s*([^=]+))?\s*=\s*.+$/
      );
      const annotatedAttributeMatch = trimmed.match(
        /^([A-Za-z_][\w]*)\s*:\s*(.+)$/
      );
      const attributeName =
        classAttributeMatch?.[1] ?? annotatedAttributeMatch?.[1];
      if (attributeName) {
        const typeAnnotation = classMemberDisplayTypeAnnotation(
          classAttributeMatch?.[2] ?? annotatedAttributeMatch?.[2]
        );
        items.set(attributeName, {
          name: attributeName,
          kind: 'attribute',
          detail: classMemberItemDetail(
            'attribute',
            qualifiedClassName,
            typeAnnotation
          ),
          ownerClassName: classDef.name,
          typeAnnotation,
          filePath: document.uri.fsPath,
          line: line + 1,
          column: memberColumn(lineText, attributeName),
        });
      }
      continue;
    }

    const selfAttributeMatch = trimmed.match(
      /^self\.([A-Za-z_][\w]*)\s*(?::\s*([^=]+))?\s*=\s*.+$/
    );
    const selfAnnotatedAttributeMatch = trimmed.match(
      /^self\.([A-Za-z_][\w]*)\s*:\s*(.+)$/
    );
    const selfAttributeName =
      selfAttributeMatch?.[1] ?? selfAnnotatedAttributeMatch?.[1];
    if (selfAttributeName) {
      const typeAnnotation = classMemberDisplayTypeAnnotation(
        selfAttributeMatch?.[2] ?? selfAnnotatedAttributeMatch?.[2]
      );
      const attributeName = selfAttributeName;
      if (!items.has(attributeName)) {
        items.set(attributeName, {
          name: attributeName,
          kind: 'attribute',
          detail: classMemberItemDetail(
            'instance attribute',
            qualifiedClassName,
            typeAnnotation
          ),
          ownerClassName: classDef.name,
          typeAnnotation,
          filePath: document.uri.fsPath,
          line: line + 1,
          column: memberColumn(lineText, attributeName),
        });
      }
    }
  }

  return [...items.values()];
}

function classMemberDisplayTypeAnnotation(
  annotation: string | undefined
): string | undefined {
  if (!annotation) {
    return undefined;
  }

  const normalizedAnnotation = normalizeTypeAnnotation(annotation);
  return normalizedAnnotation || undefined;
}

function classMemberItemDetail(
  kindLabel: string,
  ownerQualifiedClassName: string,
  typeAnnotation: string | undefined
): string {
  if (!typeAnnotation) {
    return `${kindLabel} · ${ownerQualifiedClassName}`;
  }

  if (kindLabel === 'method') {
    return `${kindLabel} -> ${typeAnnotation} · ${ownerQualifiedClassName}`;
  }

  return `${kindLabel} (${typeAnnotation}) · ${ownerQualifiedClassName}`;
}

function collectFunctionDecorators(
  document: vscode.TextDocument,
  functionLine: number
): string[] {
  const decorators: string[] = [];

  for (let line = functionLine - 1; line >= 0; line -= 1) {
    const text = stripTrailingComment(document.lineAt(line).text).trim();
    if (!text) {
      break;
    }

    if (!text.startsWith('@')) {
      break;
    }

    decorators.unshift(text);
  }

  return decorators;
}

function hasPropertyDecorator(decorators: string[]): boolean {
  return decorators.some((decorator) => {
    const normalizedDecorator = decorator.replace(/\s+/g, '');
    return (
      normalizedDecorator === '@property' ||
      normalizedDecorator === '@cached_property' ||
      normalizedDecorator.endsWith('.setter') ||
      normalizedDecorator.endsWith('.deleter')
    );
  });
}

function memberColumn(lineText: string, memberName: string): number {
  const index = lineText.indexOf(memberName);
  return index >= 0 ? index + 1 : 1;
}

async function resolveClassHoverCategory(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  visited: Set<string>
): Promise<ClassHoverCategory> {
  if (daemon.isAborted()) { return 'general'; }
  const visitKey = `${classSource.document.uri.toString()}:${classSource.classDef.name}`;
  if (visited.has(visitKey)) {
    return 'general';
  }
  visited.add(visitKey);

  for (const baseExpression of classSource.classDef.baseExpressions) {
    const baseReference = baseClassReferenceExpression(baseExpression);
    if (!baseReference) {
      continue;
    }

    const canonicalBase = await canonicalTypeAnnotationName(
      daemon,
      classSource.document,
      baseReference,
      classSource.beforeOffset
    );
    if (isDjangoCanonicalClassName(canonicalBase)) {
      return 'django';
    }

    const baseClassSource = await resolveClassDefinitionSource(
      daemon,
      classSource.document,
      baseReference,
      classSource.beforeOffset
    );
    if (!baseClassSource) {
      continue;
    }

    if (
      (await resolveClassHoverCategory(daemon, baseClassSource, visited)) ===
      'django'
    ) {
      return 'django';
    }
  }

  return 'general';
}

async function resolveFunctionDefinitionSource(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  symbol: string,
  beforeOffset: number
): Promise<FunctionDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const sameDocumentFunction = findTopLevelFunctionDefinition(document, symbol);
  if (sameDocumentFunction) {
    return {
      document,
      functionDef: sameDocumentFunction,
      beforeOffset: document.offsetAt(
        new vscode.Position(sameDocumentFunction.line, 0)
      ),
    };
  }

  const importedDefinition = await resolveImportedDefinitionDocument(
    daemon,
    document,
    symbol,
    beforeOffset
  );
  if (!importedDefinition) {
    return undefined;
  }

  const importedFunction = findTopLevelFunctionDefinition(
    importedDefinition.document,
    importedDefinition.symbolName
  );
  if (!importedFunction) {
    return undefined;
  }

  return {
    document: importedDefinition.document,
    functionDef: importedFunction,
    beforeOffset: importedDefinition.document.offsetAt(
      new vscode.Position(importedFunction.line, 0)
    ),
  };
}

async function resolveReceiverFromFunctionReturnAnnotation(
  daemon: AnalysisDaemon,
  functionSource: FunctionDefinitionSource
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const annotation = functionSource.functionDef.returnAnnotation;
  if (!annotation) {
    return undefined;
  }

  return resolveDirectReceiverFromTypeAnnotation(
    daemon,
    functionSource.document,
    annotation,
    functionSource.beforeOffset
  );
}

async function resolveModelLabelFromFunctionReturnAnnotation(
  daemon: AnalysisDaemon,
  functionSource: FunctionDefinitionSource
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const annotation = functionSource.functionDef.returnAnnotation;
  if (!annotation) {
    return undefined;
  }

  return resolveModelLabelFromTypeAnnotation(
    daemon,
    functionSource.document,
    annotation,
    functionSource.beforeOffset
  );
}

async function resolveClassDefinitionFromFunctionReturnAnnotation(
  daemon: AnalysisDaemon,
  functionSource: FunctionDefinitionSource
): Promise<ClassDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const annotation = functionSource.functionDef.returnAnnotation;
  if (!annotation) {
    return undefined;
  }

  return resolveClassDefinitionFromTypeAnnotation(
    daemon,
    functionSource.document,
    annotation,
    functionSource.beforeOffset
  );
}

async function resolveImportedDefinitionDocument(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  symbol: string,
  beforeOffset: number
): Promise<{ document: vscode.TextDocument; symbolName: string } | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const bindings = collectImportBindings(document, beforeOffset);
  const directBinding = bindings.symbols.get(symbol);
  if (directBinding) {
    const target = await resolveImportedSymbolOrModule(
      daemon,
      directBinding.moduleName,
      directBinding.symbolName
    );
    if (target?.kind === 'symbol' && target.resolution.originFilePath) {
      return {
        document: await vscode.workspace.openTextDocument(
          target.resolution.originFilePath
        ),
        symbolName: target.resolution.originSymbol ?? directBinding.symbolName,
      };
    }
    if (target?.kind === 'module' && target.resolution.filePath) {
      return {
        document: await vscode.workspace.openTextDocument(
          target.resolution.filePath
        ),
        symbolName: path.basename(
          target.resolution.filePath,
          path.extname(target.resolution.filePath)
        ),
      };
    }

    const directDefinition = await resolveDirectModuleDefinitionDocument(
      daemon,
      directBinding.moduleName,
      directBinding.symbolName
    );
    if (directDefinition) {
      return directDefinition;
    }

    const importedModelDefinition = await resolveImportedModelDefinitionDocument(
      daemon,
      directBinding.moduleName,
      directBinding.symbolName
    );
    if (importedModelDefinition) {
      return importedModelDefinition;
    }
  }

  const parts = symbol.split('.');
  if (parts.length === 2) {
    const moduleName = await resolveImportedModuleAlias(
      daemon,
      bindings,
      parts[0]
    );
    if (moduleName) {
      const resolution = await daemon.resolveExportOrigin(moduleName, parts[1]);
      if (resolution.resolved && resolution.originFilePath) {
        return {
          document: await vscode.workspace.openTextDocument(
            resolution.originFilePath
          ),
          symbolName: resolution.originSymbol ?? parts[1],
        };
      }
    }
  }

  return undefined;
}

async function resolveDirectModuleDefinitionDocument(
  daemon: AnalysisDaemon,
  moduleName: string,
  symbolName: string
): Promise<{ document: vscode.TextDocument; symbolName: string } | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const moduleResolution = await daemon.resolveModule(moduleName);
  if (!moduleResolution.resolved || !moduleResolution.filePath) {
    return undefined;
  }

  const document = await vscode.workspace.openTextDocument(moduleResolution.filePath);
  if (!findClassDefinition(document, symbolName)) {
    return undefined;
  }

  return { document, symbolName };
}

async function resolveImportedModelDefinitionDocument(
  daemon: AnalysisDaemon,
  moduleName: string,
  symbolName: string
): Promise<{ document: vscode.TextDocument; symbolName: string } | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const targets = await listAllRelationTargets(daemon);
  const sameNameTargets = targets.items.filter(
    (item) => item.objectName === symbolName
  );
  if (sameNameTargets.length === 0) {
    return undefined;
  }

  const preferredTarget =
    preferredImportedModelDefinitionTarget(sameNameTargets, moduleName) ??
    (sameNameTargets.length === 1 ? sameNameTargets[0] : undefined);
  if (!preferredTarget?.filePath) {
    return undefined;
  }

  return {
    document: await vscode.workspace.openTextDocument(
      preferredTarget.filePath
    ),
    symbolName: preferredTarget.objectName,
  };
}

function preferredImportedModelDefinitionTarget(
  targets: RelationTargetItem[],
  moduleName: string
): RelationTargetItem | undefined {
  const exactModuleTarget = targets.filter((item) => item.module === moduleName);
  if (exactModuleTarget.length === 1) {
    return exactModuleTarget[0];
  }

  const packageModuleTargets = targets.filter((item) =>
    item.module.startsWith(`${moduleName}.`)
  );
  if (packageModuleTargets.length === 1) {
    return packageModuleTargets[0];
  }

  const moduleRoot = moduleName.split('.', 1)[0];
  const sameRootTargets = targets.filter(
    (item) =>
      item.appLabel === moduleName ||
      item.appLabel === moduleRoot ||
      item.module === moduleRoot ||
      item.module.startsWith(`${moduleRoot}.`)
  );
  if (sameRootTargets.length === 1) {
    return sameRootTargets[0];
  }

  return undefined;
}

function cachedDocumentDefinitions(
  document: vscode.TextDocument
): CachedDocumentDefinitions {
  const cached = documentDefinitionsCache.get(document);
  if (cached && cached.version === document.version) {
    return cached;
  }

  const classesByName = new Map<string, PythonClassDefinition>();
  const topLevelFunctionsByName = new Map<string, PythonFunctionDefinition>();

  for (let line = 0; line < document.lineCount; line += 1) {
    const classDef = parseClassDefinitionAtLine(document, line);
    if (classDef && !classesByName.has(classDef.name)) {
      classesByName.set(classDef.name, classDef);
    }

    const functionDef = parseFunctionDefinitionAtLine(document, line);
    if (
      functionDef &&
      functionDef.indent === 0 &&
      !topLevelFunctionsByName.has(functionDef.name)
    ) {
      topLevelFunctionsByName.set(functionDef.name, functionDef);
    }
  }

  const nextCache = {
    version: document.version,
    classesByName,
    topLevelFunctionsByName,
  };
  documentDefinitionsCache.set(document, nextCache);
  return nextCache;
}

function findEnclosingClassDefinition(
  document: vscode.TextDocument,
  beforeOffset: number
): PythonClassDefinition | undefined {
  const targetLine = document.positionAt(beforeOffset).line;

  for (let line = targetLine; line >= 0; line -= 1) {
    const classDef = parseClassDefinitionAtLine(document, line);
    if (!classDef) {
      continue;
    }

    if (targetLine > classDef.line && targetLine <= classDef.endLine) {
      return classDef;
    }
  }

  return undefined;
}

function classDefinitionAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): PythonClassDefinition | undefined {
  const lineText = document.lineAt(position.line).text;
  const classDef = parseClassDefinitionAtLine(document, position.line);
  if (!classDef) {
    return undefined;
  }

  const classPrefixMatch = lineText.match(/^(\s*class\s+)/);
  const classNameStart = classPrefixMatch?.[0].length;
  if (classNameStart === undefined) {
    return undefined;
  }

  const classNameEnd = classNameStart + classDef.name.length;
  if (
    position.character < classNameStart ||
    position.character > classNameEnd
  ) {
    return undefined;
  }

  return classDef;
}

function findEnclosingParentClassDefinition(
  document: vscode.TextDocument,
  childClass: PythonClassDefinition
): PythonClassDefinition | undefined {
  for (let line = childClass.line - 1; line >= 0; line -= 1) {
    const classDef = parseClassDefinitionAtLine(document, line);
    if (!classDef) {
      continue;
    }

    if (
      classDef.indent < childClass.indent &&
      classDef.line < childClass.line &&
      classDef.endLine >= childClass.endLine
    ) {
      return classDef;
    }
  }

  return undefined;
}

async function resolveMetaOwnerModelLabel(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const metaClass = findEnclosingClassDefinition(document, document.offsetAt(position));
  if (!metaClass || metaClass.name !== 'Meta') {
    return undefined;
  }

  const ownerClass = findEnclosingParentClassDefinition(document, metaClass);
  if (!ownerClass) {
    return undefined;
  }

  return resolveModelLabelFromSymbol(
    daemon,
    document,
    ownerClass.name,
    document.offsetAt(new vscode.Position(ownerClass.line, 0))
  );
}

function findEnclosingFunctionDefinition(
  document: vscode.TextDocument,
  beforeOffset: number
): PythonFunctionDefinition | undefined {
  const targetLine = document.positionAt(beforeOffset).line;

  for (let line = targetLine; line >= 0; line -= 1) {
    const functionDef = parseFunctionDefinitionAtLine(document, line);
    if (!functionDef) {
      continue;
    }
    if (targetLine > functionDef.line && targetLine <= functionDef.endLine) {
      return functionDef;
    }
  }

  return undefined;
}

function findClassDefinition(
  document: vscode.TextDocument,
  className: string
): PythonClassDefinition | undefined {
  return cachedDocumentDefinitions(document).classesByName.get(className);
}

function parseClassDefinitionAtLine(
  document: vscode.TextDocument,
  line: number
): PythonClassDefinition | undefined {
  const lineText = document.lineAt(line).text;
  const match = lineText.match(CLASS_HEADER_START_PATTERN);
  if (!match) {
    return undefined;
  }

  const indent = match[1].length;
  const className = match[2];
  const header = collectClassHeaderText(document, line, match[3]);
  if (!header) {
    return undefined;
  }

  const colonIndex = findTopLevelKeyword(header.text, ':');
  if (colonIndex === undefined) {
    return undefined;
  }

  const beforeColon = header.text.slice(0, colonIndex).trim();
  return {
    name: className,
    baseExpressions: classBaseExpressionsFromHeader(beforeColon),
    line,
    indent,
    endLine: findBlockEndLine(document, header.endLine, indent),
  };
}

function collectClassHeaderText(
  document: vscode.TextDocument,
  startLine: number,
  firstLineTail: string
): { text: string; endLine: number } | undefined {
  const parts = [stripTrailingComment(firstLineTail)];
  const firstHeaderText = parts.join('\n');
  if (findTopLevelKeyword(firstHeaderText, ':') !== undefined) {
    return { text: firstHeaderText, endLine: startLine };
  }

  for (let line = startLine + 1; line < document.lineCount; line += 1) {
    const currentPart = stripTrailingComment(document.lineAt(line).text);
    parts.push(currentPart);
    const headerText = parts.join('\n');
    if (findTopLevelKeyword(headerText, ':') !== undefined) {
      return { text: headerText, endLine: line };
    }
  }

  return undefined;
}

function classBaseExpressionsFromHeader(headerText: string): string[] {
  if (!headerText.startsWith('(')) {
    return [];
  }

  const closeParenIndex = findMatchingClosingDelimiter(headerText, 0, '(', ')');
  if (closeParenIndex === undefined) {
    return [];
  }

  const baseText = headerText.slice(1, closeParenIndex).trim();
  return baseText ? splitTopLevelExpressions(baseText) : [];
}

function findMethodDefinition(
  document: vscode.TextDocument,
  classDef: PythonClassDefinition,
  methodName: string
): PythonFunctionDefinition | undefined {
  for (let line = classDef.line + 1; line <= classDef.endLine; line += 1) {
    const functionDef = parseFunctionDefinitionAtLine(document, line);
    if (!functionDef || functionDef.name !== methodName) {
      continue;
    }

    if (functionDef.indent <= classDef.indent) {
      continue;
    }

    return functionDef;
  }

  return undefined;
}

function findClassAttributeAssignment(
  document: vscode.TextDocument,
  classDef: PythonClassDefinition,
  attributeName: string
): vscode.Location | undefined {
  const assignmentPattern = new RegExp(
    String.raw`^(\s+)${escapeRegExp(attributeName)}\s*=`
  );

  for (let line = classDef.line + 1; line <= classDef.endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    const match = lineText.match(assignmentPattern);
    if (!match) {
      continue;
    }

    if (match[1].length <= classDef.indent) {
      continue;
    }

    const column = lineText.indexOf(attributeName);
    if (column < 0) {
      continue;
    }

    return new vscode.Location(
      document.uri,
      new vscode.Position(line, column)
    );
  }

  return undefined;
}

function findTopLevelFunctionDefinition(
  document: vscode.TextDocument,
  functionName: string
): PythonFunctionDefinition | undefined {
  return cachedDocumentDefinitions(document).topLevelFunctionsByName.get(
    functionName
  );
}

function buildFunctionDefinition(
  document: vscode.TextDocument,
  line: number,
  match: RegExpMatchArray
): PythonFunctionDefinition {
  const indent = match[1].length;
  const returnAnnotation = stripTypeDefaultValue((match[4] ?? '').trim());
  return {
    name: match[2],
    line,
    indent,
    endLine: findBlockEndLine(document, line, indent),
    returnAnnotation: returnAnnotation || undefined,
  };
}

function parseFunctionDefinitionAtLine(
  document: vscode.TextDocument,
  line: number
): PythonFunctionDefinition | undefined {
  const header = collectFunctionDefinitionHeader(document, line);
  if (!header) {
    return undefined;
  }

  const match = header.text.match(
    /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([\s\S]*?)\)\s*(?:->\s*([^:]+))?\s*:$/
  );
  if (!match) {
    return undefined;
  }

  const returnAnnotation = stripTypeDefaultValue((match[3] ?? '').trim());
  return {
    name: match[1],
    line,
    indent: header.indent,
    endLine: findBlockEndLine(document, header.endLine, header.indent),
    returnAnnotation: returnAnnotation || undefined,
  };
}

function collectFunctionDefinitionHeader(
  document: vscode.TextDocument,
  line: number
): { text: string; indent: number; endLine: number } | undefined {
  if (line < 0 || line >= document.lineCount) {
    return undefined;
  }

  const firstLineText = stripTrailingComment(document.lineAt(line).text);
  if (!firstLineText.match(/^\s*(?:async\s+)?def\b/)) {
    return undefined;
  }

  const indent = indentationWidth(firstLineText);
  const parts: string[] = [firstLineText.trim()];
  let currentLine = line;
  let depth = bracketBalance(firstLineText);

  while (currentLine < document.lineCount - 1) {
    const currentText = stripTrailingComment(document.lineAt(currentLine).text).trimEnd();
    if (depth <= 0 && currentText.trim().endsWith(':')) {
      break;
    }

    currentLine += 1;
    const nextLineText = stripTrailingComment(document.lineAt(currentLine).text);
    if (nextLineText.trim()) {
      parts.push(nextLineText.trim());
    }
    depth += bracketBalance(nextLineText);
  }

  return {
    text: joinCollectedExpressionParts(parts),
    indent,
    endLine: currentLine,
  };
}

function classReferenceExpressionAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const hoveredWord = document.getText(wordRange);
  const lineText = document.lineAt(position.line).text;
  if (
    wordRange.start.character === 0 ||
    lineText[wordRange.start.character - 1] !== '.'
  ) {
    return hoveredWord;
  }

  let objectEnd = wordRange.start.character - 1;
  let objectStart = objectEnd;
  while (objectStart > 0 && /[A-Za-z0-9_]/.test(lineText[objectStart - 1] ?? '')) {
    objectStart -= 1;
  }

  const objectName = lineText.slice(objectStart, objectEnd);
  if (!/^[A-Za-z_][\w]*$/.test(objectName)) {
    return hoveredWord;
  }

  return `${objectName}.${hoveredWord}`;
}

function receiverExpressionPrefixAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): { expression: string; range: vscode.Range } | undefined {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const lineText = document.lineAt(position.line).text;
  let start = wordRange.start.character;
  const end = wordRange.end.character;

  while (start > 0) {
    const dotIndex = start - 1;
    if (lineText[dotIndex] !== '.') {
      break;
    }

    let segmentStart = dotIndex;
    while (
      segmentStart > 0 &&
      /[A-Za-z0-9_]/.test(lineText[segmentStart - 1] ?? '')
    ) {
      segmentStart -= 1;
    }

    const segment = lineText.slice(segmentStart, dotIndex);
    if (!/^[A-Za-z_][\w]*$/.test(segment)) {
      break;
    }

    start = segmentStart;
  }

  const expression = lineText.slice(start, end).trim();
  if (!expression) {
    return undefined;
  }

  return {
    expression,
    range: new vscode.Range(position.line, start, position.line, end),
  };
}

function baseClassReferenceExpression(baseExpression: string): string | undefined {
  const normalizedExpression = stripWrappingParentheses(baseExpression.trim());
  if (!normalizedExpression) {
    return undefined;
  }

  const genericType = parseGenericTypeAnnotation(normalizedExpression);
  if (genericType) {
    return genericType.base;
  }

  const parsedCall = parseCalledExpression(normalizedExpression);
  if (!parsedCall) {
    return normalizedExpression;
  }

  if (parsedCall.kind === 'function') {
    return parsedCall.functionName;
  }

  if (parsedCall.memberName === 'from_queryset') {
    return parsedCall.objectExpression;
  }

  return `${parsedCall.objectExpression}.${parsedCall.memberName}`;
}

function specialClassKindFromCanonicalName(
  canonicalName: string
): SpecialClassKind | undefined {
  if (QUERYSET_TYPE_NAMES.has(canonicalName)) {
    return 'queryset';
  }

  if (MANAGER_TYPE_NAMES.has(canonicalName)) {
    return 'manager';
  }

  if (RELATED_MANAGER_TYPE_NAMES.has(canonicalName)) {
    return 'related_manager';
  }

  return undefined;
}

function isDjangoCanonicalClassName(canonicalName: string): boolean {
  return (
    DJANGO_TYPE_HINT_NAMES.has(canonicalName) ||
    canonicalName.startsWith('django.')
  );
}

function typeHintCategory(
  canonicalName: string
): 'builtin' | 'typing' | 'django' | undefined {
  if (BUILTIN_TYPE_HINT_NAMES.has(canonicalName)) {
    return 'builtin';
  }

  if (TYPING_TYPE_HINT_NAMES.has(canonicalName)) {
    return 'typing';
  }

  if (DJANGO_TYPE_HINT_NAMES.has(canonicalName)) {
    return 'django';
  }

  return undefined;
}

function findBlockEndLine(
  document: vscode.TextDocument,
  startLine: number,
  indent: number
): number {
  for (let line = startLine + 1; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    if (!text.trim()) {
      continue;
    }

    const trimmed = text.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }

    if (indentationWidth(text) <= indent) {
      return line - 1;
    }
  }

  return document.lineCount - 1;
}

function collectReturnExpressions(
  document: vscode.TextDocument,
  functionDef: PythonFunctionDefinition
): Array<{ expression: string; offset: number }> {
  const expressions: Array<{ expression: string; offset: number }> = [];

  for (let line = functionDef.line + 1; line <= functionDef.endLine; line += 1) {
    const text = document.lineAt(line).text;
    if (!text.trim() || indentationWidth(text) <= functionDef.indent) {
      continue;
    }

    const trimmed = stripTrailingComment(text).trim();
    if (!trimmed.startsWith('return')) {
      continue;
    }

    const initialExpression = trimmed.slice('return'.length).trim();
    if (!initialExpression) {
      continue;
    }

    const collected = collectMultilineExpression(
      document,
      line,
      functionDef.endLine,
      initialExpression
    );
    if (!collected.expression) {
      continue;
    }

    expressions.push({
      expression: collected.expression,
      offset: document.offsetAt(new vscode.Position(line, 0)),
    });
    line = collected.endLine;
  }

  return expressions;
}

function collectMultilineExpression(
  document: vscode.TextDocument,
  startLine: number,
  endLine: number,
  initialExpression: string
): { expression: string; endLine: number } {
  const parts = [initialExpression];
  let currentLine = startLine;
  let depth = bracketBalance(initialExpression);

  while (currentLine < endLine && depth > 0) {
    currentLine += 1;
    const nextLine = stripTrailingComment(document.lineAt(currentLine).text).trim();
    if (!nextLine) {
      continue;
    }
    parts.push(nextLine);
    depth += bracketBalance(nextLine);
  }

  return {
    expression: stripWrappingParentheses(
      joinCollectedExpressionParts(parts).trim()
    ),
    endLine: currentLine,
  };
}

function joinCollectedExpressionParts(parts: string[]): string {
  let expression = '';

  for (const part of parts) {
    if (!part) {
      continue;
    }

    if (
      !expression ||
      part.startsWith('.') ||
      part.startsWith(')') ||
      part.startsWith(']') ||
      part.startsWith('}') ||
      expression.endsWith('(') ||
      expression.endsWith('[') ||
      expression.endsWith('{')
    ) {
      expression += part;
      continue;
    }

    expression += ` ${part}`;
  }

  return expression;
}

function parseCalledExpression(expression: string): ParsedCallExpression | undefined {
  const normalizedExpression = stripWrappingParentheses(expression.trim());
  if (!normalizedExpression.endsWith(')')) {
    return undefined;
  }

  const openParenIndex = findMatchingOpeningDelimiter(
    normalizedExpression,
    normalizedExpression.length - 1,
    '(',
    ')'
  );
  if (openParenIndex === undefined) {
    return undefined;
  }

  const calleeExpression = normalizedExpression.slice(0, openParenIndex);
  if (!calleeExpression) {
    return undefined;
  }

  const memberAccess = splitTopLevelMemberAccess(calleeExpression);
  if (memberAccess) {
    return {
      kind: 'member',
      objectExpression: memberAccess.objectExpression,
      memberName: memberAccess.memberName,
    };
  }

  if (/^[A-Za-z_][\w]*$/.test(calleeExpression)) {
    return {
      kind: 'function',
      functionName: calleeExpression,
    };
  }

  return undefined;
}

function collectOrmMemberChain(
  expression: string
): { baseExpression: string; members: string[] } | undefined {
  const members: string[] = [];
  let current = expression;

  while (true) {
    const parsed = parseCalledExpression(current);
    if (!parsed) {
      break;
    }

    if (parsed.kind === 'function') {
      // base is a simple call like Model()
      break;
    }

    members.unshift(parsed.memberName);
    current = parsed.objectExpression;
  }

  if (members.length === 0) {
    return undefined;
  }

  const baseExpression = current.trim();
  if (!baseExpression) {
    return undefined;
  }

  return { baseExpression, members };
}

function parseCallExpressionDetails(
  expression: string
): { parsedCall: ParsedCallExpression; argsText: string } | undefined {
  const normalizedExpression = stripWrappingParentheses(expression.trim());
  if (!normalizedExpression.endsWith(')')) {
    return undefined;
  }

  const openParenIndex = findMatchingOpeningDelimiter(
    normalizedExpression,
    normalizedExpression.length - 1,
    '(',
    ')'
  );
  if (openParenIndex === undefined) {
    return undefined;
  }

  const parsedCall = parseCalledExpression(normalizedExpression);
  if (!parsedCall) {
    return undefined;
  }

  return {
    parsedCall,
    argsText: normalizedExpression.slice(openParenIndex + 1, -1),
  };
}

function splitTopLevelMemberAccess(
  expression: string
): { objectExpression: string; memberName: string } | undefined {
  let depth = 0;

  for (let index = expression.length - 1; index >= 0; index -= 1) {
    const char = expression[index];
    if (char === ')' || char === ']' || char === '}') {
      depth += 1;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      if (depth > 0) {
        depth -= 1;
      }
      continue;
    }

    if (char !== '.' || depth !== 0) {
      continue;
    }

    const objectExpression = expression.slice(0, index);
    const memberName = expression.slice(index + 1);
    if (!objectExpression || !/^[A-Za-z_][\w]*$/.test(memberName)) {
      return undefined;
    }

    return {
      objectExpression,
      memberName,
    };
  }

  return undefined;
}

function splitTopLevelExpressions(value: string): string[] {
  const expressions: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        expressions.push(trimmed);
      }
      current = '';
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if ((char === ')' || char === ']' || char === '}') && depth > 0) {
      depth -= 1;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) {
    expressions.push(trailing);
  }

  return expressions;
}

function splitTopLevelExpressionsWithOffsets(
  value: string
): Array<{ value: string; start: number; end: number }> {
  const expressions: Array<{ value: string; start: number; end: number }> = [];
  let current = '';
  let currentStart = 0;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        const leadingWhitespace = current.search(/\S/);
        const start = currentStart + Math.max(leadingWhitespace, 0);
        expressions.push({
          value: trimmed,
          start,
          end: currentStart + current.length,
        });
      }
      current = '';
      currentStart = index + 1;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if ((char === ')' || char === ']' || char === '}') && depth > 0) {
      depth -= 1;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) {
    const leadingWhitespace = current.search(/\S/);
    const start = currentStart + Math.max(leadingWhitespace, 0);
    expressions.push({
      value: trailing,
      start,
      end: currentStart + current.length,
    });
  }

  return expressions;
}

function stripWrappingParentheses(value: string): string {
  let current = value.trim();

  while (
    current.startsWith('(') &&
    current.endsWith(')') &&
    findMatchingOpeningDelimiter(current, current.length - 1, '(', ')') === 0
  ) {
    current = current.slice(1, -1).trim();
  }

  return current;
}

function normalizeReceiverExpression(value: string): string {
  let current = trimLeadingUnmatchedOpeningDelimiters(
    stripWrappingParentheses(value.trim())
  );

  while (true) {
    let strippedPrefix = false;

    // Strip leading Python statement / boolean-context keywords. Require a
    // word-boundary (space) after the keyword so we don't accidentally chew
    // through identifiers like `notify_user` (`not` prefix) or `iterator`
    // (`if` prefix).
    for (const prefix of [
      'return', 'await', 'not', 'if', 'and', 'or', 'elif', 'while', 'assert', 'yield',
    ]) {
      if (!current.startsWith(prefix + ' ')) {
        continue;
      }

      const candidate = current.slice(prefix.length).trimStart();
      if (!candidate || !/[A-Za-z_(\[{]/.test(candidate[0])) {
        continue;
      }

      current = trimLeadingUnmatchedOpeningDelimiters(
        stripWrappingParentheses(candidate)
      );
      strippedPrefix = true;
      break;
    }

    if (!strippedPrefix) {
      break;
    }
  }

  return current;
}

function findMatchingOpeningDelimiter(
  text: string,
  closingIndex: number,
  openingDelimiter: string,
  closingDelimiter: string
): number | undefined {
  let depth = 0;

  for (let index = closingIndex; index >= 0; index -= 1) {
    const char = text[index];
    if (char === closingDelimiter) {
      depth += 1;
      continue;
    }

    if (char !== openingDelimiter) {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  return undefined;
}

function findMatchingClosingDelimiter(
  text: string,
  openingIndex: number,
  openingDelimiter: string,
  closingDelimiter: string
): number | undefined {
  let depth = 0;

  for (let index = openingIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === openingDelimiter) {
      depth += 1;
      continue;
    }

    if (char !== closingDelimiter) {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  return undefined;
}

function bracketBalance(value: string): number {
  let balance = 0;

  for (const char of value) {
    if (char === '(' || char === '[' || char === '{') {
      balance += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      balance -= 1;
    }
  }

  return balance;
}

function indentationWidth(lineText: string): number {
  return lineText.match(/^\s*/)?.[0].length ?? 0;
}

function directModelSymbolCandidates(receiverExpression: string): string[] {
  const normalizedExpression = receiverExpression.trim();
  const candidates: string[] = [];
  const objectsIndex = normalizedExpression.indexOf('.objects');
  if (objectsIndex > 0) {
    candidates.push(normalizedExpression.slice(0, objectsIndex).trim());
  }

  const rootIdentifier = receiverRootIdentifier(normalizedExpression);
  if (rootIdentifier && normalizedExpression.includes('.')) {
    candidates.push(rootIdentifier);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function snakeToPascalCase(snake: string): string {
  return snake
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Produces the standard snake→PascalCase conversion, plus a small set of
 * fuzzy variants that try to recover from common pluralization mismatches
 * between variable names and model names. Variants are returned in
 * decreasing-confidence order; callers should try them in sequence and
 * stop at the first match.
 *
 * Examples for input `vendors`:
 *   `Vendors`  (literal pascal-case)
 *   `Vendor`   (drop trailing 's' from last segment)
 *
 * Examples for input `directors_meeting`:
 *   `DirectorsMeeting`
 *   `DirectorMeeting`   (drop trailing 's' from first segment)
 */
function snakeToPascalCaseVariants(snake: string): string[] {
  const segments = snake.split('_').filter(Boolean);
  if (segments.length === 0) return [];
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (parts: string[]): void => {
    const v = parts.map(cap).join('');
    if (!seen.has(v)) {
      seen.add(v);
      variants.push(v);
    }
  };
  push(segments);
  // Drop trailing 's' from the LAST segment (e.g. vendors → Vendor).
  const last = segments[segments.length - 1];
  if (last.length > 1 && last.endsWith('s')) {
    push([...segments.slice(0, -1), last.slice(0, -1)]);
  }
  // Drop trailing 's' from the FIRST segment (e.g. directors_meeting →
  // DirectorMeeting). Only when there's more than one segment so that the
  // identifier still looks like a compound noun.
  if (segments.length > 1) {
    const first = segments[0];
    if (first.length > 1 && first.endsWith('s')) {
      push([first.slice(0, -1), ...segments.slice(1)]);
    }
  }
  // Drop descriptive suffixes often used in local variables, e.g.
  // `company_for_chain` should still be allowed to fall back to `Company`.
  const suffixConnectorIndex = segments.findIndex((segment) =>
    ['for', 'from', 'with', 'by'].includes(segment)
  );
  if (suffixConnectorIndex > 0) {
    push(segments.slice(0, suffixConnectorIndex));
  }
  return variants;
}

/**
 * Diagnostic helper: classify why a receiver expression failed to resolve.
 * Used only for logging — does not block the main resolver flow. Cheap
 * synchronous checks against `daemon.modelLabelByName` and string shape;
 * no IPC, no async work.
 *
 * Returned categories:
 *   `unknown_root`        — root identifier not in model graph, no fuzzy
 *                            variant matches. Most likely workspace model
 *                            indexing miss (or a genuinely unknown name).
 *   `fuzzy_matched:Name`  — a snake→pascal fuzzy variant maps to a known
 *                            model `Name`, but the chain still failed —
 *                            usually means a reverse accessor / member is
 *                            not in the surface index.
 *   `root_matched:Name`   — root resolves to `Name` directly, but the
 *                            member chain after the root failed. Indicates
 *                            an unindexed attribute/method on a known model.
 *   `parse_polluted`      — receiver expression contains `#` or starts
 *                            with non-identifier characters, signaling a
 *                            parser path that swallowed comment/docstring
 *                            text into the expression.
 *   `no_root_identifier`  — could not extract a root identifier at all
 *                            (e.g. starts with a literal or punctuation).
 */
function classifyNoRecvReason(
  daemon: AnalysisDaemon,
  receiverExpression: string,
): string {
  if (!receiverExpression) {
    return 'no_root_identifier';
  }
  if (receiverExpression.includes('#')) {
    return 'parse_polluted';
  }
  // Normalize first (strip Python keyword prefixes like `return`, `await`,
  // `not`, etc.) so the root identifier extraction matches what the
  // resolver actually attempted. Captain trace L81/L138 showed
  // `return Director.objects.get_queryset()` bucketed as `unknown_root`
  // because the raw expression's first identifier is `return`.
  const normalized = normalizeReceiverExpression(receiverExpression) || receiverExpression;
  // Detect self/cls/super references — captain shows 23+ per cycle in the
  // `self.<X>_set` shape. Mark them with a dedicated bucket so the
  // diagnostics surface separates them from the generic no_root_identifier
  // catch-all (literals, punctuation starts, etc.).
  const selfPrefixMatch = /^(self|cls|super)\b/.exec(normalized);
  if (selfPrefixMatch) {
    return `self_reference:${selfPrefixMatch[1]}`;
  }
  const rootIdentifier = receiverRootIdentifier(normalized);
  if (!rootIdentifier) {
    return 'no_root_identifier';
  }
  const hasMemberChain = normalized.length > rootIdentifier.length;
  if (daemon.hasModelByShortName(rootIdentifier)) {
    return hasMemberChain
      ? `root_matched:${rootIdentifier}`
      : `root_matched_bare:${rootIdentifier}`;
  }
  for (const variant of snakeToPascalCaseVariants(rootIdentifier)) {
    if (variant !== rootIdentifier && daemon.hasModelByShortName(variant)) {
      return `fuzzy_matched:${variant}`;
    }
  }
  return 'unknown_root';
}

function receiverRootIdentifier(receiverExpression: string): string | undefined {
  const match = receiverExpression.match(/^([A-Za-z_][\w]*)\b/);
  if (!match) {
    return undefined;
  }

  const identifier = match[1];
  if (identifier === 'self' || identifier === 'cls' || identifier === 'super') {
    return undefined;
  }

  return identifier;
}

// A name's binding (assignment / annotation / loop / comprehension) is, in
// practice, a bounded distance above its use. Scanning to the start of a
// multi-thousand-line file on every receiver resolution (hover / diagnostics /
// inlay) was a profiled 100%-CPU hot path. Bound the backward search; a binding
// farther than this is not worth the per-keystroke cost.
const MAX_BINDING_BACKSCAN_LINES = 600;
const MAX_COMPREHENSION_BACKSCAN_CHARS = 24000;

function findNearestLoopIterableExpression(
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): { expression: string; offset: number } | undefined {
  const beforePosition = document.positionAt(beforeOffset);
  const minLine = Math.max(0, beforePosition.line - MAX_BINDING_BACKSCAN_LINES);

  for (let line = beforePosition.line; line >= minLine; line -= 1) {
    const parsedLoop = parseForLoopHeader(document.lineAt(line).text);
    if (!parsedLoop || !loopTargetContainsIdentifier(parsedLoop.target, variableName)) {
      continue;
    }

    const endLine = findBlockEndLine(document, line, parsedLoop.indent);
    if (beforePosition.line <= line || beforePosition.line > endLine) {
      continue;
    }

    return {
      expression: parsedLoop.iterable,
      offset: document.offsetAt(new vscode.Position(line, 0)),
    };
  }

  return undefined;
}

function findNearestIterableBindingExpression(
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): { expression: string; offset: number } | undefined {
  return (
    findNearestLoopIterableExpression(document, variableName, beforeOffset) ??
    findNearestComprehensionIterableExpression(
      document,
      variableName,
      beforeOffset
    )
  );
}

function findNearestComprehensionIterableExpression(
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): { expression: string; offset: number } | undefined {
  const fullText = getDocumentText(document);
  const minIndex = Math.max(0, beforeOffset - MAX_COMPREHENSION_BACKSCAN_CHARS);

  // Walk backward tracking bracket depth so we only run the O(n) forward
  // delimiter match for brackets that actually ENCLOSE beforeOffset (the few
  // unmatched openers at the cursor's nesting depth), instead of for every
  // opener before the cursor — which made this O(n²) and a GC hot path.
  let depth = 0;
  for (let index = beforeOffset - 1; index >= minIndex; index -= 1) {
    const char = fullText[index];
    if (char === ')' || char === ']' || char === '}') {
      depth += 1;
      continue;
    }
    if (char !== '(' && char !== '[' && char !== '{') {
      continue;
    }
    // `char` is an opening delimiter.
    if (depth > 0) {
      // Matches a closer we already passed — a sibling sub-expression, not an
      // enclosing bracket.
      depth -= 1;
      continue;
    }

    // depth === 0 → this opener encloses beforeOffset.
    const closingDelimiter = char === '(' ? ')' : char === '[' ? ']' : '}';
    const closingIndex = findMatchingClosingDelimiter(
      fullText,
      index,
      char,
      closingDelimiter
    );
    if (closingIndex === undefined || closingIndex < beforeOffset) {
      // Defensive — keep scanning outward for an enclosing comprehension.
      continue;
    }

    const bodyStartOffset = index + 1;
    const body = fullText.slice(bodyStartOffset, closingIndex);
    const clauses = parseComprehensionClauses(body).filter((clause) =>
      loopTargetContainsIdentifier(clause.target, variableName)
    );
    if (clauses.length > 0) {
      const relativeOffset = beforeOffset - bodyStartOffset;
      const inScopeClauses = clauses.filter(
        (clause) => clause.clauseStart <= relativeOffset
      );
      const matchedClause = inScopeClauses.at(-1) ?? clauses.at(-1);
      if (matchedClause) {
        return {
          expression: matchedClause.iterable,
          offset: bodyStartOffset + matchedClause.iterableStart,
        };
      }
    }
    // Not a matching comprehension; keep scanning outward (depth stays 0 — we
    // have consumed this opener as the current enclosing bracket).
  }

  return undefined;
}

function findNearestAssignedExpression(
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): { expression: string; offset: number } | undefined {
  const assignmentPattern = new RegExp(
    String.raw`^\s*${escapeRegExp(variableName)}(?:\s*:\s*[^=]+)?\s*=\s*(.+)$`
  );
  const beforePosition = document.positionAt(beforeOffset);
  const minLine = Math.max(0, beforePosition.line - MAX_BINDING_BACKSCAN_LINES);

  // Root-cause fix (self-reassignment chain): a variable rebound in terms of
  // itself — `x = get_emps(hrm)` then `x = x.annotate_status_at()...` then
  // `x = x.filter(...)` — must be walked ONE STEP AT A TIME so each rebinding's
  // transforms (annotate virtual fields, filters) accumulate. We therefore
  // return the NEAREST assignment, INCLUDING a self-referential one, EXCEPT the
  // self-referential assignment on `beforePosition.line` itself: that is the very
  // RHS we are currently resolving, whose inner `x` is bound by the PREVIOUS
  // assignment, so we keep scanning upward. Because each returned self-referential
  // assignment is re-entered with its own line as the new beforeOffset, the next
  // lookup skips that line and moves strictly earlier — the walk is monotonic
  // (no infinite loop) and reaches the origin binding while preserving every
  // intermediate `.annotate_*()` that adds virtual fields.
  //
  // (The earlier implementation skipped ALL self-referential lines straight to
  // the origin, which dropped the `x = x.annotate_*()` rebinding entirely and
  // lost its annotated virtual fields — the real-world `hrm_emp_qs` bug.)
  for (let line = beforePosition.line; line >= minLine; line -= 1) {
    const lineText = document.lineAt(line).text;
    const match = lineText.match(assignmentPattern);
    if (!match) {
      continue;
    }

    const rawExpression = stripTrailingComment(match[1]).trim();
    if (!rawExpression) {
      continue;
    }

    if (line === beforePosition.line) {
      // The nearest assignment is on the very line we started resolving from —
      // i.e. we are resolving the RHS of THIS assignment, whose inner `x` is
      // bound by the PREVIOUS assignment. If it is self-referential, keep
      // scanning upward. Detect self-reference against the FULL (possibly
      // multi-line) RHS: collecting only up to beforePosition.line truncates a
      // multi-line RHS to its opening token (e.g. `(`) and would hide the
      // self-reference, returning that garbage token instead.
      const fullCollected = collectMultilineExpression(
        document,
        line,
        document.lineCount - 1,
        rawExpression
      );
      if (
        fullCollected.expression &&
        receiverRootIdentifier(fullCollected.expression) === variableName
      ) {
        continue;
      }
    }

    const collected = collectMultilineExpression(
      document,
      line,
      beforePosition.line,
      rawExpression
    );
    if (!collected.expression) {
      continue;
    }

    const expressionOffset = document.offsetAt(new vscode.Position(line, 0));
    return { expression: collected.expression, offset: expressionOffset };
  }

  return undefined;
}

function findNearestTupleAssignedExpression(
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): { expression: string; offset: number; tupleIndex: number } | undefined {
  const beforePosition = document.positionAt(beforeOffset);

  for (let line = beforePosition.line; line >= 0; line -= 1) {
    const lineText = document.lineAt(line).text;
    const equalsIndex = findTopLevelEqualsIndex(lineText);
    if (equalsIndex <= 0) {
      continue;
    }

    const assignmentTarget = lineText.slice(0, equalsIndex).trim();
    if (!assignmentTarget.includes(',')) {
      continue;
    }

    const targets = splitTopLevelExpressions(assignmentTarget);
    const tupleIndex = targets.findIndex((target) => target.trim() === variableName);
    if (tupleIndex < 0) {
      continue;
    }

    const rawExpression = stripTrailingComment(lineText.slice(equalsIndex + 1)).trim();
    if (!rawExpression) {
      continue;
    }

    return {
      expression: rawExpression,
      offset: document.offsetAt(new vscode.Position(line, 0)),
      tupleIndex,
    };
  }

  return undefined;
}

function findTypeAnnotationForIdentifier(
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): { annotation: string; offset: number } | undefined {
  return (
    findNearestAnnotatedAssignment(document, variableName, beforeOffset) ??
    findFunctionParameterTypeAnnotation(document, variableName, beforeOffset)
  );
}

async function resolveTypeVarBoundAnnotation(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  typeVarName: string,
  beforeOffset: number,
  visitedTypeVars: Set<string>
): Promise<TypeAnnotationSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedTypeVarName = normalizeTypeAnnotation(typeVarName);
  if (!normalizedTypeVarName) {
    return undefined;
  }

  const localVisitKey = `${document.uri.toString()}:${normalizedTypeVarName}`;
  if (visitedTypeVars.has(localVisitKey)) {
    return undefined;
  }
  visitedTypeVars.add(localVisitKey);

  const localBound = findTopLevelTypeVarBoundAnnotation(
    document,
    normalizedTypeVarName
  );
  if (localBound) {
    return {
      document,
      ...localBound,
    };
  }

  const bindings = collectImportBindings(document, beforeOffset);
  const directBinding = bindings.symbols.get(normalizedTypeVarName);
  if (!directBinding) {
    return undefined;
  }

  try {
    const target = await resolveImportedSymbolOrModule(
      daemon,
      directBinding.moduleName,
      directBinding.symbolName
    );
    if (
      target?.kind !== 'symbol' ||
      !target.resolution.originFilePath ||
      !target.resolution.originSymbol
    ) {
      return undefined;
    }

    const importedDocument = await vscode.workspace.openTextDocument(
      target.resolution.originFilePath
    );
    const importedBound = findTopLevelTypeVarBoundAnnotation(
      importedDocument,
      target.resolution.originSymbol
    );
    if (!importedBound) {
      return undefined;
    }

    return {
      document: importedDocument,
      ...importedBound,
    };
  } catch {
    return undefined;
  }
}

function findTopLevelTypeVarBoundAnnotation(
  document: vscode.TextDocument,
  typeVarName: string
): { annotation: string; offset: number } | undefined {
  const assignmentPattern = new RegExp(
    String.raw`^\s*${escapeRegExp(typeVarName)}\s*=\s*(.+)$`
  );

  for (let line = 0; line < document.lineCount; line += 1) {
    const lineText = document.lineAt(line).text;
    const match = lineText.match(assignmentPattern);
    if (!match) {
      continue;
    }

    const rawExpression = stripTrailingComment(match[1]).trim();
    if (!rawExpression) {
      continue;
    }

    const collected = collectMultilineExpression(
      document,
      line,
      document.lineCount - 1,
      rawExpression
    );
    const callDetails = parseCallExpressionDetails(collected.expression);
    if (!callDetails) {
      continue;
    }

    const functionName =
      callDetails.parsedCall.kind === 'function'
        ? callDetails.parsedCall.functionName
        : callDetails.parsedCall.memberName;
    if (functionName !== 'TypeVar') {
      continue;
    }

    for (const argument of splitTopLevelExpressions(callDetails.argsText)) {
      const equalsIndex = findTopLevelEqualsIndex(argument);
      if (equalsIndex < 0) {
        continue;
      }

      const keyword = argument.slice(0, equalsIndex).trim();
      if (keyword !== 'bound') {
        continue;
      }

      const annotation = argument.slice(equalsIndex + 1).trim();
      if (!annotation) {
        continue;
      }

      return {
        annotation,
        offset: document.offsetAt(new vscode.Position(line, 0)),
      };
    }
  }

  return undefined;
}

function findClassAttributeTypeAnnotation(
  document: vscode.TextDocument,
  classDef: PythonClassDefinition,
  attributeName: string
): { annotation: string; offset: number } | undefined {
  const annotationPattern = new RegExp(
    String.raw`^\s*${escapeRegExp(attributeName)}\s*:\s*(.+)$`
  );
  const selfAnnotationPattern = new RegExp(
    String.raw`^\s*self\.${escapeRegExp(attributeName)}\s*:\s*(.+)$`
  );

  for (let line = classDef.line + 1; line <= classDef.endLine; line += 1) {
    const lineOffset = document.offsetAt(new vscode.Position(line, 0));
    const enclosingClass = findEnclosingClassDefinition(document, lineOffset);
    if (
      !enclosingClass ||
      enclosingClass.line !== classDef.line ||
      enclosingClass.name !== classDef.name
    ) {
      continue;
    }

    const enclosingFunction = findEnclosingFunctionDefinition(
      document,
      lineOffset
    );
    const lineText = document.lineAt(line).text;
    if (
      enclosingFunction &&
      line > enclosingFunction.line &&
      line <= enclosingFunction.endLine &&
      enclosingFunction.indent > classDef.indent
    ) {
      const selfMatch = lineText.match(selfAnnotationPattern);
      if (!selfMatch) {
        continue;
      }

      const selfAnnotation = stripTypeDefaultValue(
        stripTrailingComment(selfMatch[1]).trim()
      );
      if (!selfAnnotation) {
        continue;
      }

      return {
        annotation: selfAnnotation,
        offset: lineOffset,
      };
    }

    const match = lineText.match(annotationPattern);
    if (!match) {
      continue;
    }

    const annotation = stripTypeDefaultValue(
      stripTrailingComment(match[1]).trim()
    );
    if (!annotation) {
      continue;
    }

    return {
      annotation,
      offset: lineOffset,
    };
  }

  return undefined;
}

function typeAnnotationSegmentAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): TypeAnnotationSegment | undefined {
  const lineText = document.lineAt(position.line).text;

  for (const segment of typeAnnotationSegmentsForLine(lineText)) {
    if (position.character >= segment.start && position.character < segment.end) {
      return segment;
    }
  }

  return undefined;
}

function typeAnnotationSegmentsForLine(lineText: string): TypeAnnotationSegment[] {
  return [
    ...functionTypeAnnotationSegments(lineText),
    ...annotatedAssignmentTypeAnnotationSegments(lineText),
  ];
}

function functionTypeAnnotationSegments(lineText: string): TypeAnnotationSegment[] {
  if (!lineText.match(FUNCTION_DEFINITION_PATTERN)) {
    return [];
  }

  const openParenIndex = lineText.indexOf('(');
  if (openParenIndex < 0) {
    return [];
  }

  const closeParenIndex = findMatchingClosingDelimiter(
    lineText,
    openParenIndex,
    '(',
    ')'
  );
  if (closeParenIndex === undefined) {
    return [];
  }

  const segments: TypeAnnotationSegment[] = [];
  const paramsText = lineText.slice(openParenIndex + 1, closeParenIndex);
  for (const parameter of splitTopLevelExpressionsWithOffsets(paramsText)) {
    const colonIndex = findTopLevelCharacter(parameter.value, ':');
    if (colonIndex === undefined) {
      continue;
    }

    const annotationSegment = annotationSegmentFromFragment(
      parameter.value,
      colonIndex + 1,
      parameter.start + openParenIndex + 1
    );
    if (annotationSegment) {
      segments.push(annotationSegment);
    }
  }

  const returnArrowIndex = lineText.indexOf('->', closeParenIndex);
  const definitionColonIndex = lineText.lastIndexOf(':');
  if (
    returnArrowIndex >= 0 &&
    definitionColonIndex > returnArrowIndex + 2
  ) {
    const annotationSegment = annotationSegmentFromFragment(
      lineText.slice(returnArrowIndex + 2, definitionColonIndex),
      0,
      returnArrowIndex + 2
    );
    if (annotationSegment) {
      segments.push(annotationSegment);
    }
  }

  return segments;
}

function annotatedAssignmentTypeAnnotationSegments(
  lineText: string
): TypeAnnotationSegment[] {
  const trimmed = lineText.trimStart();
  if (
    trimmed.startsWith('def ') ||
    trimmed.startsWith('async def ') ||
    trimmed.startsWith('class ') ||
    trimmed.startsWith('from ') ||
    trimmed.startsWith('import ')
  ) {
    return [];
  }

  const colonIndex = findTopLevelCharacter(lineText, ':');
  if (colonIndex === undefined) {
    return [];
  }

  const target = lineText.slice(0, colonIndex).trim();
  if (!/^[A-Za-z_][\w]*$/.test(target)) {
    return [];
  }

  const assignmentIndex = findTopLevelEqualsIndex(lineText);
  const commentIndex = lineText.indexOf('#');
  let endIndex = lineText.length;
  if (assignmentIndex >= 0) {
    endIndex = assignmentIndex;
  }
  if (commentIndex >= 0) {
    endIndex = Math.min(endIndex, commentIndex);
  }
  if (endIndex <= colonIndex + 1) {
    return [];
  }

  const annotationSegment = annotationSegmentFromFragment(
    lineText.slice(colonIndex + 1, endIndex),
    0,
    colonIndex + 1
  );
  return annotationSegment ? [annotationSegment] : [];
}

function annotationSegmentFromFragment(
  fragment: string,
  startOffset: number,
  absoluteBase: number
): TypeAnnotationSegment | undefined {
  let start = startOffset;
  while (start < fragment.length && /\s/.test(fragment[start])) {
    start += 1;
  }

  const candidate = fragment.slice(start);
  if (!candidate) {
    return undefined;
  }

  const assignmentIndex = findTopLevelCharacter(candidate, '=');
  const end =
    assignmentIndex === undefined ? fragment.length : start + assignmentIndex;
  if (end <= start) {
    return undefined;
  }

  return {
    start: absoluteBase + start,
    end: absoluteBase + end,
  };
}

function findNearestAnnotatedAssignment(
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): { annotation: string; offset: number } | undefined {
  const annotationPattern = new RegExp(
    String.raw`^\s*${escapeRegExp(variableName)}\s*:\s*(.+)$`
  );
  const beforePosition = document.positionAt(beforeOffset);
  const minLine = Math.max(0, beforePosition.line - MAX_BINDING_BACKSCAN_LINES);

  for (let line = beforePosition.line; line >= minLine; line -= 1) {
    const lineText = document.lineAt(line).text;
    const match = lineText.match(annotationPattern);
    if (!match) {
      continue;
    }

    const annotation = stripTypeDefaultValue(
      stripTrailingComment(match[1]).trim()
    );
    if (!annotation) {
      continue;
    }

    return {
      annotation,
      offset: document.offsetAt(new vscode.Position(line, 0)),
    };
  }

  return undefined;
}

function findFunctionParameterTypeAnnotation(
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): { annotation: string; offset: number } | undefined {
  const functionDef = findEnclosingFunctionDefinition(document, beforeOffset);
  if (!functionDef) {
    return undefined;
  }

  const header = collectFunctionDefinitionHeader(document, functionDef.line);
  if (!header) {
    return undefined;
  }

  const match = header.text.match(
    /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([\s\S]*?)\)\s*(?:->\s*([^:]+))?\s*:$/
  );
  if (!match) {
    return undefined;
  }

  for (const parameter of splitTopLevelExpressions(match[2] ?? '')) {
    const parameterMatch = parameter.match(
      /^\s*\*{0,2}([A-Za-z_][\w]*)\s*:\s*(.+)$/
    );
    if (!parameterMatch || parameterMatch[1] !== variableName) {
      continue;
    }

    const annotation = stripTypeDefaultValue(parameterMatch[2].trim());
    if (!annotation) {
      continue;
    }

    return {
      annotation,
      offset: document.offsetAt(new vscode.Position(functionDef.line, 0)),
    };
  }

  return undefined;
}

async function resolveAnnotatedReceiverForIdentifier(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const typeAnnotation = findTypeAnnotationForIdentifier(
    document,
    variableName,
    beforeOffset
  );
  if (!typeAnnotation) {
    return undefined;
  }

  return resolveDirectReceiverFromTypeAnnotation(
    daemon,
    document,
    typeAnnotation.annotation,
    typeAnnotation.offset
  );
}

async function resolveAnnotatedReceiverForMemberAccess(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  objectExpression: string,
  memberName: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const typeAnnotation = await resolveTypeAnnotationForMemberAccess(
    daemon,
    document,
    objectExpression,
    memberName,
    beforeOffset,
    visited
  );
  if (!typeAnnotation) {
    return undefined;
  }

  return resolveDirectReceiverFromTypeAnnotation(
    daemon,
    typeAnnotation.document,
    typeAnnotation.annotation,
    typeAnnotation.offset
  );
}

async function resolveAnnotatedReceiverForExpression(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedExpression = normalizeReceiverExpression(expression);
  if (!normalizedExpression) {
    return undefined;
  }

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (!memberAccess) {
    return undefined;
  }

  return resolveAnnotatedReceiverForMemberAccess(
    daemon,
    document,
    memberAccess.objectExpression,
    memberAccess.memberName,
    beforeOffset,
    new Set()
  );
}

async function resolveTypeAnnotationForMemberAccess(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  objectExpression: string,
  memberName: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<TypeAnnotationSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const classSource = await resolveClassDefinitionForExpression(
    daemon,
    document,
    objectExpression,
    beforeOffset,
    visited
  );
  if (!classSource) {
    return undefined;
  }

  return resolveClassAttributeTypeAnnotationSource(
    daemon,
    classSource,
    memberName,
    new Set()
  );
}

async function resolveClassAttributeTypeAnnotationSource(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  attributeName: string,
  visitedClasses: Set<string>
): Promise<TypeAnnotationSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const visitKey = `${classSource.document.uri.toString()}:${classSource.classDef.name}:${attributeName}`;
  if (visitedClasses.has(visitKey)) {
    return undefined;
  }
  visitedClasses.add(visitKey);

  const directAnnotation = findClassAttributeTypeAnnotation(
    classSource.document,
    classSource.classDef,
    attributeName
  );
  if (directAnnotation) {
    return {
      document: classSource.document,
      ...directAnnotation,
    };
  }

  for (const baseExpression of classSource.classDef.baseExpressions) {
    const baseClassSource = await resolveClassDefinitionSource(
      daemon,
      classSource.document,
      baseExpression,
      classSource.beforeOffset
    );
    if (!baseClassSource) {
      continue;
    }

    const resolvedAnnotation = await resolveClassAttributeTypeAnnotationSource(
      daemon,
      baseClassSource,
      attributeName,
      visitedClasses
    );
    if (resolvedAnnotation) {
      return resolvedAnnotation;
    }
  }

  return undefined;
}

async function resolveDirectReceiverFromTypeAnnotation(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  annotation: string,
  beforeOffset: number
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  for (const candidate of splitTopLevelTypeAlternatives(annotation)) {
    const resolvedReceiver = await resolveSingleDirectReceiverType(
      daemon,
      document,
      candidate,
      beforeOffset
    );
    if (resolvedReceiver) {
      return resolvedReceiver;
    }
  }

  return undefined;
}

async function resolveSingleDirectReceiverType(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  annotation: string,
  beforeOffset: number
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedAnnotation = normalizeTypeAnnotation(annotation);
  if (!normalizedAnnotation) {
    return undefined;
  }

  const genericType = parseGenericTypeAnnotation(normalizedAnnotation);
  if (genericType) {
    const canonicalBase = await canonicalTypeAnnotationName(
      daemon,
      document,
      genericType.base,
      beforeOffset
    );

    if (OPTIONAL_TYPE_NAMES.has(canonicalBase) && genericType.args[0]) {
      return resolveDirectReceiverFromTypeAnnotation(
        daemon,
        document,
        genericType.args[0],
        beforeOffset
      );
    }

    if (UNION_TYPE_NAMES.has(canonicalBase)) {
      for (const arg of genericType.args) {
        const resolvedReceiver = await resolveDirectReceiverFromTypeAnnotation(
          daemon,
          document,
          arg,
          beforeOffset
        );
        if (resolvedReceiver) {
          return resolvedReceiver;
        }
      }

      return undefined;
    }

    if (QUERYSET_TYPE_NAMES.has(canonicalBase) && genericType.args[0]) {
      const modelLabel = await resolveModelLabelFromTypeAnnotation(
        daemon,
        document,
        genericType.args[0],
        beforeOffset
      );
      if (modelLabel) {
        return {
          kind: 'queryset',
          modelLabel,
        };
      }
    }

    if (MANAGER_TYPE_NAMES.has(canonicalBase) && genericType.args[0]) {
      const modelLabel = await resolveModelLabelFromTypeAnnotation(
        daemon,
        document,
        genericType.args[0],
        beforeOffset
      );
      if (modelLabel) {
        return {
          kind: 'manager',
          modelLabel,
        };
      }
    }

    if (RELATED_MANAGER_TYPE_NAMES.has(canonicalBase) && genericType.args[0]) {
      const modelLabel = await resolveModelLabelFromTypeAnnotation(
        daemon,
        document,
        genericType.args[0],
        beforeOffset
      );
      if (modelLabel) {
        return {
          kind: 'related_manager',
          modelLabel,
        };
      }
    }

    const specialGenericReceiver = await resolveReceiverFromSpecialClassGenericType(
      daemon,
      document,
      genericType.base,
      genericType.args[0],
      beforeOffset
    );
    if (specialGenericReceiver) {
      return specialGenericReceiver;
    }

    return undefined;
  }

  const specialReceiver = await resolveReceiverFromSpecialClassTypeAnnotation(
    daemon,
    document,
    normalizedAnnotation,
    beforeOffset
  );
  if (specialReceiver) {
    return specialReceiver;
  }

  const modelLabel = await resolveModelLabelFromTypeAnnotation(
    daemon,
    document,
    normalizedAnnotation,
    beforeOffset
  );
  if (!modelLabel) {
    return undefined;
  }

  return {
    kind: 'instance',
    modelLabel,
  };
}

async function resolveIterableElementReceiverFromTypeAnnotation(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  annotation: string,
  beforeOffset: number
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  for (const candidate of splitTopLevelTypeAlternatives(annotation)) {
    const resolvedReceiver = await resolveSingleIterableElementType(
      daemon,
      document,
      candidate,
      beforeOffset
    );
    if (resolvedReceiver) {
      return resolvedReceiver;
    }
  }

  return undefined;
}

async function resolveSingleIterableElementType(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  annotation: string,
  beforeOffset: number
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedAnnotation = normalizeTypeAnnotation(annotation);
  if (!normalizedAnnotation) {
    return undefined;
  }

  const genericType = parseGenericTypeAnnotation(normalizedAnnotation);
  if (!genericType) {
    return undefined;
  }

  const canonicalBase = await canonicalTypeAnnotationName(
    daemon,
    document,
    genericType.base,
    beforeOffset
  );

  if (OPTIONAL_TYPE_NAMES.has(canonicalBase) && genericType.args[0]) {
    return resolveIterableElementReceiverFromTypeAnnotation(
      daemon,
      document,
      genericType.args[0],
      beforeOffset
    );
  }

  if (UNION_TYPE_NAMES.has(canonicalBase)) {
    for (const arg of genericType.args) {
      const resolvedReceiver = await resolveIterableElementReceiverFromTypeAnnotation(
        daemon,
        document,
        arg,
        beforeOffset
      );
      if (resolvedReceiver) {
        return resolvedReceiver;
      }
    }

    return undefined;
  }

  if (ITERABLE_TYPE_NAMES.has(canonicalBase) && genericType.args[0]) {
    return resolveDirectReceiverFromTypeAnnotation(
      daemon,
      document,
      genericType.args[0],
      beforeOffset
    );
  }

  if (
    (QUERYSET_TYPE_NAMES.has(canonicalBase) ||
      RELATED_MANAGER_TYPE_NAMES.has(canonicalBase)) &&
    genericType.args[0]
  ) {
    const modelLabel = await resolveModelLabelFromTypeAnnotation(
      daemon,
      document,
      genericType.args[0],
      beforeOffset
    );
    if (modelLabel) {
      return {
        kind: 'instance',
        modelLabel,
      };
    }
  }

  const specialGenericReceiver = await resolveReceiverFromSpecialClassGenericType(
    daemon,
    document,
    genericType.base,
    genericType.args[0],
    beforeOffset
  );
  if (
    specialGenericReceiver &&
    (specialGenericReceiver.kind === 'queryset' ||
      specialGenericReceiver.kind === 'related_manager')
  ) {
    return {
      kind: 'instance',
      modelLabel: specialGenericReceiver.modelLabel,
    };
  }

  return undefined;
}

async function resolveModelLabelFromTypeAnnotation(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  annotation: string,
  beforeOffset: number
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedAnnotation = normalizeTypeAnnotation(annotation);
  if (!normalizedAnnotation) {
    return undefined;
  }

  const genericType = parseGenericTypeAnnotation(normalizedAnnotation);
  if (genericType) {
    const canonicalBase = await canonicalTypeAnnotationName(
      daemon,
      document,
      genericType.base,
      beforeOffset
    );

    if (OPTIONAL_TYPE_NAMES.has(canonicalBase) || UNION_TYPE_NAMES.has(canonicalBase)) {
      for (const arg of genericType.args) {
        const resolvedLabel = await resolveModelLabelFromTypeAnnotation(
          daemon,
          document,
          arg,
          beforeOffset
        );
        if (resolvedLabel) {
          return resolvedLabel;
        }
      }
      return undefined;
    }

    const specialGenericLabel = await resolveModelLabelFromSpecialClassGenericType(
      daemon,
      document,
      genericType.base,
      genericType.args[0],
      beforeOffset
    );
    if (specialGenericLabel) {
      return specialGenericLabel;
    }
  }

  const specialClassLabel = await resolveModelLabelFromSpecialClassTypeAnnotation(
    daemon,
    document,
    normalizedAnnotation,
    beforeOffset
  );
  if (specialClassLabel) {
    return specialClassLabel;
  }

  const typeVarBound = await resolveTypeVarBoundAnnotation(
    daemon,
    document,
    normalizedAnnotation,
    beforeOffset,
    new Set()
  );
  if (typeVarBound) {
    return resolveModelLabelFromTypeAnnotation(
      daemon,
      typeVarBound.document,
      typeVarBound.annotation,
      typeVarBound.offset
    );
  }

  for (const candidate of splitTopLevelTypeAlternatives(normalizedAnnotation)) {
    const strippedCandidate = stripStringLiteralQuotes(candidate);
    if (!strippedCandidate) {
      continue;
    }

    const simpleName = strippedCandidate.includes('.')
      ? strippedCandidate.split('.').at(-1)!
      : strippedCandidate;
    const localLabel = daemon.modelLabelByName.get(simpleName);
    if (localLabel) {
      return localLabel;
    }

    const resolvedLabel = await resolveModelLabelFromSymbol(
      daemon,
      document,
      strippedCandidate,
      beforeOffset
    );
    if (resolvedLabel) {
      return resolvedLabel;
    }
  }

  return undefined;
}

async function resolveReceiverFromSpecialClassTypeAnnotation(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  annotation: string,
  beforeOffset: number
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const classSource = await resolveClassDefinitionFromTypeAnnotation(
    daemon,
    document,
    annotation,
    beforeOffset
  );
  if (!classSource) {
    return undefined;
  }

  const specialKind = await resolveSpecialClassKind(daemon, classSource, new Set());
  if (
    specialKind !== 'manager' &&
    specialKind !== 'queryset' &&
    specialKind !== 'related_manager'
  ) {
    return undefined;
  }

  const modelLabel = await resolveModelLabelFromSpecialClassSource(
    daemon,
    classSource,
    specialKind
  );
  if (!modelLabel) {
    return undefined;
  }

  return {
    kind: specialKind,
    modelLabel,
    classSource,
    specialKind,
  };
}

async function resolveReceiverFromSpecialClassGenericType(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  baseAnnotation: string,
  modelAnnotation: string | undefined,
  beforeOffset: number
): Promise<OrmReceiverInfo | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const classSource = await resolveClassDefinitionFromTypeAnnotation(
    daemon,
    document,
    baseAnnotation,
    beforeOffset
  );
  if (!classSource) {
    return undefined;
  }

  const specialKind = await resolveSpecialClassKind(daemon, classSource, new Set());
  if (
    specialKind !== 'manager' &&
    specialKind !== 'queryset' &&
    specialKind !== 'related_manager'
  ) {
    return undefined;
  }

  const modelLabel =
    (modelAnnotation ?
      await resolveModelLabelFromTypeAnnotation(
        daemon,
        document,
        modelAnnotation,
        beforeOffset
      )
    : undefined) ??
    (await resolveModelLabelFromSpecialClassSource(
      daemon,
      classSource,
      specialKind
    ));
  if (!modelLabel) {
    return undefined;
  }

  return {
    kind: specialKind,
    modelLabel,
    classSource,
    specialKind,
  };
}

async function resolveModelLabelFromSpecialClassTypeAnnotation(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  annotation: string,
  beforeOffset: number
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const classSource = await resolveClassDefinitionFromTypeAnnotation(
    daemon,
    document,
    annotation,
    beforeOffset
  );
  if (!classSource) {
    return undefined;
  }

  const specialKind = await resolveSpecialClassKind(daemon, classSource, new Set());
  if (
    specialKind !== 'manager' &&
    specialKind !== 'queryset' &&
    specialKind !== 'related_manager'
  ) {
    return undefined;
  }

  return resolveModelLabelFromSpecialClassSource(daemon, classSource, specialKind);
}

async function resolveModelLabelFromSpecialClassGenericType(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  baseAnnotation: string,
  modelAnnotation: string | undefined,
  beforeOffset: number
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const specialReceiver = await resolveReceiverFromSpecialClassGenericType(
    daemon,
    document,
    baseAnnotation,
    modelAnnotation,
    beforeOffset
  );
  return specialReceiver?.modelLabel;
}

async function resolveModelLabelFromSpecialClassSource(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  specialKind: SpecialClassKind
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const preferredCandidateLabel = await resolvePreferredSpecialClassCandidateModelLabel(
    daemon,
    classSource,
    specialKind
  );
  const directBaseLabel = await resolveDirectModelLabelFromSpecialClassBaseExpressions(
    daemon,
    classSource,
    specialKind,
  );
  if (
    preferredCandidateLabel &&
    directBaseLabel &&
    preferredCandidateLabel !== directBaseLabel
  ) {
    return preferredCandidateLabel;
  }
  if (directBaseLabel) {
    return directBaseLabel;
  }

  if (preferredCandidateLabel) {
    return preferredCandidateLabel;
  }

  const candidateModelNames = specialClassModelNameCandidates(classSource, specialKind);
  if (candidateModelNames.length === 0) {
    return resolveInheritedModelLabelFromSpecialClassBaseExpressions(
      daemon,
      classSource,
      specialKind,
      new Set()
    );
  }

  const relationTargets = await listAllRelationTargets(daemon);
  const currentModule = moduleNameForDocument(classSource.document);
  const currentModuleRoot = currentModule?.split('.', 1)[0];

  for (const candidateName of candidateModelNames) {
    const exactMatches = relationTargets.items.filter(
      (item) => item.objectName === candidateName
    );
    if (exactMatches.length === 0) {
      continue;
    }

    const sameModuleRootMatches =
      currentModuleRoot ?
        exactMatches.filter(
          (item) =>
            item.appLabel === currentModuleRoot ||
            item.module === currentModuleRoot ||
            item.module.startsWith(`${currentModuleRoot}.`)
        )
      : [];
    if (sameModuleRootMatches.length === 1) {
      return sameModuleRootMatches[0].label;
    }

    if (exactMatches.length === 1) {
      return exactMatches[0].label;
    }
  }

  return resolveInheritedModelLabelFromSpecialClassBaseExpressions(
    daemon,
    classSource,
    specialKind,
    new Set()
  );
}

async function resolvePreferredSpecialClassCandidateModelLabel(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  specialKind: SpecialClassKind
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const candidateModelNames = specialClassModelNameCandidates(
    classSource,
    specialKind
  );
  if (candidateModelNames.length === 0) {
    return undefined;
  }

  const relationTargets = await listAllRelationTargets(daemon);
  const currentModule = moduleNameForDocument(classSource.document);
  const currentModuleRoot = currentModule?.split('.', 1)[0];

  for (const candidateName of candidateModelNames) {
    const exactMatches = relationTargets.items.filter(
      (item) => item.objectName === candidateName
    );
    if (exactMatches.length === 0) {
      continue;
    }

    const sameModuleRootMatches =
      currentModuleRoot ?
        exactMatches.filter(
          (item) =>
            item.appLabel === currentModuleRoot ||
            item.module === currentModuleRoot ||
            item.module.startsWith(`${currentModuleRoot}.`)
        )
      : [];
    if (sameModuleRootMatches.length === 1) {
      return sameModuleRootMatches[0].label;
    }

    if (exactMatches.length === 1) {
      return exactMatches[0].label;
    }
  }

  return undefined;
}

async function resolveDirectModelLabelFromSpecialClassBaseExpressions(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  specialKind: SpecialClassKind
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  for (const baseExpression of classSource.classDef.baseExpressions) {
    const genericBaseLabel =
      await resolveModelLabelFromSpecialClassGenericBaseExpression(
        daemon,
        classSource,
        baseExpression,
        specialKind
      );
    if (genericBaseLabel) {
      return genericBaseLabel;
    }

    const fromQuerysetLabel = await resolveModelLabelFromFromQuerysetArgument(
      daemon,
      classSource,
      baseExpression,
      new Set()
    );
    if (fromQuerysetLabel) {
      return fromQuerysetLabel;
    }
  }

  return undefined;
}

async function resolveInheritedModelLabelFromSpecialClassBaseExpressions(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  specialKind: SpecialClassKind,
  visited: Set<string>
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const visitKey = `${classSource.document.uri.toString()}:${classSource.classDef.name}:${specialKind}`;
  if (visited.has(visitKey)) {
    return undefined;
  }
  visited.add(visitKey);

  for (const baseExpression of classSource.classDef.baseExpressions) {
    const baseReference = baseClassReferenceExpression(baseExpression);
    if (!baseReference) {
      continue;
    }

    const baseClassSource = await resolveClassDefinitionSource(
      daemon,
      classSource.document,
      baseReference,
      classSource.beforeOffset
    );
    if (!baseClassSource) {
      continue;
    }

    const inheritedLabel = await resolveModelLabelFromSpecialClassSource(
      daemon,
      baseClassSource,
      specialKind
    );
    if (inheritedLabel) {
      return inheritedLabel;
    }
  }

  return undefined;
}

async function resolveModelLabelFromSpecialClassGenericBaseExpression(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  baseExpression: string,
  specialKind: SpecialClassKind
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedExpression = stripWrappingParentheses(baseExpression.trim());
  if (!normalizedExpression) {
    return undefined;
  }

  const genericBase = parseGenericTypeAnnotation(normalizedExpression);
  if (!genericBase || !genericBase.args[0]) {
    return undefined;
  }

  const canonicalBase = await canonicalTypeAnnotationName(
    daemon,
    classSource.document,
    genericBase.base,
    classSource.beforeOffset
  );
  if (specialClassKindFromCanonicalName(canonicalBase) !== specialKind) {
    return undefined;
  }

  return resolveModelLabelFromTypeAnnotation(
    daemon,
    classSource.document,
    genericBase.args[0],
    classSource.beforeOffset
  );
}

async function resolveModelLabelFromFromQuerysetArgument(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  baseExpression: string,
  visited: Set<string>
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const details = parseCallExpressionDetails(baseExpression);
  if (
    !details ||
    details.parsedCall.kind !== 'member' ||
    details.parsedCall.memberName !== 'from_queryset'
  ) {
    return undefined;
  }

  const firstArgument = splitTopLevelExpressions(details.argsText)[0];
  if (!firstArgument) {
    return undefined;
  }

  const querysetClassSource = await resolveClassDefinitionSource(
    daemon,
    classSource.document,
    firstArgument,
    classSource.beforeOffset
  );
  if (!querysetClassSource) {
    return undefined;
  }

  const resolvedLabel = await resolveModelLabelFromSpecialClassSource(
    daemon,
    querysetClassSource,
    'queryset'
  );
  if (resolvedLabel) {
    return resolvedLabel;
  }

  return resolveInheritedModelLabelFromSpecialClassBaseExpressions(
    daemon,
    querysetClassSource,
    'queryset',
    visited
  );
}

function specialClassModelNameCandidates(
  classSource: ClassDefinitionSource,
  specialKind: SpecialClassKind
): string[] {
  const candidates: string[] = [];
  const pushCandidate = (value: string | undefined): void => {
    const candidate = specialClassModelNameCandidate(value, specialKind);
    if (!candidate || candidates.includes(candidate)) {
      return;
    }
    candidates.push(candidate);
  };

  pushCandidate(classSource.classDef.name);

  for (const baseExpression of classSource.classDef.baseExpressions) {
    const details = parseCallExpressionDetails(baseExpression);
    if (
      !details ||
      details.parsedCall.kind !== 'member' ||
      details.parsedCall.memberName !== 'from_queryset'
    ) {
      continue;
    }

    const firstArgument = splitTopLevelExpressions(details.argsText)[0];
    pushCandidate(firstArgument);
  }

  return candidates;
}

function specialClassModelNameCandidate(
  value: string | undefined,
  specialKind: SpecialClassKind
): string | undefined {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return undefined;
  }

  const name = normalizedValue.split('.').at(-1);
  if (!name) {
    return undefined;
  }

  if (specialKind === 'manager' && name.endsWith('Manager')) {
    return name.slice(0, -'Manager'.length) || undefined;
  }

  if (
    (specialKind === 'queryset' || specialKind === 'related_manager') &&
    name.endsWith('QuerySet')
  ) {
    return name.slice(0, -'QuerySet'.length) || undefined;
  }

  return undefined;
}

async function resolveClassDefinitionFromTypeAnnotation(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  annotation: string,
  beforeOffset: number
): Promise<ClassDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const normalizedAnnotation = normalizeTypeAnnotation(annotation);
  if (!normalizedAnnotation) {
    return undefined;
  }

  const genericType = parseGenericTypeAnnotation(normalizedAnnotation);
  if (genericType) {
    const canonicalBase = await canonicalTypeAnnotationName(
      daemon,
      document,
      genericType.base,
      beforeOffset
    );

    if (OPTIONAL_TYPE_NAMES.has(canonicalBase) || UNION_TYPE_NAMES.has(canonicalBase)) {
      for (const arg of genericType.args) {
        const resolvedClassSource = await resolveClassDefinitionFromTypeAnnotation(
          daemon,
          document,
          arg,
          beforeOffset
        );
        if (resolvedClassSource) {
          return resolvedClassSource;
        }
      }

      return undefined;
    }

    const genericBaseClassSource = await resolveClassDefinitionSource(
      daemon,
      document,
      genericType.base,
      beforeOffset
    );
    if (genericBaseClassSource) {
      return genericBaseClassSource;
    }
  }

  const typeVarBound = await resolveTypeVarBoundAnnotation(
    daemon,
    document,
    normalizedAnnotation,
    beforeOffset,
    new Set()
  );
  if (typeVarBound) {
    return resolveClassDefinitionFromTypeAnnotation(
      daemon,
      typeVarBound.document,
      typeVarBound.annotation,
      typeVarBound.offset
    );
  }

  for (const candidate of splitTopLevelTypeAlternatives(normalizedAnnotation)) {
    const strippedCandidate = stripStringLiteralQuotes(candidate);
    if (!strippedCandidate) {
      continue;
    }

    const classSource = await resolveClassDefinitionSource(
      daemon,
      document,
      strippedCandidate,
      beforeOffset
    );
    if (classSource) {
      return classSource;
    }

    const siblingClassSource = await resolveSpecialSiblingClassDefinitionSource(
      daemon,
      strippedCandidate
    );
    if (siblingClassSource) {
      return siblingClassSource;
    }
  }

  return undefined;
}

async function resolveSpecialSiblingClassDefinitionSource(
  daemon: AnalysisDaemon,
  className: string
): Promise<ClassDefinitionSource | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const candidateName = className.trim().split('.').at(-1);
  if (!candidateName) {
    return undefined;
  }

  const modelName =
    specialClassModelNameCandidate(candidateName, 'manager') ??
    specialClassModelNameCandidate(candidateName, 'queryset') ??
    specialClassModelNameCandidate(candidateName, 'related_manager');
  if (!modelName) {
    return undefined;
  }

  const relationTargets = await listAllRelationTargets(daemon);
  for (const target of relationTargets.items) {
    if (target.objectName !== modelName || !target.filePath) {
      continue;
    }

    const document = await vscode.workspace.openTextDocument(target.filePath);
    const classDef = findClassDefinition(document, candidateName);
    if (!classDef) {
      continue;
    }

    return {
      document,
      classDef,
      beforeOffset: document.offsetAt(new vscode.Position(classDef.line, 0)),
    };
  }

  return undefined;
}

async function canonicalTypeAnnotationName(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  typeName: string,
  beforeOffset: number
): Promise<string> {
  const normalizedTypeName = normalizeTypeAnnotation(typeName);
  if (!normalizedTypeName) {
    return typeName;
  }

  const bindings = collectImportBindings(document, beforeOffset);
  const directBinding = bindings.symbols.get(normalizedTypeName);
  if (directBinding) {
    return `${directBinding.moduleName}.${directBinding.symbolName}`;
  }

  const parts = normalizedTypeName.split('.');
  if (parts.length === 2) {
    const moduleName = await resolveImportedModuleAlias(
      daemon,
      bindings,
      parts[0]
    );
    if (moduleName) {
      return `${moduleName}.${parts[1]}`;
    }
  }

  return normalizedTypeName;
}

function parseForLoopHeader(
  lineText: string
): { indent: number; target: string; iterable: string } | undefined {
  const match = lineText.match(/^(\s*)(?:async\s+)?for\s+(.+)$/);
  if (!match) {
    return undefined;
  }

  const body = stripTrailingComment(match[2]).trimEnd();
  if (!body.endsWith(':')) {
    return undefined;
  }

  const loopBody = body.slice(0, -1).trimEnd();
  const inIndex = findTopLevelKeyword(loopBody, ' in ');
  if (inIndex === undefined) {
    return undefined;
  }

  const target = loopBody.slice(0, inIndex).trim();
  const iterable = loopBody.slice(inIndex + ' in '.length).trim();
  if (!target || !iterable) {
    return undefined;
  }

  return {
    indent: match[1].length,
    target,
    iterable,
  };
}

function parseComprehensionClauses(
  value: string
): Array<{
  clauseStart: number;
  target: string;
  iterable: string;
  iterableStart: number;
}> {
  const clauses: Array<{
    clauseStart: number;
    target: string;
    iterable: string;
    iterableStart: number;
  }> = [];
  let searchStart = 0;

  while (searchStart < value.length) {
    const forIndex = findTopLevelKeywordFrom(value, ' for ', searchStart);
    if (forIndex === undefined) {
      break;
    }

    const targetStart = forIndex + ' for '.length;
    const inIndex = findTopLevelKeywordFrom(value, ' in ', targetStart);
    if (inIndex === undefined) {
      break;
    }

    const nextIfIndex = findTopLevelKeywordFrom(
      value,
      ' if ',
      inIndex + ' in '.length
    );
    const nextForIndex = findTopLevelKeywordFrom(
      value,
      ' for ',
      inIndex + ' in '.length
    );
    const clauseEnd = [nextIfIndex, nextForIndex]
      .filter((index): index is number => index !== undefined)
      .reduce((smallest, index) => Math.min(smallest, index), value.length);
    const target = value.slice(targetStart, inIndex).trim();
    const iterableStart = inIndex + ' in '.length;
    const iterable = value.slice(iterableStart, clauseEnd).trim();

    if (target && iterable) {
      clauses.push({
        clauseStart: forIndex,
        target,
        iterable,
        iterableStart,
      });
    }

    searchStart = clauseEnd;
  }

  return clauses;
}

function loopTargetContainsIdentifier(
  targetExpression: string,
  identifier: string
): boolean {
  const identifiers: string[] = targetExpression.match(/[A-Za-z_][\w]*/g) ?? [];
  return identifiers.includes(identifier);
}

function parseGenericTypeAnnotation(
  annotation: string
): { base: string; args: string[] } | undefined {
  if (!annotation.endsWith(']')) {
    return undefined;
  }

  const openBracketIndex = findMatchingOpeningDelimiter(
    annotation,
    annotation.length - 1,
    '[',
    ']'
  );
  if (openBracketIndex === undefined || openBracketIndex === 0) {
    return undefined;
  }

  const base = annotation.slice(0, openBracketIndex).trim();
  const argsText = annotation.slice(openBracketIndex + 1, -1).trim();
  if (!base || !argsText) {
    return undefined;
  }

  return {
    base,
    args: splitTopLevelExpressions(argsText),
  };
}

function splitTopLevelTypeAlternatives(annotation: string): string[] {
  const candidates = splitTopLevelByDelimiter(annotation, '|');
  return candidates.length > 0 ? candidates : [annotation];
}

function splitTopLevelByDelimiter(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === delimiter && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      current = '';
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if ((char === ')' || char === ']' || char === '}') && depth > 0) {
      depth -= 1;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) {
    parts.push(trailing);
  }

  return parts;
}

function stripTypeDefaultValue(value: string): string {
  const assignmentIndex = findTopLevelCharacter(value, '=');
  return (assignmentIndex === undefined ? value : value.slice(0, assignmentIndex)).trim();
}

function normalizeTypeAnnotation(annotation: string): string {
  return stripWrappingParentheses(stripStringLiteralQuotes(annotation.trim()));
}

function stripStringLiteralQuotes(value: string): string {
  const match = value.match(/^(['"])(.+)\1$/);
  return match ? match[2].trim() : value;
}

function findTopLevelKeyword(value: string, keyword: string): number | undefined {
  return findTopLevelKeywordFrom(value, keyword, 0);
}

function findTopLevelKeywordFrom(
  value: string,
  keyword: string,
  startIndex: number
): number | undefined {
  let depth = 0;
  let activeQuote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index <= value.length - keyword.length; index += 1) {
    const char = value[index];
    if (activeQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      activeQuote = char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if ((char === ')' || char === ']' || char === '}') && depth > 0) {
      depth -= 1;
      continue;
    }

    if (
      index >= startIndex &&
      depth === 0 &&
      value.slice(index, index + keyword.length) === keyword
    ) {
      return index;
    }
  }

  return undefined;
}

function findTopLevelCharacter(value: string, targetCharacter: string): number | undefined {
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if ((char === ')' || char === ']' || char === '}') && depth > 0) {
      depth -= 1;
      continue;
    }

    if (depth === 0 && char === targetCharacter) {
      return index;
    }
  }

  return undefined;
}

function stripTrailingComment(text: string): string {
  const commentIndex = text.indexOf('#');
  if (commentIndex < 0) {
    return text;
  }

  return text.slice(0, commentIndex);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

async function resolveImportedModuleAlias(
  daemon: AnalysisDaemon,
  bindings: ImportBindings,
  alias: string
): Promise<string | undefined> {
  if (daemon.isAborted()) { return undefined; }
  const directModule = bindings.modules.get(alias);
  if (directModule) {
    return directModule;
  }

  const directSymbol = bindings.symbols.get(alias);
  if (!directSymbol) {
    return undefined;
  }

  const importedModuleName = `${directSymbol.moduleName}.${directSymbol.symbolName}`;
  const moduleResolution = await daemon.resolveModule(importedModuleName);
  return moduleResolution.resolved ? importedModuleName : undefined;
}

function collectParsedImportStatements(
  document: vscode.TextDocument
): ParsedImportStatement[] {
  const cached = parsedImportStatementCache.get(document);
  if (cached && cached.version === document.version) {
    return cached.statements;
  }

  const statements = buildParsedImportStatements(document);
  parsedImportStatementCache.set(document, {
    version: document.version,
    statements,
  });
  return statements;
}

function buildParsedImportStatements(
  document: vscode.TextDocument
): ParsedImportStatement[] {
  const statements: ParsedImportStatement[] = [];

  for (const rawStatement of collectRawImportStatements(document)) {
    const parsedStatement = parseImportStatement(document, rawStatement);
    if (parsedStatement) {
      statements.push(parsedStatement);
    }
  }

  return statements;
}

function collectRawImportStatements(
  document: vscode.TextDocument
): RawImportStatement[] {
  const statements: RawImportStatement[] = [];

  for (let line = 0; line < document.lineCount; line += 1) {
    const lineText = document.lineAt(line).text;
    const trimmed = lineText.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (!trimmed.startsWith('from ') && !trimmed.startsWith('import ')) {
      continue;
    }

    let endLine = line;
    let delimiterDepth = 0;
    while (true) {
      const statementLine = stripTrailingComment(document.lineAt(endLine).text);
      delimiterDepth = Math.max(
        0,
        delimiterDepth + importStatementDelimiterDelta(statementLine)
      );
      const continues =
        delimiterDepth > 0 || statementLine.trimEnd().endsWith('\\');
      if (!continues || endLine >= document.lineCount - 1) {
        break;
      }

      endLine += 1;
    }

    const start = new vscode.Position(line, 0);
    const end = document.lineAt(endLine).range.end;
    statements.push({
      startOffset: document.offsetAt(start),
      endOffset: document.offsetAt(end),
      text: document.getText(new vscode.Range(start, end)),
    });
    line = endLine;
  }

  return statements;
}

function importStatementDelimiterDelta(text: string): number {
  let delta = 0;

  for (const char of text) {
    if (char === '(' || char === '[' || char === '{') {
      delta += 1;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      delta -= 1;
    }
  }

  return delta;
}

function parseImportStatement(
  document: vscode.TextDocument,
  statement: RawImportStatement
): ParsedImportStatement | undefined {
  const fromMatch = statement.text.match(/^\s*from\s+([.A-Za-z_][\w.]*)\s+import\b/);
  if (fromMatch) {
    const rawModuleName = fromMatch[1];
    const moduleName = resolveImportedModuleName(document, rawModuleName);
    const clauseStartOffset = statement.startOffset + fromMatch[0].length;
    const clauseText = statement.text.slice(fromMatch[0].length);

    return {
      kind: 'from',
      startOffset: statement.startOffset,
      endOffset: statement.endOffset,
      rawModuleName,
      moduleName,
      symbolSpecs: parseImportSymbolSpecs(clauseText, clauseStartOffset),
    };
  }

  const importMatch = statement.text.match(/^\s*import\b/);
  if (!importMatch) {
    return undefined;
  }

  const clauseStartOffset = statement.startOffset + importMatch[0].length;
  const clauseText = statement.text.slice(importMatch[0].length);

  return {
    kind: 'import',
    startOffset: statement.startOffset,
    endOffset: statement.endOffset,
    moduleSpecs: parseImportModuleSpecs(clauseText, clauseStartOffset),
  };
}

function parseImportSymbolSpecs(
  clauseText: string,
  clauseStartOffset: number
): ParsedImportSymbolSpec[] {
  const specs: ParsedImportSymbolSpec[] = [];

  for (const match of clauseText.matchAll(IMPORT_SPEC_PATTERN)) {
    const importedName = match[1];
    const aliasName = match[2];
    const relativeStart = match.index ?? 0;
    const importedStartOffset = clauseStartOffset + relativeStart;
    const spec: ParsedImportSymbolSpec = {
      importedName,
      aliasName,
      importedStartOffset,
      importedEndOffset: importedStartOffset + importedName.length,
    };

    if (aliasName) {
      const aliasOffset = match[0].lastIndexOf(aliasName);
      spec.aliasStartOffset = clauseStartOffset + relativeStart + aliasOffset;
      spec.aliasEndOffset = spec.aliasStartOffset + aliasName.length;
    }

    specs.push(spec);
  }

  return specs;
}

function parseImportModuleSpecs(
  clauseText: string,
  clauseStartOffset: number
): ParsedImportModuleSpec[] {
  const specs: ParsedImportModuleSpec[] = [];

  for (const match of clauseText.matchAll(IMPORT_MODULE_SPEC_PATTERN)) {
    const importedModule = match[1];
    const aliasName = match[2];
    const relativeStart = match.index ?? 0;
    const importedStartOffset = clauseStartOffset + relativeStart;
    const spec: ParsedImportModuleSpec = {
      importedModule,
      aliasName,
      importedStartOffset,
      importedEndOffset: importedStartOffset + importedModule.length,
    };

    if (aliasName) {
      const aliasOffset = match[0].lastIndexOf(aliasName);
      spec.aliasStartOffset = clauseStartOffset + relativeStart + aliasOffset;
      spec.aliasEndOffset = spec.aliasStartOffset + aliasName.length;
    }

    specs.push(spec);
  }

  return specs;
}

function collectImportBindings(
  document: vscode.TextDocument,
  beforeOffset: number
): ImportBindings {
  const symbols = new Map<string, { moduleName: string; symbolName: string }>();
  const modules = new Map<string, string>();
  const importStatements = collectParsedImportStatements(document);

  for (const statement of importStatements) {
    if (statement.endOffset > beforeOffset) {
      continue;
    }

    if (statement.kind === 'from') {
      if (!statement.moduleName) {
        continue;
      }

      for (const spec of statement.symbolSpecs) {
        const aliasName = spec.aliasName ?? spec.importedName;
        symbols.set(aliasName, {
          moduleName: statement.moduleName,
          symbolName: spec.importedName,
        });
      }
      continue;
    }

    for (const spec of statement.moduleSpecs) {
      const aliasName =
        spec.aliasName ?? spec.importedModule.split('.').at(-1);
      if (!aliasName) {
        continue;
      }
      modules.set(aliasName, spec.importedModule);
    }
  }

  return { symbols, modules };
}

function resolveImportedModuleName(
  document: vscode.TextDocument,
  moduleName: string
): string | undefined {
  if (!moduleName.startsWith('.')) {
    return moduleName;
  }

  const currentModuleName = moduleNameForDocument(document);
  if (!currentModuleName) {
    return undefined;
  }

  return resolveRelativeModuleName(
    currentModuleName,
    moduleName,
    path.basename(document.uri.fsPath) === '__init__.py'
  );
}

function moduleNameForDocument(
  document: vscode.TextDocument
): string | undefined {
  const configuredRoot = getExtensionSettings(document.uri).workspaceRoot;
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const roots = [configuredRoot, workspaceRoot].filter(
    (value): value is string => Boolean(value)
  );

  for (const rootPath of roots) {
    const resolvedModuleName = moduleNameFromFilePath(rootPath, document.uri.fsPath);
    if (resolvedModuleName !== undefined) {
      return resolvedModuleName;
    }
  }

  return undefined;
}

function moduleNameFromFilePath(
  rootPath: string,
  filePath: string
): string | undefined {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(filePath));
  if (
    !relativePath ||
    relativePath.startsWith(`..${path.sep}`) ||
    relativePath === '..' ||
    path.isAbsolute(relativePath) ||
    !relativePath.endsWith('.py')
  ) {
    return undefined;
  }

  const normalizedPath = relativePath.split(path.sep).join('/');
  if (normalizedPath === '__init__.py') {
    return undefined;
  }

  if (normalizedPath.endsWith('/__init__.py')) {
    return normalizedPath.slice(0, -'/__init__.py'.length).split('/').join('.');
  }

  return normalizedPath.slice(0, -'.py'.length).split('/').join('.');
}

function resolveRelativeModuleName(
  currentModule: string,
  importedModule: string,
  isPackageInit: boolean
): string | undefined {
  const level = importedModule.match(/^\.+/)?.[0].length ?? 0;
  if (level === 0) {
    return importedModule;
  }

  let packageParts = currentModule.split('.');
  if (!isPackageInit) {
    packageParts = packageParts.slice(0, -1);
  }

  if (level > 1) {
    if (level - 1 > packageParts.length) {
      return undefined;
    }
    packageParts = packageParts.slice(0, packageParts.length - (level - 1));
  }

  const suffix = importedModule.slice(level);
  const suffixParts = suffix ? suffix.split('.') : [];
  const resolvedParts = [...packageParts, ...suffixParts].filter(Boolean);
  return resolvedParts.length > 0 ? resolvedParts.join('.') : undefined;
}

function stripPythonLineComments(text: string): string {
  // Blank `#...` comments to end-of-line (quote-aware: a `#` inside a string
  // literal is kept), preserving newlines/length. Without this, collapsing a
  // multi-line receiver expression that follows a comment line joins the comment
  // to the code (`# note\nQs.objects` -> `#noteQs.objects`), and the leading `#`
  // then comments out the whole receiver.
  const out = text.split('');
  const n = out.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const triple = text[i + 1] === c && text[i + 2] === c;
      i += triple ? 3 : 1;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (triple) {
          if (text[i] === c && text[i + 1] === c && text[i + 2] === c) { i += 3; break; }
        } else {
          if (text[i] === c) { i += 1; break; }
          if (text[i] === '\n') { i += 1; break; }
        }
        i += 1;
      }
      continue;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function compactPythonExpression(value: string): string {
  // Strip line comments first (so a receiver following a comment line is not
  // commented out when newlines are collapsed below), then collapse all
  // whitespace, preserving a single space between two word characters —
  // otherwise expressions like `not Foo.objects.filter(...)` collapse into
  // `notFoo.objects.filter(...)`, making the keyword look like the receiver.
  return stripPythonLineComments(value).replace(/\s+/g, (match, offset: number, str: string) => {
    const before = str[offset - 1] ?? '';
    const after = str[offset + match.length] ?? '';
    return /\w/.test(before) && /\w/.test(after) ? ' ' : '';
  });
}

function trimLeadingUnmatchedOpeningDelimiters(value: string): string {
  let current = value;

  while (current.length > 0) {
    const firstChar = current[0];
    const closingDelimiter =
      firstChar === '(' ? ')'
      : firstChar === '[' ? ']'
      : firstChar === '{' ? '}'
      : undefined;
    if (!closingDelimiter) {
      return current;
    }

    if (
      findMatchingClosingDelimiter(current, 0, firstChar, closingDelimiter) !==
      undefined
    ) {
      return current;
    }

    current = current.slice(1);
  }

  return current;
}

function lookupReplacementLength(value: string): number {
  const segmentStartOffset = value.lastIndexOf('__');
  if (segmentStartOffset >= 0) {
    return value.length - (segmentStartOffset + 2);
  }

  if (value.startsWith('-')) {
    return value.length - 1;
  }

  return value.length;
}

function lookupFilterText(
  prefix: string,
  item: LookupPathItem
): string | undefined {
  const normalizedPrefix = prefix.startsWith('-') ? prefix.slice(1) : prefix;
  const prefixSegments = normalizedPrefix.split('__');

  if (prefixSegments.length > 1) {
    const leadingSegments = prefixSegments.slice(0, -1).filter(Boolean);
    const baseFilterText = [...leadingSegments, item.name]
      .filter(Boolean)
      .join('__');
    return prefix.startsWith('-') ? `-${baseFilterText}` : baseFilterText;
  }

  if (
    (item.fieldKind === 'lookup_operator' || item.fieldKind === 'lookup_transform') &&
    item.name.includes('__')
  ) {
    return item.name.split('__', 1)[0];
  }

  return item.name;
}

function scanKeywordTokenStart(textBefore: string): number {
  let index = textBefore.length;
  while (index > 0 && /[A-Za-z0-9_]/.test(textBefore[index - 1])) {
    index -= 1;
  }
  return index;
}

function isDynamicLookupDictKey(value: string): boolean {
  return value.includes('{') || value.includes('}');
}

function isLookupKeywordCandidate(value: string): boolean {
  return (
    value.length === 0 ||
    /^[A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*(?:__)?$/.test(value)
  );
}

function isDirectFieldKeywordCandidate(value: string): boolean {
  return value.length === 0 || /^[A-Za-z_][\w]*$/.test(value);
}

function querysetKeywordCallContext(
  text: string,
  tokenStartOffset: number,
  tokenEndOffset: number
):
  | {
      receiverExpression: string;
      method: string;
      argumentStartOffset: number;
      argumentEndOffset: number;
    }
  | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, tokenStartOffset);
  if (openParenOffset === undefined) {
    return undefined;
  }

  const argumentStartOffset = findCurrentArgumentStartOffset(
    text,
    openParenOffset,
    tokenStartOffset
  );
  const argumentEndOffset = findCurrentArgumentEndOffset(text, tokenEndOffset);

  const directCalleeMatch = parseQuerysetCallee(
    text,
    openParenOffset,
    KEYWORD_LOOKUP_METHODS
  );
  const calleeMatch = directCalleeMatch ?? resolveKeywordEnclosingQuerysetCallContext(
    text,
    openParenOffset
  );
  if (!calleeMatch) {
    return undefined;
  }

  const { receiverExpression, method } = calleeMatch;
  const argumentPrefix = text.slice(argumentStartOffset, tokenStartOffset);
  if (hasTopLevelEquals(argumentPrefix)) {
    return undefined;
  }

  return {
    receiverExpression,
    method,
    argumentStartOffset,
    argumentEndOffset,
  };
}

function qExpressionKeywordCallContext(
  text: string,
  tokenStartOffset: number,
  tokenEndOffset: number
):
  | {
      argumentStartOffset: number;
      argumentEndOffset: number;
    }
  | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, tokenStartOffset);
  if (openParenOffset === undefined || !isQExpressionCall(text, openParenOffset)) {
    return undefined;
  }

  const argumentStartOffset = findCurrentArgumentStartOffset(
    text,
    openParenOffset,
    tokenStartOffset
  );
  const argumentEndOffset = findCurrentArgumentEndOffset(text, tokenEndOffset);
  const argumentPrefix = text.slice(argumentStartOffset, tokenStartOffset);
  if (hasTopLevelEquals(argumentPrefix)) {
    return undefined;
  }

  return {
    argumentStartOffset,
    argumentEndOffset,
  };
}

function unpackedLookupDictCallContext(
  text: string,
  tokenStartOffset: number,
  tokenEndOffset: number
):
  | {
      receiverExpression: string;
      method: string;
      argumentStartOffset: number;
      argumentEndOffset: number;
    }
  | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, tokenStartOffset);
  if (openParenOffset === undefined) {
    return undefined;
  }

  const argumentStartOffset = findCurrentArgumentStartOffset(
    text,
    openParenOffset,
    tokenStartOffset
  );
  const argumentEndOffset = findCurrentArgumentEndOffset(text, tokenEndOffset);
  const argumentPrefix = text.slice(argumentStartOffset, tokenStartOffset).trimStart();
  if (!argumentPrefix.startsWith('**{')) {
    return undefined;
  }

  const directCalleeMatch = parseQuerysetCallee(
    text,
    openParenOffset,
    KEYWORD_LOOKUP_METHODS
  );
  const calleeMatch =
    directCalleeMatch ?? resolveKeywordEnclosingQuerysetCallContext(text, openParenOffset);
  if (!calleeMatch) {
    return undefined;
  }

  return {
    receiverExpression: calleeMatch.receiverExpression,
    method: calleeMatch.method,
    argumentStartOffset,
    argumentEndOffset,
  };
}

function querysetDirectFieldKeywordCallContext(
  text: string,
  tokenStartOffset: number,
  tokenEndOffset: number
):
  | {
      receiverExpression: string;
      method: string;
      argumentStartOffset: number;
      argumentEndOffset: number;
    }
  | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, tokenStartOffset);
  if (openParenOffset === undefined) {
    return undefined;
  }

  const argumentStartOffset = findCurrentArgumentStartOffset(
    text,
    openParenOffset,
    tokenStartOffset
  );
  const argumentEndOffset = findCurrentArgumentEndOffset(text, tokenEndOffset);
  const calleeMatch = parseQuerysetCallee(
    text,
    openParenOffset,
    DIRECT_FIELD_KEYWORD_METHODS
  );
  if (!calleeMatch) {
    return undefined;
  }

  return {
    receiverExpression: calleeMatch.receiverExpression,
    method: calleeMatch.method,
    argumentStartOffset,
    argumentEndOffset,
  };
}

function resolveKeywordEnclosingQuerysetCallContext(
  text: string,
  openParenOffset: number
): { receiverExpression: string; method: string } | undefined {
  if (
    !isQExpressionCall(text, openParenOffset) &&
    !isWhenExpressionCall(text, openParenOffset)
  ) {
    return undefined;
  }

  const directContext = resolveEnclosingQuerysetCallContext(
    text,
    openParenOffset,
    KEYWORD_LOOKUP_METHODS,
    (candidateText, candidateOpenParenOffset) =>
      isQExpressionCall(candidateText, candidateOpenParenOffset) ||
      isWhenExpressionCall(candidateText, candidateOpenParenOffset)
  );
  if (directContext) {
    return directContext;
  }

  const expressionContext = resolveEnclosingQuerysetCallContext(
    text,
    openParenOffset,
    EXPRESSION_QUERYSET_METHODS,
    (candidateText, candidateOpenParenOffset) =>
      isQExpressionCall(candidateText, candidateOpenParenOffset) ||
      isWhenExpressionCall(candidateText, candidateOpenParenOffset) ||
      isCaseExpressionCall(candidateText, candidateOpenParenOffset)
  );
  if (!expressionContext) {
    return undefined;
  }

  return {
    receiverExpression: expressionContext.receiverExpression,
    method: 'filter',
  };
}

function prefetchLookupCallContext(
  text: string,
  beforeOffset: number
): { receiverExpression: string; method: string } | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, beforeOffset);
  if (
    openParenOffset === undefined ||
    normalizedEnclosingCallName(text, openParenOffset) !== 'Prefetch'
  ) {
    return undefined;
  }

  const callContext = resolveEnclosingQuerysetCallContext(
    text,
    openParenOffset,
    new Set(['prefetch_related']),
    () => false
  );
  if (!callContext) {
    return undefined;
  }

  return {
    receiverExpression: callContext.receiverExpression,
    method: 'prefetch_related',
  };
}

function fExpressionCallContext(
  text: string,
  beforeOffset: number
): { receiverExpression: string; method: string } | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, beforeOffset);
  if (openParenOffset === undefined || !isFExpressionCall(text, openParenOffset)) {
    return undefined;
  }

  const callContext = resolveExpressionQuerysetCallContext(text, openParenOffset);
  if (!callContext) {
    return undefined;
  }

  return {
    receiverExpression: callContext.receiverExpression,
    method: F_EXPRESSION_METHOD,
  };
}

function expressionPathCallContext(
  text: string,
  beforeOffset: number
): { receiverExpression: string; expressionName: string } | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, beforeOffset);
  if (openParenOffset === undefined || !isExpressionPathCall(text, openParenOffset)) {
    return undefined;
  }

  const expressionName = normalizedEnclosingCallName(text, openParenOffset);
  if (!expressionName) {
    return undefined;
  }

  const callContext =
    expressionName === 'OuterRef'
      ? resolveOuterRefQuerysetCallContext(text, openParenOffset)
      : resolveExpressionQuerysetCallContext(text, openParenOffset);
  if (!callContext) {
    return undefined;
  }

  return {
    receiverExpression: callContext.receiverExpression,
    expressionName,
  };
}

function expressionStringArgumentCallContext(
  text: string,
  tokenStartOffset: number,
  tokenEndOffset: number
): { receiverExpression: string; expressionName: string } | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, tokenStartOffset);
  if (openParenOffset === undefined) {
    return undefined;
  }

  const expressionName = normalizedEnclosingCallName(text, openParenOffset);
  if (!expressionName) {
    return undefined;
  }

  const argument = describeEnclosingCallArgument(
    text,
    openParenOffset,
    tokenStartOffset,
    tokenEndOffset
  );
  if (!expressionArgumentAllowsFieldPath(expressionName, argument)) {
    return undefined;
  }

  const callContext =
    expressionName === 'OuterRef'
      ? resolveOuterRefQuerysetCallContext(text, openParenOffset)
      : resolveExpressionQuerysetCallContext(text, openParenOffset);
  if (!callContext) {
    return undefined;
  }

  return {
    receiverExpression: callContext.receiverExpression,
    expressionName,
  };
}

function querysetStringCallContext(
  text: string,
  beforeOffset: number
): { receiverExpression: string; method: string } | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, beforeOffset);
  if (openParenOffset === undefined) {
    return undefined;
  }

  return parseQuerysetCallee(text, openParenOffset, STRING_LOOKUP_METHODS);
}

function bulkUpdateFieldListCallContext(
  text: string,
  beforeOffset: number
): { receiverExpression: string; method: string } | undefined {
  const openParenOffset = findEnclosingCallOpenParenOffset(text, beforeOffset);
  if (openParenOffset === undefined) {
    return undefined;
  }

  return parseQuerysetCallee(
    text,
    openParenOffset,
    BULK_UPDATE_FIELD_LIST_METHODS
  );
}

function parseQuerysetCallee(
  text: string,
  openParenOffset: number,
  allowedMethods: ReadonlySet<string>
): { receiverExpression: string; method: string } | undefined {
  const calleeText = trimLeadingUnmatchedOpeningDelimiters(
    compactPythonExpression(trailingTopLevelExpression(text.slice(0, openParenOffset)))
  );
  const memberAccess = splitTopLevelMemberAccess(calleeText);
  if (!memberAccess || !allowedMethods.has(memberAccess.memberName)) {
    return undefined;
  }

  return {
    receiverExpression: trailingNestedReceiverExpression(
      memberAccess.objectExpression
    ),
    method: memberAccess.memberName,
  };
}

function trailingTopLevelExpression(text: string): string {
  const starts = [...topLevelStatementStarts(text, text.length)];
  const start = starts.length > 0 ? Math.max(...starts) : 0;
  return text.slice(start).trim();
}

function trailingNestedReceiverExpression(text: string): string {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === ')') {
      parenDepth += 1;
      continue;
    }

    if (char === ']') {
      bracketDepth += 1;
      continue;
    }

    if (char === '}') {
      braceDepth += 1;
      continue;
    }

    if (char === '(') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return text.slice(index + 1).trim();
      }
      if (parenDepth > 0) {
        parenDepth -= 1;
      }
      continue;
    }

    if (char === '[') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return text.slice(index + 1).trim();
      }
      if (bracketDepth > 0) {
        bracketDepth -= 1;
      }
      continue;
    }

    if (char === '{') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return text.slice(index + 1).trim();
      }
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      continue;
    }

    if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      ',=:\n;'.includes(char)
    ) {
      return text.slice(index + 1).trim();
    }
  }

  return text.trim();
}

function topLevelStatementStarts(
  text: string,
  beforeOffset: number
): Set<number> {
  const starts = new Set<number>([0]);
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let activeQuote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < beforeOffset; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (activeQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      activeQuote = char;
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char === ')' && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }

    if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }

    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }

    if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      '\n;=:'.includes(char)
    ) {
      if (char === '\n' && continuesTopLevelExpression(text, index + 1)) {
        continue;
      }
      starts.add(index + 1);
    }
  }

  return starts;
}

function continuesTopLevelExpression(
  text: string,
  startIndex: number
): boolean {
  let index = startIndex;
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) {
    index += 1;
  }

  return text[index] === '.';
}

function resolveEnclosingQuerysetCallContext(
  text: string,
  searchBeforeOffset: number,
  allowedMethods: ReadonlySet<string>,
  isWrapperCall: (
    text: string,
    openParenOffset: number
  ) => boolean
): { receiverExpression: string; method: string } | undefined {
  const callContext = resolveEnclosingQuerysetCallContextWithOffset(
    text,
    searchBeforeOffset,
    allowedMethods,
    isWrapperCall
  );
  if (!callContext) {
    return undefined;
  }

  return {
    receiverExpression: callContext.receiverExpression,
    method: callContext.method,
  };
}

function resolveEnclosingQuerysetCallContextWithOffset(
  text: string,
  searchBeforeOffset: number,
  allowedMethods: ReadonlySet<string>,
  isWrapperCall: (
    text: string,
    openParenOffset: number
  ) => boolean
):
  | {
      receiverExpression: string;
      method: string;
      openParenOffset: number;
    }
  | undefined {
  let currentBeforeOffset = searchBeforeOffset;

  while (true) {
    const openParenOffset = findEnclosingCallOpenParenOffset(
      text,
      currentBeforeOffset
    );
    if (openParenOffset === undefined) {
      return undefined;
    }

    const calleeMatch = parseQuerysetCallee(text, openParenOffset, allowedMethods);
    if (calleeMatch) {
      return {
        ...calleeMatch,
        openParenOffset,
      };
    }

    if (!isWrapperCall(text, openParenOffset)) {
      return undefined;
    }

    currentBeforeOffset = openParenOffset;
  }
}

function resolveExpressionQuerysetCallContext(
  text: string,
  searchBeforeOffset: number
): { receiverExpression: string; method: string } | undefined {
  return resolveEnclosingQuerysetCallContext(
    text,
    searchBeforeOffset,
    EXPRESSION_QUERYSET_METHODS,
    (candidateText, candidateOpenParenOffset) =>
      isQExpressionCall(candidateText, candidateOpenParenOffset) ||
      isFExpressionCall(candidateText, candidateOpenParenOffset) ||
      isWhenExpressionCall(candidateText, candidateOpenParenOffset) ||
      isCaseExpressionCall(candidateText, candidateOpenParenOffset) ||
      isExpressionWrapperCall(candidateText, candidateOpenParenOffset) ||
      isExpressionPathCall(candidateText, candidateOpenParenOffset)
  );
}

function resolveOuterRefQuerysetCallContext(
  text: string,
  outerRefOpenParenOffset: number
): { receiverExpression: string; method: string } | undefined {
  const innerQueryContext = resolveEnclosingQuerysetCallContextWithOffset(
    text,
    outerRefOpenParenOffset,
    EXPRESSION_QUERYSET_METHODS,
    (candidateText, candidateOpenParenOffset) =>
      isQExpressionCall(candidateText, candidateOpenParenOffset) ||
      isFExpressionCall(candidateText, candidateOpenParenOffset) ||
      isWhenExpressionCall(candidateText, candidateOpenParenOffset) ||
      isCaseExpressionCall(candidateText, candidateOpenParenOffset) ||
      isExpressionWrapperCall(candidateText, candidateOpenParenOffset) ||
      isExpressionPathCall(candidateText, candidateOpenParenOffset)
  );
  if (!innerQueryContext) {
    return undefined;
  }

  const outerQueryContext = resolveEnclosingQuerysetCallContextWithOffset(
    text,
    innerQueryContext.openParenOffset,
    EXPRESSION_QUERYSET_METHODS,
    (candidateText, candidateOpenParenOffset) =>
      isExpressionQuerysetContextWrapperCall(
        candidateText,
        candidateOpenParenOffset
      )
  );
  if (!outerQueryContext) {
    return undefined;
  }

  return {
    receiverExpression: outerQueryContext.receiverExpression,
    method: outerQueryContext.method,
  };
}

function isQExpressionCall(text: string, openParenOffset: number): boolean {
  return normalizedEnclosingCallName(text, openParenOffset) === 'Q';
}

function isFExpressionCall(text: string, openParenOffset: number): boolean {
  return normalizedEnclosingCallName(text, openParenOffset) === 'F';
}

function isWhenExpressionCall(text: string, openParenOffset: number): boolean {
  return normalizedEnclosingCallName(text, openParenOffset) === 'When';
}

function isCaseExpressionCall(text: string, openParenOffset: number): boolean {
  return normalizedEnclosingCallName(text, openParenOffset) === 'Case';
}

function isExpressionPathCall(text: string, openParenOffset: number): boolean {
  const callName = normalizedEnclosingCallName(text, openParenOffset);
  return callName ? EXPRESSION_FIELD_FUNCTION_NAME_SET.has(callName) : false;
}

function isExpressionWrapperCall(
  text: string,
  openParenOffset: number
): boolean {
  const callName = normalizedEnclosingCallName(text, openParenOffset);
  return callName ? EXPRESSION_WRAPPER_FUNCTION_NAMES.has(callName) : false;
}

function isExpressionQuerysetContextWrapperCall(
  text: string,
  openParenOffset: number
): boolean {
  return (
    isQExpressionCall(text, openParenOffset) ||
    isFExpressionCall(text, openParenOffset) ||
    isWhenExpressionCall(text, openParenOffset) ||
    isCaseExpressionCall(text, openParenOffset) ||
    isExpressionWrapperCall(text, openParenOffset) ||
    isExpressionPathCall(text, openParenOffset) ||
    isQuerysetMethodCall(text, openParenOffset, EXPRESSION_QUERYSET_METHODS)
  );
}

function isQuerysetMethodCall(
  text: string,
  openParenOffset: number,
  allowedMethods: ReadonlySet<string>
): boolean {
  const callName = normalizedEnclosingCallName(text, openParenOffset);
  return callName ? allowedMethods.has(callName) : false;
}

function expressionPathMethodName(expressionName: string): string {
  return `${EXPRESSION_PATH_METHOD_PREFIX}${expressionName}`;
}

function normalizedEnclosingCallName(
  text: string,
  openParenOffset: number
): string | undefined {
  const calleeExpression = parseEnclosingCallExpression(text, openParenOffset);
  if (!calleeExpression) {
    return undefined;
  }

  return calleeExpression.replace(/^~/, '').split('.').at(-1);
}

function parseEnclosingCallExpression(
  text: string,
  openParenOffset: number
): string | undefined {
  const calleeText = compactPythonExpression(text.slice(0, openParenOffset));
  const match = calleeText.match(/(?:^|[^\w.])(~?[A-Za-z_][\w.]*)$/);
  return match?.[1];
}

function findEnclosingCallOpenParenOffset(
  text: string,
  beforeOffset: number
): number | undefined {
  let depth = 0;

  for (let index = beforeOffset - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === ')') {
      depth += 1;
      continue;
    }

    if (char === '(') {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }

  return undefined;
}

function findCurrentArgumentStartOffset(
  text: string,
  openParenOffset: number,
  tokenStartOffset: number
): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let activeQuote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = tokenStartOffset - 1; index > openParenOffset; index -= 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (activeQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      activeQuote = char;
      continue;
    }

    if (char === ')') {
      parenDepth += 1;
      continue;
    }

    if (char === ']') {
      bracketDepth += 1;
      continue;
    }

    if (char === '}') {
      braceDepth += 1;
      continue;
    }

    if (char === '(') {
      if (parenDepth > 0) {
        parenDepth -= 1;
      }
      continue;
    }

    if (char === '[') {
      if (bracketDepth > 0) {
        bracketDepth -= 1;
      }
      continue;
    }

    if (char === '{') {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      continue;
    }

    if (
      char === ',' &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return index + 1;
    }
  }

  return openParenOffset + 1;
}

function findCurrentArgumentEndOffset(text: string, tokenEndOffset: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let activeQuote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = tokenEndOffset; index < text.length; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (activeQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      activeQuote = char;
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char === ')') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return index;
      }
      if (parenDepth > 0) {
        parenDepth -= 1;
      }
      continue;
    }

    if (char === ']') {
      if (bracketDepth > 0) {
        bracketDepth -= 1;
      }
      continue;
    }

    if (char === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      continue;
    }

    if (
      char === ',' &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return index;
    }
  }

  return text.length;
}

function describeEnclosingCallArgument(
  text: string,
  openParenOffset: number,
  tokenStartOffset: number,
  tokenEndOffset: number
): { argumentIndex: number; keywordName: string | undefined } {
  const argumentStartOffset = findCurrentArgumentStartOffset(
    text,
    openParenOffset,
    tokenStartOffset
  );
  const argumentEndOffset = findCurrentArgumentEndOffset(text, tokenEndOffset);
  const argumentText = text.slice(argumentStartOffset, argumentEndOffset).trim();
  const equalsIndex = findTopLevelEqualsIndex(argumentText);

  return {
    argumentIndex: countTopLevelArgumentsBeforeOffset(
      text,
      openParenOffset,
      argumentStartOffset
    ),
    keywordName:
      equalsIndex >= 0
        ? argumentText.slice(0, equalsIndex).trim() || undefined
        : undefined,
  };
}

function expressionArgumentAllowsFieldPath(
  expressionName: string,
  argument: { argumentIndex: number; keywordName: string | undefined }
): boolean {
  if (KEYWORD_VALUE_EXPRESSION_FIELD_FUNCTIONS.has(expressionName)) {
    return Boolean(argument.keywordName);
  }

  if (argument.keywordName) {
    return false;
  }

  if (ANY_POSITION_EXPRESSION_FIELD_FUNCTIONS.has(expressionName)) {
    return true;
  }

  if (FIRST_ARGUMENT_EXPRESSION_FIELD_FUNCTIONS.has(expressionName)) {
    return argument.argumentIndex === 0;
  }

  return false;
}

function expressionStringTokenEndOffset(
  text: string,
  cursorOffset: number
): number {
  let offset = cursorOffset;
  while (offset < text.length && /[-\w.]/.test(text[offset] ?? '')) {
    offset += 1;
  }

  const trailingCharacter = text[offset];
  if (trailingCharacter === "'" || trailingCharacter === '"') {
    offset += 1;
  }

  return offset;
}

function countTopLevelArgumentsBeforeOffset(
  text: string,
  openParenOffset: number,
  argumentStartOffset: number
): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let activeQuote: '"' | "'" | undefined;
  let escaped = false;
  let count = 0;

  for (let index = openParenOffset + 1; index < argumentStartOffset; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (activeQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      activeQuote = char;
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char === ')' && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }

    if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }

    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }

    if (
      char === ',' &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      count += 1;
    }
  }

  return count;
}

function hasTopLevelEquals(text: string): boolean {
  return findTopLevelEqualsIndex(text) >= 0;
}

/**
 * True when `text` contains a comma at top level (outside parens / brackets
 * / braces / strings). Captain trace 2026-05-12 17:44 showed function-call
 * argument lists like `directors_meeting, user=self.user, context=self.context`
 * being passed to `resolveOrmReceiverAtOffset` as receiver expressions —
 * 10k+ slow steps consumed by the resolver chewing on garbage that could
 * never be a valid Python receiver. Top-level commas reliably mark such
 * malformed slices.
 */
function hasTopLevelComma(text: string): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let activeQuote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!char) continue;

    if (activeQuote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === activeQuote) activeQuote = undefined;
      continue;
    }

    if (char === "'" || char === '"') { activeQuote = char; continue; }
    if (char === '(') { parenDepth += 1; continue; }
    if (char === '[') { bracketDepth += 1; continue; }
    if (char === '{') { braceDepth += 1; continue; }
    if (char === ')' && parenDepth > 0) { parenDepth -= 1; continue; }
    if (char === ']' && bracketDepth > 0) { bracketDepth -= 1; continue; }
    if (char === '}' && braceDepth > 0) { braceDepth -= 1; continue; }

    if (
      char === ',' &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return true;
    }
  }

  return false;
}

/** Detect receiver-expression slices that are obviously argument lists
 *  (not single Python expressions). Either a top-level comma or a
 *  top-level `=` proves the scanner captured too much. Cheap sync check;
 *  used as an early bail-out before the receiver chain spends seconds
 *  trying to resolve the garbage. */
function isMalformedReceiverExpression(text: string): boolean {
  return hasTopLevelComma(text) || hasTopLevelEquals(text);
}

function findTopLevelEqualsIndex(text: string): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let activeQuote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (activeQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === activeQuote) {
        activeQuote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      activeQuote = char;
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char === ')' && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }

    if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }

    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }

    if (
      char === '=' &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}
