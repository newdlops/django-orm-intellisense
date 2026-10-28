import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** One compatibility result per daemon; replacing an executable invalidates it. */
export class PythonRuntimeCompatibility {
  private last?: { key: string; result: Promise<void> };

  check(executable: string, cwd: string): Promise<void> {
    const fingerprint = (file: string): string => {
      try {
        const s = fs.statSync(file);
        return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
      } catch { return 'missing'; }
    };
    const key = JSON.stringify([executable, cwd, fingerprint(executable), process.env.PATH,
      process.env.ASDF_PYTHON_VERSION, process.env.PYENV_VERSION,
      ...[cwd, os.homedir()].flatMap(root => ['.tool-versions', '.python-version'].map(name => fingerprint(path.join(root, name))))]);
    if (this.last?.key === key) return this.last.result;
    const result = new Promise<void>((resolve, reject) => {
      execFile(executable, ['-I', '-S', '-B', '-c', 'import sys; print("%s.%s.%s" % sys.version_info[:3])'],
        { cwd, timeout: 1500, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
          if (error) {
            if (this.last?.key === key) this.last = undefined;
            reject(new Error(`Cannot run the selected Python interpreter ${executable}: ${error.message}`));
            return;
          }
          const version = stdout.trim();
          const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
          if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
            if (!match && this.last?.key === key) this.last = undefined;
            reject(new Error(`Django ORM Intellisense requires Python 3.10 or newer; ${executable} reports ${version || 'an unknown version'}. Select a compatible project environment.`));
            return;
          }
          resolve();
        });
    });
    this.last = { key, result };
    return result;
  }
}
