import * as vscode from 'vscode';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import type { HealthSnapshot } from '../protocol';

function buildStatusMessage(snapshot: HealthSnapshot): string {
  const lines = [
    `State: ${snapshot.phase}`,
    `Detail: ${snapshot.detail}`,
    `Workspace: ${snapshot.workspaceRoot ?? 'Unavailable'}`,
    `Python: ${snapshot.pythonPath ?? 'Unavailable'}`,
    `Settings: ${snapshot.settingsModule ?? 'Not set'}`,
  ];

  if (snapshot.runtime) {
    lines.push(
      `Django: ${
        snapshot.runtime.djangoImportable
          ? snapshot.runtime.djangoVersion ?? 'importable'
          : 'not importable'
      }`
    );
  }

  if (snapshot.staticIndex) {
    lines.push(
      `Static index: ${snapshot.staticIndex.pythonFileCount} files, ${snapshot.staticIndex.reexportModuleCount} re-export surfaces`
    );
  }

  if (snapshot.semanticGraph) {
    lines.push(
      `Semantic graph: ${snapshot.semanticGraph.coverageMode} (${snapshot.semanticGraph.provenanceLayers.join(', ')})`
    );
  }

  return lines.join('\n');
}

export function registerShowStatusCommand(
  daemon: AnalysisDaemon,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'djangoOrmIntellisense.showStatus',
    async () => {
      let snapshot = daemon.getState();

      try {
        snapshot =
          snapshot.phase === 'stopped' ? await daemon.start() : await daemon.refreshHealth();
      } catch {
        snapshot = daemon.getState();
      }

      const message = buildStatusMessage(snapshot);
      const prompt =
        snapshot.phase === 'error'
          ? vscode.window.showErrorMessage
          : snapshot.phase === 'degraded'
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;

      const choice = await prompt(message, 'Open Output', 'Restart Daemon');

      if (choice === 'Open Output') {
        output.show(true);
        return;
      }

      if (choice === 'Restart Daemon') {
        await daemon.restart();
      }
    }
  );
}
