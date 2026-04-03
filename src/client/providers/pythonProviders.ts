import * as vscode from 'vscode';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import type {
  ExportOriginResolution,
  LookupPathItem,
  LookupPathResolution,
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
const KEYWORD_LOOKUP_CALLEE_PATTERN = new RegExp(
  String.raw`(${QUERYSET_RECEIVER_PATTERN})\.(${KEYWORD_LOOKUP_METHOD_PATTERN})$`
);
const STRING_LOOKUP_CALLEE_PATTERN = new RegExp(
  String.raw`(${QUERYSET_RECEIVER_PATTERN})\.(${LOOKUP_METHOD_PATTERN})$`
);

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

interface RelationDiagnosticContext {
  value: string;
  range: vscode.Range;
}

interface LookupDiagnosticContext extends LookupLiteral {
  range: vscode.Range;
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
      await daemon.ensureStarted();
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
            await daemon.ensureStarted();
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
        if (!lookupContext) {
          return undefined;
        }

        try {
          await daemon.ensureStarted();
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

          return result.items.map((item) => {
            const completion = new vscode.CompletionItem(
              item.name,
              item.fieldKind === 'lookup_operator'
                ? vscode.CompletionItemKind.Operator
                : item.isRelation
                ? vscode.CompletionItemKind.Field
                : vscode.CompletionItemKind.Property
            );
            completion.detail =
              item.fieldKind === 'lookup_operator'
                ? `Django lookup operator on ${item.modelLabel}`
                : `${item.modelLabel}${item.relatedModelLabel ? ` -> ${item.relatedModelLabel}` : ''}`;
            completion.insertText = item.name;
            completion.filterText = lookupFilterText(lookupContext.prefix, item.name);
            completion.range = lookupContext.range;
            completion.documentation = buildLookupItemMarkdown(
              item,
              lookupContext.method,
              baseModelLabel
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
            await daemon.ensureStarted();
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
            await daemon.ensureStarted();
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

        const importSpec = importSpecifierAtPosition(document, position);
        if (!importSpec || importSpec.moduleName.startsWith('.')) {
          return undefined;
        }

        try {
          await daemon.ensureStarted();
          const resolution = await daemon.resolveExportOrigin(
            importSpec.moduleName,
            importSpec.symbol
          );
          const importHover = buildImportHover(resolution);
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
            await daemon.ensureStarted();
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
            await daemon.ensureStarted();
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

        const importSpec = importSpecifierAtPosition(document, position);
        if (!importSpec || importSpec.moduleName.startsWith('.')) {
          return undefined;
        }

        try {
          await daemon.ensureStarted();
          const resolution = await daemon.resolveExportOrigin(
            importSpec.moduleName,
            importSpec.symbol
          );
          const location = definitionLocationFromExportResolution(resolution);
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

function importSpecifierAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): { moduleName: string; symbol: string } | undefined {
  const lineText = document.lineAt(position.line).text;
  const lineMatch = lineText.match(IMPORT_FROM_PATTERN);
  if (!lineMatch) {
    return undefined;
  }

  const [, moduleName, clauseText] = lineMatch;
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
          moduleName,
          symbol: importedName,
        };
      }
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

function buildImportHover(
  resolution: ExportOriginResolution
): vscode.Hover | undefined {
  if (!resolution.resolved || !resolution.originModule) {
    return undefined;
  }

  if (
    resolution.viaModules.length <= 1 &&
    resolution.originModule === resolution.requestedModule
  ) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`**Re-export Origin**\n\n`);
  markdown.appendMarkdown(
    `Imported from \`${resolution.requestedModule}\`, defined in \`${resolution.originModule}\`.`
  );

  if (resolution.originSymbol) {
    markdown.appendMarkdown(`\n\nOrigin symbol: \`${resolution.originSymbol}\``);
  }

  if (resolution.viaModules.length > 1) {
    markdown.appendMarkdown(
      `\n\nResolution path: \`${resolution.viaModules.join(' -> ')}\``
    );
  }

  return new vscode.Hover(markdown);
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

  markdown.appendMarkdown(`Field kind: \`${item.fieldKind}\``);

  if (item.relatedModelLabel) {
    markdown.appendMarkdown(`\n\nRelated model: \`${item.relatedModelLabel}\``);
  }

  if (item.relationDirection) {
    markdown.appendMarkdown(`\n\nRelation direction: \`${item.relationDirection}\``);
  }

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
  const normalizedExpression = receiverExpression.trim();
  if (!normalizedExpression) {
    return undefined;
  }

  const visitKey = `${normalizedExpression}@${beforeOffset}`;
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

  const moduleName = bindings.modules.get(parts[0]);
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
  if (identifier === 'self' || identifier === 'cls') {
    return undefined;
  }

  return identifier;
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
      const [, moduleName, clauseText] = fromMatch;
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

function lookupFilterText(prefix: string, completionName: string): string {
  const replacementLength = lookupReplacementLength(prefix);
  const staticPrefix = prefix.slice(0, prefix.length - replacementLength);
  return `${staticPrefix}${completionName}`;
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
