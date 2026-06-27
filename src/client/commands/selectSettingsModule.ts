import * as vscode from 'vscode';
import { CONFIGURATION_SECTION } from '../config/settings';
import { AnalysisDaemon } from '../daemon/analysisDaemon';

/**
 * Resolve the configuration scope `settingsModule` should be written to, so it
 * matches the scope `getExtensionSettings` reads from. Prefers the daemon's
 * active project root (its enclosing workspace folder), then the active
 * editor's folder, then the first workspace folder. Mirrors
 * `resolveInterpreterConfigurationScope` in the interpreter command.
 */
function resolveSettingsConfigurationScope(
  daemon: AnalysisDaemon
): vscode.Uri | undefined {
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

/**
 * Pick the configuration target that wins the folder-scoped read in
 * `getExtensionSettings`. WorkspaceFolder takes precedence over Workspace, so a
 * value written there is never shadowed by a stray per-folder setting — the
 * exact "settings gets unset" failure caused by writing at Workspace while
 * reading at the folder scope.
 */
function resolveSettingsConfigurationTarget(
  scope: vscode.Uri | undefined
): vscode.ConfigurationTarget {
  if (scope && vscode.workspace.getWorkspaceFolder(scope)) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (vscode.workspace.workspaceFolders?.length) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

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

        const scope = resolveSettingsConfigurationScope(daemon);
        const target = resolveSettingsConfigurationTarget(scope);
        const configuration = vscode.workspace.getConfiguration(
          CONFIGURATION_SECTION,
          scope
        );

        await configuration.update(
          'settingsModule',
          selection.clear ? undefined : selection.value,
          target
        );

        const nextSnapshot = await daemon.restart(scope);
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
