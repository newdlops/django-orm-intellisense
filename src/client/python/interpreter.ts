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
  | 'python-extension'
  | 'python.defaultInterpreterPath'
  | 'workspace-venv'
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
  settings: ExtensionSettings = getExtensionSettings(),
  resource: vscode.Uri | undefined = getInterpreterResource(settings)
): string | undefined {
  const configuredWorkspaceRoot = resolveExistingWorkspaceRootSetting(
    settings.workspaceRoot
  );
  if (configuredWorkspaceRoot) {
    return configuredWorkspaceRoot;
  }

  const workspaceFolder = getWorkspaceFolderPath(resource);
  if (workspaceFolder) {
    return workspaceFolder;
  }

  return getResourceBasePath(resource);
}

export async function resolvePythonInterpreter(
  settings: ExtensionSettings = getExtensionSettings(),
  resource: vscode.Uri | undefined = getInterpreterResource(settings)
): Promise<ResolvedPythonInterpreter> {
  const basePath = getInterpreterBasePath(settings, resource);

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

  // Read the public selection synchronously. Environment discovery/activation
  // may still be running; the owned readiness observer reconciles it later.
  try {
    const python = vscode.extensions.getExtension<PythonSelectionApi>('ms-python.python');
    const selected = python?.isActive
      ? python.exports.environments?.getActiveEnvironmentPath(resource)?.path : undefined;
    const selectedPath = existingAutomaticInterpreter(selected, resource, basePath);
    if (selectedPath) {
      const directory = path.dirname(selectedPath);
      const environmentRoot = ['bin', 'scripts'].includes(path.basename(directory).toLowerCase())
        ? path.dirname(directory) : directory;
      const selectedEnvironment = fs.existsSync(path.join(environmentRoot, 'pyvenv.cfg'))
        || fs.existsSync(path.join(environmentRoot, 'conda-meta'));
      // Public selection may be the resolved base executable of a project
      // virtualenv. Preserve the virtualenv path so its installed packages
      // remain visible. An explicitly selected external env stays external.
      const projectPath = !selectedEnvironment
        ? findAutomaticWorkspaceInterpreter(resource, basePath, safeRealpath(selectedPath)) : undefined;
      return {
        path: projectPath ?? selectedPath, source: 'python-extension',
        detail: projectPath
          ? 'Using the project virtualenv for the base Python executable selected in VS Code.'
          : 'Using the Python environment selected in VS Code for this workspace.',
      };
    }
  } catch {
    // The Python extension may not have published its API yet.
  }

  const pythonConfiguration = vscode.workspace.getConfiguration('python', resource);
  const defaultPath = existingAutomaticInterpreter(
    pythonConfiguration.get<string>('defaultInterpreterPath'), resource, basePath);
  if (defaultPath) return {
    path: defaultPath, source: 'python.defaultInterpreterPath',
    detail: 'Using the workspace `python.defaultInterpreterPath` setting.',
  };

  const localPath = findAutomaticWorkspaceInterpreter(resource, basePath);
  if (localPath) return {
    path: localPath, source: 'workspace-venv',
    detail: 'Using the project virtual environment discovered from the source file and workspace root.',
  };

  const fallbackInterpreter = findFallbackPythonInterpreter();
  return {
    path: fallbackInterpreter,
    source: 'fallback',
    detail:
      `No selected Python environment or project virtual environment was found. ` +
      `Falling back to \`${fallbackInterpreter}\`.`,
  };
}

/** Public contract: https://github.com/microsoft/vscode-python/blob/main/pythonExtensionApi/src/main.ts */
export interface PythonSelectionApi {
  ready?: PromiseLike<unknown>;
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { path: string } | undefined;
    onDidChangeActiveEnvironmentPath?: vscode.Event<{ resource?: vscode.Uri | vscode.WorkspaceFolder }>;
  };
}

function existingAutomaticInterpreter(candidate: string | undefined, resource?: vscode.Uri,
                                      basePath?: string): string | undefined {
  const normalized = normalizeInterpreterCandidate(candidate, resource, basePath);
  // The Python API's unselected default can be the command "python". It
  // must not hide an existing project virtualenv or another folder's choice.
  if (!normalized || !path.isAbsolute(normalized)) return undefined;
  return validatePythonInterpreterPath(normalized).valid ? normalized : undefined;
}

