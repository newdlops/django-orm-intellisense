import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { registerConfigurePylanceDiagnosticsCommand } from './commands/configurePylanceDiagnostics';
import { registerRestartDaemonCommand } from './commands/restartDaemon';
import { registerSelectSettingsModuleCommand } from './commands/selectSettingsModule';
import { registerSelectPythonInterpreterCommand } from './commands/selectPythonInterpreter';
import { registerShowStatusCommand } from './commands/showStatus';
import { isRelevantConfigurationChange, getExtensionSettings } from './config/settings';
import { AnalysisDaemon } from './daemon/analysisDaemon';
import { HealthDiagnostics } from './diagnostics/healthDiagnostics';
import { registerPythonProviders } from './providers/pythonProviders';
import { excludeDjangoStubsFromPylance } from './pylance/excludeDjangoStubs';
import { normalizePythonInterpreterSettings } from './python/interpreter';
import { isPylanceAvailable } from './python/pylance';
import { HealthStatusView } from './status/healthStatus';

let activeDaemon: AnalysisDaemon | undefined;
let languageClient: LanguageClient | undefined;

export function getActiveDaemonForTesting(): AnalysisDaemon | undefined {
  return activeDaemon;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Django ORM Intellisense');
  const daemon = new AnalysisDaemon(context, output);
  const statusView = new HealthStatusView();
  const diagnostics = new HealthDiagnostics();
  const autoRestartsEnabled = process.env.DJLS_DISABLE_AUTO_RESTARTS !== '1';

  activeDaemon = daemon;

  if (!isPylanceAvailable()) {
    output.appendLine(
      '[extension] Pylance not detected. ORM diagnostics are disabled to reduce noisy errors and startup cost.'
    );
  }

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
    registerConfigurePylanceDiagnosticsCommand(output),
    registerSelectSettingsModuleCommand(daemon, output),
    registerSelectPythonInterpreterCommand(daemon, output),
    ...registerPythonProviders(daemon),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!autoRestartsEnabled) {
        return;
      }
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
      if (!autoRestartsEnabled) {
        return;
      }
      output.appendLine('[extension] Workspace folders changed. Restarting analysis daemon.');
      void daemon.restart().catch((error) => {
        output.appendLine(`[extension] Failed to restart daemon: ${String(error)}`);
      });
    })
  );

  void excludeDjangoStubsFromPylance(output).catch((error) => {
    output.appendLine(
      `[pylance] Failed to exclude django-stubs from Pylance analysis: ${String(error)}`
    );
  });

  void normalizePythonInterpreterSettings()
    .then((normalization) => {
      if (normalization === 'migrated') {
        output.appendLine(
          '[interpreter] Migrated legacy djangoOrmIntellisense.pythonPath into djangoOrmIntellisense.pythonInterpreter.'
        );
      } else if (normalization === 'cleared') {
        output.appendLine(
          '[interpreter] Removed legacy djangoOrmIntellisense.pythonPath because djangoOrmIntellisense.pythonInterpreter is already set.'
        );
      }
    })
    .catch((error) => {
      output.appendLine(
        `[interpreter] Failed to normalize legacy interpreter settings: ${String(error)}`
      );
    });

  // --- Language Server 시작 ---
  const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'python' }],
    outputChannel: output,
  };
  languageClient = new LanguageClient(
    'djangoOrmLs',
    'Django ORM Language Server',
    serverOptions,
    clientOptions
  );
  context.subscriptions.push(languageClient);
  void languageClient.start().then(() => {
    output.appendLine('[ls] Language Server started');
    // daemon이 ready되면 surfaceIndex를 서버에 전달
    feedSurfaceIndexToServer(daemon, output);

    // LS에서 파일 재인덱싱 요청 수신 → surfaceIndex 재전송 (debounce)
    let reindexTimer: ReturnType<typeof setTimeout> | undefined;
    languageClient!.onNotification('django/fileNeedsReindex', () => {
      if (reindexTimer) clearTimeout(reindexTimer);
      reindexTimer = setTimeout(() => {
        output.appendLine('[ls] re-sending surfaceIndex after file save');
        if (languageClient && Object.keys(daemon.surfaceIndex).length > 0) {
          void languageClient.sendNotification('django/updateSurfaceIndex', {
            surfaceIndex: daemon.surfaceIndex,
            modelNames: Array.from(daemon.modelNames),
            staticFallback: daemon.staticFallback,
          });
        }
      }, 300);
    });
  });

  const settings = getExtensionSettings();
  const initialEditor = vscode.window.activeTextEditor;
  if (settings.autoStart && initialEditor?.document.languageId === 'python') {
    void daemon.start(initialEditor.document.uri).catch((error) => {
      output.appendLine(`[extension] Failed to start daemon: ${String(error)}`);
    });
  }
}

function feedSurfaceIndexToServer(
  daemon: AnalysisDaemon,
  output: vscode.OutputChannel
): void {
  // daemon 상태 변경 시마다 surfaceIndex를 서버에 전달
  const trySend = (): void => {
    if (
      !languageClient ||
      Object.keys(daemon.surfaceIndex).length === 0
    ) {
      return;
    }
    const modelNames = Array.from(daemon.modelNames);
    output.appendLine(
      `[ls] sending surfaceIndex to server: ${modelNames.length} models`
    );
    void languageClient.sendNotification('django/updateSurfaceIndex', {
      surfaceIndex: daemon.surfaceIndex,
      modelNames,
      customLookups: daemon.customLookups,
      staticFallback: daemon.staticFallback,
    });
  };

  // 즉시 시도 (이미 ready일 수 있음)
  trySend();

  // daemon 상태 변경 시 재시도
  daemon.onDidChangeState(() => {
    trySend();
  });
}

export async function deactivate(): Promise<void> {
  if (languageClient) {
    await languageClient.stop();
    languageClient = undefined;
  }
  if (!activeDaemon) {
    return;
  }

  await activeDaemon.stop();
  activeDaemon = undefined;
}
