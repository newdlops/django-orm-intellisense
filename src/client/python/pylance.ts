import * as vscode from 'vscode';

export const PYLANCE_EXTENSION_ID = 'ms-python.vscode-pylance';

export function isPylanceAvailable(): boolean {
  return vscode.extensions.getExtension(PYLANCE_EXTENSION_ID) !== undefined;
}
