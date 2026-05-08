import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisDaemon } from '../daemon/analysisDaemon';
import { loadNative } from '../native/loader';

function cacheRoot(): string {
  const override = process.env.DJANGO_ORM_INTELLISENSE_CACHE_DIR;
  if (override) return override;
  return path.join(os.tmpdir(), 'django-orm-intellisense');
}

export function registerClearCacheAndReindexCommand(
  daemon: AnalysisDaemon,
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'djangoOrmIntellisense.clearCacheAndReindex',
    async () => {
      const workspaceRoot = daemon.getState().workspaceRoot;
      if (!workspaceRoot) {
        void vscode.window.showWarningMessage(
          'Django ORM Intellisense: workspace root unknown — open a Python file in your project first, then retry.',
        );
        return;
      }

      let cacheDir: string | undefined;
      try {
        const native = loadNative();
        cacheDir = native.workspaceCacheDir(cacheRoot(), workspaceRoot);
      } catch (err) {
        output.appendLine(`[clear-cache] could not resolve cache directory: ${String(err)}`);
        void vscode.window.showErrorMessage(
          'Django ORM Intellisense: failed to resolve cache directory (native bindings unavailable).',
        );
        return;
      }

      try {
        await daemon.stop();
      } catch (err) {
        output.appendLine(`[clear-cache] daemon stop failed: ${String(err)}`);
      }

      try {
        await fs.promises.rm(cacheDir, { recursive: true, force: true });
        output.appendLine(`[clear-cache] removed ${cacheDir}`);
      } catch (err) {
        output.appendLine(`[clear-cache] removal failed: ${String(err)}`);
        void vscode.window.showErrorMessage(
          `Django ORM Intellisense: failed to remove cache (${String(err)}).`,
        );
        return;
      }

      try {
        await daemon.start();
      } catch (err) {
        output.appendLine(`[clear-cache] daemon restart failed: ${String(err)}`);
      }

      void vscode.window.showInformationMessage(
        'Django ORM Intellisense: cache cleared, reindex in progress.',
      );
    },
  );
}
