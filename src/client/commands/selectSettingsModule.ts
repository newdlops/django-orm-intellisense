import * as vscode from 'vscode';
import { CONFIGURATION_SECTION } from '../config/settings';
import { AnalysisDaemon } from '../daemon/analysisDaemon';

export function registerSelectSettingsModuleCommand(
  daemon: AnalysisDaemon,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'djangoOrmIntellisense.selectSettingsModule',
    async () => {
      try {
        let snapshot = daemon.getState();
        snapshot =
          snapshot.phase === 'stopped' ? await daemon.start() : await daemon.refreshHealth();

        const candidates = snapshot.settingsCandidates ?? [];
        if (candidates.length === 0) {
          await vscode.window.showWarningMessage(
            'No Django settings module candidates were discovered in this workspace.'
          );
          return;
        }

        const quickPickItems: Array<
          vscode.QuickPickItem & { value?: string; clear?: boolean }
        > = candidates.map((candidate) => ({
          label: candidate,
          description:
            candidate === snapshot.settingsModule ? 'Current selection' : undefined,
          value: candidate,
        }));

        quickPickItems.push({
          label: 'Clear explicit setting',
          description: 'Remove djangoOrmIntellisense.settingsModule',
          clear: true,
        });

        const selection = await vscode.window.showQuickPick(quickPickItems, {
          placeHolder: 'Select a Django settings module for runtime ORM inspection',
          ignoreFocusOut: true,
        });

        if (!selection) {
          return;
        }

        const target = vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
        const configuration = vscode.workspace.getConfiguration(
          CONFIGURATION_SECTION
        );

        await configuration.update(
          'settingsModule',
          selection.clear ? undefined : selection.value,
          target
        );

        const nextSnapshot = await daemon.restart();
        const message = selection.clear
          ? 'Cleared djangoOrmIntellisense.settingsModule.'
          : `Selected settings module: ${selection.value}.`;

        const choice = await vscode.window.showInformationMessage(
          `${message} Current state: ${nextSnapshot.phase}.`,
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
            'djangoOrmIntellisense.settingsModule'
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(
          `[extension] Select Settings Module command failed: ${message}`
        );

        const choice = await vscode.window.showErrorMessage(
          `Failed to update the Django settings module: ${message}`,
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
