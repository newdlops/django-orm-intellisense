import * as vscode from 'vscode';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import type { HealthSnapshot } from '../protocol';

function buildStatusMessage(snapshot: HealthSnapshot): string {
  const lines = [
    `State: ${snapshot.phase}`,
    `Detail: ${snapshot.detail}`,
    `Workspace: ${snapshot.workspaceRoot ?? 'Unavailable'}`,
    `Python: ${snapshot.pythonPath ?? 'Unavailable'}`,
    `Python source: ${snapshot.pythonSource ?? 'Unavailable'}`,
    `Settings: ${snapshot.settingsModule ?? 'Not set'}`,
  ];

  if (snapshot.pythonSourceDetail) {
    lines.push(`Interpreter resolution: ${snapshot.pythonSourceDetail}`);
  }

  if (snapshot.settingsCandidates && snapshot.settingsCandidates.length > 0) {
    lines.push(
      `Settings candidates: ${snapshot.settingsCandidates.join(', ')}`
    );
  }

  if (snapshot.runtime) {
    lines.push(
      `Django: ${
        snapshot.runtime.djangoImportable
          ? snapshot.runtime.djangoVersion ?? 'importable'
          : 'not importable'
      }`
    );
    lines.push(`Bootstrap: ${snapshot.runtime.bootstrapStatus}`);

    if (snapshot.runtime.modelCount !== undefined) {
      lines.push(
        `Runtime ORM: ${snapshot.runtime.appCount ?? 0} apps, ${snapshot.runtime.modelCount} models, ${snapshot.runtime.fieldCount ?? 0} fields, ${snapshot.runtime.relationCount ?? 0} forward relations, ${snapshot.runtime.reverseRelationCount ?? 0} reverse relations`
      );
    }

    if (snapshot.runtime.modelPreview && snapshot.runtime.modelPreview.length > 0) {
      lines.push(
        `Model preview: ${snapshot.runtime.modelPreview.map((model) => model.label).join(', ')}`
      );
    }

    if (snapshot.runtime.bootstrapError) {
      lines.push(`Runtime error: ${snapshot.runtime.bootstrapError}`);
    }
  }

  if (snapshot.staticIndex) {
    lines.push(
      `Static index: ${snapshot.staticIndex.pythonFileCount} files, ${snapshot.staticIndex.reexportModuleCount} re-export surfaces`
    );
  }

  if (snapshot.pylanceStubs) {
    lines.push(
      `Pylance stubs: ${snapshot.pylanceStubs.fileCount} files in ${snapshot.pylanceStubs.relativeRoot}`
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

      const choice = await prompt(
        message,
        'Open Output',
        'Restart Daemon',
        'Configure Pylance'
      );

      if (choice === 'Open Output') {
        output.show(true);
        return;
      }

      if (choice === 'Restart Daemon') {
        await daemon.restart();
        return;
      }

      if (choice === 'Configure Pylance') {
        await vscode.commands.executeCommand(
          'djangoOrmIntellisense.configurePylanceDiagnostics'
        );
      }
    }
  );
}
