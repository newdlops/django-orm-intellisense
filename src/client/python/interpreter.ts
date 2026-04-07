import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CONFIGURATION_SECTION,
  getExtensionSettings,
  type ExtensionSettings,
} from '../config/settings';

const DARWIN_PYTHON3_CANDIDATES = [
  '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
  '/Library/Developer/CommandLineTools/usr/bin/python3',
];

export type PythonInterpreterSource =
  | 'djangoOrmIntellisense.pythonInterpreter'
  | 'fallback';

export interface ResolvedPythonInterpreter {
  path: string;
  source: PythonInterpreterSource;
  detail: string;
}

export interface PythonInterpreterValidation {
  valid: boolean;
  normalizedPath: string;
  reason?: string;
}

export function getInterpreterResource(
  settings: ExtensionSettings = getExtensionSettings()
): vscode.Uri | undefined {
  const configuredWorkspaceRoot = resolveExistingWorkspaceRootSetting(
    settings.workspaceRoot
  );
  if (configuredWorkspaceRoot) {
    return vscode.Uri.file(configuredWorkspaceRoot);
  }

  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument?.uri.scheme === 'file') {
    return activeDocument.uri;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function getInterpreterBasePath(
  settings: ExtensionSettings = getExtensionSettings()
): string | undefined {
  const configuredWorkspaceRoot = resolveExistingWorkspaceRootSetting(
    settings.workspaceRoot
  );
  if (configuredWorkspaceRoot) {
    return configuredWorkspaceRoot;
  }

  const resource = getInterpreterResource(settings);
  const workspaceFolder = getWorkspaceFolderPath(resource);
  if (workspaceFolder) {
    return workspaceFolder;
  }

  return getResourceBasePath(resource);
}

export async function resolvePythonInterpreter(
  settings: ExtensionSettings = getExtensionSettings()
): Promise<ResolvedPythonInterpreter> {
  const resource = getInterpreterResource(settings);
  const basePath = getInterpreterBasePath(settings);

  const configuredInterpreter = normalizeInterpreterCandidate(
    settings.pythonInterpreter,
    resource,
    basePath
  );
  if (configuredInterpreter) {
    return {
      path: configuredInterpreter,
      source: 'djangoOrmIntellisense.pythonInterpreter',
      detail:
        'Using the `djangoOrmIntellisense.pythonInterpreter` setting.',
    };
  }

  const legacyInterpreter = normalizeInterpreterCandidate(
    getLegacyPythonInterpreterSetting(resource),
    resource,
    basePath
  );
  if (legacyInterpreter) {
    return {
      path: legacyInterpreter,
      source: 'djangoOrmIntellisense.pythonInterpreter',
      detail:
        'Using legacy `djangoOrmIntellisense.pythonPath` until it is migrated into `djangoOrmIntellisense.pythonInterpreter`.',
    };
  }

  const fallbackInterpreter = findFallbackPythonInterpreter();
  return {
    path: fallbackInterpreter,
    source: 'fallback',
    detail:
      `No \`djangoOrmIntellisense.pythonInterpreter\` is configured. ` +
      `Falling back to \`${fallbackInterpreter}\`.`,
  };
}

export async function normalizePythonInterpreterSettings(
  settings: ExtensionSettings = getExtensionSettings()
): Promise<'migrated' | 'cleared' | 'noop'> {
  const resource = getInterpreterResource(settings);
  const configuration = vscode.workspace.getConfiguration(
    CONFIGURATION_SECTION,
    resource
  );
  const configuredInterpreter = configuration.get<string>('pythonInterpreter')?.trim();
  const legacyInterpreter = getLegacyPythonInterpreterSetting(resource);

  if (!legacyInterpreter) {
    return 'noop';
  }

  if (!configuredInterpreter) {
    await configuration.update(
      'pythonInterpreter',
      legacyInterpreter,
      resolveLegacySettingTarget(configuration, resource) ??
        resolveInterpreterConfigurationTarget(resource)
    );
    await clearLegacyPythonPathSetting(configuration, resource);
    return 'migrated';
  }

  await clearLegacyPythonPathSetting(configuration, resource);
  return 'cleared';
}

export function validatePythonInterpreterPath(
  interpreterPath: string
): PythonInterpreterValidation {
  const normalizedPath = normalizeFilesystemInterpreterPath(interpreterPath);

  if (!isFilesystemInterpreterCandidate(normalizedPath)) {
    return {
      valid: true,
      normalizedPath,
    };
  }

  if (!fs.existsSync(normalizedPath)) {
    return {
      valid: false,
      normalizedPath,
      reason: `Interpreter path does not exist: ${normalizedPath}`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalizedPath);
  } catch (error) {
    return {
      valid: false,
      normalizedPath,
      reason:
        error instanceof Error
          ? `Failed to inspect interpreter path: ${error.message}`
          : 'Failed to inspect interpreter path.',
    };
  }

  if (stat.isDirectory()) {
    return {
      valid: false,
      normalizedPath,
      reason: `Interpreter path resolved to a directory, not an executable: ${normalizedPath}`,
    };
  }

  if (process.platform !== 'win32') {
    try {
      fs.accessSync(normalizedPath, fs.constants.X_OK);
    } catch {
      return {
        valid: false,
        normalizedPath,
        reason: `Interpreter path is not executable: ${normalizedPath}`,
      };
    }
  }

  return {
    valid: true,
    normalizedPath,
  };
}

export async function browseForPythonInterpreter(
  settings: ExtensionSettings = getExtensionSettings()
): Promise<string | undefined> {
  const localCandidates = findWorkspaceVirtualEnvInterpreterCandidates(settings);
  if (localCandidates.length > 0) {
    const items: Array<
      vscode.QuickPickItem & {
        path?: string;
        browse?: boolean;
      }
    > = [
      ...localCandidates.map((candidatePath) => ({
        label: path.basename(candidatePath),
        description: candidatePath,
        path: candidatePath,
      })),
      {
        label: 'Browse...',
        description: 'Choose another Python executable or virtualenv directory',
        browse: true,
      },
    ];

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a Python interpreter for this workspace',
      ignoreFocusOut: true,
    });

    if (!selection) {
      return undefined;
    }

    if (!selection.browse) {
      return selection.path;
    }
  }

  const basePath = getInterpreterBasePath(settings);
  const selection = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: basePath ? vscode.Uri.file(basePath) : undefined,
    openLabel: 'Select Interpreter',
    title: 'Select a Python executable or virtualenv directory',
  });

  return selection?.[0]?.fsPath;
}

