import * as vscode from 'vscode';
import type { PythonSelectionApi } from './interpreter';
import { waitForPublicReady } from './providerReadiness';

/** Observe public environment readiness/selection without blocking a provider. */
export function registerPythonInterpreterChanges(
  changed: (resource?: vscode.Uri) => void,
  log: (message: string) => void
): vscode.Disposable {
  let disposed = false;
  let generation = 0;
  let attempted = false;
  let abort = new AbortController();
  let selection: vscode.Disposable | undefined;
  const hasPython = () => vscode.workspace.textDocuments.some(document =>
    document.languageId === 'python' && document.uri.scheme === 'file');
  const observe = (): void => {
    if (disposed || attempted || !hasPython()) return;
    const python = vscode.extensions.getExtension<PythonSelectionApi>('ms-python.python');
    if (!python) return;
    attempted = true;
    const ownGeneration = generation;
    const ownAbort = abort;
    const current = () => !disposed && ownGeneration === generation && !ownAbort.signal.aborted;
    void (async () => {
      const api = python.isActive ? python.exports : await waitForPublicReady(python.activate(), ownAbort.signal);
      if (!current()) return;
      if (api.ready) await waitForPublicReady(api.ready, ownAbort.signal);
      if (!current() || vscode.extensions.getExtension('ms-python.python')?.exports !== api) return;
      selection = api.environments?.onDidChangeActiveEnvironmentPath?.(event => {
        if (!current()) return;
        const resource = event.resource;
        changed(resource && 'uri' in resource ? resource.uri : resource);
      });
      if (hasPython()) changed();
    })().catch(error => {
      if (current()) log(`[interpreter] Python environment readiness unavailable: ${String(error)}`);
    });
  };
  const documents = vscode.workspace.onDidOpenTextDocument(document => {
    if (document.languageId === 'python' && document.uri.scheme === 'file') observe();
  });
  const extensions = vscode.extensions.onDidChange(() => {
    generation++;
    abort.abort();
    abort = new AbortController();
    selection?.dispose();
    selection = undefined;
    attempted = false;
    observe();
  });
  observe();
  return new vscode.Disposable(() => {
    disposed = true;
    abort.abort();
    selection?.dispose();
    documents.dispose();
    extensions.dispose();
  });
}
