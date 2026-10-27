import * as fs from 'fs';
import * as path from 'path';

export function daemonProcessLaunch(extensionPath: string, pythonPath: string): {
  command: string; argv0?: string; stateChannel?: true;
} {
  if (process.platform !== 'darwin') return { command: pythonPath };
  const directory = path.join(extensionPath, 'native', 'worker-parent', 'darwin-universal');
  if (!fs.existsSync(directory)) return { command: pythonPath };
  const launcher = path.join(directory, 'daemon-parent-launch');
  const library = path.join(directory, 'daemon-parent-guard.dylib');
  if (!fs.statSync(launcher).isFile() || !fs.statSync(library).isFile()) {
    throw new Error('Analysis daemon native bundle is incomplete.');
  }
  fs.accessSync(launcher, fs.constants.X_OK);
  return { command: launcher, argv0: pythonPath, stateChannel: true };
}
