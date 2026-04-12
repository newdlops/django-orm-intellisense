import * as path from 'path';
import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import { isPylanceAvailable } from '../python/pylance';
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

const PYTHON_SELECTOR: vscode.DocumentSelector = [
  { language: 'python', scheme: 'file' },
];

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
const KEYWORD_LOOKUP_METHODS = new Set([
  'filter',
  'exclude',
  'get',
  'get_or_create',
  'update_or_create',
]);
const DIRECT_FIELD_KEYWORD_METHODS = new Set(['create', 'update']);
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
const CLASS_DEFINITION_PATTERN =
  /^(\s*)class\s+([A-Za-z_][\w]*)\s*(?:\((.*)\))?\s*:/;
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
const documentDefinitionsCache = new WeakMap<
  vscode.TextDocument,
  CachedDocumentDefinitions
>();
let allRelationTargetsCache = new WeakMap<
  AnalysisDaemon,
  Promise<RelationTargetsResult>
>();

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

export function registerPythonProviders(
  daemon: AnalysisDaemon
): vscode.Disposable[] {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection(
    'djangoOrmIntellisense.orm'
  );
  const diagnosticsEnabled = isPylanceAvailable();
  const diagnosticTimers = new Map<string, NodeJS.Timeout>();
  const lastDiagnosedDocumentVersions = new Map<string, number>();
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

  const scheduleDiagnosticsRefresh = (
    document: vscode.TextDocument,
    delayMs = 200
  ): void => {
    if (!shouldAnalyzeDocument(document, daemon.getState().workspaceRoot)) {
      return;
    }

    const key = document.uri.toString();
    if (lastDiagnosedDocumentVersions.get(key) === document.version) {
      return;
    }

    const existingTimer = diagnosticTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      diagnosticTimers.delete(key);
      void refreshDiagnostics(document);
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
    for (const document of collectDiagnosticRefreshDocuments()) {
      if (!shouldAnalyzeDocument(document, daemon.getState().workspaceRoot)) {
        diagnosticCollection.delete(document.uri);
        continue;
      }

      scheduleDiagnosticsRefresh(document, 0);
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
    document: vscode.TextDocument
  ): Promise<void> => daemon.withRequestSource('diagnostic', async () => {
    const key = document.uri.toString();
    const documentVersion = document.version;
    if (lastDiagnosedDocumentVersions.get(key) === documentVersion) {
      return;
    }

    if (!shouldAnalyzeDocument(document, daemon.getState().workspaceRoot)) {
      diagnosticCollection.delete(document.uri);
      lastDiagnosedDocumentVersions.delete(key);
      return;
    }

    try {
      await daemon.ensureStarted(document.uri);
    } catch {
      diagnosticCollection.delete(document.uri);
      return;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    const seenRanges = new Set<string>();

    for (const context of findRelationDiagnosticContexts(document)) {
      try {
        const resolution = await daemon.resolveRelationTarget(context.value, /* background */ true);
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
      } catch {
        continue;
      }
    }

    // Pass 1: Resolve receivers and collect items needing daemon lookup
    const _lookupPending: Array<{
      context: ReturnType<typeof findLookupDiagnosticContexts> extends Iterable<infer T> ? T : never;
      receiver: OrmReceiverInfo;
      baseModelLabel: string;
      batchIdx: number;
    }> = [];
    const _batchItems: Array<{ baseModelLabel: string; value: string; method: string }> = [];
    const _receiverCache = new Map<string, OrmReceiverInfo | null>();

    for (const context of findLookupDiagnosticContexts(document)) {
      try {
        const lookupReceiver = await resolveLookupReceiverInfoForReceiver(
          daemon, document, context.receiverExpression, context.range.end
        );
        if (!lookupReceiver) continue;

        const virtualRes = resolveVirtualLookupPath(lookupReceiver, context.value, context.method);
        if (virtualRes?.resolved) {
          // Virtual lookup resolved successfully — skip daemon
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
      } catch {
        continue;
      }
    }

    // Pass 2: Batch resolve lookup paths
    let _batchRes: import('../protocol').LookupPathResolution[] | undefined;
    // Only use batch when there are enough items to justify the overhead,
    // and batch size is manageable for the daemon's single-threaded processing.
    // Batch only when enough items exist — small files use individual calls
    // which return results incrementally (important for waitForDiagnostics timeout)
    const BATCH_THRESHOLD = 200;
    if (_batchItems.length >= BATCH_THRESHOLD) {
      try {
        _batchRes = await daemon.resolveLookupPathBatch(_batchItems);
        if (!Array.isArray(_batchRes) || _batchRes.length !== _batchItems.length) {
          _batchRes = undefined;
        }
      } catch {
        // fall back to individual
      }
    }

    // Pass 3: Build diagnostics
    for (const { context, receiver, baseModelLabel, batchIdx } of _lookupPending) {
      try {
        const resolution = _batchRes?.[batchIdx]
          ?? await daemon.resolveLookupPath(baseModelLabel, context.value, context.method, /* background */ true);
        if (!resolution.resolved) {
          const partialCompletions = {
            items: mergeLookupCompletionItems(
              (await listLookupPathCompletionsFast(
                daemon,
                baseModelLabel,
                context.value,
                context.method
              )).items,
              virtualLookupCompletionItems(receiver, context.value, context.method)
            ),
            resolved: true,
          };
          if (partialCompletions.items.length > 0) continue;
        }
        const diagnostic = buildLookupDiagnostic(context, baseModelLabel, resolution);
        if (!diagnostic) continue;
        const key = diagnostic.range.start.toString() + diagnostic.message;
        if (seenRanges.has(key)) continue;
        seenRanges.add(key);
        diagnostics.push(diagnostic);
      } catch {
        continue;
      }
    }

    for (const context of findDirectFieldDiagnosticContexts(document)) {
      try {
        const baseModelLabel = await resolveBaseModelLabelForReceiver(
          daemon,
          document,
          context.receiverExpression,
          context.range.end
        );
        if (!baseModelLabel) {
          continue;
        }

        const resolution = await daemon.resolveLookupPath(
          baseModelLabel,
          context.value,
          'filter',
          /* background */ true
        );
        const diagnostic = buildDirectFieldDiagnostic(
          context,
          baseModelLabel,
          resolution
        );
        if (!diagnostic) {
          continue;
        }

        const key = diagnostic.range.start.toString() + diagnostic.message;
        if (seenRanges.has(key)) {
          continue;
        }
        seenRanges.add(key);
        diagnostics.push(diagnostic);
      } catch {
        continue;
      }
    }

    for (const context of findSchemaFieldDiagnosticContexts(document)) {
      try {
        const baseModelLabel = await resolveMetaOwnerModelLabel(
          daemon,
          document,
          context.range.end
        );
        if (!baseModelLabel) {
          continue;
        }

        const resolution = await daemon.resolveLookupPath(
          baseModelLabel,
          context.value,
          'filter',
          /* background */ true
        );
        const diagnostic = buildSchemaFieldDiagnostic(
          context,
          baseModelLabel,
          resolution
        );
        if (!diagnostic) {
          continue;
        }

        const key = diagnostic.range.start.toString() + diagnostic.message;
        if (seenRanges.has(key)) {
          continue;
        }
        seenRanges.add(key);
        diagnostics.push(diagnostic);
      } catch {
        continue;
      }
    }

    for (const context of findMetaConstraintLookupDiagnosticContexts(document)) {
      try {
        const baseModelLabel = await resolveMetaOwnerModelLabel(
          daemon,
          document,
          context.range.end
        );
        if (!baseModelLabel) {
          continue;
        }

        const resolution = await daemon.resolveLookupPath(
          baseModelLabel,
          context.value,
          'filter',
          /* background */ true
        );
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
        if (!diagnostic) {
          continue;
        }

        const key = diagnostic.range.start.toString() + diagnostic.message;
        if (seenRanges.has(key)) {
          continue;
        }
        seenRanges.add(key);
        diagnostics.push(diagnostic);
      } catch {
        continue;
      }
    }

    for (const context of findBulkUpdateFieldDiagnosticContexts(document)) {
      try {
        const baseModelLabel = await resolveBaseModelLabelForReceiver(
          daemon,
          document,
          context.receiverExpression,
          context.range.end
        );
        if (!baseModelLabel) {
          continue;
        }

        const resolution = await daemon.resolveLookupPath(
          baseModelLabel,
          context.value,
          'filter',
          /* background */ true
        );
        const diagnostic = buildBulkUpdateFieldDiagnostic(
          context,
          baseModelLabel,
          resolution
        );
        if (!diagnostic) {
          continue;
        }

        const key = diagnostic.range.start.toString() + diagnostic.message;
        if (seenRanges.has(key)) {
          continue;
        }
        seenRanges.add(key);
        diagnostics.push(diagnostic);
      } catch {
        continue;
      }
    }

    if (document.version !== documentVersion) {
      return;
    }

    diagnosticCollection.set(document.uri, diagnostics);
    lastDiagnosedDocumentVersions.set(key, documentVersion);
  });

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    PYTHON_SELECTOR,
    {
      async provideCompletionItems(document, position, token) {
        return daemon.withRequestSource('completion', async () => {
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
            const lookupReceiver = await resolveLookupReceiverInfoForReceiver(
              daemon,
              document,
              lookupContext.receiverExpression,
              position
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            if (!lookupReceiver) {
              return undefined;
            }

            const baseModelLabel = lookupReceiver.modelLabel;
            const result = await listLookupPathCompletionsFast(
              daemon,
              baseModelLabel,
              lookupContext.prefix,
              lookupContext.method
            );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            const mergedLookupItems = mergeLookupCompletionItems(
              result.items,
              virtualLookupCompletionItems(
                lookupReceiver,
                lookupContext.prefix,
                lookupContext.method
              )
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

            return completions;
          }

          if (directFieldContext) {
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              directFieldContext.receiverExpression,
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
            const result =
              daemon.listOrmMemberCompletionsLocal(
                memberContext.receiver.modelLabel,
                memberContext.receiver.kind,
                memberContext.prefix,
                memberContext.receiver.managerName
              ) ??
              await daemon.listOrmMemberCompletions(
                memberContext.receiver.modelLabel,
                memberContext.receiver.kind,
                memberContext.prefix,
                memberContext.receiver.managerName
              );
            if (token.isCancellationRequested) {
              return cancelledCompletionResult(token);
            }
            const mergedItems = mergeVirtualOrmMemberItems(
              result.items,
              memberContext.receiver
            );
            const sortedItems = prioritizeOrmMemberCompletionItems(
              mergedItems,
              memberContext.receiver
            );

            return sortedItems.map((item, index) => {
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
                index
              );
              completion.preselect = shouldPreselectOrmMemberCompletion(
                item,
                memberContext.receiver,
                index
              );
              completion.documentation = buildOrmMemberMarkdown(
                item,
                memberContext.receiver
              );
              return completion;
            });
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
              item.name,
              classMemberCompletionKind(item)
            );
            completion.detail = item.detail;
            completion.insertText = item.name;
            completion.filterText = item.name;
            completion.range = classInstanceContext.range;
            return completion;
          });
        } catch {
          return undefined;
        }
        });
      },
    },
    "'",
    '"',
    '.',
    '_',
    '(',
    ','
  );

  const hoverProvider = vscode.languages.registerHoverProvider(
    PYTHON_SELECTOR,
    {
      async provideHover(document, position, token) {
        return daemon.withRequestSource('hover', async () => {
        const ensureStarted = createEnsureStartedOnce(daemon, document.uri);
        const relationLiteral = relationHoverLiteral(document, position);
        if (relationLiteral) {
          try {
            await ensureStarted();
            const resolution = await daemon.resolveRelationTarget(relationLiteral.value);
            const relationHover = buildRelationHover(relationLiteral.value, resolution);
            if (relationHover) {
              return relationHover;
            }
          } catch {
            return undefined;
          }
        }

        const lookupLiteral =
          lookupHoverLiteral(document, position) ??
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
            const lookupReceiver = await resolveLookupReceiverInfoForReceiver(
              daemon,
              document,
              lookupLiteral.receiverExpression,
              position
            );
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
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              directFieldLiteral.receiverExpression,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              directFieldLiteral.value,
              'filter'
            );
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
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              metaConstraintLookupLiteralAtPosition.value,
              'filter'
            );
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
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              schemaFieldLiteral.value,
              'filter'
            );
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
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              bulkUpdateFieldLiteral.receiverExpression,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              bulkUpdateFieldLiteral.value,
              'filter'
            );
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

        try {
          await ensureStarted();
          const memberContext = await resolveOrmMemberAccessContext(
            daemon,
            document,
            position
          );
          if (memberContext) {
            const virtualResolution = resolveVirtualOrmMember(
              memberContext.receiver,
              memberContext.memberName
            );
            if (virtualResolution) {
              const memberHover = buildOrmMemberHover(
                memberContext.memberName,
                memberContext.receiver,
                virtualResolution
              );
              if (memberHover) {
                return memberHover;
              }
            }

            const resolution = await daemon.resolveOrmMember(
              memberContext.receiver.modelLabel,
              memberContext.receiver.kind,
              memberContext.memberName,
              memberContext.receiver.managerName
            );
            const memberHover = buildOrmMemberHover(
              memberContext.memberName,
              memberContext.receiver,
              resolution
            );
            if (memberHover) {
              return memberHover;
            }
          }
        } catch {
          return undefined;
        }

        try {
          await ensureStarted();
          const importReference = await resolveImportReferenceAtPosition(
            daemon,
            document,
            position
          );
          if (importReference) {
            const importHover = await buildImportHover(
              daemon,
              importReference
            );
            if (importHover) {
              return importHover;
            }
          }
        } catch {
          return undefined;
        }

        try {
          await ensureStarted();
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
          return undefined;
        }

        try {
          await ensureStarted();
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
          return undefined;
        }

        if (!token.isCancellationRequested) {
          try {
            await ensureStarted();
            if (!token.isCancellationRequested) {
              const ormInstanceHover = await resolveOrmInstanceHoverAtPosition(
                daemon,
                document,
                position
              );
              if (ormInstanceHover) {
                return ormInstanceHover;
              }
            }
          } catch {
            return undefined;
          }
        }

        return undefined;
        });
      },
    }
  );

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    PYTHON_SELECTOR,
    {
      async provideDefinition(document, position) {
        return daemon.withRequestSource('definition', async () => {
        const ensureStarted = createEnsureStartedOnce(daemon, document.uri);
        const relationLiteral = relationHoverLiteral(document, position);
        if (relationLiteral) {
          try {
            await ensureStarted();
            const resolution = await daemon.resolveRelationTarget(relationLiteral.value);
            const location = definitionLocationFromRelationResolution(resolution);
            if (location) {
              return location;
            }
          } catch {
            return undefined;
          }
        }

        const lookupLiteral =
          lookupHoverLiteral(document, position) ??
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
            const lookupReceiver = await resolveLookupReceiverInfoForReceiver(
              daemon,
              document,
              lookupLiteral.receiverExpression,
              position
            );
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
            const location = definitionLocationFromLookupResolution(resolution);
            if (location) {
              return location;
            }
          } catch {
            return undefined;
          }
        }

        if (directFieldLiteral) {
          try {
            await ensureStarted();
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              directFieldLiteral.receiverExpression,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              directFieldLiteral.value,
              'filter'
            );
            return definitionLocationFromLookupResolution(resolution);
          } catch {
            return undefined;
          }
        }

        if (metaConstraintLookupLiteralAtPosition) {
          try {
            await ensureStarted();
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              metaConstraintLookupLiteralAtPosition.value,
              'filter'
            );
            return definitionLocationFromLookupResolution(resolution);
          } catch {
            return undefined;
          }
        }

        if (schemaFieldLiteral) {
          try {
            await ensureStarted();
            const baseModelLabel = await resolveMetaOwnerModelLabel(
              daemon,
              document,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              schemaFieldLiteral.value,
              'filter'
            );
            return definitionLocationFromLookupResolution(resolution);
          } catch {
            return undefined;
          }
        }

        if (bulkUpdateFieldLiteral) {
          try {
            await ensureStarted();
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              bulkUpdateFieldLiteral.receiverExpression,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              bulkUpdateFieldLiteral.value,
              'filter'
            );
            return definitionLocationFromLookupResolution(resolution);
          } catch {
            return undefined;
          }
        }

        try {
          await ensureStarted();
          const memberContext = await resolveOrmMemberAccessContext(
            daemon,
            document,
            position
          );
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
            const location = definitionLocationFromOrmMemberResolution(resolution);
            if (location) {
              return location;
            }
          }
        } catch {
          return undefined;
        }

        try {
          await ensureStarted();
          const importReference = await resolveImportReferenceAtPosition(
            daemon,
            document,
            position
          );
          if (!importReference) {
            return undefined;
          }
          const location = await definitionLocationFromImportReference(
            daemon,
            importReference
          );
          if (location) {
            return location;
          }
        } catch {
          return undefined;
        }

        return undefined;
        });
      },
    }
  );

  if (diagnosticsEnabled) {
    scheduleTrackedDiagnosticsRefresh();
  }

  return [
    completionProvider,
    hoverProvider,
    definitionProvider,
    diagnosticCollection,
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (!diagnosticsEnabled) {
        return;
      }
      if (!isVisibleDocument(document)) {
        return;
      }
      scheduleDiagnosticsRefresh(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!diagnosticsEnabled) {
        return;
      }
      if (!isVisibleDocument(event.document)) {
        return;
      }
      scheduleDiagnosticsRefresh(event.document);
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      if (!diagnosticsEnabled) {
        return;
      }
      scheduleTrackedDiagnosticsRefresh(0);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnosticCollection.delete(document.uri);
      const key = document.uri.toString();
      lastDiagnosedDocumentVersions.delete(key);
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
        return;
      }

      scheduleTrackedDiagnosticsRefresh(0);
    }),
    new vscode.Disposable(() => {
      clearScheduledDiagnostics();
      lastDiagnosedDocumentVersions.clear();
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

  return item.isRelation || DJANGO_FIELD_PRIORITY_METHODS.has(method);
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
  receiver: OrmReceiverInfo
): OrmMemberItem[] {
  return [...items]
    .map((item, index) => ({
      item,
      index,
    }))
    .sort((left, right) => {
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

function ormMemberCompletionPriority(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): number {
  if (receiver.kind === 'instance') {
    if (item.memberKind === 'field' || item.memberKind === 'relation') {
      return 0;
    }
    if (item.memberKind === 'reverse_relation') {
      return 1;
    }
    if (item.memberKind === 'manager') {
      return 2;
    }
    return 3;
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
  const shouldInlineFieldKind =
    (item.memberKind === 'field' ||
      item.memberKind === 'relation' ||
      item.memberKind === 'reverse_relation') ||
    item.source === ANNOTATED_MEMBER_SOURCE;
  if (
    shouldInlineFieldKind &&
    (item.fieldKind !== undefined || item.detail.length > 0)
  ) {
    return {
      label: `${item.name} (${item.fieldKind ?? item.detail})`,
      description: 'Django model',
    };
  }

  if (
    receiver.kind !== 'instance' &&
    (item.memberKind === 'method' ||
      item.memberKind === 'manager' ||
      item.memberKind === 'property')
  ) {
    return {
      label: item.name,
      description: 'Django',
    };
  }

  return item.name;
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
  index: number
): string {
  return `\u0000django-${ormMemberCompletionPriority(item, receiver)
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
  index: number
): boolean {
  if (index !== 0) {
    return false;
  }

  if (receiver.kind === 'instance') {
    return item.memberKind === 'field' || item.memberKind === 'relation';
  }

  if (
    item.memberKind === 'method' &&
    PREFERRED_MANAGER_MEMBER_METHOD_PRIORITY.has(item.name)
  ) {
    return true;
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
    return undefined;
  }

  const [, method, , currentValue] = match;
  const callContext = querysetStringCallContext(
    document.getText(),
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
    document.getText(),
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
    document.getText(),
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
    document.getText(),
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
    document.getText(),
    cursorOffset
  );
  const callContext = expressionStringArgumentCallContext(
    document.getText(),
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

  const fullText = document.getText();
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
  const fullText = document.getText();
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

  const fullText = document.getText();
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
    document.getText(),
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
        document.getText(),
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
      document.getText(),
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
    document.getText(),
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
      document.getText(),
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
      document.getText(),
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

  const fullText = document.getText();
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
  const fullText = document.getText();
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

  const fullText = document.getText();
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
      document.getText(),
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

async function resolveOrmInstanceHoverAtPosition(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Hover | undefined> {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const hoveredWord = document.getText(wordRange);
  if (/^[A-Z]/.test(hoveredWord)) {
    return undefined;
  }

  const ormReceiver = await resolveOrmReceiverAtOffset(
    daemon,
    document,
    hoveredWord,
    document.offsetAt(position),
    new Set()
  );
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
    `**${hoveredWord}**: \`${target.objectName}\` instance\n\n`
  );
  markdown.appendMarkdown(`Model: \`${target.label}\`\n\n`);
  markdown.appendMarkdown(`Module: \`${target.module}\``);
  appendImportFilePath(markdown, target.filePath);
  return new vscode.Hover(markdown, wordRange);
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

function resetProviderResolutionCaches(): void {
  allRelationTargetsCache = new WeakMap<AnalysisDaemon, Promise<RelationTargetsResult>>();
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

async function listLookupPathCompletionsFast(
  daemon: AnalysisDaemon,
  baseModelLabel: string,
  prefix: string,
  method: string
): Promise<LookupPathCompletionsResult> {
  if (process.env.DJLS_ENABLE_LOCAL_LOOKUP_FAST_PATH === '1') {
    return (
      daemon.listLookupPathCompletionsLocal(baseModelLabel, prefix, method) ??
      await daemon.listLookupPathCompletions(baseModelLabel, prefix, method)
    );
  }

  return daemon.listLookupPathCompletions(baseModelLabel, prefix, method);
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

function buildOrmMemberHover(
  memberName: string,
  receiver: OrmReceiverInfo,
  resolution: OrmMemberResolution
): vscode.Hover | undefined {
  if (!resolution.resolved || !resolution.item) {
    return undefined;
  }

  const markdown = buildOrmMemberMarkdown(resolution.item, receiver);
  markdown.appendMarkdown(`\n\nResolved from member access \`${memberName}\`.`);
  return new vscode.Hover(markdown);
}

function buildOrmMemberMarkdown(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${item.name}**\n\n`);
  markdown.appendMarkdown(`Receiver kind: \`${receiver.kind}\`\n\n`);
  markdown.appendMarkdown(`Receiver model: \`${receiver.modelLabel}\`\n\n`);
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

function findRelationDiagnosticContexts(
  document: vscode.TextDocument
): RelationDiagnosticContext[] {
  const contexts: RelationDiagnosticContext[] = [];

  for (let line = 0; line < document.lineCount; line += 1) {
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

function findLookupDiagnosticContexts(
  document: vscode.TextDocument
): LookupDiagnosticContext[] {
  const contexts: LookupDiagnosticContext[] = [];
  const seen = new Set<string>();

  for (let line = 0; line < document.lineCount; line += 1) {
    const lineText = document.lineAt(line).text;
    const lineStartOffset = document.offsetAt(new vscode.Position(line, 0));
    const excludedWordRanges: Array<{ start: number; end: number }> = [];

    for (const match of lineText.matchAll(LOOKUP_HOVER_PATTERN)) {
      const [, method, , value] = match;
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      const absoluteStart = lineStartOffset + start;
      const callContext = querysetStringCallContext(document.getText(), absoluteStart);
      if (!callContext || callContext.method !== method) {
        continue;
      }

      const range = new vscode.Range(line, start, line, start + value.length);
      const key = `${range.start.line}:${range.start.character}:${value}:${method}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      contexts.push({
        receiverExpression: callContext.receiverExpression,
        method,
        value,
        range,
      });
    }

    for (const match of lineText.matchAll(PREFETCH_LOOKUP_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      const absoluteStart = lineStartOffset + start;
      const callContext = prefetchLookupCallContext(document.getText(), absoluteStart);
      if (!callContext) {
        continue;
      }

      const range = new vscode.Range(line, start, line, start + value.length);
      const key = `${range.start.line}:${range.start.character}:${value}:${callContext.method}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      contexts.push({
        receiverExpression: callContext.receiverExpression,
        method: callContext.method,
        value,
        range,
      });
    }

    for (const match of lineText.matchAll(LOOKUP_DICT_KEY_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      const end = start + value.length;
      excludedWordRanges.push({ start, end });

      if (isDynamicLookupDictKey(value)) {
        continue;
      }

      const callContext = unpackedLookupDictCallContext(
        document.getText(),
        lineStartOffset + start,
        lineStartOffset + end
      );
      if (!callContext) {
        continue;
      }

      const range = new vscode.Range(line, start, line, end);
      const key = `${range.start.line}:${range.start.character}:${value}:${callContext.method}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      contexts.push({
        receiverExpression: callContext.receiverExpression,
        method: callContext.method,
        value,
        range,
      });
    }

    for (const match of lineText.matchAll(F_EXPRESSION_HOVER_PATTERN)) {
      const value = match[2];
      const prefix = match[0];
      const localOffset = prefix.lastIndexOf(value);
      const start = (match.index ?? 0) + localOffset;
      const absoluteStart = lineStartOffset + start;
      const callContext = fExpressionCallContext(document.getText(), absoluteStart);
      if (!callContext) {
        continue;
      }

      const range = new vscode.Range(line, start, line, start + value.length);
      const key = `${range.start.line}:${range.start.character}:${value}:${F_EXPRESSION_METHOD}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      contexts.push({
        receiverExpression: callContext.receiverExpression,
        method: F_EXPRESSION_METHOD,
        value,
        range,
      });
    }

    for (const match of lineText.matchAll(EXPRESSION_STRING_HOVER_PATTERN)) {
      const value = match[2];
      const start = (match.index ?? 0) + 1;
      const absoluteStart = lineStartOffset + start;
      const absoluteEnd = absoluteStart + value.length + 1;
      const callContext = expressionStringArgumentCallContext(
        document.getText(),
        absoluteStart,
        absoluteEnd
      );
      if (!callContext) {
        continue;
      }

      const method = expressionPathMethodName(callContext.expressionName);
      const range = new vscode.Range(line, start, line, start + value.length);
      const key = `${range.start.line}:${range.start.character}:${value}:${method}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      contexts.push({
        receiverExpression: callContext.receiverExpression,
        method,
        value,
        range,
      });
    }

    for (const match of lineText.matchAll(/[A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*/g)) {
      const start = match.index ?? 0;
      const value = match[0];
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

  return contexts;
}

function findDirectFieldDiagnosticContexts(
  document: vscode.TextDocument
): DirectFieldDiagnosticContext[] {
  const contexts: DirectFieldDiagnosticContext[] = [];
  const seen = new Set<string>();

  for (let line = 0; line < document.lineCount; line += 1) {
    const lineText = document.lineAt(line).text;

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
  document: vscode.TextDocument
): SchemaFieldDiagnosticContext[] {
  const contexts: SchemaFieldDiagnosticContext[] = [];
  const seen = new Set<string>();

  for (let line = 0; line < document.lineCount; line += 1) {
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
  document: vscode.TextDocument
): MetaConstraintLookupDiagnosticContext[] {
  const contexts: MetaConstraintLookupDiagnosticContext[] = [];
  const seen = new Set<string>();

  for (let line = 0; line < document.lineCount; line += 1) {
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
  document: vscode.TextDocument
): BulkUpdateFieldListDiagnosticContext[] {
  const contexts: BulkUpdateFieldListDiagnosticContext[] = [];
  const seen = new Set<string>();

  for (let line = 0; line < document.lineCount; line += 1) {
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
  if (resolution.resolved) {
    return undefined;
  }

  if (resolution.reason === 'empty') {
    return undefined;
  }

  let message: string | undefined;
  if (resolution.reason === 'segment_not_found' && resolution.missingSegment) {
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

    const dynamicReceiver = await resolveDynamicInstanceReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      new Set()
    );
    const staticReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      new Set()
    );
    const receiver = preferMemberReceiver(staticReceiver, dynamicReceiver);
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

    const dynamicReceiver = await resolveDynamicInstanceReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      new Set()
    );
    const staticReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      new Set()
    );
    const receiver = preferMemberReceiver(staticReceiver, dynamicReceiver);
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
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
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
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
    return undefined;
  }

  const visitKey = `${document.uri.toString()}:orm:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 12) {
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
      new Set()
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
      new Set()
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
          return preferAnnotatedMemberReceiver(
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
        return preferAnnotatedMemberReceiver(
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
    return undefined;
  }

  return resolveOrmReceiverAtOffset(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    visited
  );
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
    staticReceiver.modelLabel !== dynamicReceiver.modelLabel
  ) {
    return staticReceiver;
  }

  return dynamicReceiver ?? staticReceiver;
}

function preferAnnotatedMemberReceiver(
  resolvedReceiver: OrmReceiverInfo | undefined,
  annotatedReceiver: OrmReceiverInfo | undefined,
  objectReceiver: OrmReceiverInfo
): OrmReceiverInfo | undefined {
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

  return resolvedReceiver;
}

async function resolveDynamicInstanceReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
    return undefined;
  }

  const visitKey = `${document.uri.toString()}:dynamic-instance:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 12) {
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
      new Set()
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
  const parsedCall = parseCalledExpression(expression);
  if (!parsedCall) {
    return undefined;
  }

  // Fast path: try to resolve the full chain locally via surfaceIndex
  const chain = collectOrmMemberChain(expression);
  if (chain) {
    const hasUnsafe = chain.members.some(
      (m) => m === 'annotate' || m === 'alias'
    );
    const STANDARD_ORM_CHAIN_METHODS = new Set([
      'objects', 'all', 'filter', 'exclude', 'get', 'aggregate',
      'update', 'create', 'get_or_create', 'update_or_create',
      'values', 'values_list', 'order_by', 'only', 'defer',
      'select_related', 'prefetch_related', 'distinct', 'reverse',
      'none', 'union', 'intersection', 'difference', 'using',
      'first', 'last', 'earliest', 'latest', 'count', 'exists',
      'bulk_create', 'bulk_update', 'in_bulk', 'iterator',
      'delete', 'dates', 'datetimes', 'raw',
    ]);
    const allStandard = chain.members.every((m) => STANDARD_ORM_CHAIN_METHODS.has(m));
    if (!hasUnsafe && allStandard) {
      const baseLabel = daemon.modelLabelByName.get(chain.base);
      if (baseLabel) {
        const localResult = daemon.resolveOrmMemberChainLocal(
          baseLabel,
          'model_class',
          chain.members
        );
        if (localResult.resolved && localResult.modelLabel && localResult.receiverKind) {
          if (isOrmReceiverKind(localResult.receiverKind)) {
            return {
              kind: localResult.receiverKind,
              modelLabel: localResult.modelLabel,
              managerName: localResult.managerName,
            };
          }
        }
        // Fall back to daemon IPC if local resolution failed
        const ipcResult = await daemon.resolveOrmMemberChain(
          baseLabel,
          'model_class',
          chain.members
        );
        if (ipcResult.resolved && ipcResult.modelLabel && ipcResult.receiverKind) {
          if (isOrmReceiverKind(ipcResult.receiverKind)) {
            return {
              kind: ipcResult.receiverKind,
              modelLabel: ipcResult.modelLabel,
              managerName: ipcResult.managerName,
            };
          }
        }
      }
    }
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

async function resolveOrmReceiverFromFunctionSource(
  daemon: AnalysisDaemon,
  functionSource: FunctionDefinitionSource,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
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
    .join(',')}`;
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
  return resolveBaseModelLabelForReceiverAtOffset(
    daemon,
    document,
    receiverExpression,
    document.offsetAt(position),
    new Set()
  );
}

async function resolveLookupReceiverInfoForReceiver(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  position: vscode.Position
): Promise<OrmReceiverInfo | undefined> {
  return resolveLookupReceiverInfoForReceiverAtOffset(
    daemon,
    document,
    receiverExpression,
    document.offsetAt(position),
    new Set()
  );
}

async function resolveLookupReceiverInfoForReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  const resolvedReceiver = await resolveLookupReceiverAtOffset(
    daemon,
    document,
    receiverExpression,
    beforeOffset,
    visited
  );
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
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
    return undefined;
  }

  const visitKey = `${document.uri.toString()}:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 8) {
    return undefined;
  }
  visited.add(visitKey);

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (memberAccess) {
    const objectReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      new Set()
    );
    const annotatedMemberReceiver = await resolveAnnotatedReceiverForMemberAccess(
      daemon,
      document,
      memberAccess.objectExpression,
      memberAccess.memberName,
      beforeOffset,
      new Set()
    );
    if (
      annotatedMemberReceiver &&
      (!objectReceiver ||
        annotatedMemberReceiver.modelLabel !== objectReceiver.modelLabel)
    ) {
      return annotatedMemberReceiver.modelLabel;
    }
  }

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
    return undefined;
  }

  return resolveBaseModelLabelForReceiverAtOffset(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    visited
  );
}

function asLookupReceiver(
  receiver: OrmReceiverInfo | undefined
): OrmReceiverInfo | undefined {
  if (!receiver || !LOOKUP_RECEIVER_KINDS.has(receiver.kind)) {
    return undefined;
  }

  return receiver;
}

async function resolveLookupReceiverAtOffset(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  receiverExpression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  const normalizedExpression = normalizeReceiverExpression(receiverExpression);
  if (!normalizedExpression) {
    return undefined;
  }

  const visitKey = `${document.uri.toString()}:lookup:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 12) {
    return undefined;
  }
  visited.add(visitKey);

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (memberAccess) {
    const lookupObjectReceiver = await resolveLookupReceiverAtOffset(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      visited
    );
    const ormObjectReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      new Set()
    );
    const objectReceiver = lookupObjectReceiver ?? ormObjectReceiver;
    const annotatedMemberReceiver = asLookupReceiver(
      await resolveAnnotatedReceiverForMemberAccess(
        daemon,
        document,
        memberAccess.objectExpression,
        memberAccess.memberName,
        beforeOffset,
        new Set()
      )
    );
    if (objectReceiver) {
      const localRes4 = daemon.resolveOrmMemberLocal(
        objectReceiver.modelLabel, objectReceiver.kind, memberAccess.memberName
      );
      if (localRes4) {
        const lr = asLookupReceiver(receiverFromOrmMemberResolution(localRes4));
        if (lr) return preferAnnotatedMemberReceiver(lr, annotatedMemberReceiver, objectReceiver);
      }
      const resolution = await daemon.resolveOrmMember(
        objectReceiver.modelLabel,
        objectReceiver.kind,
        memberAccess.memberName,
        objectReceiver.managerName
      );
      const resolvedReceiver = asLookupReceiver(
        receiverFromOrmMemberResolution(resolution)
      );
      if (resolvedReceiver) {
        return preferAnnotatedMemberReceiver(
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

  const callResolvedReceiver = await resolveLookupReceiverFromCallExpression(
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

  const loopTargetReceiver = asLookupReceiver(
    await resolveOrmReceiverFromLoopTarget(
      daemon,
      document,
      rootIdentifier,
      beforeOffset,
      visited
    )
  );
  if (loopTargetReceiver) {
    return loopTargetReceiver;
  }

  const annotatedReceiver = asLookupReceiver(
    await resolveAnnotatedReceiverForIdentifier(
      daemon,
      document,
      rootIdentifier,
      beforeOffset
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
    return undefined;
  }

  return resolveLookupReceiverAtOffset(
    daemon,
    document,
    assignment.expression,
    assignment.offset,
    visited
  );
}

async function resolveLookupReceiverFromCallExpression(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  expression: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
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
    const resolution = await daemon.resolveOrmMember(
      objectReceiver.modelLabel,
      objectReceiver.kind,
      parsedCall.memberName,
      objectReceiver.managerName
    );
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
  const simpleName = symbol.includes('.') ? symbol.split('.').at(-1)! : symbol;
  const localLabel = daemon.modelLabelByName.get(simpleName);
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

  return resolveModelLabelFromFunctionReturnAnnotation(daemon, functionSource);
}

async function resolveModelLabelFromClassMethodSource(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string,
  visited: Set<string>
): Promise<string | undefined> {
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

async function resolveClassDefinitionFromBaseClasses(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  methodName: string,
  visitedClasses: Set<string>
): Promise<ClassDefinitionSource | undefined> {
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
      items.set(functionDef.name, {
        name: functionDef.name,
        kind,
        detail: `${kind} · ${qualifiedClassName}`,
        filePath: document.uri.fsPath,
        line: line + 1,
        column: memberColumn(lineText, functionDef.name),
      });
      continue;
    }

    if (!enclosingFunction) {
      const classAttributeMatch = trimmed.match(
        /^([A-Za-z_][\w]*)\s*(?::\s*[^=]+)?=\s*.+$/
      );
      const annotatedAttributeMatch = trimmed.match(
        /^([A-Za-z_][\w]*)\s*:\s*.+$/
      );
      const attributeName =
        classAttributeMatch?.[1] ?? annotatedAttributeMatch?.[1];
      if (attributeName) {
        items.set(attributeName, {
          name: attributeName,
          kind: 'attribute',
          detail: `attribute · ${qualifiedClassName}`,
          filePath: document.uri.fsPath,
          line: line + 1,
          column: memberColumn(lineText, attributeName),
        });
      }
      continue;
    }

    const selfAttributeMatch = trimmed.match(
      /^self\.([A-Za-z_][\w]*)\s*(?::\s*[^=]+)?=\s*.+$/
    );
    if (selfAttributeMatch) {
      const attributeName = selfAttributeMatch[1];
      if (!items.has(attributeName)) {
        items.set(attributeName, {
          name: attributeName,
          kind: 'attribute',
          detail: `instance attribute · ${qualifiedClassName}`,
          filePath: document.uri.fsPath,
          line: line + 1,
          column: memberColumn(lineText, attributeName),
        });
      }
    }
  }

  return [...items.values()];
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

async function resolveImportedModelDefinitionDocument(
  daemon: AnalysisDaemon,
  moduleName: string,
  symbolName: string
): Promise<{ document: vscode.TextDocument; symbolName: string } | undefined> {
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
    const lineText = document.lineAt(line).text;
    const classMatch = lineText.match(CLASS_DEFINITION_PATTERN);
    if (classMatch && !classesByName.has(classMatch[2])) {
      classesByName.set(classMatch[2], buildClassDefinition(document, line, classMatch));
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
    const match = document.lineAt(line).text.match(CLASS_DEFINITION_PATTERN);
    if (!match) {
      continue;
    }

    const classDef = buildClassDefinition(document, line, match);
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
  const match = lineText.match(CLASS_DEFINITION_PATTERN);
  if (!match) {
    return undefined;
  }

  const classDef = buildClassDefinition(document, position.line, match);
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
    const match = document.lineAt(line).text.match(CLASS_DEFINITION_PATTERN);
    if (!match) {
      continue;
    }

    const classDef = buildClassDefinition(document, line, match);
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

function buildClassDefinition(
  document: vscode.TextDocument,
  line: number,
  match: RegExpMatchArray
): PythonClassDefinition {
  const indent = match[1].length;
  return {
    name: match[2],
    baseExpressions: splitTopLevelExpressions(match[3] ?? ''),
    line,
    indent,
    endLine: findBlockEndLine(document, line, indent),
  };
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
): { base: string; members: string[] } | undefined {
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

  // current should be a simple identifier (the model class name)
  const base = current.trim();
  if (!/^[A-Za-z_][\w]*$/.test(base)) {
    return undefined;
  }

  return { base, members };
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

    for (const prefix of ['return', 'await']) {
      if (!current.startsWith(prefix) || current.length === prefix.length) {
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

function findNearestLoopIterableExpression(
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number
): { expression: string; offset: number } | undefined {
  const beforePosition = document.positionAt(beforeOffset);

  for (let line = beforePosition.line; line >= 0; line -= 1) {
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
  const fullText = document.getText();

  for (let index = beforeOffset - 1; index >= 0; index -= 1) {
    const openingDelimiter = fullText[index];
    const closingDelimiter =
      openingDelimiter === '(' ? ')'
      : openingDelimiter === '[' ? ']'
      : openingDelimiter === '{' ? '}'
      : undefined;
    if (!closingDelimiter) {
      continue;
    }

    const closingIndex = findMatchingClosingDelimiter(
      fullText,
      index,
      openingDelimiter,
      closingDelimiter
    );
    if (closingIndex === undefined || closingIndex < beforeOffset) {
      continue;
    }

    const bodyStartOffset = index + 1;
    const body = fullText.slice(bodyStartOffset, closingIndex);
    const clauses = parseComprehensionClauses(body).filter((clause) =>
      loopTargetContainsIdentifier(clause.target, variableName)
    );
    if (clauses.length === 0) {
      continue;
    }

    const relativeOffset = beforeOffset - bodyStartOffset;
    const inScopeClauses = clauses.filter(
      (clause) => clause.clauseStart <= relativeOffset
    );
    const matchedClause =
      inScopeClauses.at(-1) ??
      clauses.at(-1);
    if (!matchedClause) {
      continue;
    }

    return {
      expression: matchedClause.iterable,
      offset: bodyStartOffset + matchedClause.iterableStart,
    };
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

  for (let line = beforePosition.line; line >= 0; line -= 1) {
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
      beforePosition.line,
      rawExpression
    );
    if (!collected.expression) {
      continue;
    }

    const expressionOffset = document.offsetAt(new vscode.Position(line, 0));
    return {
      expression: collected.expression,
      offset: expressionOffset,
    };
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

  for (let line = beforePosition.line; line >= 0; line -= 1) {
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

async function resolveTypeAnnotationForMemberAccess(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  objectExpression: string,
  memberName: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<TypeAnnotationSource | undefined> {
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
  };
}

async function resolveReceiverFromSpecialClassGenericType(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  baseAnnotation: string,
  modelAnnotation: string | undefined,
  beforeOffset: number
): Promise<OrmReceiverInfo | undefined> {
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
  };
}

async function resolveModelLabelFromSpecialClassTypeAnnotation(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  annotation: string,
  beforeOffset: number
): Promise<string | undefined> {
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
  const directBaseLabel = await resolveDirectModelLabelFromSpecialClassBaseExpressions(
    daemon,
    classSource,
    specialKind,
  );
  if (directBaseLabel) {
    return directBaseLabel;
  }

  const candidateModelNames = specialClassModelNameCandidates(
    classSource,
    specialKind
  );
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

async function resolveDirectModelLabelFromSpecialClassBaseExpressions(
  daemon: AnalysisDaemon,
  classSource: ClassDefinitionSource,
  specialKind: SpecialClassKind
): Promise<string | undefined> {
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

function compactPythonExpression(value: string): string {
  return value.replace(/\s+/g, '');
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

  const argumentPrefix = text.slice(argumentStartOffset, tokenStartOffset);
  if (hasTopLevelEquals(argumentPrefix)) {
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
