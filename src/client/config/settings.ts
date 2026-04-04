import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const CONFIGURATION_SECTION = 'djangoOrmIntellisense';

export interface ExtensionSettings {
  pythonInterpreter?: string;
  pythonPath?: string;
  settingsModule?: string;
  workspaceRoot?: string;
  logLevel: 'off' | 'info' | 'debug';
  autoStart: boolean;
}

export function getExtensionSettings(
  scope?: vscode.ConfigurationScope
): ExtensionSettings {
  const requestedScope =
    scope ??
    vscode.window.activeTextEditor?.document.uri ??
    vscode.workspace.workspaceFolders?.[0]?.uri;
  const effectiveScope = normalizeConfigurationScope(requestedScope);
  const configuration = vscode.workspace.getConfiguration(
    CONFIGURATION_SECTION,
    effectiveScope
  );
  const pythonInterpreter = configuration.get<string>('pythonInterpreter')?.trim();
  const pythonPath = configuration.get<string>('pythonPath')?.trim();
  const settingsModule = configuration.get<string>('settingsModule')?.trim();
  const workspaceRoot = resolveWorkspaceRootSetting(
    configuration.get<string>('workspaceRoot')?.trim(),
    requestedScope
  );
  const logLevel = configuration.get<'off' | 'info' | 'debug'>('logLevel', 'info');
  const autoStart = configuration.get<boolean>('autoStart', true);

  return {
    pythonInterpreter: pythonInterpreter || undefined,
    pythonPath: pythonPath || undefined,
    settingsModule: settingsModule || undefined,
    workspaceRoot: workspaceRoot || undefined,
    logLevel,
    autoStart,
  };
}

function normalizeConfigurationScope(
  scope?: vscode.ConfigurationScope
): vscode.ConfigurationScope | undefined {
  if (!scope) {
    return undefined;
  }

  if (scope instanceof vscode.Uri) {
    return (
      vscode.workspace.getWorkspaceFolder(scope)?.uri ??
      vscode.workspace.workspaceFolders?.[0]?.uri
    );
  }

  return scope;
}

function resolveWorkspaceRootSetting(
  workspaceRoot: string | undefined,
  scope?: vscode.ConfigurationScope
): string | undefined {
  const normalizedWorkspaceRoot = workspaceRoot
    ? path.resolve(workspaceRoot)
    : undefined;
  const scopeUri = scope instanceof vscode.Uri ? scope : undefined;
  if (!scopeUri || scopeUri.scheme !== 'file') {
    return normalizedWorkspaceRoot;
  }

  const scopePath = scopeUri.fsPath;
  if (
    normalizedWorkspaceRoot &&
    pathContains(normalizedWorkspaceRoot, scopePath)
  ) {
    return normalizedWorkspaceRoot;
  }

  return (
    inferWorkspaceRootFromFile(scopePath) ??
    normalizedWorkspaceRoot
  );
}

function inferWorkspaceRootFromFile(filePath: string): string | undefined {
  let currentPath = fs.statSync(filePath, { throwIfNoEntry: false })?.isDirectory()
    ? path.resolve(filePath)
    : path.dirname(path.resolve(filePath));

  while (true) {
    if (fs.existsSync(path.join(currentPath, 'manage.py'))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

function pathContains(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

export function isRelevantConfigurationChange(
  event: vscode.ConfigurationChangeEvent
): boolean {
  const scopes: vscode.ConfigurationScope[] = [];
  const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
  if (activeDocumentUri) {
    scopes.push(activeDocumentUri);
  }

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    scopes.push(workspaceFolder.uri);
  }

  const affectsConfiguration = (section: string): boolean =>
    event.affectsConfiguration(section) ||
    scopes.some((scope) => event.affectsConfiguration(section, scope));

  return (
    affectsConfiguration(CONFIGURATION_SECTION) ||
    affectsConfiguration('python.defaultInterpreterPath') ||
    affectsConfiguration('python.pythonPath')
  );
}
