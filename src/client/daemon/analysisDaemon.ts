import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
import {
  resolvePythonInterpreter,
  validatePythonInterpreterPath,
} from '../python/interpreter';
import type {
  ExportOriginResolution,
  HealthSnapshot,
  LookupPathItem,
  InitializeResult,
  LookupPathCompletionsResult,
  LookupPathResolution,
  ModuleResolution,
  OrmMemberChainResolution,
  OrmMemberCompletionsResult,
  OrmMemberItem,
  OrmMemberResolution,
  OrmReceiverKind,
  ReindexFileResult,
  RelationTargetResolution,
  RelationTargetsResult,
  RequestMessage,
  ResponseMessage,
  ServerMessage,
} from '../protocol';
import {
  buildWorkspaceIndex,
  diffSurfaceIndex,
  updateWorkspaceIndexIncremental,
  type StaticFallback,
  type SurfaceIndex,
} from '../../server/workspaceIndexer';
import { parseLookupChain, getCompletionCandidates } from '../../server/lookupResolver';
import type {
  FieldInfo,
  ModelInfo,
  ParsedLookup,
  PrefixCandidate,
  WorkspaceIndex,
} from '../../server/types';

const REQUEST_TIMEOUT_MS = 8_000;
const INITIALIZE_REQUEST_TIMEOUT_MS = 60_000;
const RESPONSE_CACHE_LIMIT = 512;
const RESPONSE_CACHE_TTL_MS = 30_000;
const MAX_PENDING_REQUESTS = 64;
const MAX_PAYLOAD_BYTES = 512 * 1024; // 512KB
const LOCAL_LOOKUP_RELATION_ONLY_METHODS = new Set([
  'select_related',
  'prefetch_related',
]);
const LOCAL_LOOKUP_ALIAS_SENSITIVE_METHODS = new Set([
  'only',
  'defer',
  'select_related',
  'prefetch_related',
]);
const LOCAL_LOOKUP_OPERATOR_METHODS = new Set([
  'filter',
  'exclude',
  'get',
  'get_or_create',
  'update_or_create',
]);
const LOCAL_LOOKUP_CHAIN_DEPTH = 2;

type IpcRequestSource =
  | 'completion'
  | 'diagnostic'
  | 'hover'
  | 'signature'
  | 'definition'
  | 'initialSync'
  | 'reindex'
  | 'health'
  | 'command'
  | 'unknown';

function createEmptyWorkspaceIndex(): WorkspaceIndex {
  return {
    models: new Map(),
    perFile: new Map(),
    modelLabelByName: new Map(),
    fieldTrieByModel: new Map(),
    lookupTrie: { children: new Map(), isTerminal: false },
    transformTrie: { children: new Map(), isTerminal: false },
  };
}

interface LocalLookupTraversal {
  completionMode: 'field' | 'field_and_lookup' | 'lookup';
  currentModelLabel: string;
  lookupField?: FieldInfo;
  lookupFieldOwnerLabel?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface LaunchContext {
  workspaceRoot: string;
  pythonPath: string;
  pythonSource: string;
  pythonSourceDetail: string;
  settingsModule?: string;
}

function buildPythonEnvironment(
  extensionPythonRoot: string,
  interpreterPath: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DJANGO_ORM_INTELLISENSE: '1',
    PYTHONPATH: extensionPythonRoot,
    PYTHONUNBUFFERED: '1',
  };

  delete environment.PYTHONHOME;
  delete environment.__PYVENV_LAUNCHER__;
  delete environment.VIRTUAL_ENV;

  const virtualEnvironmentRoot = findVirtualEnvironmentRoot(interpreterPath);
  if (virtualEnvironmentRoot) {
    environment.VIRTUAL_ENV = virtualEnvironmentRoot;
    environment.PATH = prependToPath(
      path.join(
        virtualEnvironmentRoot,
        process.platform === 'win32' ? 'Scripts' : 'bin'
      ),
      process.env.PATH
    );
  }

  return environment;
}

function findVirtualEnvironmentRoot(interpreterPath: string): string | undefined {
  const executableDirectory = path.dirname(interpreterPath);
  const directoryName = path.basename(executableDirectory).toLowerCase();
  if (directoryName !== 'bin' && directoryName !== 'scripts') {
    return undefined;
  }

  const candidateRoot = path.dirname(executableDirectory);
  return fs.existsSync(path.join(candidateRoot, 'pyvenv.cfg'))
    ? candidateRoot
    : undefined;
}

function prependToPath(
  segment: string,
  existingPath: string | undefined
): string {
  if (!existingPath) {
    return segment;
  }

  const parts = existingPath.split(path.delimiter);
  return parts.includes(segment)
    ? existingPath
    : [segment, existingPath].join(path.delimiter);
}

