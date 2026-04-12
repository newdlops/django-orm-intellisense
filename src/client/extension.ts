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
const WATCHER_IGNORED_SEGMENTS = new Set([
  '.git',
  '.hg',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.svn',
  '.tox',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'out',
  'venv',
]);

export function getActiveDaemonForTesting(): AnalysisDaemon | undefined {
  return activeDaemon;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Django ORM Intellisense');
  const daemon = new AnalysisDaemon(context, output);
  const statusView = new HealthStatusView();
  const diagnostics = new HealthDiagnostics();
  const autoRestartsEnabled = process.env.DJLS_DISABLE_AUTO_RESTARTS !== '1';
  let pythonSourceWatcher: vscode.FileSystemWatcher | undefined;
  let watchedPythonRoot: string | undefined;
  let reindexTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingReindexFiles = new Set<string>();

  const disposePythonSourceWatcher = (): void => {
    pythonSourceWatcher?.dispose();
    pythonSourceWatcher = undefined;
    watchedPythonRoot = undefined;
  };

  const queueReindexFile = (filePath: string): void => {
    const normalizedPath = path.resolve(filePath);
    if (
      watchedPythonRoot &&
      shouldIgnoreWatcherPath(watchedPythonRoot, normalizedPath)
    ) {
      return;
    }
    pendingReindexFiles.add(normalizedPath);
    if (reindexTimer) {
      clearTimeout(reindexTimer);
    }
    reindexTimer = setTimeout(() => {
      void flushPendingReindexFiles();
    }, 300);
  };

  const flushPendingReindexFiles = async (): Promise<void> => {
    reindexTimer = undefined;
    if (pendingReindexFiles.size === 0) {
      return;
    }
    if (!languageClient || !daemon.isReady()) {
      reindexTimer = setTimeout(() => {
        void flushPendingReindexFiles();
      }, 300);
      return;
    }

    const files = [...pendingReindexFiles];
    pendingReindexFiles.clear();

    for (const filePath of files) {
      try {
        output.appendLine(`[ls] reindexing file: ${filePath}`);
        await daemon.reindexFile(filePath);
      } catch (error) {
        output.appendLine(`[ls] reindex failed: ${String(error)}`);
      }
    }

    if (Object.keys(daemon.surfaceIndex).length === 0) {
      return;
    }

    output.appendLine(
      `[ls] re-sending surfaceIndex after reindex: ${Object.keys(daemon.surfaceIndex).length} models`
    );
    void languageClient.sendNotification('django/updateSurfaceIndex', {
      surfaceIndex: daemon.surfaceIndex,
      modelNames: Array.from(daemon.modelNames),
      customLookups: daemon.customLookups,
      staticFallback: daemon.staticFallback,
    });
  };

  const updatePythonSourceWatcher = (workspaceRoot?: string): void => {
    if (!workspaceRoot) {
      pendingReindexFiles.clear();
      disposePythonSourceWatcher();
      return;
    }

    const normalizedRoot = path.resolve(workspaceRoot);
    if (watchedPythonRoot === normalizedRoot && pythonSourceWatcher) {
      return;
    }

    pendingReindexFiles.clear();
    disposePythonSourceWatcher();
    watchedPythonRoot = normalizedRoot;
    pythonSourceWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(normalizedRoot, '**/*.py')
    );

    const onWatcherEvent = (uri: vscode.Uri): void => {
      if (uri.scheme !== 'file') {
        return;
      }
      queueReindexFile(uri.fsPath);
    };

    pythonSourceWatcher.onDidCreate(onWatcherEvent);
    pythonSourceWatcher.onDidChange(onWatcherEvent);
    pythonSourceWatcher.onDidDelete(onWatcherEvent);
    output.appendLine(
      `[watcher] watching configured workspace root: ${normalizedRoot}`
    );
  };

  activeDaemon = daemon;

  if (!isPylanceAvailable()) {
    output.appendLine(
      '[extension] Pylance not detected. ORM diagnostics are disabled to reduce noisy errors and startup cost.'
    );
  }

  daemon.onDidChangeState((snapshot) => {
    statusView.update(snapshot);
    diagnostics.update(snapshot);
    updatePythonSourceWatcher(snapshot.workspaceRoot);
    if (daemon.isReady() && pendingReindexFiles.size > 0) {
      if (reindexTimer) {
        clearTimeout(reindexTimer);
      }
      reindexTimer = setTimeout(() => {
        void flushPendingReindexFiles();
      }, 50);
    }
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
    new vscode.Disposable(() => {
      if (reindexTimer) {
        clearTimeout(reindexTimer);
      }
      disposePythonSourceWatcher();
    }),
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
    languageClient!.onNotification('django/fileNeedsReindex', (params: { uri: string }) => {
      const uri = params?.uri;
      if (!uri) {
        return;
      }
      try {
        queueReindexFile(vscode.Uri.parse(uri).fsPath);
      } catch {
        queueReindexFile(uri);
      }
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

function shouldIgnoreWatcherPath(workspaceRoot: string, filePath: string): boolean {
  const relativePath = path.relative(workspaceRoot, filePath);
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    return true;
  }

  return relativePath
    .split(path.sep)
    .some((segment) => WATCHER_IGNORED_SEGMENTS.has(segment));
}
