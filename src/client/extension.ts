import * as vscode from 'vscode';
import { registerConfigurePylanceDiagnosticsCommand } from './commands/configurePylanceDiagnostics';
import { registerRestartDaemonCommand } from './commands/restartDaemon';
import { registerSelectSettingsModuleCommand } from './commands/selectSettingsModule';
import { registerSelectPythonInterpreterCommand } from './commands/selectPythonInterpreter';
import { registerShowStatusCommand } from './commands/showStatus';
import { isRelevantConfigurationChange, getExtensionSettings } from './config/settings';
import { AnalysisDaemon } from './daemon/analysisDaemon';
import { HealthDiagnostics } from './diagnostics/healthDiagnostics';
import { registerPythonProviders } from './providers/pythonProviders';
import { normalizePythonInterpreterSettings } from './python/interpreter';
import { HealthStatusView } from './status/healthStatus';

let activeDaemon: AnalysisDaemon | undefined;

export function getActiveDaemonForTesting(): AnalysisDaemon | undefined {
  return activeDaemon;
}

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

  const normalization = await normalizePythonInterpreterSettings();
  if (normalization === 'migrated') {
    output.appendLine(
      '[interpreter] Migrated legacy djangoOrmIntellisense.pythonPath into djangoOrmIntellisense.pythonInterpreter.'
    );
  } else if (normalization === 'cleared') {
    output.appendLine(
      '[interpreter] Removed legacy djangoOrmIntellisense.pythonPath because djangoOrmIntellisense.pythonInterpreter is already set.'
    );
  }

  context.subscriptions.push(
    output,
    daemon,
    statusView,
    diagnostics,
    registerShowStatusCommand(daemon, output),
    registerRestartDaemonCommand(daemon),
    registerConfigurePylanceDiagnosticsCommand(output),
    registerSelectSettingsModuleCommand(daemon, output),
    registerSelectPythonInterpreterCommand(daemon, output),
    ...registerPythonProviders(daemon),
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
  const initialEditor = vscode.window.activeTextEditor;
  if (settings.autoStart && initialEditor?.document.languageId === 'python') {
    void daemon.start(initialEditor.document.uri).catch((error) => {
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
