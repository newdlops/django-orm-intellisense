import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CONFIGURATION_SECTION,
  getExtensionSettings,
  type ExtensionSettings,
} from '../config/settings';

const PYTHON_EXTENSION_ID = 'ms-python.python';
const PYTHON_INTERPRETER_COMMAND = 'python.interpreterPath';
const PYTHON_SELECT_COMMAND = 'python.setInterpreter';
const DARWIN_PYTHON3_CANDIDATES = [
  '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
  '/Library/Developer/CommandLineTools/usr/bin/python3',
];

export type PythonInterpreterSource =
  | 'djangoOrmIntellisense.pythonInterpreter'
  | 'djangoOrmIntellisense.pythonPath'
  | 'python.interpreterPath'
  | 'python.defaultInterpreterPath'
  | 'python.pythonPath'
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

type InterpreterBrowseKind = 'file' | 'folder';

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

  const explicitInterpreter = normalizeInterpreterCandidate(
    settings.pythonInterpreter,
    resource,
    basePath
  );
  if (explicitInterpreter) {
    return {
      path: explicitInterpreter,
      source: 'djangoOrmIntellisense.pythonInterpreter',
      detail:
        'Using the explicit `djangoOrmIntellisense.pythonInterpreter` setting.',
    };
  }

  const legacyInterpreter = normalizeInterpreterCandidate(
    settings.pythonPath,
    resource,
    basePath
  );
  if (legacyInterpreter) {
    return {
      path: legacyInterpreter,
      source: 'djangoOrmIntellisense.pythonPath',
      detail: 'Using the legacy `djangoOrmIntellisense.pythonPath` setting.',
    };
  }

  const pythonExtensionInterpreter = normalizeInterpreterCandidate(
    await getPythonExtensionInterpreter(resource),
    resource,
    basePath
  );
  if (pythonExtensionInterpreter) {
    return {
      path: pythonExtensionInterpreter,
      source: 'python.interpreterPath',
      detail:
        'Following the Python extension selected interpreter (`python.interpreterPath`).',
    };
  }

  const pythonConfiguration = vscode.workspace.getConfiguration('python', resource);
  const defaultInterpreter = normalizeInterpreterCandidate(
    pythonConfiguration.get<string>('defaultInterpreterPath'),
    resource,
    basePath
  );
  if (defaultInterpreter) {
    return {
      path: defaultInterpreter,
      source: 'python.defaultInterpreterPath',
      detail:
        'Using the `python.defaultInterpreterPath` setting because no active interpreter could be resolved.',
    };
  }

  const legacyPythonPath = normalizeInterpreterCandidate(
    pythonConfiguration.get<string>('pythonPath'),
    resource,
    basePath
  );
  if (legacyPythonPath) {
    return {
      path: legacyPythonPath,
      source: 'python.pythonPath',
      detail: 'Using the legacy `python.pythonPath` setting.',
    };
  }

  const fallbackInterpreter = findFallbackPythonInterpreter();
  return {
    path: fallbackInterpreter,
    source: 'fallback',
    detail: `Falling back to \`${fallbackInterpreter}\` because no workspace interpreter could be resolved.`,
  };
}

export async function selectPythonInterpreterFromPythonExtension(
  settings: ExtensionSettings = getExtensionSettings()
): Promise<boolean> {
  const extension = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
  if (!extension) {
    return false;
  }

  try {
    if (!extension.isActive) {
      await extension.activate();
    }
  } catch {
    // The command may still be available even if activation fails.
  }

  const resource = getInterpreterResource(settings);

  for (const argument of [resource, resource?.fsPath, undefined]) {
    try {
      if (argument === undefined) {
        await vscode.commands.executeCommand(PYTHON_SELECT_COMMAND);
      } else {
        await vscode.commands.executeCommand(PYTHON_SELECT_COMMAND, argument);
      }
      return true;
    } catch {
      // Try the next invocation shape.
    }
  }

  return false;
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
  const browseKind = await vscode.window.showQuickPick<
    { label: string; description: string; value: InterpreterBrowseKind }
  >(
    [
      {
        label: 'Python Executable',
        description: 'Select a python executable such as .venv/bin/python',
        value: 'file',
      },
      {
        label: 'Virtualenv Directory',
        description: 'Select an environment root such as .venv',
        value: 'folder',
      },
    ],
    {
      placeHolder: 'Choose what you want to browse for',
      ignoreFocusOut: true,
    }
  );

  if (!browseKind) {
    return undefined;
  }

  const basePath = getInterpreterBasePath(settings);
  const selection = await vscode.window.showOpenDialog({
    canSelectFiles: browseKind.value === 'file',
    canSelectFolders: browseKind.value === 'folder',
    canSelectMany: false,
    defaultUri: basePath ? vscode.Uri.file(basePath) : undefined,
    openLabel:
      browseKind.value === 'file'
        ? 'Select Python Executable'
        : 'Select Virtualenv Directory',
  });

  return selection?.[0]?.fsPath;
}

export async function savePythonInterpreterSetting(
  selectedPath: string,
  settings: ExtensionSettings = getExtensionSettings()
): Promise<string> {
  const resource = getInterpreterResource(settings);
  const value = toPythonInterpreterSettingValue(selectedPath, settings);
  const target = vscode.workspace.getWorkspaceFolder(resource ?? vscode.Uri.file(selectedPath))
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;

  await vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION, resource)
    .update('pythonInterpreter', value, target);

  return value;
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

async function getPythonExtensionInterpreter(
  resource?: vscode.Uri
): Promise<string | undefined> {
  const extension = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
  if (!extension) {
    return undefined;
  }

  try {
    if (!extension.isActive) {
      await extension.activate();
    }
  } catch {
    // Keep going and try the command directly.
  }

  for (const argument of [resource, resource?.fsPath, undefined]) {
    try {
      const result =
        argument === undefined
          ? await vscode.commands.executeCommand<unknown>(
              PYTHON_INTERPRETER_COMMAND
            )
          : await vscode.commands.executeCommand<unknown>(
              PYTHON_INTERPRETER_COMMAND,
              argument
            );
      const interpreterPath = extractInterpreterPath(result);
      if (interpreterPath) {
        return interpreterPath;
      }
    } catch {
      // Try the next invocation shape.
    }
  }

  return undefined;
}

function extractInterpreterPath(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value.trim() || undefined;
  }

  if (value instanceof vscode.Uri) {
    return value.fsPath || undefined;
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  for (const key of ['path', 'interpreterPath', 'fsPath', 'executable', 'uri']) {
    const extracted = extractInterpreterPath(candidate[key]);
    if (extracted) {
      return extracted;
    }
  }

  return undefined;
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
      return canonicalExecutablePath(normalizedCandidate);
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
        return canonicalExecutablePath(candidate);
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
        return canonicalExecutablePath(candidate);
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

function canonicalExecutablePath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function toPythonInterpreterSettingValue(
  selectedPath: string,
  settings: ExtensionSettings
): string {
  const normalizedSelectedPath = path.normalize(selectedPath);
  const basePath = getInterpreterBasePath(settings);
  if (!basePath) {
    return normalizedSelectedPath;
  }

  const relativePath = path.relative(basePath, normalizedSelectedPath);
  if (
    relativePath &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  ) {
    return normalizeSettingPath(relativePath);
  }

  return normalizedSelectedPath;
}

function normalizeSettingPath(value: string): string {
  return value.split(path.sep).join('/');
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
