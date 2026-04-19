# Rust Migration — 성과 요약 (세션 4 종료 시점)

브랜치: `rust-migration` (main 분기, 커밋 없음). 모든 수치는 darwin-arm64, Rust 1.95, release 빌드.

## 핵심 성능 개선 (실측)

| 경로 | Python baseline (실측 로그) | Rust 현재 | 속도비 |
|-----|---------------------------|---------|-------|
| **resolveRelationTarget** (value="int") | 3084ms | **0.02ms** | **~150,000×** |
| **resolveRelationTarget** (value="Starting") | 953ms | **0.02ms** | **~48,000×** |
| **resolveLookupPath** (title__startswith) | 2623ms | **0.01ms** | **~260,000×** |
| **resolveOrmMember** (db.Company instance) | 288ms | **0.01ms** | **~29,000×** |
| **build_static_index** (1500 모델) | 359ms | 14.78ms | ~24× |
| **snapshot_python_sources** (1530 파일) | 38.3ms | 4.22ms | ~9× |
| **bincode cache load** (1500 모델, hit) | ~200ms | 0.87ms | ~200× |
| **End-to-end SurfaceIndex 생성** (1500 모델) | ~500-700ms | 148ms | ~3-4× |
| **surfaceIndex pre-warm** (실제 1156 모델) | 대기 구간 ~500ms | 379.7ms load+rebuild | 즉시 가용 |

## 사용자 체감 변화 (P8 완결 이후)

기존 로그에서 관찰된 지연들이 마이크로초 단위로:

- **Hover timeout (3초)** → 정적 멤버는 <1ms. `resolveOrmMember` fast-path.
- **Diagnostics 10초 예산 고갈 (90 requests)** → 요청당 마이크로초. 예산 여유.
- **Go-to-definition 1-3초 지연** → <1ms (정적 경로).
- **Completion 217ms** → 유지 (bulk 쿼리는 여전히 Python — 다른 ROI 낮음).
- **확장 첫 반응 3.3초** → 379ms (P8 최소 pre-warm에서 확인).

## Phase 현황 (최종)

| Phase | 상태 | 산출물 / 경계 |
|------|------|---------|
| P0 | ✅ | 베이스라인 캡처 |
| P1 | ✅ | Cargo 워크스페이스 + napi-rs + CI prebuild |
| P2 | ✅ | bincode 캐시 (mmap) + napi |
| P3 | ✅ | walkdir+rayon discovery, Python 핑거프린트 **바이트 동일** |
| P4.1 | ✅ | rustpython-parser AST + 모델/필드 추출 |
| P4.2 | ✅ | forward 해석 + reverse relation 합성 + 상속 기반 모델 확장 (reverse-import BFS) |
| P5 | ✅ | ModelGraph — forward/reverse 방향 구분, BFS |
| P6.1 | ✅ | lookup_paths 정적 해석 |
| P6.2 | ✅ (정적) | orm_members — surfaceIndex end-to-end 생성 (Python 데몬 불필요) |
| P7 | ✅ | django_builtins + relation_targets |
| P8 | ✅ **완결** | surfaceIndex pre-warm + **analysisDaemon fast-path 4종 주입** (resolveRelationTarget, resolveLookupPath, resolveOrmMember, listRelationTargets). Python은 runtime 경로 fallback 전용 |
| P9 | ✅ (skip) | 측정 기반 skip (hot path p95 = 0.008ms, 이미 한계) |

## P8에서 여전히 Python으로 라우팅되는 것 (의도된 경계)

- `lookupPathCompletions`, `ormMemberCompletions` — bulk 페이로드, Python 측 per-model 캐시가 이미 충분
- `resolveExportOrigin`, `resolveModule` — import alias resolution 미포팅
- `reindexFile`, `resolveOrmMemberBatch`, `resolveLookupPathBatch`
- 모든 runtime 의존 쿼리 (`register_lookup()` custom lookup, 동적 manager)

## Rust 라우팅 제어

- `analysisDaemon.startProcess()`에서 Python handshake 완료 직후 `ensureNativeFastPath()` 호출
- Rust resident state (static_index + model graph)를 background로 build — Python 대기 안 함
- 준비 실패 시 자동으로 Python 경로 유지 (disabled flag)
- `daemon.dispose()`에서 `dropNativeFastPath()` 호출해 메모리 해제

## 테스트/검증

- **Rust 단위 테스트: 44 passing**
- **napi E2E smoke 테스트 6종 (모두 통과):**
  - loader, cache, discovery, indexer, surface, **fastpath** (신규)
  - server-side nativeCache
- **TS 벤치마크 회귀**: median-of-5 기준 baseline 대비 회귀 0 (exit=0) × 3회 연속 확인
- **TS compile**: 전체 통과

## 추가 남은 옵션 (ROI 낮지만 가능)

1. **runtime inspector Rust 최적화**: 여전히 CPython 바인딩 필수이지만 PyO3로 startup 경량화 가능
2. **`lookupPathCompletions` Rust 이관**: 현재 Python 221ms / 3MB 페이로드. Rust에서 생성 시 ~50ms 가능
3. **`resolveExportOrigin` Rust**: import 체인 해석. 이미 `ImportBinding`을 Rust가 가지고 있어 포팅 가능
4. **Python 데몬 축소**: runtime inspector (687 LOC)만 남기고 나머지 제거. 메모리 ~80MB 절감
5. **TS hot path rkyv 시도**: 현재 <0.01ms라 스킵했으나 극한 최적화 시 재측정 가치

## 브랜치 상태

- 브랜치: `rust-migration` (main 기준 분기)
- **커밋 없음** — 사용자 요청 시에만 커밋
- 산출물:
  - `crates/core`, `crates/node` — Rust 워크스페이스
  - `native/<triple>/index.node` — 플랫폼별 바이너리 (gitignore)
  - `src/client/native/` — TS 로더 + 테스트
  - `src/client/daemon/nativeFastPath.ts` — P8 fast-path 래퍼 (신규)
  - `src/server/nativeCache.ts` — surfaceIndex 영속화
  - `src/server/server.ts` — onInitialized pre-warm 훅 (수정)
  - `src/client/daemon/analysisDaemon.ts` — 4개 메서드에 fast-path 주입 (수정)
  - `bench/` — 모든 벤치 결과와 SUMMARY
- `.vscodeignore`로 `crates/`, `Cargo.toml/lock`, `bench/`, `target/` VSIX 제외
