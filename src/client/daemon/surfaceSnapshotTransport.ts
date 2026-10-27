import type { SurfaceIndexChangedNotificationMessage } from '../protocol';
import type { SurfaceIndex } from '../../server/workspaceIndexer';

type Payload = NonNullable<SurfaceIndexChangedNotificationMessage['params']>;

/** Private wire baseline; application reindex deltas never mutate its tables. */
export class SurfaceSnapshotDecoder {
  private baseline?: { sequence: number; surface: SurfaceIndex; fingerprints: Record<string, string> };

  reset(): void { this.baseline = undefined; }

  get hasBaseline(): boolean { return this.baseline !== undefined; }

  decodeInitialize<T extends Payload>(payload: T, sourceContextReady: boolean): T {
    this.reset();
    if (!sourceContextReady || payload.surfaceTransport?.kind !== 'full') return payload;
    try {
      // Keep every initialize-only/future property, including source context.
      // A partial fingerprint set remains usable but cannot suppress resync.
      return { ...payload, ...this.decode(payload) };
    } catch {
      this.reset();
      return payload;
    }
  }

  decode(payload: Payload): Payload {
    const header = payload.surfaceTransport;
    if (!header) {
      this.reset();
      return payload;
    }
    const { surfaceTransport, surfaceIndexDelta, removedSurfaceLabels, ...complete } = payload;
    if (header.version !== 1 || !Number.isSafeInteger(header.sequence) || header.sequence <= 0) {
      throw new Error('Invalid surface transport sequence/version.');
    }
    let surface: SurfaceIndex;
    let fingerprints: Record<string, string>;
    if (header.kind === 'full') {
      if (!complete.surfaceIndex) throw new Error('Incomplete full surface frame.');
      surface = { ...complete.surfaceIndex };
      fingerprints = { ...(complete.surfaceFingerprints ?? {}) };
    } else if (header.kind === 'delta') {
      const baseline = this.baseline;
      if (!baseline || header.baseSequence !== baseline.sequence || header.sequence <= baseline.sequence) {
        throw new Error('Surface transport baseline is missing or outdated.');
      }
      if (!surfaceIndexDelta || !complete.surfaceFingerprints || !Array.isArray(removedSurfaceLabels)
          || removedSurfaceLabels.some(label => typeof label !== 'string')
          || removedSurfaceLabels.some(label => Object.hasOwn(surfaceIndexDelta, label))
          || Object.keys(surfaceIndexDelta).length !== Object.keys(complete.surfaceFingerprints).length
          || Object.keys(surfaceIndexDelta).some(label => typeof complete.surfaceFingerprints![label] !== 'string')) {
        throw new Error('Incomplete surface delta frame.');
      }
      surface = { ...baseline.surface, ...surfaceIndexDelta };
      fingerprints = { ...baseline.fingerprints, ...complete.surfaceFingerprints };
      for (const label of removedSurfaceLabels) { delete surface[label]; delete fingerprints[label]; }
    } else {
      throw new Error('Unsupported surface transport frame.');
    }
    const keys = Object.keys(surface);
    if (keys.length !== Object.keys(fingerprints).length || keys.some(label => typeof fingerprints[label] !== 'string')) {
      // Full legacy-compatible contents remain usable; never use an incomplete
      // fingerprint set as the basis of a subsequent transport delta.
      if (header.kind !== 'full') throw new Error('Surface delta did not reconstruct complete fingerprints.');
      this.reset();
    } else {
      this.baseline = { sequence: header.sequence, surface, fingerprints };
    }
    // Root tables are owned by the caller. Model entries are existing immutable
    // published values, shared exactly as they already are by local indexes.
    return { ...complete, surfaceIndex: { ...surface },
      ...(complete.surfaceFingerprints !== undefined ? { surfaceFingerprints: { ...fingerprints } } : {}) };
  }
}
