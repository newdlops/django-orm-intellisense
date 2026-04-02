import * as vscode from 'vscode';
import { registerRestartDaemonCommand } from './commands/restartDaemon';
import { registerShowStatusCommand } from './commands/showStatus';
import { isRelevantConfigurationChange, getExtensionSettings } from './config/settings';
import { AnalysisDaemon } from './daemon/analysisDaemon';
import { HealthDiagnostics } from './diagnostics/healthDiagnostics';
import { HealthStatusView } from './status/healthStatus';

let activeDaemon: AnalysisDaemon | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Django ORM Intellisense');
  const daemon = new AnalysisDaemon(context, output);
  const statusView = new HealthStatusView();
  const diagnostics = new HealthDiagnostics();

  activeDaemon = daemon;

  daemon.onDidChangeState((snapshot) => {
    statusView.update(snapshot);
    diagnostics.update(snapshot);
  });

  statusView.update(daemon.getState());
  diagnostics.update(daemon.getState());

  context.subscriptions.push(
    output,
    daemon,
    statusView,
    diagnostics,
    registerShowStatusCommand(daemon, output),
    registerRestartDaemonCommand(daemon),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!isRelevantConfigurationChange(event)) {
        return;
      }

      output.appendLine(
        '[extension] Configuration changed. Restarting analysis daemon.'
      );
      void daemon.restart().catch((error) => {
        output.appendLine(`[extension] Failed to restart daemon: ${String(error)}`);
      });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      output.appendLine('[extension] Workspace folders changed. Restarting analysis daemon.');
      void daemon.restart().catch((error) => {
        output.appendLine(`[extension] Failed to restart daemon: ${String(error)}`);
      });
    })
  );

  const settings = getExtensionSettings();
  if (settings.autoStart) {
    void daemon.start().catch((error) => {
      output.appendLine(`[extension] Failed to start daemon: ${String(error)}`);
    });
  }
}

export async function deactivate(): Promise<void> {
  if (!activeDaemon) {
    return;
  }

  await activeDaemon.stop();
  activeDaemon = undefined;
}
