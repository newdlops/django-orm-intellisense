import * as vscode from 'vscode';

export const CONFIGURATION_SECTION = 'djangoOrmIntellisense';

export interface ExtensionSettings {
  pythonPath?: string;
  settingsModule?: string;
  logLevel: 'off' | 'info' | 'debug';
  autoStart: boolean;
}

export function getExtensionSettings(): ExtensionSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const pythonPath = configuration.get<string>('pythonPath')?.trim();
  const settingsModule = configuration.get<string>('settingsModule')?.trim();
  const logLevel = configuration.get<'off' | 'info' | 'debug'>('logLevel', 'info');
  const autoStart = configuration.get<boolean>('autoStart', true);

  return {
    pythonPath: pythonPath || undefined,
    settingsModule: settingsModule || undefined,
    logLevel,
    autoStart,
  };
}

export function isRelevantConfigurationChange(
  event: vscode.ConfigurationChangeEvent
): boolean {
  return event.affectsConfiguration(CONFIGURATION_SECTION);
}
