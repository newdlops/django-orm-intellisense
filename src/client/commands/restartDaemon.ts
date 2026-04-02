import * as vscode from 'vscode';
import { AnalysisDaemon } from '../daemon/analysisDaemon';

export function registerRestartDaemonCommand(
  daemon: AnalysisDaemon
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'djangoOrmIntellisense.restartDaemon',
    async () => {
      await daemon.restart();
      void vscode.window.showInformationMessage(
        'Django ORM Intellisense analysis daemon restarted.'
      );
    }
  );
}