export async function savePythonInterpreterSetting(
  selectedPath: string,
  settings: ExtensionSettings = getExtensionSettings()
): Promise<string> {
  const resource = getInterpreterResource(settings);
  const value = resolveStoredInterpreterPath(selectedPath, settings);
  const target = resolveInterpreterConfigurationTarget(
    resource ?? vscode.Uri.file(selectedPath)
  );
  const configuration = vscode.workspace.getConfiguration(
    CONFIGURATION_SECTION,
    resource
  );

  await configuration.update('pythonInterpreter', value, target);
  await clearLegacyPythonPathSetting(configuration);

  return value;
}

function resolveStoredInterpreterPath(
  selectedPath: string,
  settings: ExtensionSettings
): string {
  const normalizedSelectedPath = path.normalize(selectedPath);
  const workspaceVirtualEnvPath = findWorkspaceVirtualEnvInterpreterPath(
    normalizedSelectedPath,
    settings
  );
  return path.normalize(workspaceVirtualEnvPath ?? normalizedSelectedPath);
}

function findWorkspaceVirtualEnvInterpreterPath(
  selectedPath: string,
  settings: ExtensionSettings
): string | undefined {
  if (!path.isAbsolute(selectedPath)) {
    return undefined;
  }

  const selectedRealPath = safeRealpath(selectedPath);
  const basePath = getInterpreterBasePath(settings);
  if (!selectedRealPath || !basePath) {
    return undefined;
  }

  for (const virtualEnvName of ['venv', '.venv', 'env', '.env']) {
    const virtualEnvRoot = path.join(basePath, virtualEnvName);
    const matchedPath = findMatchingVirtualEnvInterpreterInRoot(
      virtualEnvRoot,
      selectedPath,
      selectedRealPath
    );
    if (matchedPath) {
      return matchedPath;
    }
  }

  return undefined;
}

