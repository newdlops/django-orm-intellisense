import * as vscode from 'vscode';
import type { HealthSnapshot } from '../protocol';

export class HealthDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(
    'djangoOrmIntellisense'
  );

  update(snapshot: HealthSnapshot): void {
    this.collection.clear();

    if (
      (snapshot.phase !== 'error' && snapshot.phase !== 'degraded') ||
      !snapshot.managePyPath
    ) {
      return;
    }

    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 1),
      snapshot.detail,
      snapshot.phase === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'Django ORM Intellisense';

    this.collection.set(vscode.Uri.file(snapshot.managePyPath), [diagnostic]);
  }

  dispose(): void {
    this.collection.dispose();
  }
}
