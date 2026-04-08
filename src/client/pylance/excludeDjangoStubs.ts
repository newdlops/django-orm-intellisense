import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { resolvePythonInterpreter } from '../python/interpreter';
import {
  readWorkspaceSettingValue,
  writeWorkspaceSettingValue,
} from '../settings/workspaceJsonSettings';

const STUBS_PACKAGES = ['django-stubs', 'django_stubs_ext'] as const;

const ANALYSIS_EXCLUDE_KEY = 'python.analysis.exclude';

export async function excludeDjangoStubsFromPylance(
  output: vscode.OutputChannel
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  let stubsPaths: string[];
  try {
    stubsPaths = await findDjangoStubsPaths(output);
  } catch (error) {
    output.appendLine(
      `[pylance] Failed to locate django-stubs packages: ${String(error)}`
    );
    return;
  }

  if (stubsPaths.length === 0) {
    output.appendLine(
      '[pylance] No django-stubs packages found in the Python environment.'
    );
    return;
  }

  try {
    await addToAnalysisExclude(stubsPaths, output);
  } catch (error) {
    output.appendLine(
      `[pylance] Failed to update python.analysis.exclude: ${String(error)}`
    );
  }
}

async function findDjangoStubsPaths(
  output: vscode.OutputChannel
): Promise<string[]> {
  const interpreter = await resolvePythonInterpreter();
  const pythonCode = [
    'import importlib.metadata, pathlib, os',
    '',
    'results = set()',
    `for pkg in ${JSON.stringify(STUBS_PACKAGES)}:`,
    '    try:',
    '        dist = importlib.metadata.distribution(pkg)',
    '        files = dist.files',
    '        if files:',
    '            top_dirs = set()',
    '            for f in files:',
    '                parts = f.parts',
    '                if parts:',
    '                    top_dirs.add(parts[0])',
    '            for d in top_dirs:',
    '                resolved = (pathlib.Path(dist._path.parent) / d).resolve()',
    '                if resolved.exists():',
    '                    results.add(str(resolved))',
    '    except Exception:',
    '        pass',
    '',
    'for r in sorted(results):',
    '    print(r)',
  ].join('\n');

  const paths = await runPython(interpreter.path, pythonCode);
  if (paths.length > 0) {
    output.appendLine(
      `[pylance] Found django-stubs paths to exclude: ${paths.join(', ')}`
    );
  }
  return paths;
}

function runPython(
  interpreterPath: string,
  code: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      interpreterPath,
      ['-c', code],
      { timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Python execution failed: ${stderr || error.message}`));
          return;
        }

        const lines = stdout
          .trim()
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        resolve(lines);
      }
    );
  });
}

async function addToAnalysisExclude(
  stubsPaths: string[],
  output: vscode.OutputChannel
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const currentExclude =
    ((await readWorkspaceSettingValue(ANALYSIS_EXCLUDE_KEY)) as string[] | undefined) ?? [];

  const existingSet = new Set(currentExclude);
  const newPaths = stubsPaths.filter((p) => !existingSet.has(p));

  if (newPaths.length === 0) {
    output.appendLine(
      '[pylance] django-stubs paths are already in python.analysis.exclude.'
    );
    return;
  }

  const updatedExclude = [...currentExclude, ...newPaths];
  await writeWorkspaceSettingValue(ANALYSIS_EXCLUDE_KEY, updatedExclude);

  output.appendLine(
    `[pylance] Added to python.analysis.exclude: ${newPaths.join(', ')}`
  );
}
