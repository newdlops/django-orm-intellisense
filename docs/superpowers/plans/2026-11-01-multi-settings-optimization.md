# Multi-settings Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Complete all four multi-settings optimizations while preserving every settings registry and its distinct metadata.

**Architecture:** Incremental per-profile contributions feed the repository union and existing surface transport. A generation-owned seed and bounded record sharing remove repeated allocations; versioned pure-record caches restore successful registries after validating their witnesses.

**Tech Stack:** Python dataclasses/unittest/JSON, TypeScript/Node control programs, existing Rust native bindings.

**Spec:** `docs/superpowers/specs/2026-11-01-multi-settings-optimization-design.md`

## Global Constraints

- Python 3.10 minimum and existing VS Code compatibility remain.
- All settings are included; one owned registry collector runs at a time.
- No administrator access, system path/security/VPN changes, autostart registration or separate resident service.
- No global GC policy changes or forced GC. Bound disk caches and workspace-owned pools.
- Preserve cancellation, request budgets, stopped sessions and source generation checks.
- Preserve unrelated untracked documentation and old release evidence. Retire only this task's disposable data after retention-policy checks.

## Review Focus

- A later profile adds/removes a reverse relation or custom transform on a model also owned by an earlier profile.
- A source edit or dependency replacement occurs between capture and adoption, including equal size/mtime and path aliases.
- Client notifications are cancelled, duplicated, reordered or health-only while native preparation is in flight.
- A failed/cancelled registry refresh cannot replace a successful persistent cache with partial or stale data.
- Shared graph/catalog/member storage must not permit an edit in one profile to mutate another or retain retired generations.

## Task 1: Incremental union and stable client/native adoption

**Files:** `server/workspace_projects.py`, new `server/project_contributions.py` if needed, `src/client/daemon/analysisDaemon.ts`, `nativeFastPath.ts`; tests `python/tests/test_project_incremental_union.py`, `scripts/check-client-settings-updates.cjs`.

**Interfaces:** `WorkspaceProjects.payload()` remains a complete protocol snapshot; it reuses cached per-profile qualified contributions and updates only invalidated labels. Client notification adoption preserves unchanged model rows, and identical native instance inputs preserve prepared source modules.

- [x] Capture baseline startup/publication counts and run the current same-root/project tests.
- [x] Add tests that compare incremental output to a fresh full union after a profile replacement, failed profile, field/member/lookup change and deletion; assert unaffected contribution identity and no redundant conversion.
- [x] Run tests and observe failure on baseline.
- [x] Implement contribution invalidation and client/native no-op handling using existing fingerprints and generation checks.
- [x] Run new tests plus project union/transport/client adoption controls; expect all pass and identical complete semantics.
- [x] Commit and ledger evidence.

## Task 2: Shared generation inputs and source proof

**Files:** `runtime/projects.py`, `server/project_daemon.py`, `server/worker_state.py`; tests `python/tests/test_project_shared_inputs.py` and runtime isolation/source provenance tests.

**Interfaces:** `collect_project_runtimes(..., source_snapshot=None)` consumes a coordinator snapshot; generation-owned private seed files are referenced by per-profile input records. Workers return pure records with their before/after witnesses; public call defaults stay compatible.

- [x] Add tests for one static seed write across same-root profiles, source mutation/membership during collection, added sibling import, cancellation and temporary-state cleanup.
- [x] Observe failures before implementation.
- [x] Share seed files and projections by source identity; reuse coordinator inventory without dropping worker/adoption validation.
- [x] Verify actual serial children, stale-seed rebuild and cancellation; compare bytes and source-walk counts with baseline.
- [x] Commit and ledger evidence.

## Task 3: Bounded common metadata sharing

**Files:** new `server/project_records.py`, `server/workspace_projects.py`, graph/catalog record helpers only as needed; test `python/tests/test_project_record_sharing.py`.

**Interfaces:** Workspace-owned `ProjectRecordPool` reuses equal immutable records while keeping mutable container owners separate; it forgets records not referenced by current installed profiles and clears at close.

- [x] Test equal and unequal fields/nodes/catalog descriptors, profile-specific runtime identity, edit isolation and generation release.
- [x] Observe missing sharing/retained-generation failures on baseline.
- [x] Intern only safe records, rebuilding profile containers without aliasing mutable lists/maps.
- [x] Run ownership/catalog/save controls and count unique record storage; report observed memory separately from exact physical peaks.
- [x] Commit and ledger evidence.

## Task 4: Validated multi-settings restart cache

**Files:** new `cache/projects.py`, `runtime/projects.py`, `server/project_daemon.py`, existing cache serialization helpers; tests `python/tests/test_project_runtime_cache.py`.

**Interfaces:** Cache load/save accept the settings plan and a current witness; restore `ProjectRuntime` pure records using the current shared static seed. No persisted pickle. Failed results are never reusable successes.

- [x] Add cold/restart parity tests, no-worker unchanged hit, source/settings/environment/interpreter/code/dependency misses, corrupt cache and cancelled/partial writer controls.
- [x] Observe cold-only baseline failure before implementation.
- [x] Implement atomic versioned JSON records and strict witnesses with bounded files; integrate early restore and existing clear-cache behavior.
- [x] Run real subprocess restart checks and compare warm latency and worker counts with cold baseline.
- [x] Commit and ledger evidence.

## Task 5: Completion audit and release

**Files:** task-owned benchmark runner/receipts, release notes and package version after validation.

- [x] Run the relevant Python suite on Django 5/6 and client/native regression controls, then the repository test entry points within available environments; report any unavailable or pre-existing failure explicitly.
- [x] Run controlled before/after workloads with identical inputs and current code provenance for all four requirements.
- [x] Verify all seven captain settings and native/editor startup without changing project/system configuration.
- [x] Request one fresh whole-branch review; address important findings with reproducing tests.
- [ ] Audit each design requirement, package source integrity, version, commit/push/release and published bytes; clean disposable task data with retention guards.
- [ ] Mark the goal complete only when all four optimizations and their validation are proven.