function findWorkspaceVirtualEnvInterpreterCandidates(
  settings: ExtensionSettings
): string[] {
  const basePath = getInterpreterBasePath(settings);
  if (!basePath) {
    return [];
  }

  const candidates: string[] = [];
  for (const virtualEnvName of ['venv', '.venv', 'env', '.env']) {
    candidates.push(
      ...listVirtualEnvInterpreterCandidates(path.join(basePath, virtualEnvName))
    );
  }

  return [...new Set(candidates)];
}

function listVirtualEnvInterpreterCandidates(virtualEnvRoot: string): string[] {
  if (!fs.existsSync(path.join(virtualEnvRoot, 'pyvenv.cfg'))) {
    return [];
  }

  const executableDirectory = path.join(
    virtualEnvRoot,
    process.platform === 'win32' ? 'Scripts' : 'bin'
  );

  let entries: string[];
  try {
    entries = fs.readdirSync(executableDirectory);
  } catch {
    return [];
  }

  const preferredNames = process.platform === 'win32'
    ? ['python.exe', 'python']
    : ['python', 'python3'];
  const candidatePaths = [
    ...preferredNames.map((name) => path.join(executableDirectory, name)),
    ...entries
      .filter((name) => isPythonExecutableName(name))
      .sort(comparePythonExecutableNames)
      .map((name) => path.join(executableDirectory, name)),
  ];

  return [...new Set(candidatePaths)].filter((candidatePath) => {
    try {
      return fs.statSync(candidatePath).isFile();
    } catch {
      return false;
    }
  });
}

function findMatchingVirtualEnvInterpreterInRoot(
  virtualEnvRoot: string,
  selectedPath: string,
  selectedRealPath: string
): string | undefined {
  if (!fs.existsSync(path.join(virtualEnvRoot, 'pyvenv.cfg'))) {
    return undefined;
  }

  const executableDirectory = path.join(
    virtualEnvRoot,
    process.platform === 'win32' ? 'Scripts' : 'bin'
  );

  let entries: string[];
  try {
    entries = fs.readdirSync(executableDirectory);
  } catch {
    return undefined;
  }

  const preferredNames = [
    path.basename(selectedPath),
    ...(process.platform === 'win32'
      ? ['python.exe', 'python']
      : ['python', 'python3']),
  ];
  const candidatePaths = [
    ...preferredNames.map((name) => path.join(executableDirectory, name)),
    ...entries
      .filter((name) => isPythonExecutableName(name))
      .map((name) => path.join(executableDirectory, name)),
  ];

  for (const candidatePath of [...new Set(candidatePaths)]) {
    try {
      if (
        fs.statSync(candidatePath).isFile() &&
        safeRealpath(candidatePath) === selectedRealPath
      ) {
        return candidatePath;
      }
    } catch {
      // Keep searching for a matching local virtualenv executable.
    }
  }

  return undefined;
}

function isPythonExecutableName(name: string): boolean {
  return process.platform === 'win32'
    ? /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(name)
    : /^python(?:\d+(?:\.\d+)*)?$/.test(name);
}

function comparePythonExecutableNames(left: string, right: string): number {
  const rank = (name: string): number => {
    const normalized = name.toLowerCase();
    if (normalized === 'python' || normalized === 'python.exe') {
      return 0;
    }
    if (normalized === 'python3' || normalized === 'python3.exe') {
      return 1;
    }
    return 2;
  };

  const rankDifference = rank(left) - rank(right);
  return rankDifference !== 0 ? rankDifference : left.localeCompare(right);
}

function safeRealpath(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function normalizeInterpreterCandidate(
  candidate: string | undefined,
  resource?: vscode.Uri,
  basePath?: string
): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed || trimmed.includes('${command:')) {
    return undefined;
  }

  let expanded = trimmed;

  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith(`~${path.sep}`)) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  } else if (expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }

  const candidateBasePath = basePath ?? getInterpreterBasePath();
  const workspaceBaseName = candidateBasePath
    ? path.basename(candidateBasePath)
    : undefined;

  expanded = replaceToken(expanded, '${workspaceFolder}', candidateBasePath);
  expanded = replaceToken(expanded, '${workspaceRoot}', candidateBasePath);
  expanded = replaceToken(
    expanded,
    '${workspaceFolderBasename}',
    workspaceBaseName
  );

  if (expanded.includes('${')) {
    return undefined;
  }

  if (!path.isAbsolute(expanded)) {
    const resolutionBasePath = candidateBasePath ?? getResourceBasePath(resource);
    const existingRelativePath =
      resolutionBasePath && fs.existsSync(path.resolve(resolutionBasePath, expanded))
        ? path.resolve(resolutionBasePath, expanded)
        : undefined;

    if (existingRelativePath) {
      expanded = existingRelativePath;
    } else if (looksLikeFilesystemPath(expanded) && resolutionBasePath) {
      expanded = path.resolve(resolutionBasePath, expanded);
    }
  }

  return normalizeFilesystemInterpreterPath(expanded);
}

