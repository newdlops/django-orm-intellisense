import * as path from 'path';
import * as vscode from 'vscode';
import type { HealthSnapshot } from '../protocol';
import {
  readWorkspaceSettingValue,
  writeWorkspaceSettingValue,
} from '../settings/workspaceJsonSettings';

const STUB_PATH_SETTING = 'python.analysis.stubPath';

export async function syncManagedPylanceStubPath(
  snapshot: HealthSnapshot,
  output: vscode.OutputChannel
): Promise<void> {
  const stubSnapshot = snapshot.pylanceStubs;
  if (!stubSnapshot?.rootPath) {
    return;
  }

  const workspaceFolder =
    findWorkspaceFolderForPath(snapshot.workspaceRoot) ??
    findWorkspaceFolderForPath(stubSnapshot.rootPath);
  if (!workspaceFolder) {
    return;
  }

  const workspaceFolderPath = workspaceFolder.uri.fsPath;
  const expectedValue = toStubPathSettingValue(
    workspaceFolderPath,
    stubSnapshot.rootPath
  );
  const existingValue = await readWorkspaceSettingValue(
    STUB_PATH_SETTING,
    workspaceFolder
  );
  const currentValue =
    typeof existingValue === 'string' ? existingValue.trim() : '';

  if (
    currentValue &&
    currentValue !== expectedValue &&
    !isManagedStubPathValue(
      currentValue,
      workspaceFolderPath,
      stubSnapshot.rootPath,
      stubSnapshot.relativeRoot
    )
  ) {
    output.appendLine(
      `[extension] Skipping ${STUB_PATH_SETTING} update for ${workspaceFolder.name} because the workspace already defines a custom value: ${currentValue}`
    );
    return;
  }

  if (currentValue === expectedValue) {
    return;
  }

  await writeWorkspaceSettingValue(
    STUB_PATH_SETTING,
    expectedValue,
    workspaceFolder
  );
  output.appendLine(
    `[extension] Configured ${STUB_PATH_SETTING} -> ${expectedValue} for ${workspaceFolder.name}.`
  );
}

function findWorkspaceFolderForPath(
  targetPath: string | undefined
): vscode.WorkspaceFolder | undefined {
  if (!targetPath) {
    return vscode.workspace.workspaceFolders?.[0];
  }

  const normalizedTarget = normalizePathForComparison(targetPath);
  let matchedFolder: vscode.WorkspaceFolder | undefined;
  let matchedLength = -1;

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const folderPath = normalizePathForComparison(workspaceFolder.uri.fsPath);
    if (
      normalizedTarget === folderPath ||
      normalizedTarget.startsWith(`${folderPath}${path.sep}`)
    ) {
      if (folderPath.length > matchedLength) {
        matchedFolder = workspaceFolder;
        matchedLength = folderPath.length;
      }
    }
  }

  return matchedFolder;
}

function toStubPathSettingValue(
  workspaceFolderPath: string,
  stubRootPath: string
): string {
  const relativePath = path.relative(workspaceFolderPath, stubRootPath);
  if (
    relativePath &&
    relativePath !== '.' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..'
  ) {
    return toPosixPath(relativePath);
  }

  return stubRootPath;
}

function isManagedStubPathValue(
  candidateValue: string,
  workspaceFolderPath: string,
  stubRootPath: string,
  relativeRoot: string
): boolean {
  if (resolvesToPath(candidateValue, workspaceFolderPath, stubRootPath)) {
    return true;
  }

  const normalizedRelativeRoot = normalizePathForComparison(
    path.resolve(workspaceFolderPath, relativeRoot)
  );
  const normalizedCandidate = normalizePathForComparison(
    path.resolve(workspaceFolderPath, candidateValue)
  );
  return (
    normalizedCandidate === normalizedRelativeRoot ||
    normalizedCandidate.endsWith(
      normalizePathForComparison(path.join('.django_orm_intellisense', 'stubs'))
    )
  );
}

function resolvesToPath(
  candidateValue: string,
  workspaceFolderPath: string,
  targetPath: string
): boolean {
  const resolvedCandidate = path.isAbsolute(candidateValue)
    ? candidateValue
    : path.resolve(workspaceFolderPath, candidateValue);
  return (
    normalizePathForComparison(resolvedCandidate) ===
    normalizePathForComparison(targetPath)
  );
}

function normalizePathForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}
