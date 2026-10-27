import type { DjangoProjectContext } from '../client/protocol';
import type { WorkspaceIndex } from './types';

function sourcePath(value: string): string {
  if (value.startsWith('file://')) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch { return ''; }
  }
  const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
  return /^\/?[A-Za-z]:\//.test(normalized) ? normalized.replace(/^\//, '').toLowerCase() : normalized;
}

export function projectForFile(contexts: readonly DjangoProjectContext[], file?: string): DjangoProjectContext | undefined {
  if (!file) return undefined;
  const path = sourcePath(file);
  let selected: DjangoProjectContext | undefined;
  let length = -1;
  for (const context of contexts) {
    for (const alias of [context.root, ...(context.rootAliases ?? [])]) {
      const root = sourcePath(alias);
      if (root.length > length && (path === root || path.startsWith(root + '/'))) {
        selected = context;
        length = root.length;
      }
    }
  }
  return selected;
}

export function attachProjectModelSources(index: WorkspaceIndex, contexts: readonly DjangoProjectContext[]): void {
  for (const context of contexts) {
    for (const [label, source] of Object.entries(context.models)) {
      const model = index.models.get(label);
      if (model) {
        model.module = source.module;
        model.filePath = source.filePath ?? '';
      }
    }
  }
}

/** Views share field records/tries; only the small maps for names are scoped. */
export function projectWorkspaceView(index: WorkspaceIndex, contexts: readonly DjangoProjectContext[],
                                     file?: string): WorkspaceIndex {
  if (contexts.length === 0) return index;
  const selected = projectForFile(contexts, file);
  const prefix = selected ? selected.namespace + '.' : undefined;
  const models = prefix ? new Map([...index.models].filter(([label]) => label.startsWith(prefix))) : index.models;
  const modelLabelByName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [label, model] of models) {
    if (model.runtimeOnly) continue;
    if (modelLabelByName.has(model.objectName)) ambiguous.add(model.objectName);
    else modelLabelByName.set(model.objectName, label);
  }
  for (const name of ambiguous) modelLabelByName.delete(name);
  return {...index, models, modelLabelByName,
    lookupCatalog: selected && index.lookupCatalog
      ? {...index.lookupCatalog, kinds: selected.lookupKinds ?? {}} : index.lookupCatalog};
}