function getWorkspaceFolderPath(resource?: vscode.Uri): string | undefined {
  if (resource) {
    const folder = vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath;
    if (folder) {
      return folder;
    }

    if (resource.scheme === 'file') {
      const resourcePath = resource.fsPath;
      return path.extname(resourcePath) ? path.dirname(resourcePath) : resourcePath;
    }
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getResourceBasePath(resource?: vscode.Uri): string | undefined {
  if (!resource || resource.scheme !== 'file') {
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath;
  if (workspaceFolder) {
    return workspaceFolder;
  }

  const resourcePath = resource.fsPath;
  if (!resourcePath) {
    return undefined;
  }

  return path.extname(resourcePath) ? path.dirname(resourcePath) : resourcePath;
}

function looksLikeFilesystemPath(candidate: string): boolean {
  return (
    candidate.startsWith('.') ||
    candidate.startsWith('~') ||
    candidate.includes('/') ||
    candidate.includes('\\')
  );
}

function isFilesystemInterpreterCandidate(candidate: string): boolean {
  return path.isAbsolute(candidate) || looksLikeFilesystemPath(candidate);
}

function normalizeFilesystemInterpreterPath(candidate: string): string {
  const normalizedCandidate = remapKnownMacOsPythonStub(candidate);
  if (!isFilesystemInterpreterCandidate(normalizedCandidate)) {
    return normalizedCandidate;
  }

  try {
    const stat = fs.statSync(normalizedCandidate);
    if (!stat.isDirectory()) {
      return path.normalize(normalizedCandidate);
    }
  } catch {
    return normalizedCandidate;
  }

  const candidates = buildDirectoryExecutableCandidates(normalizedCandidate);
  for (const executableCandidate of candidates) {
    try {
      const stat = fs.statSync(executableCandidate);
      if (stat.isFile()) {
        return executableCandidate;
      }
    } catch {
      // Keep searching.
    }
  }

  return normalizedCandidate;
}

function buildDirectoryExecutableCandidates(directory: string): string[] {
  const directoryName = path.basename(directory).toLowerCase();
  const names =
    process.platform === 'win32'
      ? ['python.exe', 'python']
      : ['python', 'python3'];

  const candidates: string[] = [];

  if (directoryName === 'scripts' || directoryName === 'bin') {
    for (const name of names) {
      candidates.push(path.join(directory, name));
    }
  }

  for (const childDirectory of ['Scripts', 'scripts', 'bin']) {
    for (const name of names) {
      candidates.push(path.join(directory, childDirectory, name));
    }
  }

  for (const name of names) {
    candidates.push(path.join(directory, name));
  }

  return [...new Set(candidates)];
}

function findFallbackPythonInterpreter(): string {
  if (process.platform === 'win32') {
    return 'python';
  }

  for (const candidate of [
    ...DARWIN_PYTHON3_CANDIDATES,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ]) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return path.normalize(candidate);
      }
    } catch {
      // Keep searching fallback locations.
    }
  }

  for (const segment of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(segment, 'python3');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return path.normalize(candidate);
      }
    } catch {
      // Keep searching PATH entries.
    }
  }

  return 'python3';
}

function remapKnownMacOsPythonStub(candidate: string): string {
  if (process.platform !== 'darwin' || candidate !== '/usr/bin/python3') {
    return candidate;
  }

  for (const developerPython of DARWIN_PYTHON3_CANDIDATES) {
    try {
      const stat = fs.statSync(developerPython);
      if (stat.isFile()) {
        return developerPython;
      }
    } catch {
      // Keep searching for a usable developer tools Python.
    }
  }

  return candidate;
}

