export type ServerPhase = 'starting' | 'ready' | 'degraded' | 'stopped' | 'error';

export interface StaticIndexSnapshot {
  pythonFileCount: number;
  packageInitCount: number;
  reexportModuleCount: number;
  starImportCount: number;
  explicitAllCount: number;
  modelCandidateCount: number;
}

export interface RuntimeInspectionSnapshot {
  djangoImportable: boolean;
  djangoVersion?: string;
  bootstrapStatus: string;
  settingsModule?: string;
  bootstrapError?: string;
  appCount?: number;
  modelCount?: number;
  fieldCount?: number;
  relationCount?: number;
  reverseRelationCount?: number;
  managerCount?: number;
  modelPreview?: RuntimeModelPreview[];
}

export interface SemanticGraphSnapshot {
  coverageMode: string;
  moduleCount: number;
  exportSurfaceCount: number;
  modelCandidateCount: number;
  runtimeModelCount?: number | null;
  provenanceLayers: string[];
}

export interface RuntimeModelPreview {
  appLabel?: string;
  objectName?: string;
  label: string;
  module: string;
  filePath?: string;
  line?: number;
  column?: number;
  fieldNames: string[];
  relationNames: string[];
  reverseRelationNames: string[];
  managerNames: string[];
}

export interface RelationTargetItem extends RuntimeModelPreview {
  appLabel: string;
  objectName: string;
  source: string;
}

export interface RelationTargetsResult {
  items: RelationTargetItem[];
}

export interface RelationTargetResolution {
  resolved: boolean;
  matchKind?: string;
  reason?: string;
  target?: RelationTargetItem;
  candidates?: RelationTargetItem[];
}

export interface ExportOriginResolution {
  requestedModule: string;
  symbol: string;
  resolved: boolean;
  originModule?: string;
  originSymbol?: string;
  originFilePath?: string;
  originLine?: number;
  originColumn?: number;
  viaModules: string[];
  resolutionKind: string;
}

export interface ModuleResolution {
  requestedModule: string;
  resolved: boolean;
  filePath?: string;
  line?: number;
  column?: number;
}

export interface LookupPathItem {
  name: string;
  modelLabel: string;
  relatedModelLabel?: string;
  filePath?: string;
  line?: number;
  column?: number;
  fieldKind: string;
  isRelation: boolean;
  fieldPath?: string;
  relationDirection?: string;
  source: string;
  lookupOperator?: string;
}

export interface LookupPathCompletionsResult {
  items: LookupPathItem[];
  resolved: boolean;
  reason?: string;
  currentModelLabel?: string;
  truncated?: boolean;
}

export interface LookupPathResolution {
  resolved: boolean;
  reason?: string;
  missingSegment?: string;
  target?: LookupPathItem;
  resolvedSegments?: LookupPathItem[];
  baseModelLabel?: string;
  lookupOperator?: string;
}

export type OrmReceiverKind =
  | 'model_class'
  | 'instance'
  | 'manager'
  | 'queryset'
  | 'related_manager'
  | 'scalar'
  | 'unknown';

export interface OrmMemberItem {
  name: string;
  memberKind: string;
  modelLabel: string;
  receiverKind: string;
  detail: string;
  source: string;
  returnKind?: string;
  returnModelLabel?: string;
  managerName?: string;
  filePath?: string;
  line?: number;
  column?: number;
  fieldKind?: string;
  isRelation: boolean;
  signature?: string;
}

export interface OrmMemberCompletionsResult {
  items: OrmMemberItem[];
  resolved: boolean;
  reason?: string;
  receiverKind?: string;
  modelLabel?: string;
  managerName?: string;
}

export interface OrmMemberResolution {
  resolved: boolean;
  reason?: string;
  item?: OrmMemberItem;
}

export interface OrmMemberChainResolution {
  resolved: boolean;
  reason?: string;
  failedAt?: string;
  modelLabel?: string;
  receiverKind?: string;
  managerName?: string;
}

export interface HealthSnapshot {
  phase: ServerPhase;
  detail: string;
  capabilities: string[];
  workspaceRoot?: string;
  managePyPath?: string;
  pythonPath?: string;
  pythonSource?: string;
  pythonSourceDetail?: string;
  settingsModule?: string;
  settingsCandidates?: string[];
  startedAt?: string;
  staticIndex?: StaticIndexSnapshot;
  runtime?: RuntimeInspectionSnapshot;
  semanticGraph?: SemanticGraphSnapshot;
}

export interface InitializeResult {
  serverName: string;
  protocolVersion: string;
  health: HealthSnapshot;
  modelNames?: string[];
  surfaceIndex?: Record<string, Record<string, Record<string, [string, string | null, string?, (string | null)?]>>>;
  surfaceFingerprints?: Record<string, string>;
  customLookups?: Record<string, string[]>;
  customLookupsFingerprint?: string;
  staticFallback?: Record<string, { fields: string[]; relations: string[] }> | null;
  staticFallbackFingerprint?: string | null;
}

export interface ReindexFileResult {
  surfaceIndex?: Record<string, Record<string, Record<string, [string, string | null, string?, (string | null)?]>>>;
  surfaceIndexDelta?: Record<string, Record<string, Record<string, [string, string | null, string?, (string | null)?]>>>;
  surfaceFingerprints?: Record<string, string>;
  modelNames?: string[];
  staticFallback?: Record<string, { fields: string[]; relations: string[] }> | null;
  staticFallbackFingerprint?: string | null;
  /** When true, no model changes were detected — surfaceIndex/modelNames are omitted. */
  unchanged?: boolean;
  addedLabels?: string[];
  changedLabels?: string[];
  removedLabels?: string[];
}

export interface RequestMessage {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  source?: string;
  /** When true, the daemon processes this on a background thread pool
   *  instead of the main thread, keeping hover responsive. */
  background?: boolean;
}

export interface ResponseMessage {
  id: string;
  result?: unknown;
  error?: {
    code?: string;
    message: string;
    data?: unknown;
  };
}

export interface HealthChangedNotificationMessage {
  event: 'healthChanged';
  params?: {
    health?: HealthSnapshot;
  };
}

export interface SurfaceIndexChangedNotificationMessage {
  event: 'surfaceIndexChanged';
  params?: {
    health?: HealthSnapshot;
    modelNames?: string[];
    surfaceIndex?: Record<string, Record<string, Record<string, [string, string | null, string?, (string | null)?]>>>;
    surfaceFingerprints?: Record<string, string>;
    customLookups?: Record<string, string[]>;
    customLookupsFingerprint?: string;
    staticFallback?: Record<string, { fields: string[]; relations: string[] }> | null;
    staticFallbackFingerprint?: string | null;
  };
}

export type ServerMessage =
  | ResponseMessage
  | HealthChangedNotificationMessage
  | SurfaceIndexChangedNotificationMessage;
