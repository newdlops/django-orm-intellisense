import type { OrmMemberResolution } from '../protocol';
import type { SurfaceMemberTuple } from '../../server/workspaceIndexer';

/** Native project methods carry locations but do not infer their return types. */
export function withKnownNativeMemberReturn(
  result: OrmMemberResolution | undefined,
  surface?: SurfaceMemberTuple
): OrmMemberResolution | undefined {
  const item = result?.item;
  if (!item || item.source === 'builtin' ||
      !['method', 'property', 'classmethod', 'staticmethod'].includes(item.memberKind) ||
      (item.returnKind !== undefined && item.returnKind !== 'unknown')) return result;
  if (!surface?.[0] || surface[0] === 'unknown') return undefined;
  if (['instance', 'model_class', 'manager', 'queryset', 'related_manager'].includes(surface[0]) &&
      !surface[1]) return undefined;
  return { ...result!, item: { ...item,
    returnKind: surface[0], returnModelLabel: surface[1] ?? undefined } };
}
