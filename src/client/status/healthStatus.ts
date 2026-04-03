import * as vscode from 'vscode';
import type { HealthSnapshot } from '../protocol';

function iconForPhase(phase: HealthSnapshot['phase']): string {
  switch (phase) {
    case 'starting':
      return '$(sync~spin)';
    case 'ready':
      return '$(check)';
    case 'degraded':
      return '$(warning)';
    case 'error':
      return '$(error)';
    case 'stopped':
    default:
      return '$(circle-slash)';
  }
}

export class HealthStatusView implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  constructor() {
    this.item.name = 'Django ORM Intellisense';
    this.item.command = 'djangoOrmIntellisense.showStatus';
    this.item.show();
  }

  update(snapshot: HealthSnapshot): void {
    this.item.text = `${iconForPhase(snapshot.phase)} Django ORM`;
    this.item.tooltip = [
      `State: ${snapshot.phase}`,
      `Detail: ${snapshot.detail}`,
      `Workspace: ${snapshot.workspaceRoot ?? 'Unavailable'}`,
      `Python: ${snapshot.pythonPath ?? 'Unavailable'}`,
      `Python source: ${snapshot.pythonSource ?? 'Unavailable'}`,
      `Settings: ${snapshot.settingsModule ?? 'Not set'}`,
      `Settings candidates: ${(snapshot.settingsCandidates ?? []).join(', ') || 'None'}`,
      `Bootstrap: ${snapshot.runtime?.bootstrapStatus ?? 'Not started'}`,
      `Runtime models: ${snapshot.runtime?.modelCount ?? 0}`,
    ].join('\n');
  }

  dispose(): void {
    this.item.dispose();
  }
}
