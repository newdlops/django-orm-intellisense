import * as vscode from 'vscode';

export const CONFIGURATION_SECTION = 'djangoOrmIntellisense';

export interface ExtensionSettings {
  pythonInterpreter?: string;
  pythonPath?: string;
  settingsModule?: string;
  workspaceRoot?: string;
  logLevel: 'off' | 'info' | 'debug';
  autoStart: boolean;
}

export function getExtensionSettings(
  scope?: vscode.ConfigurationScope
): ExtensionSettings {
  const configuration = vscode.workspace.getConfiguration(
    CONFIGURATION_SECTION,
    scope
  );
  const pythonInterpreter = configuration.get<string>('pythonInterpreter')?.trim();
  const pythonPath = configuration.get<string>('pythonPath')?.trim();
  const settingsModule = configuration.get<string>('settingsModule')?.trim();
  const workspaceRoot = configuration.get<string>('workspaceRoot')?.trim();
  const logLevel = configuration.get<'off' | 'info' | 'debug'>('logLevel', 'info');
  const autoStart = configuration.get<boolean>('autoStart', true);

  return {
    pythonInterpreter: pythonInterpreter || undefined,
    pythonPath: pythonPath || undefined,
    settingsModule: settingsModule || undefined,
    workspaceRoot: workspaceRoot || undefined,
    logLevel,
    autoStart,
  };
}

export function isRelevantConfigurationChange(
  event: vscode.ConfigurationChangeEvent
): boolean {
  return (
    event.affectsConfiguration(CONFIGURATION_SECTION) ||
    event.affectsConfiguration('python.defaultInterpreterPath') ||
    event.affectsConfiguration('python.pythonPath')
  );
}
