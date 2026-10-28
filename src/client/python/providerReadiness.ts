import * as vscode from 'vscode';

const PYTHON_EXTENSION_ID = 'ms-python.python';
const CANCELLED = Symbol('Python provider readiness cancelled');

/** Release our continuation on scope changes without cancelling another extension's work. */
export function waitForPublicReady<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(CANCELLED);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(CANCELLED);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

/** Observe initial public Python readiness only when a supported document is in use.
 * Extension.activate() may finish before its selected language service registers
 * providers. Python.ready covers that initial setup, not later provider starts.
 * This does not block extension startup or any foreground provider request. */
export function registerPythonProviderReadiness(
  promote: (() => void) | undefined,
  log: ((message: string) => void) | undefined
): vscode.Disposable {
  let disposed = false;
  let epoch = 0;
  let attemptedEpoch = -1;
  let pending: { epoch: number; abort: AbortController; api?: unknown } | undefined;
  let ready: { epoch: number; api: unknown } | undefined;
  let documentSubscription: vscode.Disposable | undefined;
  let extensionSubscription: vscode.Disposable | undefined;
  const hasPythonFile = () => vscode.workspace.textDocuments.some(document =>
    document.languageId === 'python' && document.uri.scheme === 'file');
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pending?.abort.abort();
    documentSubscription?.dispose();
    extensionSubscription?.dispose();
    ready = undefined;
    promote = undefined;
    log = undefined;
  };
  const publish = (): boolean => {
    if (disposed || !ready || ready.epoch !== epoch || !hasPythonFile()) return false;
    const python = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
    if (!python?.isActive || python.exports !== ready.api) return false;
    try {
      promote?.();
      log?.('[extension] Promoted SignatureHelp after initial public Python readiness; retained the original adapter.');
      dispose();
      return true;
    } catch (error) {
      ready = undefined;
      log?.(`[extension] Python provider readiness promotion failed: ${String(error)}`);
      return false;
    }
  };
  const consider = (): void => {
    if (disposed || !hasPythonFile()) return;
    const python = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
    if (!python) return;
    if (ready && python.isActive && python.exports !== ready.api) {
      ready = undefined;
      attemptedEpoch = -1;
    }
    if (publish()) return;
    if (pending) {
      if (!pending.abort.signal.aborted && pending.api && python.isActive && python.exports !== pending.api) {
        epoch++;
        pending.abort.abort();
      }
      return;
    }
    if (ready || attemptedEpoch === epoch) return;
    const attempt = { epoch, abort: new AbortController(), api: undefined as unknown };
    pending = attempt;
    attemptedEpoch = epoch;
    void (async () => {
      const api = python.isActive ? python.exports
        : await waitForPublicReady(python.activate(), attempt.abort.signal);
      if (disposed || attempt.epoch !== epoch || attempt.abort.signal.aborted) return;
      attempt.api = api;
      const publicReady = (api as { ready?: PromiseLike<unknown> } | undefined)?.ready;
      if (!publicReady || typeof publicReady.then !== 'function') return;
      await waitForPublicReady(publicReady, attempt.abort.signal);
      if (disposed || attempt.epoch !== epoch || attempt.abort.signal.aborted) return;
      if (vscode.extensions.getExtension(PYTHON_EXTENSION_ID)?.exports !== api) return;
      ready = { epoch: attempt.epoch, api };
      publish();
    })().catch(error => {
      if (!disposed && attempt.epoch === epoch && error !== CANCELLED) {
        log?.(`[extension] Python provider readiness unavailable: ${String(error)}`);
      }
    }).finally(() => {
      if (pending === attempt) pending = undefined;
      if (!disposed && attempt.epoch !== epoch) consider();
    });
  };
  documentSubscription = vscode.workspace.onDidOpenTextDocument(document => {
    if (document.languageId === 'python' && document.uri.scheme === 'file') consider();
  });
  extensionSubscription = vscode.extensions.onDidChange(() => {
    epoch++;
    ready = undefined;
    pending?.abort.abort();
    consider();
  });
  consider();
  return new vscode.Disposable(dispose);
}
