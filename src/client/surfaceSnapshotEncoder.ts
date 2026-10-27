import type { SurfaceIndexChangedNotificationMessage } from './protocol';

type Payload = NonNullable<SurfaceIndexChangedNotificationMessage['params']>;
interface Baseline { sequence: number; fingerprints?: Record<string, string>; labels?: string[] }
export interface PreparedSurfaceSnapshot {
  readonly baseline: Baseline;
  readonly successor: Baseline;
  readonly payload: Payload;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Acknowledged full-snapshot transport; source reindex replies are independent. */
export class SurfaceSnapshotEncoder {
  private baseline: Baseline = { sequence: 0 };

  reset(): void { this.baseline = { sequence: this.baseline.sequence }; }

  prepare(value: unknown): PreparedSurfaceSnapshot | undefined {
    if (!record(value) || !record(value.surfaceIndex)) return undefined;
    const payload = value as Payload;
    const surface = payload.surfaceIndex!;
    const labels = Object.keys(surface);
    const provided = payload.surfaceFingerprints;
    const valid = record(provided) && labels.length === Object.keys(provided).length
      && labels.every(label => typeof provided[label] === 'string');
    const fingerprints = valid ? { ...provided } as Record<string, string> : undefined;
    const baseline = this.baseline;
    const successor: Baseline = { sequence: baseline.sequence + 1, fingerprints, labels };
    let wire: Payload = { ...payload, surfaceTransport: { version: 1, kind: 'full', sequence: successor.sequence } };
    if (baseline.fingerprints && fingerprints) {
      const changed = labels.filter(label => baseline.fingerprints![label] !== fingerprints[label]);
      const removed = Object.keys(baseline.fingerprints).filter(label => !Object.hasOwn(surface, label));
      // A model's short-name owner follows table order. Replacing existing keys
      // in a delta cannot reproduce a reordered full table or an inserted key.
      const reconstructedLabels = [...baseline.labels!.filter(label => Object.hasOwn(surface, label)),
        ...labels.filter(label => !Object.hasOwn(baseline.fingerprints!, label))];
      const preservesOrder = reconstructedLabels.every((label, index) => label === labels[index]);
      if (preservesOrder && changed.length + removed.length < labels.length) {
        const { surfaceIndex: _surface, surfaceFingerprints: _fingerprints, ...globals } = payload;
        wire = { ...globals,
          surfaceTransport: { version: 1, kind: 'delta', sequence: successor.sequence, baseSequence: baseline.sequence },
          surfaceIndexDelta: Object.fromEntries(changed.map(label => [label, surface[label]])),
          surfaceFingerprints: Object.fromEntries(changed.map(label => [label, fingerprints[label]])),
          removedSurfaceLabels: removed };
      }
    }
    return { baseline, successor, payload: wire };
  }

  commit(prepared: PreparedSurfaceSnapshot): boolean {
    if (prepared.baseline !== this.baseline) return false;
    this.baseline = prepared.successor;
    return true;
  }
}
