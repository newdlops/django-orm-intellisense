import { execFile, type ChildProcessWithoutNullStreams, type StdioOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

const MAX_FRAME_BYTES = 8192;
const OWNER_CLOSE_MS = 2500;
const STOP_EXIT_MS = 1200 + 800;

export interface NativeDaemonStateOwner {
  ready: Promise<void>;
  closed: Promise<void>;
  beginStop(): void;
  waitForStopCleanup(): Promise<void>;
}

export interface NativeDaemonStateLaunch {
  argsPrefix: string[];
  stdio: StdioOptions;
  closeDescriptors(): void;
  bind(child: ChildProcessWithoutNullStreams): NativeDaemonStateOwner;
  disposeUnspawned(): Promise<void>;
}

// Ownership is established before spawn. A child need not publish anything
// before the surviving client can remove its exact, already owned inode.
export function prepareNativeDaemonState(
  temporaryRoot: string,
  launcher: string,
  log: (message: string) => void,
): NativeDaemonStateLaunch {
  const parent = fs.realpathSync(temporaryRoot);
  const allocator = String(process.pid), uid = String(process.getuid?.());
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let parentFd = -1, rootFd = -1, root: string | undefined;
  let identity: fs.BigIntStats | undefined;
  let parentIdentity: fs.BigIntStats;
  try {
    parentFd = fs.openSync(parent, directoryFlags);
    parentIdentity = fs.fstatSync(parentFd, { bigint: true });
    root = fs.mkdtempSync(path.join(parent, `djls-owned-worker-state-${allocator}-`));
    identity = fs.lstatSync(root, { bigint: true });
    if (!identity.isDirectory() || String(identity.uid) !== uid) throw new Error('Invalid native daemon state directory owner.');
    rootFd = fs.openSync(root, directoryFlags);
    const opened = fs.fstatSync(rootFd, { bigint: true });
    if (opened.dev !== identity.dev || opened.ino !== identity.ino) throw new Error('Native daemon state directory changed during creation.');
  } catch (error) {
    // No child or writer exists yet. Remove only an unchanged empty directory.
    if (root && identity) {
      try {
        const current = fs.lstatSync(root, { bigint: true });
        if (current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino) fs.rmdirSync(root);
      } catch { /* Preserve an exchanged/nonempty directory. */ }
    }
    if (rootFd >= 0) fs.closeSync(rootFd);
    if (parentFd >= 0) fs.closeSync(parentFd);
    throw error;
  }
  const ownedRoot = root;
  const fields = [allocator, uid, String(parentIdentity.dev), String(parentIdentity.ino), String(identity.dev), String(identity.ino)];
  const hexPath = Buffer.from(ownedRoot, 'utf8').toString('hex');
  let bound = false;
  const closeDescriptors = (): void => {
    if (rootFd >= 0) { fs.closeSync(rootFd); rootFd = -1; }
    if (parentFd >= 0) { fs.closeSync(parentFd); parentFd = -1; }
  };
  const cleanup = (pid: string, remaining: number): Promise<void> => new Promise(resolve => {
    if (remaining <= 0) { log('Native daemon state cleanup exceeded the existing stop window.'); resolve(); return; }
    execFile(launcher, ['--djls-clean-owned-state-v2', pid, ...fields, ownedRoot], {
      timeout: Math.max(1, Math.floor(Math.min(OWNER_CLOSE_MS, remaining))),
      killSignal: 'SIGKILL', maxBuffer: MAX_FRAME_BYTES,
    }, (error, _stdout, stderr) => {
      if (error) log(`Native daemon state cleanup failed: ${error.message}${stderr ? `: ${stderr.trim()}` : ''}`);
      resolve();
    });
  });
  return {
    argsPrefix: ['--djls-native-state-root', '3', '4', '5', ...fields, hexPath, '--'],
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', rootFd, parentFd],
    closeDescriptors,
    disposeUnspawned() {
      if (bound) throw new Error('Native daemon state already belongs to a spawned child.');
      bound = true;
      closeDescriptors();
      return cleanup('0', OWNER_CLOSE_MS);
    },
    bind(child) {
      if (bound) throw new Error('Native daemon state cannot be bound twice.');
      bound = true;
      const channel = child.stdio[3];
      let stopDeadline: number | undefined;
      let settled = false, frame = Buffer.alloc(0);
      let resolveReady!: () => void, rejectReady!: (reason: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady=resolve; rejectReady=reject; });
      void ready.catch(() => undefined);
      const reject = (reason: Error): void => {
        if (!settled) { settled=true; frame=Buffer.alloc(0); rejectReady(reason); }
      };
      if (!(channel instanceof Readable)) reject(new Error('Analysis daemon ownership channel is missing.'));
      else {
        channel.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (frame.length + chunk.length > MAX_FRAME_BYTES) {
            reject(new Error('Analysis daemon ownership frame is too large.'));
            channel.destroy();
            return;
          }
          frame=Buffer.concat([frame,chunk]);
        });
        channel.once('error', error => reject(error));
        channel.once('end', () => {
          if (settled) return;
          const expected = ['djls-state-2', String(child.pid), ...fields, hexPath].join('\t')+'\n';
          if (!frame.equals(Buffer.from(expected,'ascii'))) { reject(new Error('Native daemon ownership acknowledgment differs from its pre-spawn lease.')); return; }
          frame=Buffer.alloc(0);settled=true;resolveReady();
        });
        channel.once('close', () => reject(new Error('Analysis daemon ownership channel closed before its acknowledgment.')));
      }
      child.once('error', error => reject(error));
      const closed = new Promise<void>(resolve => child.once('close', () => {
        reject(new Error('Analysis daemon ended before acknowledging its ownership.'));
        // The pre-spawn lease remains valid even if ready never fulfilled.
        const remaining=(stopDeadline ?? performance.now()+OWNER_CLOSE_MS)-performance.now();
        void cleanup(String(child.pid ?? 0),remaining).then(resolve);
      }));
      return {
        ready, closed,
        beginStop() { stopDeadline ??= performance.now()+STOP_EXIT_MS; },
        async waitForStopCleanup() {
          const remaining=(stopDeadline ?? performance.now())-performance.now();
          if (remaining<=0) return;
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([closed,new Promise<void>(resolve=>{timer=setTimeout(resolve,remaining);})]);
          clearTimeout(timer);
        },
      };
    },
  };
}
