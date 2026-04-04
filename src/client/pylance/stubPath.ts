import * as path from 'path';
import * as vscode from 'vscode';
import type { HealthSnapshot } from '../protocol';
import {
  readWorkspaceSettingValue,
  writeWorkspaceSettingValue,
} from '../settings/workspaceJsonSettings';

const STUB_PATH_SETTING = 'python.analysis.stubPath';
const EXTRA_PATHS_SETTING = 'python.analysis.extraPaths';
const LEGACY_MANAGED_STUB_CONTAINER = '.django_orm_intellisense';
const LEGACY_MANAGED_STUB_RELATIVE_ROOT = '.django_orm_intellisense/stubs';

export async function syncManagedPylanceStubPath(
  snapshot: HealthSnapshot,
  output: vscode.OutputChannel
): Promise<void> {
  const stubSnapshot = snapshot.pylanceStubs;
  const workspaceFolder =
    findWorkspaceFolderForPath(snapshot.workspaceRoot) ??
    findWorkspaceFolderForPath(stubSnapshot?.rootPath);
  if (!workspaceFolder) {
    return;
  }

  const existingValue = await readWorkspaceSettingValue(
    STUB_PATH_SETTING,
    workspaceFolder
  );
  const existingExtraPathsValue = await readWorkspaceSettingValue(
    EXTRA_PATHS_SETTING,
    workspaceFolder
  );
  const currentValue =
    typeof existingValue === 'string' ? existingValue.trim() : '';
  const workspaceFolderPath = workspaceFolder.uri.fsPath;
  const currentExtraPaths = normalizeExtraPathsSetting(existingExtraPathsValue);

  if (!stubSnapshot?.rootPath) {
    if (
      currentValue &&
      isManagedStubPathValue(
        currentValue,
        workspaceFolderPath,
        undefined,
        [LEGACY_MANAGED_STUB_RELATIVE_ROOT]
      )
    ) {
      await writeWorkspaceSettingValue(
        STUB_PATH_SETTING,
        undefined,
        workspaceFolder
      );
      output.appendLine(
        `[extension] Removed managed ${STUB_PATH_SETTING} for ${workspaceFolder.name}.`
      );
    }
    const nextExtraPaths = removeManagedStubExtraPath(
      currentExtraPaths,
      workspaceFolderPath,
      undefined,
      [LEGACY_MANAGED_STUB_RELATIVE_ROOT]
    );
    if (!areStringArraysEqual(currentExtraPaths, nextExtraPaths)) {
      await writeWorkspaceSettingValue(
        EXTRA_PATHS_SETTING,
        nextExtraPaths.length > 0 ? nextExtraPaths : undefined,
        workspaceFolder
      );
      output.appendLine(
        `[extension] Removed managed ${EXTRA_PATHS_SETTING} entry for ${workspaceFolder.name}.`
      );
    }
    await cleanupLegacyManagedStubTree(workspaceFolder, output);
    return;
  }

  const expectedValue = toStubPathSettingValue(
    workspaceFolderPath,
    stubSnapshot.rootPath
  );

  if (
    currentValue &&
    currentValue !== expectedValue &&
    !isManagedStubPathValue(
      currentValue,
      workspaceFolderPath,
      stubSnapshot.rootPath,
      [stubSnapshot.relativeRoot, LEGACY_MANAGED_STUB_RELATIVE_ROOT]
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

  const nextExtraPaths = ensureManagedStubExtraPath(
    currentExtraPaths,
    expectedValue
  );
  if (!areStringArraysEqual(currentExtraPaths, nextExtraPaths)) {
    await writeWorkspaceSettingValue(
      EXTRA_PATHS_SETTING,
      nextExtraPaths,
      workspaceFolder
    );
    output.appendLine(
      `[extension] Configured ${EXTRA_PATHS_SETTING} -> [${nextExtraPaths.join(', ')}] for ${workspaceFolder.name}.`
    );
  }
}

async function cleanupLegacyManagedStubTree(
  workspaceFolder: vscode.WorkspaceFolder,
  output: vscode.OutputChannel
): Promise<void> {
  const legacyContainerUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    LEGACY_MANAGED_STUB_CONTAINER
  );
  const legacyStubRootUri = vscode.Uri.joinPath(legacyContainerUri, 'stubs');
  if (!(await pathExists(legacyStubRootUri))) {
    return;
  }

  try {
    await vscode.workspace.fs.delete(legacyStubRootUri, {
      recursive: true,
      useTrash: false,
    });
    output.appendLine(
      `[extension] Removed legacy managed stub files from ${legacyStubRootUri.fsPath}.`
    );
  } catch (error) {
    output.appendLine(
      `[extension] Failed to remove legacy managed stub files from ${legacyStubRootUri.fsPath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  try {
    const entries = await vscode.workspace.fs.readDirectory(legacyContainerUri);
    if (entries.length === 0) {
      await vscode.workspace.fs.delete(legacyContainerUri, {
        recursive: false,
        useTrash: false,
      });
      output.appendLine(
        `[extension] Removed empty legacy stub directory ${legacyContainerUri.fsPath}.`
      );
    }
  } catch {
    // Ignore best-effort container cleanup failures.
  }
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

async function pathExists(target: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(target);
    return true;
  } catch (error) {
    if (error instanceof vscode.FileSystemError) {
      return false;
    }
    throw error;
  }
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
  stubRootPath: string | undefined,
  relativeRoots: readonly string[]
): boolean {
  if (
    stubRootPath &&
    resolvesToPath(candidateValue, workspaceFolderPath, stubRootPath)
  ) {
    return true;
  }

  const normalizedCandidate = normalizePathForComparison(
    path.resolve(workspaceFolderPath, candidateValue)
  );
  return relativeRoots.some((relativeRoot) => {
    const normalizedRelativeRoot = normalizePathForComparison(
      path.resolve(workspaceFolderPath, relativeRoot)
    );
    return normalizedCandidate === normalizedRelativeRoot;
  });
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

function normalizeExtraPathsSetting(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ensureManagedStubExtraPath(
  currentExtraPaths: readonly string[],
  expectedValue: string
): string[] {
  if (currentExtraPaths.includes(expectedValue)) {
    return [...currentExtraPaths];
  }

  return [expectedValue, ...currentExtraPaths];
}

function removeManagedStubExtraPath(
  currentExtraPaths: readonly string[],
  workspaceFolderPath: string,
  stubRootPath: string | undefined,
  relativeRoots: readonly string[]
): string[] {
  return currentExtraPaths.filter(
    (entry) =>
      !isManagedStubPathValue(entry, workspaceFolderPath, stubRootPath, relativeRoots)
  );
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}
