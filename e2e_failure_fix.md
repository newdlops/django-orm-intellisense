# E2E 테스트 실패 수정 전략

## 현황
- 16개 테스트 실패 (원본 코드에서도 동일하게 실패)
- 모든 실패: `waitForDiagnostics timed out after 10000ms`
- ORM diagnostic이 10초 내에 도착하지 않음

## 실패 테스트 목록
1. resolves runtime-backed reverse lookup paths with non-literal related_name
2. resolves reverse lookup paths when Meta.app_label overrides the module root
3. supports values_list, prefetch_related, only, and defer string paths
4. supports reverse related_query_name lookups without leaking into relation-only paths
5. resolves runtime-backed custom fields in keyword lookups
6. supports foreign key attname aliases in keyword lookups
7. supports Q and F expression lookup references across queryset methods
8. supports create, update, get_or_create, and update_or_create field contexts
9. propagates write-method results and bulk_update field lists
10. skips diagnostics for dynamic unpacked dict lookup keys
11. supports annotate expressions and annotated instance members in advanced fixture project
12. supports relation-valued OuterRef field paths in subqueries
13. supports captain-style aggregate and window expression field paths
14. supports captain-style keyword and later-argument expression field paths
15. supports dotted and variant captain expression field paths
16. reports diagnostics for invalid ORM lookup paths

## 테스트 파일 분석
- `fixtures/minimal_project/blog/query_examples.py`: 303줄, 135개 ORM 패턴
- 테스트 구조: completion/hover/definition 확인 → `waitForDiagnostics` (10초 타임아웃)
- `waitForDiagnostics`: 200ms 간격 폴링, predicate 매칭 대기

## 원인 분석

### Diagnostic 파이프라인 병목
1. **Async scan yield** — `findLookupDiagnosticContexts`가 50줄마다 `setTimeout(0)` yield
2. **Deferred validation** — 각 lookup context의 `querysetStringCallContext` 등을 batch(5개)마다 yield
3. **IPC 호출** — 각 context마다 `resolveLookupReceiverInfoForReceiver` + `resolveLookupPath` = 2+ IPC
4. **Diagnostic deadline** — `DIAGNOSTIC_TIME_BUDGET_MS = 8000ms`
5. **Request budget** — `DIAGNOSTIC_REQUEST_BUDGET = 60`
6. **`daemon.isAborted()` guard** — 82개 resolve 함수에 deadline 체크 → diagnostic resolution 중단 가능

### 핵심 문제
- 135개 ORM 패턴 × deferred validation + IPC = budget(60 requests) 소진
- Budget 소진 후 남은 diagnostic 미생성
- `daemon.withDeadline`로 인해 resolve 함수가 8초 후 모두 bail out

## 수정 전략

### 1. 작은 파일 최적화 (우선순위: 높음)
- 500줄 미만 파일: scan yield 생략 (동기 scan이 충분히 빠름)
- 테스트 파일(303줄)은 이 범주에 해당

### 2. Budget 동적 조정 (우선순위: 높음)
- 파일 크기에 비례하여 budget 조정
- 작은 파일: request budget 증가 (60 → 200)
- 큰 파일(1000줄+): 현재 budget 유지

### 3. Deferred validation batch 크기 증가 (우선순위: 중간)
- VALIDATION_BATCH_SIZE: 5 → 15
- 작은 파일에서는 yield 횟수 감소

### 4. Deadline 조정 (우선순위: 중간)
- `DIAGNOSTIC_TIME_BUDGET_MS`: 8000 → 10000 (테스트 타임아웃과 동일)
- 또는 테스트에서 타임아웃을 15초로 증가

### 5. `findDirectFieldDiagnosticContexts` 필터 확인 (우선순위: 낮음)
- `.create()`/`.update()` line filter가 테스트 패턴을 놓치지 않는지 검증
- 테스트 파일의 create/update 패턴 확인

## 구현 순서
1. Budget/deadline 조정 (가장 빠른 효과)
2. 작은 파일 최적화 (scan yield 조건부 생략)
3. Batch size 조정
4. 테스트 실행 및 검증
