import * as vscode from 'vscode';
import {
  getExtensionSettings,
  type ExtensionSettings,
} from '../config/settings';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import {
  browseForPythonInterpreter,
  resolvePythonInterpreter,
  savePythonInterpreterSetting,
} from '../python/interpreter';

async function openInterpreterSettings(): Promise<void> {
  await vscode.commands.executeCommand(
    'workbench.action.openSettings',
    'djangoOrmIntellisense.pythonInterpreter'
  );
}

async function showInterpreterMessage(
  message: string,
  output: vscode.OutputChannel
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    message,
    'Show Status',
    'Open Output',
    'Open Settings'
  );

  if (choice === 'Show Status') {
    await vscode.commands.executeCommand('djangoOrmIntellisense.showStatus');
    return;
  }

  if (choice === 'Open Output') {
    output.show(true);
    return;
  }

  if (choice === 'Open Settings') {
    await openInterpreterSettings();
  }
}

function resolveInterpreterConfigurationScope(
  daemon: AnalysisDaemon
): vscode.ConfigurationScope | undefined {
  const workspaceRoot = daemon.getState().workspaceRoot;
  if (workspaceRoot) {
    const workspaceUri = vscode.Uri.file(workspaceRoot);
    return vscode.workspace.getWorkspaceFolder(workspaceUri)?.uri ?? workspaceUri;
  }

  return (
    vscode.window.activeTextEditor?.document.uri ??
    vscode.workspace.workspaceFolders?.[0]?.uri
  );
}

function resolveInterpreterSelectionSettings(
  daemon: AnalysisDaemon
): {
  scope: vscode.ConfigurationScope | undefined;
  settings: ExtensionSettings;
} {
  const scope = resolveInterpreterConfigurationScope(daemon);
  const settings = getExtensionSettings(scope);
  const workspaceRoot = daemon.getState().workspaceRoot;

  return {
    scope,
    settings: workspaceRoot
      ? {
          ...settings,
          workspaceRoot,
        }
      : settings,
  };
}

export function registerSelectPythonInterpreterCommand(
  daemon: AnalysisDaemon,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'djangoOrmIntellisense.selectPythonInterpreter',
    async () => {
      try {
        const { scope, settings } = resolveInterpreterSelectionSettings(daemon);
        const selectedPath = await browseForPythonInterpreter(settings);
        if (!selectedPath) {
          return;
        }

        const storedValue = await savePythonInterpreterSetting(
          selectedPath,
          settings
        );
        const resolved = await resolvePythonInterpreter({
          ...getExtensionSettings(scope),
          ...settings,
          pythonInterpreter: storedValue,
        });

        await daemon.restart(scope);

        output.appendLine(
          `[interpreter] Set djangoOrmIntellisense.pythonInterpreter=${storedValue} (${resolved.path}).`
        );
        await showInterpreterMessage(
          `Django ORM Intellisense now uses ${resolved.path}.`,
          output
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(
          `[interpreter] Select Python Interpreter failed: ${message}`
        );
        const choice = await vscode.window.showErrorMessage(
          `Failed to update the Django ORM Intellisense interpreter: ${message}`,
          'Show Status',
          'Open Output',
          'Open Settings'
        );

        if (choice === 'Show Status') {
          await vscode.commands.executeCommand('djangoOrmIntellisense.showStatus');
          return;
        }

        if (choice === 'Open Output') {
          output.show(true);
          return;
        }

        if (choice === 'Open Settings') {
          await openInterpreterSettings();
        }
      }
    }
  );
}
