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
}

export interface SemanticGraphSnapshot {
  coverageMode: string;
  moduleCount: number;
  exportSurfaceCount: number;
  modelCandidateCount: number;
  runtimeModelCount?: number | null;
  provenanceLayers: string[];
}

export interface HealthSnapshot {
  phase: ServerPhase;
  detail: string;
  capabilities: string[];
  workspaceRoot?: string;
  managePyPath?: string;
  pythonPath?: string;
  settingsModule?: string;
  startedAt?: string;
  staticIndex?: StaticIndexSnapshot;
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
