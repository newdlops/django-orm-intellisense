import * as vscode from 'vscode';
import { getExtensionSettings } from '../config/settings';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import {
  resolvePythonInterpreter,
  selectPythonInterpreterFromPythonExtension,
} from '../python/interpreter';

export function registerSelectPythonInterpreterCommand(
  daemon: AnalysisDaemon,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'djangoOrmIntellisense.selectPythonInterpreter',
    async () => {
      try {
        const settings = getExtensionSettings();
        if (settings.pythonInterpreter || settings.pythonPath) {
          const overrideChoice = await vscode.window.showWarningMessage(
            'Django ORM Intellisense is pinned to an explicit interpreter setting. Clear `djangoOrmIntellisense.pythonInterpreter` or `djangoOrmIntellisense.pythonPath` if you want it to follow the Python extension selection.',
            'Browse',
            'Open Settings',
            'Continue'
          );

          if (overrideChoice === 'Browse') {
            await vscode.commands.executeCommand(
              'djangoOrmIntellisense.browsePythonInterpreter'
            );
            return;
          }

          if (overrideChoice === 'Open Settings') {
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'djangoOrmIntellisense.pythonInterpreter'
            );
            return;
          }

          if (overrideChoice !== 'Continue') {
            return;
          }
        }

        const before = await resolvePythonInterpreter();
        const opened = await selectPythonInterpreterFromPythonExtension();

        if (!opened) {
          const choice = await vscode.window.showWarningMessage(
            'The Python extension is not installed, or its interpreter picker is unavailable. Set `djangoOrmIntellisense.pythonInterpreter` manually in Settings or install/enable the Python extension.',
            'Browse',
            'Open Settings'
          );

          if (choice === 'Browse') {
            await vscode.commands.executeCommand(
              'djangoOrmIntellisense.browsePythonInterpreter'
            );
            return;
          }

          if (choice === 'Open Settings') {
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'djangoOrmIntellisense.pythonInterpreter'
            );
          }
          return;
        }

        const after = await resolvePythonInterpreter();
        if (
          after.path === before.path &&
          after.source === before.source &&
          daemon.getState().phase !== 'stopped'
        ) {
          const choice = await vscode.window.showInformationMessage(
            `Interpreter selection was unchanged. Django ORM Intellisense is still using ${after.path}.`,
            'Browse',
            'Show Status',
            'Open Settings'
          );

          if (choice === 'Browse') {
            await vscode.commands.executeCommand(
              'djangoOrmIntellisense.browsePythonInterpreter'
            );
            return;
          }

          if (choice === 'Show Status') {
            await vscode.commands.executeCommand(
              'djangoOrmIntellisense.showStatus'
            );
            return;
          }

          if (choice === 'Open Settings') {
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'djangoOrmIntellisense.pythonInterpreter'
            );
          }
          return;
        }

        await daemon.restart();

        const choice = await vscode.window.showInformationMessage(
          `Django ORM Intellisense now uses ${after.path}.`,
          'Browse',
          'Show Status',
          'Open Settings'
        );

        if (choice === 'Browse') {
          await vscode.commands.executeCommand(
            'djangoOrmIntellisense.browsePythonInterpreter'
          );
          return;
        }

        if (choice === 'Show Status') {
          await vscode.commands.executeCommand(
            'djangoOrmIntellisense.showStatus'
          );
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
          `[extension] Select Python Interpreter command failed: ${message}`
        );
        const choice = await vscode.window.showErrorMessage(
          `Failed to update the Django ORM Intellisense interpreter: ${message}`,
          'Browse',
          'Show Status',
          'Open Output',
          'Open Settings'
        );

        if (choice === 'Browse') {
          await vscode.commands.executeCommand(
            'djangoOrmIntellisense.browsePythonInterpreter'
          );
          return;
        }

        if (choice === 'Show Status') {
          await vscode.commands.executeCommand('djangoOrmIntellisense.showStatus');
          return;
        }

        if (choice === 'Open Output') {
          output.show(true);
          return;
        }

        if (choice === 'Open Settings') {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'djangoOrmIntellisense.pythonInterpreter'
          );
        }
      }
    }
  );
}
