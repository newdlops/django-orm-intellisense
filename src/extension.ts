import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const showStatus = vscode.commands.registerCommand(
    'djangoOrmIntellisense.showStatus',
    () => {
      void vscode.window.showInformationMessage(
        'Django ORM Intellisense scaffold is active.'
      );
    }
  );

  context.subscriptions.push(showStatus);
}

export function deactivate(): void {
  // Intentionally empty. The extension has no long-lived resources yet.
}
