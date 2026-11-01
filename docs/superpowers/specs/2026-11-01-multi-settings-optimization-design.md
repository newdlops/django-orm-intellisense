# Multi-settings runtime optimization

The user requested all four optimization opportunities identified after 0.2.2030: incremental publication/rebuild, less repeated source checking and worker transfer, less duplicate metadata, and validated persistent restart caches. All concrete settings must remain included. Existing automatic interpreter selection and project/source identities remain authoritative.

## Approach

Keep isolated serial registry workers. Share source-generation inputs and immutable records, retain complete per-settings semantics, and update only changed model contributions. Reuse the existing surface transport and client incremental-index machinery. Cache pure records with explicit source, interpreter, code, dependency and launch-environment witnesses; reject corrupt or stale entries and retry failed settings. Cached startup remains subject to current source validation.

Alternatives considered: parallel registry collection increases memory; collapsing equal INSTALLED_APPS is incorrect because settings can register different lookups or methods; retaining resident Django registries changes process ownership. None is needed. The chosen approach removes repeated work while retaining registry isolation.

## Requirements and acceptance evidence

1. Unchanged settings results and health-only changes retain the existing merged model rows and client/native indexes. Changed fields, members, lookups, additions and removals become visible with complete ownership and ambiguity behavior. Compare incremental results against a fresh full union.
2. A serial refresh writes a shared static seed once per source generation instead of once per settings profile. Reuse the coordinator's inventory; verify source identity before/after collection and before adoption. Changes, file membership edits, aliases, cancellation and generation replacement cannot adopt stale results. Count physical seed writes and transferred bytes in a controlled multi-settings fixture.
3. Equal immutable graph/field/member/lookup records share storage within a workspace; mutable profile owners and runtime identity stay separate. Pools release replaced generations and close. Verify isolation under edits and measure unique retained record counts and memory observations without forced GC.
4. An unchanged restart restores all successful settings from bounded, versioned, atomically written JSON caches. Validate current settings roster, sources, interpreter, launch environment, analysis code and dependency inputs before adoption. Changed configuration, same-size source replacement, dependency changes, corrupted/truncated cache, partial failure and cancelled writers must miss or retain a valid prior generation. Keep the existing explicit cache-clear command effective.
5. Run relevant Django 5/6 and client/native regression tests, one workload at a time; compare cold and repeated startup plus publication/memory costs with 0.2.2030. Do not claim a speedup from a source inspection alone. Preserve all seven captain settings and verify real-editor startup where available. Review the complete branch before release.

## Constraints

- Python 3.10 minimum and existing VS Code compatibility remain.
- All settings are included; one owned registry collector runs at a time.
- No administrator access, system path/security/VPN changes, autostart registration or separate resident service.
- No global GC policy changes or forced GC. Bound disk caches and workspace-owned pools.
- Preserve cancellation, request budgets, stopped sessions and source generation checks.
- Preserve unrelated untracked documentation and old release evidence. Retire only this task's disposable data after retention-policy checks.
- New dependency, Rust rebuild, or user-visible UI is unnecessary unless concrete evidence justifies it.

## Work organization

Implement sequentially on `perf/multi-settings-runtime`, using the existing checkout to avoid a duplicate working tree and dependency/build data. User authorization to process all four items is the execution instruction; no repeated scope approvals are needed. Keep a ledger for continuation and one independent whole-branch review. Release only after correctness and before/after evidence cover all four items.