function findAutomaticWorkspaceInterpreter(resource?: vscode.Uri, basePath?: string,
                                           selectedBase?: string): string | undefined {
  if (!basePath) return undefined;
  const root = path.resolve(basePath);
  let current = root;
  if (resource?.scheme === 'file') {
    const source = path.resolve(resource.fsPath);
    const directory = fs.statSync(source, { throwIfNoEntry: false })?.isDirectory() ? source : path.dirname(source);
    const relative = path.relative(root, directory);
    if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) current = directory;
  }
  while (true) {
    for (const name of ['.venv', 'venv', 'env', '.env']) {
      const candidate = listVirtualEnvInterpreterCandidates(path.join(current, name))
        .find(value => validatePythonInterpreterPath(value).valid
          && (!selectedBase || safeRealpath(value) === selectedBase));
      if (candidate) return candidate;
    }
    if (current === root) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
    await updateConfigurationSetting(
      configuration,
      'pythonInterpreter',
      legacyInterpreter,
      resolveLegacySettingTarget(configuration, resource) ??
        resolveInterpreterConfigurationTarget(resource),
      resource
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
  const configurationResource = resolveConfigurationResource(
    resource,
    selectedPath
  );
  const value = resolveStoredInterpreterPath(selectedPath, settings);
  const target = resolveInterpreterConfigurationTarget(
    configurationResource ?? vscode.Uri.file(selectedPath)
  );
  const workspaceSettingsPath = workspaceSettingsFilePath(configurationResource);
  if (
    target !== vscode.ConfigurationTarget.Global &&
    configurationResource &&
    workspaceSettingsPath
  ) {
    await saveDirtyWorkspaceSettingsDocument(workspaceSettingsPath);
    updateWorkspaceSettingsValues(configurationResource, {
      [`${CONFIGURATION_SECTION}.pythonInterpreter`]: value,
      [`${CONFIGURATION_SECTION}.pythonPath`]: undefined,
    });
    await waitForConfigurationValue(
      'pythonInterpreter',
      value,
      configurationResource
    );
    return value;
  }

  const configuration = vscode.workspace.getConfiguration(
    CONFIGURATION_SECTION,
    configurationResource
  );

  await updateConfigurationSetting(
    configuration,
    'pythonInterpreter',
    value,
    target,
    configurationResource
  );
  await clearLegacyPythonPathSetting(configuration, configurationResource);

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
  for (const segment of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!segment || !path.isAbsolute(segment)) continue;
    for (const name of process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']) {
      const candidate = path.join(segment, name);
      if (validatePythonInterpreterPath(candidate).valid) return path.normalize(candidate);
    }
  }
  for (const candidate of process.platform === 'win32' ? [] : [
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3',
    ...(process.platform === 'darwin' ? DARWIN_PYTHON3_CANDIDATES : []), '/usr/bin/python3',
  ]) {
    if (validatePythonInterpreterPath(candidate).valid) return path.normalize(candidate);
  }
  return process.platform === 'win32' ? 'python' : 'python3';
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
  if (inspected?.workspaceFolderValue !== undefined && resource) {
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

  if (inspected?.workspaceFolderValue !== undefined && resource) {
    updates.push(
      updateConfigurationSetting(
        configuration,
        'pythonPath',
        undefined,
        vscode.ConfigurationTarget.WorkspaceFolder,
        resource
      )
    );
  }

  if (inspected?.workspaceValue !== undefined) {
    updates.push(
      updateConfigurationSetting(
        configuration,
        'pythonPath',
        undefined,
        vscode.ConfigurationTarget.Workspace,
        resource
      )
    );
  }

  if (inspected?.globalValue !== undefined) {
    updates.push(
      updateConfigurationSetting(
        configuration,
        'pythonPath',
        undefined,
        vscode.ConfigurationTarget.Global,
        resource
      )
    );
  }

  await Promise.all(updates);
  clearLegacyPythonPathFromWorkspaceSettings(resource);
}

function resolveInterpreterConfigurationTarget(
  resource?: vscode.Uri
): vscode.ConfigurationTarget {
  return resource && vscode.workspace.getWorkspaceFolder(resource)
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

function resolveConfigurationResource(
  resource: vscode.Uri | undefined,
  fallbackPath?: string
): vscode.Uri | undefined {
  if (!resource || resource.scheme !== 'file') {
    return fallbackPath ? vscode.Uri.file(fallbackPath) : resource;
  }

  try {
    if (fs.statSync(resource.fsPath).isDirectory()) {
      const scopedFilePath =
        fallbackPath && isPathInside(resource.fsPath, fallbackPath)
          ? path.resolve(fallbackPath)
          : path.join(resource.fsPath, '.vscode', 'settings.json');
      return vscode.Uri.file(scopedFilePath);
    }
  } catch {
    // Fall through — the original resource is still the best scope we have.
  }

  return resource;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

async function updateConfigurationSetting(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  value: unknown,
  target: vscode.ConfigurationTarget,
  resource?: vscode.Uri
): Promise<void> {
  try {
    await configuration.update(key, value, target);
  } catch (error) {
    if (
      target === vscode.ConfigurationTarget.WorkspaceFolder &&
      resource &&
      shouldFallbackWorkspaceFolderUpdate(resource, error)
    ) {
      await configuration.update(
        key,
        value,
        vscode.ConfigurationTarget.Workspace
      );
      return;
    }
    throw error;
  }
}

function shouldFallbackWorkspaceFolderUpdate(
  resource: vscode.Uri,
  error: unknown
): boolean {
  if (
    !(
      error instanceof Error &&
      error.message.includes('Folder Settings') &&
      error.message.includes('no resource')
    )
  ) {
    return false;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length !== 1) {
    return false;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource);
  return workspaceFolder?.uri.fsPath === workspaceFolders[0]?.uri.fsPath;
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

function updateWorkspaceSettingsValues(
  resource: vscode.Uri,
  updates: Record<string, unknown>
): void {
  const settingsPath = workspaceSettingsFilePath(resource);
  if (!settingsPath) {
    return;
  }

  const settings = readWorkspaceSettingsFile(resource) ?? {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete settings[key];
      continue;
    }
    settings[key] = value;
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

async function saveDirtyWorkspaceSettingsDocument(settingsPath: string): Promise<void> {
  const settingsDocument = vscode.workspace.textDocuments.find(
    (document) =>
      document.uri.scheme === 'file' &&
      path.normalize(document.uri.fsPath) === path.normalize(settingsPath)
  );
  if (settingsDocument?.isDirty) {
    await settingsDocument.save();
  }
}

async function waitForConfigurationValue(
  key: string,
  expectedValue: string,
  resource: vscode.Uri
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const currentValue = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION, resource)
      .get<string>(key);
    if (currentValue === expectedValue) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `Timed out waiting for ${CONFIGURATION_SECTION}.${key} to persist.`
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