export class AnalysisDaemon implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<HealthSnapshot>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly responseCache = new Map<string, { promise: Promise<unknown>; createdAt: number }>();
  private readonly intentionalExitProcessIds = new Set<number>();
  private readonly requestSourceContext = new AsyncLocalStorage<IpcRequestSource>();
  private readonly output: vscode.OutputChannel;
  private process?: ChildProcessWithoutNullStreams;
  private stdoutReader?: readline.Interface;
  private requestSequence = 0;
  private startPromise?: Promise<HealthSnapshot>;
  private restartPromise?: Promise<HealthSnapshot>;
  private restartQueued = false;
  private queuedRestartScope?: vscode.ConfigurationScope;
  private stopRequested = false;
  modelNames: Set<string> = new Set();
  modelLabelByName: Map<string, string> = new Map();
  surfaceIndex: SurfaceIndex = {};
  customLookups: Record<string, string[]> = {};
  staticFallback: StaticFallback | null = null;
  private localWorkspaceIndex: WorkspaceIndex = createEmptyWorkspaceIndex();
  private localModelFingerprints = new Map<string, string>();
  private lastLaunchContext?: LaunchContext;
  private interpreterCheck?: Promise<void>;
  private currentState: HealthSnapshot = {
    phase: 'stopped',
    detail: 'Daemon has not been started yet.',
    capabilities: [],
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    output?: vscode.OutputChannel
  ) {
    this.output =
      output ?? vscode.window.createOutputChannel('Django ORM Intellisense');
  }

  get onDidChangeState(): vscode.Event<HealthSnapshot> {
    return this.stateEmitter.event;
  }

  getState(): HealthSnapshot {
    return this.currentState;
  }

  isReady(): boolean {
    return this.process !== null && (
      this.currentState.phase === 'ready' ||
      this.currentState.phase === 'degraded'
    );
  }

  withRequestSource<T>(source: IpcRequestSource, callback: () => T): T {
    return this.requestSourceContext.run(source, callback);
  }

  private rebuildLocalWorkspaceIndex(): void {
    this.localWorkspaceIndex = buildWorkspaceIndex(
      this.surfaceIndex,
      Array.from(this.modelNames),
      this.customLookups,
      this.staticFallback ?? undefined,
    );
    this.localModelFingerprints.clear();
    for (const [label, receivers] of Object.entries(this.surfaceIndex)) {
      this.localModelFingerprints.set(label, JSON.stringify(receivers));
    }
  }

  private updateLocalWorkspaceIndex(
    nextSurfaceIndex: SurfaceIndex,
    nextStaticFallback: StaticFallback | null,
  ): void {
    if (
      this.localWorkspaceIndex.models.size === 0 ||
      JSON.stringify(this.staticFallback) !== JSON.stringify(nextStaticFallback)
    ) {
      this.surfaceIndex = nextSurfaceIndex;
      this.staticFallback = nextStaticFallback;
      this.rebuildLocalWorkspaceIndex();
      return;
    }

    const diff = diffSurfaceIndex(
      this.surfaceIndex,
      nextSurfaceIndex,
      this.localModelFingerprints,
    );

    updateWorkspaceIndexIncremental(
      this.localWorkspaceIndex,
      nextSurfaceIndex,
      diff,
      this.customLookups,
      this.customLookups,
    );
  }

  private rebuildModelLabelByName(): void {
    this.modelLabelByName = new Map();
    for (const label of Object.keys(this.surfaceIndex)) {
      const name = label.split('.').at(-1);
      if (name) {
        this.modelLabelByName.set(name, label);
      }
    }
  }

  async start(scope?: vscode.ConfigurationScope): Promise<HealthSnapshot> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.process) {
      return this.refreshHealth();
    }

    const startPromise = this.startProcess(scope);
    this.startPromise = startPromise;

    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    }
  }

  async refreshHealth(): Promise<HealthSnapshot> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.process) {
      return this.currentState;
    }

    const snapshot = this.decorateSnapshot(
      await this.request<HealthSnapshot>(
        'health',
        {},
        REQUEST_TIMEOUT_MS,
        false,
        'health'
      )
    );
    this.updateState(snapshot);
    return snapshot;
  }

  async ensureStarted(scope?: vscode.ConfigurationScope): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      if (
        scope &&
        this.process &&
        this.lastLaunchContext &&
        (await this.requiresScopedRestart(scope))
      ) {
        await this.stop();
        await this.start(scope);
      }
      return;
    }

    if (!this.process) {
      await this.start(scope);
      return;
    }

    await this.restartIfInterpreterChanged();
  }

  async restart(scope?: vscode.ConfigurationScope): Promise<HealthSnapshot> {
    if (this.restartPromise) {
      this.restartQueued = true;
      if (scope !== undefined) {
        this.queuedRestartScope = scope;
      }
      return this.restartPromise;
    }

    const restartPromise = (async () => {
      let nextScope = scope;
      let lastSnapshot: HealthSnapshot | undefined;
      let lastError: unknown;

      while (true) {
        this.restartQueued = false;
        const restartScope = nextScope;
        nextScope = undefined;

        await this.stop();
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // Ignore the terminated start attempt and continue with the queued restart.
          }
        }

        try {
          lastSnapshot = await this.start(restartScope);
          lastError = undefined;
        } catch (error) {
          lastSnapshot = undefined;
          lastError = error;
        }

        if (!this.restartQueued) {
          if (lastSnapshot) {
            return lastSnapshot;
          }
          throw lastError;
        }

        nextScope = this.queuedRestartScope;
        this.queuedRestartScope = undefined;
      }
    })();
    this.restartPromise = restartPromise;

    try {
      return await restartPromise;
    } finally {
      if (this.restartPromise === restartPromise) {
        this.restartPromise = undefined;
      }
    }
  }

  async restartIfInterpreterChanged(): Promise<void> {
    if (!this.process || this.currentState.phase === 'starting') {
      return;
    }

    if (this.interpreterCheck) {
      await this.interpreterCheck;
      return;
    }

    this.interpreterCheck = this.checkForInterpreterChange();

    try {
      await this.interpreterCheck;
    } finally {
      this.interpreterCheck = undefined;
    }
  }

  async listRelationTargets(prefix: string): Promise<RelationTargetsResult> {
    return this.cachedRequest<RelationTargetsResult>('relationTargets', { prefix });
  }

  async resolveRelationTarget(
    value: string,
    background: boolean = false
  ): Promise<RelationTargetResolution> {
    return this.cachedRequest<RelationTargetResolution>('resolveRelationTarget', {
      value,
    }, background);
  }

  async resolveExportOrigin(
    moduleName: string,
    symbol: string
  ): Promise<ExportOriginResolution> {
    return this.cachedRequest<ExportOriginResolution>('resolveExportOrigin', {
      module: moduleName,
      symbol,
    });
  }

  async resolveModule(moduleName: string): Promise<ModuleResolution> {
    return this.cachedRequest<ModuleResolution>('resolveModule', {
      module: moduleName,
    });
  }

  async reindexFile(filePath: string): Promise<ReindexFileResult> {
    const result = await this.request<ReindexFileResult>(
      'reindexFile',
      { filePath },
      INITIALIZE_REQUEST_TIMEOUT_MS,
      false,
      'reindex'
    );
    const nextSurfaceIndex = result.surfaceIndex ?? {};
    const nextModelNames = new Set(result.modelNames ?? []);
    const nextStaticFallback = result.staticFallback ?? null;
    this.updateLocalWorkspaceIndex(nextSurfaceIndex, nextStaticFallback);
    // Update local state with new surface data
    this.surfaceIndex = nextSurfaceIndex;
    this.modelNames = nextModelNames;
    this.staticFallback = nextStaticFallback;
    this.rebuildModelLabelByName();
    return result;
  }

  async listLookupPathCompletions(
    baseModelLabel: string,
    prefix: string,
    method: string
  ): Promise<LookupPathCompletionsResult> {
    return this.cachedRequest<LookupPathCompletionsResult>('lookupPathCompletions', {
      baseModelLabel,
      prefix,
      method,
    });
  }

  /**
   * List lookup-path completions from the local workspace index without IPC.
   *
   * This reuses the language-server lookup FSM and trie-backed field metadata
   * so the extension host does not have to guess from raw surfaceIndex tuples.
   * Alias-sensitive attribute-path methods still fall back to the daemon until
   * source provenance is preserved in the local index.
   */
  listLookupPathCompletionsLocal(
    baseModelLabel: string,
    prefix: string,
    method: string
  ): LookupPathCompletionsResult | undefined {
    if (LOCAL_LOOKUP_ALIAS_SENSITIVE_METHODS.has(method)) {
      return undefined;
    }

    const index = this.localWorkspaceIndex;
    if (!index.models.has(baseModelLabel)) {
      return undefined;
    }

    const { completedSegments, currentPartial } = this.splitLocalLookupPrefix(
      prefix,
      method,
    );
    const parsed: ParsedLookup = completedSegments.length > 0
      ? parseLookupChain(completedSegments.join('__'), baseModelLabel, index)
      : {
          segments: [],
          resolvedPath: [],
          state: 'partial',
          startModel: baseModelLabel,
        };
    if (parsed.state === 'error') {
      return undefined;
    }

    const traversal = this.analyzeLocalLookupTraversal(
      baseModelLabel,
      parsed,
      method,
    );
    if (!traversal) {
      return undefined;
    }

    const itemsByName = new Map<string, LookupPathItem>();
    const includePrefixedLookupItems =
      LOCAL_LOOKUP_OPERATOR_METHODS.has(method) &&
      (currentPartial.length > 0 || completedSegments.length === 0);

    if (
      traversal.completionMode === 'field' ||
      traversal.completionMode === 'field_and_lookup'
    ) {
      const directItems = this.buildLocalFieldCompletionItems(
        traversal.currentModelLabel,
        parsed,
        currentPartial,
      );
      for (const item of directItems) {
        itemsByName.set(item.name, item);
      }

      if (includePrefixedLookupItems) {
        for (const item of this.buildPrefixedLocalLookupItems(
          traversal.currentModelLabel,
          directItems,
          currentPartial,
        )) {
          itemsByName.set(item.name, item);
        }
      }

      for (const item of this.buildLocalDescendantCompletionItems(
        traversal.currentModelLabel,
        currentPartial,
        method,
      )) {
        itemsByName.set(item.name, item);
      }

      if (
        traversal.completionMode === 'field_and_lookup' &&
        traversal.lookupField &&
        traversal.lookupFieldOwnerLabel
      ) {
        for (const item of this.buildLocalLookupItems(
          traversal.lookupFieldOwnerLabel,
          traversal.lookupField,
          currentPartial,
        )) {
          itemsByName.set(item.name, item);
        }
      }
    } else if (traversal.lookupField && traversal.lookupFieldOwnerLabel) {
      for (const item of this.buildLocalLookupItems(
        traversal.lookupFieldOwnerLabel,
        traversal.lookupField,
        currentPartial,
      )) {
        itemsByName.set(item.name, item);
      }
    }

    return {
      items: [...itemsByName.values()],
      resolved: true,
      currentModelLabel: traversal.currentModelLabel,
    };
  }

  async resolveLookupPath(
    baseModelLabel: string,
    value: string,
    method: string,
    background: boolean = false
  ): Promise<LookupPathResolution> {
    return this.cachedRequest<LookupPathResolution>('resolveLookupPath', {
      baseModelLabel,
      value,
      method,
    }, background);
  }

  async listOrmMemberCompletions(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    prefix: string,
    managerName?: string
  ): Promise<OrmMemberCompletionsResult> {
    return this.cachedRequest<OrmMemberCompletionsResult>('ormMemberCompletions', {
      modelLabel,
      receiverKind,
      prefix,
      managerName,
    });
  }

  /**
   * List ORM members from the local surface index without IPC.
   *
   * This is intentionally limited to receiver kinds whose surface entries are
   * stable enough to classify locally. Instance receivers still fall back to
   * daemon IPC because surfaceIndex does not preserve enough metadata to
   * distinguish fields from instance methods safely.
   */
  listOrmMemberCompletionsLocal(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    prefix: string,
    managerName?: string
  ): OrmMemberCompletionsResult | undefined {
    if (receiverKind === 'scalar' || receiverKind === 'unknown') {
      return undefined;
    }

    if (receiverKind === 'instance') {
      return this.listLocalInstanceOrmMemberCompletions(modelLabel, prefix);
    }

    const modelEntry = this.surfaceIndex[modelLabel];
    if (!modelEntry) {
      return undefined;
    }

    const kindEntry = modelEntry[receiverKind];
    if (!kindEntry) {
      return undefined;
    }

    const normalizedPrefix = prefix.trim();
    const items: OrmMemberItem[] = [];

    for (const [name, [returnKind, returnModelLabel]] of Object.entries(kindEntry)) {
      if (normalizedPrefix && !name.startsWith(normalizedPrefix)) {
        continue;
      }

      const memberKind = returnKind === 'manager' ? 'manager' : 'method';
      let detail = 'Django ORM member';
      if (memberKind === 'manager') {
        detail = 'Django manager';
      } else if (receiverKind === 'model_class') {
        detail = 'Django model class method';
      } else if (receiverKind === 'manager') {
        detail = 'Django manager method';
      } else if (receiverKind === 'queryset') {
        detail = 'Django queryset method';
      } else if (receiverKind === 'related_manager') {
        detail = 'Django related manager method';
      }

      items.push({
        name,
        memberKind,
        modelLabel,
        receiverKind,
        detail,
        source: 'local',
        isRelation: false,
        returnKind,
        returnModelLabel: returnModelLabel || undefined,
        managerName,
      });
    }

    return {
      resolved: true,
      items,
      receiverKind,
      modelLabel,
      managerName,
    };
  }

  private listLocalInstanceOrmMemberCompletions(
    modelLabel: string,
    prefix: string,
  ): OrmMemberCompletionsResult | undefined {
    const model = this.localWorkspaceIndex.models.get(modelLabel);
    if (!model || model.fields.size === 0) {
      return undefined;
    }

    const normalizedPrefix = prefix.trim();
    const itemsByName = new Map<string, OrmMemberItem>();
    const addItem = (item: OrmMemberItem) => {
      if (normalizedPrefix && !item.name.startsWith(normalizedPrefix)) {
        return;
      }
      itemsByName.set(item.name, item);
    };

    for (const field of model.fields.values()) {
      if (this.isHiddenLookupFieldName(field.name)) {
        continue;
      }

      const relation =
        model.relations.get(field.name) ?? model.reverseRelations.get(field.name);
      const isReverseRelation = relation?.direction === 'reverse';
      const isForwardRelation = relation?.direction === 'forward' || (
        !relation && field.isRelation
      );
      let memberKind = 'field';
      let returnKind: string | undefined = 'scalar';
      let returnModelLabel: string | undefined;

      if (isReverseRelation) {
        memberKind = 'reverse_relation';
        returnKind = 'related_manager';
        returnModelLabel = relation?.targetModelLabel || undefined;
      } else if (isForwardRelation) {
        memberKind = 'relation';
        returnKind =
          field.fieldKind === 'ManyToManyField' ? 'related_manager' : 'instance';
        returnModelLabel = relation?.targetModelLabel || undefined;
      }

      addItem({
        name: field.name,
        memberKind,
        modelLabel,
        receiverKind: 'instance',
        detail: field.fieldKind,
        source: 'local',
        fieldKind: field.fieldKind,
        isRelation: field.isRelation,
        returnKind,
        returnModelLabel,
      });
    }

    const instanceEntry = this.surfaceIndex[modelLabel]?.instance;
    if (instanceEntry) {
      for (const [name, [returnKind, returnModelLabel]] of Object.entries(instanceEntry)) {
        if (itemsByName.has(name)) {
          continue;
        }

        addItem({
          name,
          memberKind: returnKind === 'manager' ? 'manager' : 'method',
          modelLabel,
          receiverKind: 'instance',
          detail:
            returnKind === 'manager'
              ? 'Django manager'
              : 'Django model instance method',
          source: 'local',
          isRelation: false,
          returnKind,
          returnModelLabel: returnModelLabel || undefined,
        });
      }
    }

    return {
      resolved: true,
      items: [...itemsByName.values()],
      receiverKind: 'instance',
      modelLabel,
    };
  }

  async resolveOrmMember(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    name: string,
    managerName?: string
  ): Promise<OrmMemberResolution> {
    return this.cachedRequest<OrmMemberResolution>('resolveOrmMember', {
      modelLabel,
      receiverKind,
      name,
      managerName,
    });
  }

  async resolveOrmMemberBatch(
    items: Array<{ modelLabel: string; receiverKind: string; name: string; managerName?: string }>
  ): Promise<OrmMemberResolution[]> {
    const result = await this.request<{ results: OrmMemberResolution[] }>(
      'resolveOrmMemberBatch',
      { items },
      INITIALIZE_REQUEST_TIMEOUT_MS,
      true,  // always background — batch is never user-interactive
      this.currentRequestSource()
    );
    return result.results;
  }

  async resolveLookupPathBatch(
    items: Array<{ baseModelLabel: string; value: string; method: string }>
  ): Promise<LookupPathResolution[]> {
    const result = await this.request<{ results: LookupPathResolution[] }>(
      'resolveLookupPathBatch',
      { items },
      INITIALIZE_REQUEST_TIMEOUT_MS,
      true,  // always background
      this.currentRequestSource()
    );
    return result.results;
  }

  /**
   * Resolve an ORM member from the local surface index without IPC.
   * Returns undefined if the member is not in the surface index.
   * The returned item has enough fields for chain resolution (returnKind,
   * returnModelLabel, managerName) but NOT for display (detail, filePath).
   */
  resolveOrmMemberLocal(
    modelLabel: string,
    receiverKind: string,
    name: string
  ): OrmMemberResolution | undefined {
    const modelEntry = this.surfaceIndex[modelLabel];
    if (!modelEntry) return undefined;
    const kindEntry = modelEntry[receiverKind];
    if (!kindEntry) return undefined;
    const member = kindEntry[name];
    if (!member) return undefined;
    const [returnKind, returnModelLabel] = member;
    // surfaceIndex member found
    return {
      resolved: true,
      item: {
        name,
        memberKind: 'field',
        modelLabel,
        receiverKind,
        detail: '',
        source: 'local',
        isRelation: !!returnModelLabel,
        returnKind,
        returnModelLabel: returnModelLabel || undefined,
      },
    };
  }

  /** 로컬 surface index에서 O(1) chain resolution. daemon IPC 불필요. */
  resolveOrmMemberChainLocal(
    modelLabel: string,
    receiverKind: string,
    chain: string[],
    managerName?: string
  ): OrmMemberChainResolution {
    let currentLabel = modelLabel;
    let currentKind = receiverKind;

    for (const name of chain) {
      const modelEntry = this.surfaceIndex[currentLabel];
      if (!modelEntry) {
        return { resolved: false, reason: 'model_not_found', failedAt: name };
      }
      const kindEntry = modelEntry[currentKind];
      if (!kindEntry) {
        return { resolved: false, reason: 'kind_not_found', failedAt: name };
      }
      const member = kindEntry[name];
      if (!member) {
        return { resolved: false, reason: 'member_not_found', failedAt: name };
      }
      currentKind = member[0];
      currentLabel = member[1] ?? currentLabel;
    }

    return {
      resolved: true,
      modelLabel: currentLabel,
      receiverKind: currentKind,
    };
  }

  private splitLocalLookupPrefix(
    prefix: string,
    method: string,
  ): { completedSegments: string[]; currentPartial: string } {
    const normalizedPrefix =
      method === 'order_by' && prefix.trim().startsWith('-')
        ? prefix.trim().slice(1)
        : prefix.trim();
    const endsWithSeparator = normalizedPrefix.endsWith('__');
    const rawSegments = normalizedPrefix.split('__').filter(Boolean);
    const currentPartial = endsWithSeparator
      ? ''
      : (rawSegments.pop() ?? '');

    return {
      completedSegments: rawSegments,
      currentPartial,
    };
  }

  private analyzeLocalLookupTraversal(
    baseModelLabel: string,
    parsed: ParsedLookup,
    method: string,
  ): LocalLookupTraversal | undefined {
    if (parsed.resolvedPath.length === 0) {
      return {
        completionMode: 'field',
        currentModelLabel: baseModelLabel,
      };
    }

    const lastResolved = parsed.resolvedPath[parsed.resolvedPath.length - 1];
    if (!lastResolved) {
      return undefined;
    }

    if (
      lastResolved.kind === 'relation' ||
      lastResolved.kind === 'reverse_relation'
    ) {
      const ownerModelLabel = lastResolved.modelLabel ?? baseModelLabel;
      const relation = this.getLocalRelationInfo(ownerModelLabel, lastResolved.name);
      if (!relation) {
        return undefined;
      }

      const lookupField = this.localWorkspaceIndex.models
        .get(ownerModelLabel)
        ?.fields.get(lastResolved.name);
      if (LOCAL_LOOKUP_OPERATOR_METHODS.has(method) && lookupField) {
        return {
          completionMode: 'field_and_lookup',
          currentModelLabel: relation.targetModelLabel,
          lookupField,
          lookupFieldOwnerLabel: ownerModelLabel,
        };
      }

      return {
        completionMode: 'field',
        currentModelLabel: relation.targetModelLabel,
      };
    }

    if (
      (lastResolved.kind === 'field' || lastResolved.kind === 'transform') &&
      parsed.finalField &&
      LOCAL_LOOKUP_OPERATOR_METHODS.has(method)
    ) {
      return {
        completionMode: 'lookup',
        currentModelLabel: lastResolved.modelLabel ?? baseModelLabel,
        lookupField: parsed.finalField,
        lookupFieldOwnerLabel: lastResolved.modelLabel ?? baseModelLabel,
      };
    }

    return undefined;
  }

  private buildLocalFieldCompletionItems(
    currentModelLabel: string,
    parsed: ParsedLookup,
    currentPartial: string,
  ): LookupPathItem[] {
    const items: LookupPathItem[] = [];
    const candidates = getCompletionCandidates(
      parsed,
      currentPartial,
      this.localWorkspaceIndex,
    );

    for (const candidate of candidates) {
      if (candidate.kind !== 'field' && candidate.kind !== 'relation') {
        continue;
      }
      if (candidate.name.includes('__') || this.isHiddenLookupFieldName(candidate.name)) {
        continue;
      }

      const item = this.localLookupItemFromCandidate(currentModelLabel, candidate);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  private buildPrefixedLocalLookupItems(
    currentModelLabel: string,
    directItems: LookupPathItem[],
    currentPartial: string,
  ): LookupPathItem[] {
    const model = this.localWorkspaceIndex.models.get(currentModelLabel);
    if (!model) {
      return [];
    }

    const lowerPartial = currentPartial.toLowerCase();
    const itemsByName = new Map<string, LookupPathItem>();

    for (const item of directItems) {
      if (
        item.name.includes('__') ||
        item.fieldKind === 'lookup_operator' ||
        item.fieldKind === 'lookup_transform' ||
        this.isHiddenLookupFieldName(item.name)
      ) {
        continue;
      }
      if (lowerPartial && !item.name.toLowerCase().startsWith(lowerPartial)) {
        continue;
      }

      const field = model.fields.get(item.name);
      if (!field) {
        continue;
      }

      for (const lookupItem of this.buildLocalLookupItems(
        currentModelLabel,
        field,
        '',
        item.name,
      )) {
        const prefixedName = `${item.name}__${lookupItem.name}`;
        if (lowerPartial && !prefixedName.toLowerCase().startsWith(lowerPartial)) {
          continue;
        }
        itemsByName.set(prefixedName, {
          ...lookupItem,
          name: prefixedName,
        });
      }
    }

    return [...itemsByName.values()];
  }

  private buildLocalDescendantCompletionItems(
    currentModelLabel: string,
    currentPartial: string,
    method: string,
  ): LookupPathItem[] {
    const relationOnly = LOCAL_LOOKUP_RELATION_ONLY_METHODS.has(method);
    const lowerPartial = currentPartial.toLowerCase();
    const itemsByName = new Map<string, LookupPathItem>();

    const walk = (
      modelLabel: string,
      prefixParts: string[],
      depth: number,
      visitedModels: Set<string>,
    ): void => {
      if (depth >= LOCAL_LOOKUP_CHAIN_DEPTH) {
        return;
      }

      for (const field of this.getLocalLookupFieldsForModel(modelLabel)) {
        const pathParts = [...prefixParts, field.name];
        const pathName = pathParts.join('__');
        if (
          prefixParts.length > 0 &&
          (!lowerPartial || pathName.toLowerCase().startsWith(lowerPartial)) &&
          (field.isRelation || !relationOnly)
        ) {
          const item = this.localLookupFieldItem(modelLabel, field.name, pathName);
          if (item) {
            itemsByName.set(pathName, item);
          }
        }

        const relation = field.isRelation
          ? this.getLocalRelationInfo(modelLabel, field.name)
          : undefined;
        if (!relation?.targetModelLabel || visitedModels.has(relation.targetModelLabel)) {
          continue;
        }

        const nextVisitedModels = new Set(visitedModels);
        nextVisitedModels.add(relation.targetModelLabel);
        walk(
          relation.targetModelLabel,
          pathParts,
          depth + 1,
          nextVisitedModels,
        );
      }
    };

    walk(currentModelLabel, [], 0, new Set([currentModelLabel]));
    return [...itemsByName.values()];
  }

  private buildLocalLookupItems(
    ownerModelLabel: string,
    field: FieldInfo,
    currentPartial: string,
    fieldPath: string = field.name,
  ): LookupPathItem[] {
    const lowerPartial = currentPartial.toLowerCase();
    const itemsByName = new Map<string, LookupPathItem>();

    for (const transform of field.transforms) {
      if (lowerPartial && !transform.toLowerCase().startsWith(lowerPartial)) {
        continue;
      }
      itemsByName.set(
        transform,
        this.localLookupOperatorItem(ownerModelLabel, transform, true, fieldPath),
      );
    }

    for (const lookup of field.lookups) {
      if (lowerPartial && !lookup.toLowerCase().startsWith(lowerPartial)) {
        continue;
      }
      itemsByName.set(
        lookup,
        this.localLookupOperatorItem(ownerModelLabel, lookup, false, fieldPath),
      );
    }

    return [...itemsByName.values()];
  }

  private getLocalLookupFieldsForModel(modelLabel: string): FieldInfo[] {
    const model = this.localWorkspaceIndex.models.get(modelLabel);
    if (!model) {
      return [];
    }

    return [...model.fields.values()].filter(
      (field) => !this.isHiddenLookupFieldName(field.name),
    );
  }

  private getLocalRelationInfo(
    modelLabel: string,
    fieldName: string,
  ) {
    const model = this.localWorkspaceIndex.models.get(modelLabel);
    return model?.relations.get(fieldName) ?? model?.reverseRelations.get(fieldName);
  }

  private localLookupItemFromCandidate(
    ownerModelLabel: string,
    candidate: PrefixCandidate,
  ): LookupPathItem | undefined {
    return this.localLookupFieldItem(ownerModelLabel, candidate.name);
  }

  private isHiddenLookupFieldName(name: string): boolean {
    return name.endsWith('+');
  }

  private localLookupFieldItem(
    ownerModelLabel: string,
    fieldName: string,
    itemName: string = fieldName,
  ): LookupPathItem | undefined {
    const model = this.localWorkspaceIndex.models.get(ownerModelLabel);
    const field = model?.fields.get(fieldName);
    if (!field || this.isHiddenLookupFieldName(field.name)) {
      return undefined;
    }

    const relation = this.getLocalRelationInfo(ownerModelLabel, fieldName);
    return {
      name: itemName,
      modelLabel: ownerModelLabel,
      relatedModelLabel: relation?.targetModelLabel,
      fieldKind: field.fieldKind,
      isRelation: field.isRelation,
      fieldPath: itemName,
      relationDirection: relation?.direction,
      source: 'local',
    };
  }

  private localLookupOperatorItem(
    ownerModelLabel: string,
    operator: string,
    isTransform: boolean,
    fieldPath?: string,
  ): LookupPathItem {
    return {
      name: operator,
      modelLabel: ownerModelLabel,
      fieldKind: isTransform ? 'lookup_transform' : 'lookup_operator',
      isRelation: false,
      fieldPath,
      source: isTransform ? 'django_transform' : 'django_lookup',
      lookupOperator: isTransform ? undefined : operator,
    };
  }

  async resolveOrmMemberChain(
    modelLabel: string,
    receiverKind: OrmReceiverKind,
    chain: string[],
    managerName?: string
  ): Promise<OrmMemberChainResolution> {
    return this.cachedRequest<OrmMemberChainResolution>('resolveOrmMemberChain', {
      modelLabel,
      receiverKind,
      chain,
      managerName,
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearResponseCache();
    this.rejectAllPending(new Error('Analysis daemon stopped.'));

    const child = this.process;
    const stdoutReader = this.stdoutReader;

    if (child?.pid !== undefined) {
      this.intentionalExitProcessIds.add(child.pid);
    }

    this.disposeProcessHandles(child, stdoutReader);

    if (child && !child.killed) {
      child.kill();
    }

    this.updateState({
      phase: 'stopped',
      detail: 'Daemon is stopped.',
      capabilities: this.currentState.capabilities,
      workspaceRoot: this.lastLaunchContext?.workspaceRoot,
      pythonPath: this.lastLaunchContext?.pythonPath,
      pythonSource: this.lastLaunchContext?.pythonSource,
      pythonSourceDetail: this.lastLaunchContext?.pythonSourceDetail,
      settingsModule: this.lastLaunchContext?.settingsModule,
      staticIndex: this.currentState.staticIndex,
      runtime: this.currentState.runtime,
      semanticGraph: this.currentState.semanticGraph,
      startedAt: this.currentState.startedAt,
    });
  }

  dispose(): void {
    void this.stop();
    this.stateEmitter.dispose();
  }

  private async startProcess(
    scope?: vscode.ConfigurationScope
  ): Promise<HealthSnapshot> {
    this.clearResponseCache();
    const launchContext = await this.createLaunchContext(scope);
    this.lastLaunchContext = launchContext;
    this.stopRequested = false;
    this.updateState({
      phase: 'starting',
      detail: `Starting analysis daemon with ${launchContext.pythonPath} (${launchContext.pythonSource}).`,
      capabilities: [],
      workspaceRoot: launchContext.workspaceRoot,
      pythonPath: launchContext.pythonPath,
      pythonSource: launchContext.pythonSource,
      pythonSourceDetail: launchContext.pythonSourceDetail,
      settingsModule: launchContext.settingsModule,
    });

    const serverModuleRoot = path.join(this.context.extensionPath, 'python');
    const environment = buildPythonEnvironment(
      serverModuleRoot,
      launchContext.pythonPath
    );

    if (launchContext.settingsModule) {
      environment.DJANGO_SETTINGS_MODULE = launchContext.settingsModule;
    }

    const child = spawn(
      launchContext.pythonPath,
      ['-m', 'django_orm_intellisense', '--stdio', '--workspace', launchContext.workspaceRoot],
      {
        cwd: launchContext.workspaceRoot,
        env: environment,
      }
    );

    this.process = child;
    const stdoutReader = readline.createInterface({ input: child.stdout });
    this.stdoutReader = stdoutReader;

    child.once('spawn', () => {
      this.log('info', `Daemon process spawned with pid ${child.pid ?? 'unknown'}.`);
    });

    child.once('error', (error) => {
      this.log('info', `Daemon failed to spawn: ${error.message}`);
      if (this.process !== child) {
        this.disposeProcessHandles(child, stdoutReader);
        return;
      }
      this.rejectAllPending(error);
      this.disposeProcessHandles(child, stdoutReader);
      this.updateStateFromError(error);
    });

    child.once('exit', (code, signal) => {
      if (this.process !== child) {
        this.disposeProcessHandles(child, stdoutReader);
        if (child.pid !== undefined) {
          this.intentionalExitProcessIds.delete(child.pid);
        }
        return;
      }

      const intentional =
        (child.pid !== undefined && this.intentionalExitProcessIds.has(child.pid)) ||
        this.stopRequested;
      if (child.pid !== undefined) {
        this.intentionalExitProcessIds.delete(child.pid);
      }
      this.log(
        'info',
        `Daemon exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}.`
      );
      this.clearResponseCache();
      this.rejectAllPending(
        new Error(
          !intentional
            ? `Analysis daemon exited unexpectedly (${code ?? 'null'}/${signal ?? 'null'}).`
            : 'Analysis daemon stopped.'
        )
      );
      this.disposeProcessHandles(child, stdoutReader);

      if (!intentional) {
        this.updateState({
          phase: 'error',
          detail: 'Analysis daemon exited unexpectedly.',
          capabilities: this.currentState.capabilities,
          workspaceRoot: this.lastLaunchContext?.workspaceRoot,
          pythonPath: this.lastLaunchContext?.pythonPath,
          pythonSource: this.lastLaunchContext?.pythonSource,
          pythonSourceDetail: this.lastLaunchContext?.pythonSourceDetail,
          settingsModule: this.lastLaunchContext?.settingsModule,
        });
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) {
        this.log('info', `[daemon stderr] ${message}`);
      }
    });

    stdoutReader.on('line', (line) => {
      this.handleServerMessage(line);
    });

    try {
      const initializeResult = await this.request<InitializeResult>(
        'initialize',
        {
          workspaceRoot: launchContext.workspaceRoot,
          settingsModule: launchContext.settingsModule,
          deferRuntime: true,
        },
        INITIALIZE_REQUEST_TIMEOUT_MS,
        false,
        'initialSync'
      );
      const snapshot = this.decorateSnapshot(initializeResult.health);
      this.modelNames = new Set(initializeResult.modelNames ?? []);
      this.surfaceIndex = initializeResult.surfaceIndex ?? {};
      this.customLookups = initializeResult.customLookups ?? {};
      this.staticFallback = initializeResult.staticFallback ?? null;
      this.rebuildModelLabelByName();
      this.rebuildLocalWorkspaceIndex();
      console.log(`[PERF] daemon initialized: modelNames=${this.modelNames.size} surfaceIndex=${Object.keys(this.surfaceIndex).length} modelLabelByName=${this.modelLabelByName.size}`);
      this.updateState(snapshot);
      return snapshot;
    } catch (error) {
      if (child.pid !== undefined) {
        this.intentionalExitProcessIds.add(child.pid);
      }
      this.disposeProcessHandles(child, stdoutReader);
      if (!child.killed) {
        child.kill();
      }
      this.updateStateFromError(error);
      throw error;
    }
  }

  private async createLaunchContext(
    scope?: vscode.ConfigurationScope
  ): Promise<LaunchContext> {
    const settings = getExtensionSettings(
      scope ?? vscode.workspace.workspaceFolders?.[0]?.uri
    );
    const configuredWorkspaceRoot = settings.workspaceRoot
      ? path.resolve(settings.workspaceRoot)
      : undefined;
    const workspaceRoot =
      (configuredWorkspaceRoot && pathExists(configuredWorkspaceRoot)
        ? configuredWorkspaceRoot
        : undefined) ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      this.context.extensionPath;
    const interpreter = await resolvePythonInterpreter(settings);
    const validation = validatePythonInterpreterPath(interpreter.path);

    if (!validation.valid) {
      throw new Error(
        `${validation.reason}. Set \`djangoOrmIntellisense.pythonInterpreter\` to a valid Python executable or virtualenv directory.`
      );
    }

    return {
      workspaceRoot,
      pythonPath: validation.normalizedPath,
      pythonSource: interpreter.source,
      pythonSourceDetail: interpreter.detail,
      settingsModule: settings.settingsModule,
    };
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    background: boolean = false,
    source: IpcRequestSource = this.currentRequestSource()
  ): Promise<T> {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error('Analysis daemon is not running.'));
    }

    const id = `req-${++this.requestSequence}`;
    const message: RequestMessage = { id, method, params, source };
    if (background) {
      message.background = true;
    }
    const ipcStart = performance.now();

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request "${method}" timed out.`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value: T) => {
          const ipcMs = performance.now() - ipcStart;
          const paramSummary = Object.entries(params).map(([k, v]) =>
            `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)}`.slice(0, 60)
          ).join(', ');
          const sourceSummary = `source=${source}`;
          const summary = paramSummary
            ? `${sourceSummary}, ${paramSummary}`
            : sourceSummary;
          this.output.appendLine(
            `  [IPC] ${method}(${summary}): ${ipcMs.toFixed(1)}ms`
          );
          resolve(value);
        },
        reject,
        timeout,
      });

      const serialized = JSON.stringify(message);
      this.log('debug', `[client->daemon] ${serialized}`);
      this.process?.stdin.write(`${serialized}\n`, 'utf8', (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  private cachedRequest<T>(
    method: string,
    params: Record<string, unknown>,
    background: boolean = false
  ): Promise<T> {
    const source = this.currentRequestSource();
    const effectiveBackground = background || source === 'diagnostic';

    // Cache key ignores background flag so foreground (hover) and background
    // (diagnostic) requests for the same method+params share a single IPC
    // round-trip.  The daemon returns identical results regardless of queue.
    const cacheKey = JSON.stringify({ method, params });
    const cached = this.responseCache.get(cacheKey);
    if (cached) {
      const age = Date.now() - cached.createdAt;
      if (age < RESPONSE_CACHE_TTL_MS) {
        return cached.promise as Promise<T>;
      }
      // TTL expired — evict and re-request
      this.responseCache.delete(cacheKey);
    }

    // Reject if pending queue is full to prevent backpressure freeze
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      this.output.appendLine(
        `  [IPC] DROPPING ${method} (source=${source}): pending queue full (${this.pendingRequests.size}/${MAX_PENDING_REQUESTS})`
      );
      return Promise.reject(new Error(`Pending request queue full (${MAX_PENDING_REQUESTS}). Dropping ${method}.`));
    }

    // Reject oversized payloads before serialization stalls the event loop
    const serializedParams = JSON.stringify(params);
    if (serializedParams.length > MAX_PAYLOAD_BYTES) {
      this.output.appendLine(
        `  [IPC] DROPPING ${method} (source=${source}): payload too large (${(serializedParams.length / 1024).toFixed(1)}KB > ${MAX_PAYLOAD_BYTES / 1024}KB)`
      );
      return Promise.reject(new Error(`Payload too large for ${method}: ${(serializedParams.length / 1024).toFixed(1)}KB`));
    }

    const requestPromise = this.request<T>(
      method,
      params,
      REQUEST_TIMEOUT_MS,
      effectiveBackground,
      source
    );
    this.responseCache.set(cacheKey, { promise: requestPromise, createdAt: Date.now() });
    this.evictOldestCachedResponse();
    requestPromise.catch(() => {
      if (this.responseCache.get(cacheKey)?.promise === requestPromise) {
        this.responseCache.delete(cacheKey);
      }
    });
    return requestPromise;
  }

  private handleServerMessage(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    this.log('debug', `[daemon->client] ${trimmed}`);

    const message = this.parseServerMessage(trimmed);
    if (!message) {
      return;
    }

    if ('event' in message) {
      this.handleServerNotification(message);
      return;
    }

    const payloadKb = trimmed.length / 1024;
    if (payloadKb >= 10) {
      this.output.appendLine(
        `  [IPC:recv] ${message.id} payload=${payloadKb.toFixed(1)}KB`
      );
    }

    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private disposeProcessHandles(
    targetProcess?: ChildProcessWithoutNullStreams,
    targetReader?: readline.Interface
  ): void {
    targetReader?.removeAllListeners();
    try {
      targetReader?.close();
    } catch {
      // Ignore reader shutdown races during restart.
    }

    if (!targetProcess || this.process === targetProcess) {
      this.process = undefined;
    }

    if (!targetReader || this.stdoutReader === targetReader) {
      this.stdoutReader = undefined;
    }
  }

  private updateState(snapshot: HealthSnapshot): void {
    this.currentState = snapshot;
    this.stateEmitter.fire(snapshot);
  }

  private decorateSnapshot(snapshot: HealthSnapshot): HealthSnapshot {
    return {
      ...snapshot,
      workspaceRoot: snapshot.workspaceRoot ?? this.lastLaunchContext?.workspaceRoot,
      pythonSource: this.lastLaunchContext?.pythonSource,
      pythonSourceDetail: this.lastLaunchContext?.pythonSourceDetail,
      settingsModule: snapshot.settingsModule ?? this.lastLaunchContext?.settingsModule,
    };
  }

  private updateStateFromError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.clearResponseCache();
    this.updateState({
      phase: 'error',
      detail: message,
      capabilities: this.currentState.capabilities,
      workspaceRoot: this.lastLaunchContext?.workspaceRoot,
      pythonPath: this.lastLaunchContext?.pythonPath,
      pythonSource: this.lastLaunchContext?.pythonSource,
      pythonSourceDetail: this.lastLaunchContext?.pythonSourceDetail,
      settingsModule: this.lastLaunchContext?.settingsModule,
      staticIndex: this.currentState.staticIndex,
      runtime: this.currentState.runtime,
      semanticGraph: this.currentState.semanticGraph,
      startedAt: this.currentState.startedAt,
    });
  }

  private async checkForInterpreterChange(): Promise<void> {
    if (!this.lastLaunchContext) {
      return;
    }

    const nextLaunchContext = await this.createLaunchContext();
    if (nextLaunchContext.pythonPath === this.lastLaunchContext.pythonPath) {
      return;
    }

    this.log(
      'info',
      `Detected Python interpreter change (${this.lastLaunchContext.pythonPath} -> ${nextLaunchContext.pythonPath}). Restarting analysis daemon.`
    );
    await this.restart();
  }

  private async requiresScopedRestart(
    scope: vscode.ConfigurationScope
  ): Promise<boolean> {
    if (!this.lastLaunchContext) {
      return false;
    }

    const nextLaunchContext = await this.createLaunchContext(scope);
    return (
      nextLaunchContext.workspaceRoot !== this.lastLaunchContext.workspaceRoot ||
      (nextLaunchContext.settingsModule ?? '') !==
        (this.lastLaunchContext.settingsModule ?? '')
    );
  }

  /** Write a diagnostic line to the output channel (always, regardless of logLevel). */
  logDiagnostic(message: string): void {
    this.output.appendLine(message);
  }

  private log(level: 'info' | 'debug', message: string): void {
    const settings = getExtensionSettings();
    if (settings.logLevel === 'off') {
      return;
    }

    if (level === 'debug' && settings.logLevel !== 'debug') {
      return;
    }

    this.output.appendLine(message);
  }

  private clearResponseCache(): void {
    this.responseCache.clear();
  }

  private evictOldestCachedResponse(): void {
    // Evict TTL-expired entries first
    const now = Date.now();
    for (const [key, entry] of this.responseCache) {
      if (now - entry.createdAt >= RESPONSE_CACHE_TTL_MS) {
        this.responseCache.delete(key);
      }
    }
    // Then evict oldest if still over limit
    while (this.responseCache.size > RESPONSE_CACHE_LIMIT) {
      const oldestKey = this.responseCache.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.responseCache.delete(oldestKey);
    }
  }

  private currentRequestSource(): IpcRequestSource {
    return this.requestSourceContext.getStore() ?? 'unknown';
  }

  private handleServerNotification(
    message: Extract<ServerMessage, { event: string }>
  ): void {
    if (message.event === 'healthChanged') {
      if (!message.params?.health) {
        return;
      }

      this.clearResponseCache();
      this.updateState(this.decorateSnapshot(message.params.health));
      return;
    }

    if (message.event !== 'surfaceIndexChanged') {
      return;
    }

    this.clearResponseCache();
    if (message.params?.surfaceIndex) {
      this.surfaceIndex = message.params.surfaceIndex;
      this.modelNames = new Set(message.params.modelNames ?? []);
      this.customLookups = message.params.customLookups ?? {};
      this.staticFallback = message.params.staticFallback ?? null;
      this.rebuildModelLabelByName();
      this.rebuildLocalWorkspaceIndex();
    }

    const nextSnapshot = message.params?.health
      ? this.decorateSnapshot(message.params.health)
      : this.currentState;
    this.updateState(nextSnapshot);
  }

  private parseServerMessage(line: string): ServerMessage | undefined {
    const firstNonWhitespace = line.search(/\S/);
    if (firstNonWhitespace < 0) {
      return undefined;
    }

    if (line[firstNonWhitespace] !== '{') {
      this.log('info', `[daemon stdout ignored] ${line}`);
      return undefined;
    }

    const extracted = extractLeadingJsonObject(line.slice(firstNonWhitespace));
    const candidate = extracted?.jsonText ?? line.slice(firstNonWhitespace);

    try {
      if (extracted?.trailingText.trim()) {
        this.log(
          'info',
          `[daemon stdout trailing noise ignored] ${extracted.trailingText.trim()}`
        );
      }
      return JSON.parse(candidate) as ServerMessage;
    } catch (error) {
      this.log(
        'info',
        `Failed to parse daemon response: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }
}

function extractLeadingJsonObject(
  text: string
): { jsonText: string; trailingText: string } | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char !== '}') {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return {
        jsonText: text.slice(0, index + 1),
        trailingText: text.slice(index + 1),
      };
    }
  }

  return undefined;
}

function pathExists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}
