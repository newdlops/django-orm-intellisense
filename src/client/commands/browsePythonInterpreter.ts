import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import {
  browseForPythonInterpreter,
  resolvePythonInterpreter,
  savePythonInterpreterSetting,
} from '../python/interpreter';

export function registerBrowsePythonInterpreterCommand(
  daemon: AnalysisDaemon,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'djangoOrmIntellisense.browsePythonInterpreter',
    async () => {
      try {
        const settings = getExtensionSettings();
        const selectedPath = await browseForPythonInterpreter(settings);
        if (!selectedPath) {
          return;
        }

        const storedValue = await savePythonInterpreterSetting(
          selectedPath,
          settings
        );
        const resolved = await resolvePythonInterpreter(getExtensionSettings());

        await daemon.restart();

        const choice = await vscode.window.showInformationMessage(
          `Saved \`djangoOrmIntellisense.pythonInterpreter\` as ${storedValue} and restarted the daemon with ${resolved.path}.`,
          'Show Status',
          'Open Settings'
        );

        if (choice === 'Show Status') {
          await vscode.commands.executeCommand('djangoOrmIntellisense.showStatus');
          return;
        }

        if (choice === 'Open Settings') {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'djangoOrmIntellisense.pythonInterpreter'
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(
          `[extension] Browse Python Interpreter command failed: ${message}`
        );

        const choice = await vscode.window.showErrorMessage(
          `Failed to save the Django ORM Intellisense interpreter: ${message}`,
          'Show Status',
          'Open Output'
        );

        if (choice === 'Show Status') {
          await vscode.commands.executeCommand('djangoOrmIntellisense.showStatus');
          return;
        }

        if (choice === 'Open Output') {
          output.show(true);
        }
      }
    }
  );
}
