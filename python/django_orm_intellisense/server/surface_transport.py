"""Model-table deltas against the last successfully written notification.

The transport baseline is independent of reindex responses and application
state. Global metadata is complete in every frame; only model tables differ.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SurfaceBaseline:
    sequence: int
    fingerprints: dict[str, str] | None


@dataclass(frozen=True, slots=True)
class PreparedSurfaceSnapshot:
    baseline: SurfaceBaseline
    successor: SurfaceBaseline
    payload: dict


class SurfaceSnapshotEncoder:
    def __init__(self):
        self.baseline = SurfaceBaseline(0, None)

    def reset(self):
        self.baseline = SurfaceBaseline(self.baseline.sequence, None)

    def prepare(self, payload, *, force_full=False):
        baseline = self.baseline
        surface = payload['surfaceIndex']
        fingerprints = payload.get('surfaceFingerprints')
        valid = (isinstance(fingerprints, dict) and surface.keys() == fingerprints.keys()
            and all(isinstance(value, str) for value in fingerprints.values()))
        current = dict(fingerprints) if valid else None
        sequence = baseline.sequence + 1
        header = {'version': 1, 'sequence': sequence, 'kind': 'full'}
        wire = {**payload, 'surfaceTransport': header}
        if not force_full and valid and baseline.fingerprints is not None:
            changed = {key for key, value in current.items() if baseline.fingerprints.get(key) != value}
            removed = baseline.fingerprints.keys() - current.keys()
            # A replacement is smaller when most/all models changed or vanished.
            if len(changed) + len(removed) < len(surface):
                header = {**header, 'kind': 'delta', 'baseSequence': baseline.sequence}
                wire = {key: value for key, value in payload.items()
                    if key not in ('surfaceIndex', 'surfaceFingerprints')}
                wire.update(surfaceTransport=header,
                    surfaceIndexDelta={key: surface[key] for key in sorted(changed)},
                    surfaceFingerprints={key: current[key] for key in sorted(changed)},
                    removedSurfaceLabels=sorted(removed))
        return PreparedSurfaceSnapshot(baseline, SurfaceBaseline(sequence, current), wire)

    def is_current(self, prepared):
        return prepared.baseline is self.baseline

    def commit(self, prepared):
        if not self.is_current(prepared):
            raise RuntimeError('Surface transport baseline changed before publication')
        self.baseline = prepared.successor
