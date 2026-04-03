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

export interface PylanceStubSnapshot {
  rootPath: string;
  relativeRoot: string;
  fileCount: number;
  moduleCount: number;
  packageCount: number;
  generatedAt: string;
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
  relationDirection?: string;
  source: string;
  lookupOperator?: string;
}

export interface LookupPathCompletionsResult {
  items: LookupPathItem[];
  resolved: boolean;
  reason?: string;
  currentModelLabel?: string;
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
  pylanceStubs?: PylanceStubSnapshot;
  runtime?: RuntimeInspectionSnapshot;
  semanticGraph?: SemanticGraphSnapshot;
}

export interface InitializeResult {
  serverName: string;
  protocolVersion: string;
  health: HealthSnapshot;
}

export interface RequestMessage {
  id: string;
  method: string;
  params?: Record<string, unknown>;
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
