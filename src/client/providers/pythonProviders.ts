import * as path from 'path';
import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import type {
  ExportOriginResolution,
  LookupPathItem,
  LookupPathResolution,
  ModuleResolution,
  OrmMemberItem,
  OrmMemberResolution,
  OrmReceiverKind,
  RelationTargetItem,
  RelationTargetResolution,
} from '../protocol';

const PYTHON_SELECTOR: vscode.DocumentSelector = [
  { language: 'python', scheme: 'file' },
];

const RELATION_COMPLETION_PATTERN =
  /(?:[A-Za-z_][\w.]*\.)?(?:ForeignKey|OneToOneField|ManyToManyField)\(\s*(['"])([\w.]*)$/;
const RELATION_HOVER_PATTERN =
  /(?:[A-Za-z_][\w.]*\.)?(?:ForeignKey|OneToOneField|ManyToManyField)\(\s*(['"])([\w.]+)\1/g;
const IMPORT_FROM_PATTERN = /^\s*from\s+([.A-Za-z_][\w.]*)\s+import\s+(.+)$/;
const IMPORT_SPEC_PATTERN = /([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?/g;
const IMPORT_MODULE_PATTERN = /^\s*import\s+(.+)$/;
const IMPORT_MODULE_SPEC_PATTERN = /([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_][\w]*))?/g;
const LOOKUP_METHOD_PATTERN =
  'values|values_list|order_by|only|defer|select_related|prefetch_related';
const KEYWORD_LOOKUP_METHOD_PATTERN = 'filter|exclude|get';
const QUERYSET_RECEIVER_PATTERN =
  String.raw`[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*|\([^()]*\))*`;
const LOOKUP_COMPLETION_PATTERN = new RegExp(
  String.raw`\.(${LOOKUP_METHOD_PATTERN})\(\s*(['"])([-\w.]*)$`
);
const LOOKUP_HOVER_PATTERN = new RegExp(
  String.raw`\.(${LOOKUP_METHOD_PATTERN})\(\s*(['"])([-\w.]+)\2`,
  'g'
);
const DJANGO_FIELD_PRIORITY_METHODS = new Set(['filter', 'exclude', 'get']);
const LOOKUP_RECEIVER_KINDS = new Set<OrmReceiverKind>([
  'model_class',
  'manager',
  'queryset',
  'related_manager',
]);
const LOOKUP_OPERATOR_PRIORITY = new Map(
  [
    'exact',
    'in',
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
const KEYWORD_LOOKUP_CALLEE_PATTERN = new RegExp(
  String.raw`(${QUERYSET_RECEIVER_PATTERN})\.(${KEYWORD_LOOKUP_METHOD_PATTERN})$`
);
const STRING_LOOKUP_CALLEE_PATTERN = new RegExp(
  String.raw`(${QUERYSET_RECEIVER_PATTERN})\.(${LOOKUP_METHOD_PATTERN})$`
);
const CLASS_DEFINITION_PATTERN =
  /^(\s*)class\s+([A-Za-z_][\w]*)\s*(?:\((.*)\))?\s*:/;
const FUNCTION_DEFINITION_PATTERN =
  /^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?\s*:/;
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

interface RelationDiagnosticContext {
  value: string;
  range: vscode.Range;
}

interface LookupDiagnosticContext extends LookupLiteral {
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

type ParsedCallExpression =
  | { kind: 'function'; functionName: string }
  | { kind: 'member'; objectExpression: string; memberName: string };

interface OrmReceiverInfo {
  kind: OrmReceiverKind;
  modelLabel: string;
  managerName?: string;
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
  const diagnosticTimers = new Map<string, NodeJS.Timeout>();

  const scheduleDiagnosticsRefresh = (
    document: vscode.TextDocument,
    delayMs = 200
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }

    const key = document.uri.toString();
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

  const refreshAllDiagnostics = (): void => {
    for (const document of vscode.workspace.textDocuments) {
      scheduleDiagnosticsRefresh(document, 0);
    }
  };

  const refreshDiagnostics = async (
    document: vscode.TextDocument
  ): Promise<void> => {
    if (!isPythonDocument(document)) {
      diagnosticCollection.delete(document.uri);
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
        const resolution = await daemon.resolveRelationTarget(context.value);
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

    for (const context of findLookupDiagnosticContexts(document)) {
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
          context.method
        );
        if (!resolution.resolved) {
          const partialCompletions = await daemon.listLookupPathCompletions(
            baseModelLabel,
            context.value,
            context.method
          );
          if (partialCompletions.resolved && partialCompletions.items.length > 0) {
            continue;
          }
        }
        const diagnostic = buildLookupDiagnostic(
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

    diagnosticCollection.set(document.uri, diagnostics);
  };

  const completionProvider = vscode.languages.registerCompletionItemProvider(
    PYTHON_SELECTOR,
    {
      async provideCompletionItems(document, position) {
        const relationContext = relationCompletionContext(document, position);
        if (relationContext) {
          try {
            await daemon.ensureStarted(document.uri);
            const result = await daemon.listRelationTargets(relationContext.prefix);

            return result.items.map((item) => {
              const completion = new vscode.CompletionItem(
                item.label,
                vscode.CompletionItemKind.Class
              );
              completion.detail = `${item.module} (${item.source})`;
              completion.insertText = item.label;
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
          keywordLookupCompletionContext(document, position);

        try {
          await daemon.ensureStarted(document.uri);
          if (lookupContext) {
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              lookupContext.receiverExpression,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const result = await daemon.listLookupPathCompletions(
              baseModelLabel,
              lookupContext.prefix,
              lookupContext.method
            );
            const sortedItems = prioritizeLookupCompletionItems(
              result.items,
              lookupContext.method
            );

            return sortedItems.map((item, index) => {
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
          }

          const memberContext = await resolveOrmMemberCompletionContext(
            daemon,
            document,
            position
          );
          if (!memberContext) {
            return undefined;
          }

          const result = await daemon.listOrmMemberCompletions(
            memberContext.receiver.modelLabel,
            memberContext.receiver.kind,
            memberContext.prefix,
            memberContext.receiver.managerName
          );
          const sortedItems = prioritizeOrmMemberCompletionItems(
            result.items,
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
        } catch {
          return undefined;
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

  const hoverProvider = vscode.languages.registerHoverProvider(
    PYTHON_SELECTOR,
    {
      async provideHover(document, position) {
        const relationLiteral = relationHoverLiteral(document, position);
        if (relationLiteral) {
          try {
            await daemon.ensureStarted(document.uri);
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
          keywordLookupLiteral(document, position);
        if (lookupLiteral) {
          try {
            await daemon.ensureStarted(document.uri);
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              lookupLiteral.receiverExpression,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              lookupLiteral.value,
              lookupLiteral.method
            );
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

        try {
          await daemon.ensureStarted(document.uri);
          const memberContext = await resolveOrmMemberAccessContext(
            daemon,
            document,
            position
          );
          if (memberContext) {
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

        const importReference = importReferenceAtPosition(document, position);
        if (!importReference) {
          return undefined;
        }

        try {
          await daemon.ensureStarted(document.uri);
          const importHover = await buildImportHover(
            daemon,
            importReference
          );
          if (importHover) {
            return importHover;
          }
        } catch {
          return undefined;
        }

        return undefined;
      },
    }
  );

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    PYTHON_SELECTOR,
    {
      async provideDefinition(document, position) {
        const relationLiteral = relationHoverLiteral(document, position);
        if (relationLiteral) {
          try {
            await daemon.ensureStarted(document.uri);
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
          keywordLookupLiteral(document, position);
        if (lookupLiteral) {
          try {
            await daemon.ensureStarted(document.uri);
            const baseModelLabel = await resolveBaseModelLabelForReceiver(
              daemon,
              document,
              lookupLiteral.receiverExpression,
              position
            );
            if (!baseModelLabel) {
              return undefined;
            }

            const resolution = await daemon.resolveLookupPath(
              baseModelLabel,
              lookupLiteral.value,
              lookupLiteral.method
            );
            const location = definitionLocationFromLookupResolution(resolution);
            if (location) {
              return location;
            }
          } catch {
            return undefined;
          }
        }

        try {
          await daemon.ensureStarted(document.uri);
          const memberContext = await resolveOrmMemberAccessContext(
            daemon,
            document,
            position
          );
          if (memberContext) {
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

        const importReference = importReferenceAtPosition(document, position);
        if (!importReference) {
          return undefined;
        }

        try {
          await daemon.ensureStarted(document.uri);
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
      },
    }
  );

  refreshAllDiagnostics();

  return [
    completionProvider,
    hoverProvider,
    definitionProvider,
    diagnosticCollection,
    vscode.workspace.onDidOpenTextDocument((document) => {
      scheduleDiagnosticsRefresh(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      scheduleDiagnosticsRefresh(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnosticCollection.delete(document.uri);
      const key = document.uri.toString();
      const timer = diagnosticTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        diagnosticTimers.delete(key);
      }
    }),
    daemon.onDidChangeState(() => {
      refreshAllDiagnostics();
    }),
    new vscode.Disposable(() => {
      for (const timer of diagnosticTimers.values()) {
        clearTimeout(timer);
      }
      diagnosticTimers.clear();
    }),
  ];
}

function lookupCompletionLabel(
  item: LookupPathItem
): string | vscode.CompletionItemLabel {
  if (
    item.fieldKind === 'lookup_operator' ||
    item.fieldKind === 'lookup_transform'
  ) {
    return item.name;
  }

  return {
    label: item.name,
    description: 'Django',
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
    return `Django lookup · ${item.modelLabel}`;
  }
  if (item.fieldKind === 'lookup_transform') {
    return `Django transform · ${item.modelLabel}`;
  }

  return `${item.fieldKind} · ${item.modelLabel}${item.relatedModelLabel ? ` -> ${item.relatedModelLabel}` : ''}`;
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
  if (!DJANGO_FIELD_PRIORITY_METHODS.has(method)) {
    return undefined;
  }

  return `0-${lookupCompletionPriority(item)}-${index.toString().padStart(4, '0')}-${item.name}`;
}

function shouldPreselectLookupCompletion(
  method: string,
  item: LookupPathItem,
  index: number
): boolean {
  return (
    DJANGO_FIELD_PRIORITY_METHODS.has(method) &&
    item.fieldKind !== 'lookup_operator' &&
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

  if (item.memberKind === 'manager') {
    return 0;
  }
  if (item.memberKind === 'field' || item.memberKind === 'relation') {
    return 1;
  }
  if (item.memberKind === 'reverse_relation') {
    return 2;
  }
  return 3;
}

function ormMemberCompletionLabel(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo
): string | vscode.CompletionItemLabel {
  if (
    receiver.kind === 'instance' &&
    (item.memberKind === 'field' ||
      item.memberKind === 'relation' ||
      item.memberKind === 'reverse_relation')
  ) {
    return {
      label: `${item.name} (${item.fieldKind ?? item.detail})`,
      description: 'Django model',
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
  return `${ormMemberCompletionPriority(item, receiver)
    .toString()
    .padStart(4, '0')}-${index
    .toString()
    .padStart(4, '0')}-${item.name}`;
}

function shouldPreselectOrmMemberCompletion(
  item: OrmMemberItem,
  receiver: OrmReceiverInfo,
  index: number
): boolean {
  return (
    receiver.kind === 'instance' &&
    (item.memberKind === 'field' || item.memberKind === 'relation') &&
    index === 0
  );
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

function keywordLookupCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupContext | undefined {
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

function keywordLookupLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): LookupLiteral | undefined {
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

function relationHoverLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): { value: string } | undefined {
  const lineText = document.lineAt(position.line).text;
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w.]*/);
  if (!wordRange) {
    return undefined;
  }

  const word = document.getText(wordRange);
  for (const match of lineText.matchAll(RELATION_HOVER_PATTERN)) {
    const value = match[2];
    const prefix = match[0];
    const localOffset = prefix.lastIndexOf(value);
    const start = (match.index ?? 0) + localOffset;
    const end = start + value.length;

    if (
      position.character >= start &&
      position.character <= end &&
      value === word
    ) {
      return { value };
    }
  }

  return undefined;
}

function importReferenceAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): ImportReference | undefined {
  const lineText = document.lineAt(position.line).text;
  const lineMatch = lineText.match(IMPORT_FROM_PATTERN);
  if (lineMatch) {
    const [, rawModuleName, clauseText] = lineMatch;
    const moduleName = resolveImportedModuleName(document, rawModuleName);
    if (!moduleName) {
      return undefined;
    }

    const clauseStart = lineText.lastIndexOf(clauseText);
    if (clauseStart === -1) {
      return undefined;
    }

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
    if (!wordRange) {
      return undefined;
    }

    const hoveredWord = document.getText(wordRange);

    for (const match of clauseText.matchAll(IMPORT_SPEC_PATTERN)) {
      const importedName = match[1];
      const aliasName = match[2];
      const relativeStart = match.index ?? 0;
      const importedStart = clauseStart + relativeStart;
      const importedEnd = importedStart + importedName.length;

      if (
        hoveredWord === importedName &&
        position.character >= importedStart &&
        position.character <= importedEnd
      ) {
        return {
          kind: 'symbol',
          moduleName,
          symbol: importedName,
        };
      }

      if (aliasName) {
        const aliasOffset = match[0].lastIndexOf(aliasName);
        const aliasStart = clauseStart + relativeStart + aliasOffset;
        const aliasEnd = aliasStart + aliasName.length;

        if (
          hoveredWord === aliasName &&
          position.character >= aliasStart &&
          position.character <= aliasEnd
        ) {
          return {
            kind: 'symbol',
            moduleName,
            symbol: importedName,
          };
        }
      }
    }

    return undefined;
  }

  const importMatch = lineText.match(IMPORT_MODULE_PATTERN);
  if (!importMatch) {
    return undefined;
  }

  const clauseText = importMatch[1];
  const clauseStart = lineText.lastIndexOf(clauseText);
  if (clauseStart === -1) {
    return undefined;
  }

  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const hoveredWord = document.getText(wordRange);

  for (const match of clauseText.matchAll(IMPORT_MODULE_SPEC_PATTERN)) {
    const importedModule = match[1];
    const aliasName = match[2];
    const relativeStart = match.index ?? 0;
    const importedStart = clauseStart + relativeStart;
    const importedEnd = importedStart + importedModule.length;

    if (
      position.character >= importedStart &&
      position.character <= importedEnd &&
      importedModule.split('.').includes(hoveredWord)
    ) {
      return {
        kind: 'module',
        moduleName: importedModule,
      };
    }

    if (!aliasName) {
      continue;
    }

    const aliasOffset = match[0].lastIndexOf(aliasName);
    const aliasStart = clauseStart + relativeStart + aliasOffset;
    const aliasEnd = aliasStart + aliasName.length;
    if (
      hoveredWord === aliasName &&
      position.character >= aliasStart &&
      position.character <= aliasEnd
    ) {
      return {
        kind: 'module',
        moduleName: importedModule,
      };
    }
  }

  return undefined;
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

  return buildSymbolImportHover(target.resolution);
}

function buildSymbolImportHover(
  resolution: ExportOriginResolution
): vscode.Hover | undefined {
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

  if (resolution.viaModules.length > 1) {
    markdown.appendMarkdown(
      `\n\nResolution path: \`${resolution.viaModules.join(' -> ')}\``
    );
  }

  return new vscode.Hover(markdown);
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
  markdown.appendMarkdown(`Source: \`${item.source}\``);

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

function buildLookupItemMarkdown(
  item: LookupPathItem,
  method: string,
  baseModelLabel: string
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**${item.name}**\n\n`);
  markdown.appendMarkdown(`Method: \`${method}\`\n\n`);
  markdown.appendMarkdown(`Base model: \`${baseModelLabel}\`\n\n`);
  markdown.appendMarkdown(`Owner model: \`${item.modelLabel}\`\n\n`);
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

    for (const match of lineText.matchAll(/[A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*/g)) {
      const start = match.index ?? 0;
      const value = match[0];
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
  for (const candidate of ormMemberExpressionCandidates(
    document,
    prefixContext.startOffset,
    endOffset
  )) {
    const parsedAccess = parseTrailingMemberAccessCandidate(
      candidate,
      prefixContext.prefix
    );
    if (!parsedAccess) {
      continue;
    }

    const receiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      new Set()
    );
    if (!receiver) {
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
  for (const candidate of ormMemberExpressionCandidates(
    document,
    startOffset,
    endOffset
  )) {
    const parsedAccess = parseTrailingMemberAccessCandidate(candidate, memberName);
    if (!parsedAccess) {
      continue;
    }

    const receiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      parsedAccess.receiverExpression,
      endOffset,
      new Set()
    );
    if (!receiver) {
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
): string[] {
  const windowStartOffset = Math.max(0, endOffset - 4_000);
  const rawWindow = document.getText(
    new vscode.Range(
      document.positionAt(windowStartOffset),
      document.positionAt(endOffset)
    )
  );
  const localTokenStart = tokenStartOffset - windowStartOffset;
  const localEndOffset = endOffset - windowStartOffset;
  const candidateStarts = new Set<number>([0]);

  for (let index = 0; index < localTokenStart; index += 1) {
    if ('\n;=,:([{'.includes(rawWindow[index] ?? '')) {
      candidateStarts.add(index + 1);
    }
  }

  return [...candidateStarts]
    .sort((left, right) => right - left)
    .map((start) =>
      compactPythonExpression(
        rawWindow
          .slice(start, localEndOffset)
          .split('\n')
          .map((line) => stripTrailingComment(line))
          .join('\n')
          .trim()
      )
    )
    .filter((candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index);
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
      ? { receiverExpression, memberName }
      : undefined;
  }

  const memberAccess = splitTopLevelMemberAccess(candidate);
  if (!memberAccess || memberAccess.memberName !== memberName) {
    return undefined;
  }

  return {
    receiverExpression: memberAccess.objectExpression,
    memberName: memberAccess.memberName,
  };
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

  const visitKey = `${document.uri.toString()}:orm:${normalizedExpression}@${beforeOffset}`;
  if (visited.has(visitKey) || visited.size > 12) {
    return undefined;
  }
  visited.add(visitKey);

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

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (memberAccess) {
    const objectReceiver = await resolveOrmReceiverAtOffset(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      visited
    );
    if (objectReceiver) {
      const resolution = await daemon.resolveOrmMember(
        objectReceiver.modelLabel,
        objectReceiver.kind,
        memberAccess.memberName,
        objectReceiver.managerName
      );
      const resolvedReceiver = receiverFromOrmMemberResolution(resolution);
      if (resolvedReceiver) {
        return resolvedReceiver;
      }
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
    const resolution = await daemon.resolveOrmMember(
      objectReceiver.modelLabel,
      objectReceiver.kind,
      parsedCall.memberName,
      objectReceiver.managerName
    );
    const resolvedReceiver = receiverFromOrmMemberResolution(resolution);
    if (resolvedReceiver) {
      return resolvedReceiver;
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
  if (returnExpressions.length === 0) {
    return undefined;
  }

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

  return resolvedReceivers.size === 1
    ? [...resolvedReceivers.values()][0]
    : undefined;
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
  resolution: OrmMemberResolution
): OrmReceiverInfo | undefined {
  if (!resolution.resolved || !resolution.item) {
    return undefined;
  }

  return receiverFromOrmMemberItem(resolution.item);
}

function receiverFromOrmMemberItem(
  item: OrmMemberItem
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
  };
}

async function resolveOrmReceiverFromLoopTarget(
  daemon: AnalysisDaemon,
  document: vscode.TextDocument,
  variableName: string,
  beforeOffset: number,
  visited: Set<string>
): Promise<OrmReceiverInfo | undefined> {
  const loopIterable = findNearestLoopIterableExpression(
    document,
    variableName,
    beforeOffset
  );
  if (!loopIterable) {
    return undefined;
  }

  const iterableReceiver = await resolveOrmReceiverAtOffset(
    daemon,
    document,
    loopIterable.expression,
    loopIterable.offset,
    visited
  );
  const resolvedLoopReceiver = receiverFromIterableReceiver(iterableReceiver);
  if (resolvedLoopReceiver) {
    return resolvedLoopReceiver;
  }

  const iterableIdentifier = receiverRootIdentifier(loopIterable.expression);
  if (!iterableIdentifier) {
    return undefined;
  }

  const iterableTypeAnnotation = findTypeAnnotationForIdentifier(
    document,
    iterableIdentifier,
    loopIterable.offset
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
  return `${receiver.kind}:${receiver.modelLabel}:${receiver.managerName ?? ''}`;
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

  const memberAccess = splitTopLevelMemberAccess(normalizedExpression);
  if (memberAccess) {
    const objectReceiver = await resolveLookupReceiverAtOffset(
      daemon,
      document,
      memberAccess.objectExpression,
      beforeOffset,
      visited
    );
    if (objectReceiver) {
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
        return resolvedReceiver;
      }
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
      receiverFromOrmMemberResolution(resolution)
    );
    if (resolvedReceiver) {
      return resolvedReceiver;
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
  const targets = await daemon.listRelationTargets('');
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
  if (returnExpressions.length === 0) {
    return undefined;
  }

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

  return resolvedLabels.size === 1 ? [...resolvedLabels][0] : undefined;
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
    return resolveClassDefinitionSource(
      daemon,
      document,
      normalizedExpression,
      beforeOffset
    );
  }

  const parsedCall = parseCalledExpression(normalizedExpression);
  if (
    parsedCall &&
    parsedCall.kind === 'function' &&
    /^[A-Za-z_][\w]*$/.test(parsedCall.functionName)
  ) {
    return resolveClassDefinitionSource(
      daemon,
      document,
      parsedCall.functionName,
      beforeOffset
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

function findEnclosingFunctionDefinition(
  document: vscode.TextDocument,
  beforeOffset: number
): PythonFunctionDefinition | undefined {
  const targetLine = document.positionAt(beforeOffset).line;

  for (let line = targetLine; line >= 0; line -= 1) {
    const match = document.lineAt(line).text.match(FUNCTION_DEFINITION_PATTERN);
    if (!match) {
      continue;
    }

    const functionDef = buildFunctionDefinition(document, line, match);
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
  for (let line = 0; line < document.lineCount; line += 1) {
    const match = document.lineAt(line).text.match(CLASS_DEFINITION_PATTERN);
    if (!match || match[2] !== className) {
      continue;
    }

    return buildClassDefinition(document, line, match);
  }

  return undefined;
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
    const text = document.lineAt(line).text;
    const match = text.match(FUNCTION_DEFINITION_PATTERN);
    if (!match || match[2] !== methodName) {
      continue;
    }

    const indent = match[1].length;
    if (indent <= classDef.indent) {
      continue;
    }

    return buildFunctionDefinition(document, line, match);
  }

  return undefined;
}

function findTopLevelFunctionDefinition(
  document: vscode.TextDocument,
  functionName: string
): PythonFunctionDefinition | undefined {
  for (let line = 0; line < document.lineCount; line += 1) {
    const match = document.lineAt(line).text.match(FUNCTION_DEFINITION_PATTERN);
    if (!match || match[2] !== functionName || match[1].length !== 0) {
      continue;
    }

    return buildFunctionDefinition(document, line, match);
  }

  return undefined;
}

function buildFunctionDefinition(
  document: vscode.TextDocument,
  line: number,
  match: RegExpMatchArray
): PythonFunctionDefinition {
  const indent = match[1].length;
  return {
    name: match[2],
    line,
    indent,
    endLine: findBlockEndLine(document, line, indent),
  };
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
    expression: stripWrappingParentheses(parts.join(' ').trim()),
    endLine: currentLine,
  };
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
  let current = stripWrappingParentheses(value.trim());

  for (const prefix of ['return', 'await']) {
    if (!current.startsWith(prefix) || current.length === prefix.length) {
      continue;
    }

    const candidate = current.slice(prefix.length);
    if (!candidate || !/[A-Za-z_(]/.test(candidate[0])) {
      continue;
    }

    current = stripWrappingParentheses(candidate);
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

    const expressionOffset = document.offsetAt(new vscode.Position(line, 0));
    return {
      expression: rawExpression,
      offset: expressionOffset,
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

  const match = document
    .lineAt(functionDef.line)
    .text.match(FUNCTION_DEFINITION_PATTERN);
  if (!match) {
    return undefined;
  }

  for (const parameter of splitTopLevelExpressions(match[3] ?? '')) {
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
    if (OPTIONAL_TYPE_NAMES.has(genericType.base) && genericType.args[0]) {
      return resolveDirectReceiverFromTypeAnnotation(
        daemon,
        document,
        genericType.args[0],
        beforeOffset
      );
    }

    if (QUERYSET_TYPE_NAMES.has(genericType.base) && genericType.args[0]) {
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

    if (MANAGER_TYPE_NAMES.has(genericType.base) && genericType.args[0]) {
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

    if (RELATED_MANAGER_TYPE_NAMES.has(genericType.base) && genericType.args[0]) {
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

    return undefined;
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

  if (OPTIONAL_TYPE_NAMES.has(genericType.base) && genericType.args[0]) {
    return resolveIterableElementReceiverFromTypeAnnotation(
      daemon,
      document,
      genericType.args[0],
      beforeOffset
    );
  }

  if (ITERABLE_TYPE_NAMES.has(genericType.base) && genericType.args[0]) {
    return resolveDirectReceiverFromTypeAnnotation(
      daemon,
      document,
      genericType.args[0],
      beforeOffset
    );
  }

  if (
    (QUERYSET_TYPE_NAMES.has(genericType.base) ||
      RELATED_MANAGER_TYPE_NAMES.has(genericType.base)) &&
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

  for (const candidate of splitTopLevelTypeAlternatives(normalizedAnnotation)) {
    const strippedCandidate = stripStringLiteralQuotes(candidate);
    if (!strippedCandidate) {
      continue;
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
  let depth = 0;

  for (let index = 0; index <= value.length - keyword.length; index += 1) {
    const char = value[index];
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if ((char === ')' || char === ']' || char === '}') && depth > 0) {
      depth -= 1;
      continue;
    }

    if (depth === 0 && value.slice(index, index + keyword.length) === keyword) {
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

function collectImportBindings(
  document: vscode.TextDocument,
  beforeOffset: number
): ImportBindings {
  const symbols = new Map<string, { moduleName: string; symbolName: string }>();
  const modules = new Map<string, string>();
  const beforePosition = document.positionAt(beforeOffset);

  for (let line = 0; line <= beforePosition.line; line += 1) {
    const lineText = document.lineAt(line).text.trim();
    if (!lineText || lineText.startsWith('#')) {
      continue;
    }

    const fromMatch = lineText.match(IMPORT_FROM_PATTERN);
    if (fromMatch) {
      const [, rawModuleName, clauseText] = fromMatch;
      const moduleName = resolveImportedModuleName(document, rawModuleName);
      if (!moduleName) {
        continue;
      }
      for (const match of clauseText.matchAll(IMPORT_SPEC_PATTERN)) {
        const importedName = match[1];
        const aliasName = match[2] ?? importedName;
        symbols.set(aliasName, {
          moduleName,
          symbolName: importedName,
        });
      }
      continue;
    }

    const importMatch = lineText.match(IMPORT_MODULE_PATTERN);
    if (!importMatch) {
      continue;
    }

    for (const match of importMatch[1].matchAll(IMPORT_MODULE_SPEC_PATTERN)) {
      const importedModule = match[1];
      const aliasName = match[2] ?? importedModule.split('.').at(-1);
      if (!aliasName) {
        continue;
      }
      modules.set(aliasName, importedModule);
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
  if (
    !prefix.includes('__') &&
    (item.fieldKind === 'lookup_operator' || item.fieldKind === 'lookup_transform') &&
    item.name.includes('__')
  ) {
    return item.name.split('__', 1)[0];
  }

  return undefined;
}

function scanKeywordTokenStart(textBefore: string): number {
  let index = textBefore.length;
  while (index > 0 && /[A-Za-z0-9_]/.test(textBefore[index - 1])) {
    index -= 1;
  }
  return index;
}

function isLookupKeywordCandidate(value: string): boolean {
  return (
    value.length === 0 ||
    /^[A-Za-z_][\w]*(?:__[A-Za-z_][\w]*)*(?:__)?$/.test(value)
  );
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
  const openParenOffset = findEnclosingCallOpenParenOffset(
    text,
    tokenStartOffset
  );
  if (openParenOffset === undefined) {
    return undefined;
  }

  const calleeMatch = parseQuerysetCallee(
    text,
    openParenOffset,
    KEYWORD_LOOKUP_CALLEE_PATTERN
  );
  if (!calleeMatch) {
    return undefined;
  }

  const { receiverExpression, method } = calleeMatch;
  const argumentStartOffset = findCurrentArgumentStartOffset(
    text,
    openParenOffset,
    tokenStartOffset
  );
  const argumentPrefix = text.slice(argumentStartOffset, tokenStartOffset);
  if (hasTopLevelEquals(argumentPrefix)) {
    return undefined;
  }

  return {
    receiverExpression,
    method,
    argumentStartOffset,
    argumentEndOffset: findCurrentArgumentEndOffset(text, tokenEndOffset),
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

  return parseQuerysetCallee(text, openParenOffset, STRING_LOOKUP_CALLEE_PATTERN);
}

function parseQuerysetCallee(
  text: string,
  openParenOffset: number,
  pattern: RegExp
): { receiverExpression: string; method: string } | undefined {
  const calleeText = compactPythonExpression(text.slice(0, openParenOffset));
  const calleeMatch = calleeText.match(pattern);
  if (!calleeMatch) {
    return undefined;
  }

  return {
    receiverExpression: calleeMatch[1],
    method: calleeMatch[2],
  };
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
  let depth = 0;

  for (let index = tokenStartOffset - 1; index > openParenOffset; index -= 1) {
    const char = text[index];
    if (char === ')') {
      depth += 1;
      continue;
    }

    if (char === '(') {
      if (depth > 0) {
        depth -= 1;
      }
      continue;
    }

    if (char === ',' && depth === 0) {
      return index + 1;
    }
  }

  return openParenOffset + 1;
}

function findCurrentArgumentEndOffset(text: string, tokenEndOffset: number): number {
  let depth = 0;

  for (let index = tokenEndOffset; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
      continue;
    }

    if (char === ',' && depth === 0) {
      return index;
    }
  }

  return text.length;
}

function hasTopLevelEquals(text: string): boolean {
  return findTopLevelEqualsIndex(text) >= 0;
}

function findTopLevelEqualsIndex(text: string): number {
  let depth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')' && depth > 0) {
      depth -= 1;
      continue;
    }

    if (char === '=' && depth === 0) {
      return index;
    }
  }

  return -1;
}