function resolveLegacySettingTarget(
  configuration: vscode.WorkspaceConfiguration,
  resource?: vscode.Uri
): vscode.ConfigurationTarget | undefined {
  const inspected = configuration.inspect<string>('pythonPath');
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }

  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }

  if (inspected?.globalValue !== undefined) {
    return vscode.ConfigurationTarget.Global;
  }

  if (legacyPythonPathExistsInWorkspaceSettings(resource)) {
    return resolveInterpreterConfigurationTarget(resource);
  }

  return undefined;
}

function getLegacyPythonInterpreterSetting(resource?: vscode.Uri): string | undefined {
  const configured = vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION, resource)
    .get<string>('pythonPath')
    ?.trim();
  if (configured) {
    return configured;
  }

  return readLegacyPythonPathFromWorkspaceSettings(resource);
}

async function clearLegacyPythonPathSetting(
  configuration: vscode.WorkspaceConfiguration,
  resource?: vscode.Uri
): Promise<void> {
  const inspected = configuration.inspect<string>('pythonPath');
  const updates: Thenable<void>[] = [];

  if (inspected?.workspaceFolderValue !== undefined) {
    updates.push(
      configuration.update(
        'pythonPath',
        undefined,
        vscode.ConfigurationTarget.WorkspaceFolder
      )
    );
  }

  if (inspected?.workspaceValue !== undefined) {
    updates.push(
      configuration.update(
        'pythonPath',
        undefined,
        vscode.ConfigurationTarget.Workspace
      )
    );
  }

  if (inspected?.globalValue !== undefined) {
    updates.push(
      configuration.update(
        'pythonPath',
        undefined,
        vscode.ConfigurationTarget.Global
      )
    );
  }

  await Promise.all(updates);
  clearLegacyPythonPathFromWorkspaceSettings(resource);
}

function resolveInterpreterConfigurationTarget(
  resource?: vscode.Uri
): vscode.ConfigurationTarget {
  return vscode.workspace.getWorkspaceFolder(resource ?? vscode.Uri.file(process.cwd()))
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
}

function resolveWorkspaceRootSetting(workspaceRoot: string): string {
  if (path.isAbsolute(workspaceRoot)) {
    return workspaceRoot;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return path.resolve(workspaceFolder ?? process.cwd(), workspaceRoot);
}

function resolveExistingWorkspaceRootSetting(
  workspaceRoot: string | undefined
): string | undefined {
  if (!workspaceRoot) {
    return undefined;
  }

  const resolvedWorkspaceRoot = resolveWorkspaceRootSetting(workspaceRoot);
  return fs.existsSync(resolvedWorkspaceRoot) ? resolvedWorkspaceRoot : undefined;
}

function replaceToken(
  value: string,
  token: string,
  replacement?: string
): string {
  if (!replacement || !value.includes(token)) {
    return value;
  }

  return value.split(token).join(replacement);
}

function readLegacyPythonPathFromWorkspaceSettings(
  resource?: vscode.Uri
): string | undefined {
  const settings = readWorkspaceSettingsFile(resource);
  const rawValue = settings?.[`${CONFIGURATION_SECTION}.pythonPath`];
  return typeof rawValue === 'string' ? rawValue.trim() || undefined : undefined;
}

function legacyPythonPathExistsInWorkspaceSettings(resource?: vscode.Uri): boolean {
  const settings = readWorkspaceSettingsFile(resource);
  return Boolean(settings && `${CONFIGURATION_SECTION}.pythonPath` in settings);
}

function clearLegacyPythonPathFromWorkspaceSettings(resource?: vscode.Uri): void {
  const settingsPath = workspaceSettingsFilePath(resource);
  const settings = readWorkspaceSettingsFile(resource);
  if (!settingsPath || !settings || !(`${CONFIGURATION_SECTION}.pythonPath` in settings)) {
    return;
  }

  delete settings[`${CONFIGURATION_SECTION}.pythonPath`];
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function readWorkspaceSettingsFile(
  resource?: vscode.Uri
): Record<string, unknown> | undefined {
  const settingsPath = workspaceSettingsFilePath(resource);
  if (!settingsPath || !fs.existsSync(settingsPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function workspaceSettingsFilePath(resource?: vscode.Uri): string | undefined {
  const workspaceFolderPath = getWorkspaceFolderPath(resource);
  return workspaceFolderPath
    ? path.join(workspaceFolderPath, '.vscode', 'settings.json')
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
