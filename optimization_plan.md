# Django ORM Intellisense — Production Architecture Plan

> 1000개가 넘어가면 "파싱 알고리즘"보다 "증분 인덱싱 아키텍처"가 답이고,
> hot path를 절대 전체 프로젝트 스캔과 연결하면 안 된다.

---

## [1] Recommended Final Architecture

```
┌─────────────────────────────────────────────────────────┐
│  VS Code Extension Host (최소 로직)                      │
│  extension.ts                                           │
│    └─ vscode-languageclient → LSP client                │
│    └─ activation / settings / watcher registration      │
└───────────────┬─────────────────────────────────────────┘
                │  LSP (JSON-RPC over stdio/pipe)
┌───────────────▼─────────────────────────────────────────┐
│  Language Server (별도 Node.js 프로세스)                   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ WorkspaceIndexer          (cold path, 초기+증분) │    │
│  │  ├─ AST-based model/field/relation scanner      │    │
│  │  ├─ import resolver (workspace + .venv)          │    │
│  │  └─ file watcher handler                        │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ DependencyIndexer         (.venv, lazy on-demand)│    │
│  │  ├─ site-packages resolver                      │    │
│  │  ├─ .pyi / .py / editable install scanner       │    │
│  │  └─ dependency module cache                     │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ WorkspaceIndex            (in-memory)            │    │
│  │  ├─ models: Map<label, ModelInfo>               │    │
│  │  ├─ perFile: Map<uri, FileIndexEntry>           │    │
│  │  ├─ deps: Map<module, DependencyModuleEntry>    │    │
│  │  └─ fieldTrie / lookupTrie (RadixTrie)          │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ CurrentDocumentResolver   (hot path)             │    │
│  │  ├─ __ segment parser (FSM)                     │    │
│  │  ├─ index lookup (O(1) per segment)             │    │
│  │  └─ trie prefix search (O(k) k=prefix length)  │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ CompletionEngine                                 │    │
│  │  ├─ ranking (recency, frequency, builtin-first) │    │
│  │  ├─ prefix match + fuzzy fallback               │    │
│  │  └─ cancellation-aware                          │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Python Daemon              (cold path only)      │    │
│  │  ├─ runtime _meta (정밀 fallback)                │    │
│  │  ├─ register_lookup() discovery                 │    │
│  │  └─ cross-module inheritance resolution         │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 책임 분리

| 컴포넌트 | 책임 | 실행 시점 |
|----------|------|----------|
| Extension Host | activation, settings, watcher 등록, LSP client | extension load |
| Language Server | 모든 분석/완성 로직 | 별도 프로세스 |
| WorkspaceIndexer | 모델/필드/관계 정적 인덱스 구축+증분 | cold: 초기. warm: 파일 변경 |
| DependencyIndexer | .venv site-packages lazy 인덱싱 | cold: 초기(최소). warm: import 시 on-demand |
| WorkspaceIndex | 메모리 인덱스 + RadixTrie | 항상 메모리 상주 |
| CurrentDocumentResolver | __ 세그먼트 파싱, 인덱스 조회 | hot: 타이핑마다 |
| CompletionEngine | 후보 정렬, prefix match, 반환 | hot: completion 요청마다 |
| Python Daemon | 런타임 _meta, custom lookup 감지 | cold path only |

---

## [2] Why This Architecture

| 대안 | 문제 | 이 아키텍처의 해결 |
|------|------|-------------------|
| 매 completion마다 전체 프로젝트 reparse | O(N) per keystroke, 11858 파일에서 16초 | 증분 인덱스 + hot path는 인덱스 조회만 |
| runtime-only Django introspection | Django import 필요, 느림, 편집기 hot path에 부적합 | 정적 인덱스 기본, runtime은 cold fallback only |
| 무겁고 범용적인 AST parser | 모든 파일 매번 full parse | 변경 파일만 증분 AST, 나머지는 캐시 |
| 일반 HashMap completion | prefix search 비효율 | Compressed Radix Trie로 O(k) prefix search |
| .venv 전체 eager indexing | 수만 파일, GB 단위 메모리 | lazy on-demand: import된 모듈만 인덱싱 |
| extension host에서 직접 분석 | Pylance/mypy와 CPU 경합, UI 블로킹 | Language Server 별도 프로세스 격리 |

---

## [3] Performance Model

### Path별 시간 복잡도

| Path | 트리거 | 비용 | 목표 |
|------|--------|------|------|
| **Cold start** | extension 활성화 | O(F) F=workspace 파일 수 | <2s (캐시 히트 <500ms) — **실측: 1.03s (11853 파일 캐시 hit)** |
| **Warm: file save** | didSave | O(1) 해당 파일만 reindex | <50ms per file |
| **Hot: typing** | 키 입력마다 | O(S×L) S=세그먼트 수, L=lookup 후보 수 | <10ms |
| **File create/delete** | watcher | O(1) 인덱스 추가/제거 | <20ms |
| **.venv discovery** | 초기화 1회 | O(1) pyvenv.cfg 파싱 | <5ms |
| **Dependency on-demand** | import 해석 시 | O(M) M=모듈 내 클래스 수 | <100ms per module |

### 메모리 전략

| 데이터 | 크기 (1000 모델 기준) | 전략 |
|--------|---------------------|------|
| WorkspaceIndex models | ~2MB | 항상 메모리 |
| Per-file cache | ~500KB | 열린 파일만 상세, 나머지 최소 메타 |
| Dependency cache | ~1MB (lazy) | import된 모듈만 |
| RadixTrie (fields) | ~500KB | 모델별 trie, lazy 생성 |
| RadixTrie (lookups) | ~50KB | 전역 1개, 정적 |
| Python daemon | 별도 프로세스 | cold path에만 사용 |

### 병목과 회피

| 병목 | 원인 | 회피 |
|------|------|------|
| 초기 스캔 | 11858개 파일 AST 파싱 | 파일별 캐시 + directory fingerprint |
| daemon IPC | JSON-RPC 왕복 500ms~2s | hot path에서 IPC 제거, 로컬 인덱스만 |
| .venv 스캔 | 수만 파일 | lazy: import된 모듈만 on-demand |
| 큰 모델 surface | 100+ reverse relations | per-model trie + dict cache |

---

## [4] Django Lookup Parsing Algorithm

### FSM (Finite State Machine)

```
입력: "author__profile__name__icontains"
세그먼트: ["author", "profile", "name", "icontains"]

States:
  EXPECT_FIELD_OR_RELATION  → 필드/관계 이름 기대
  EXPECT_TRANSFORM_OR_LOOKUP → transform 또는 최종 lookup 기대
  COMPLETE                   → 최종 lookup 확정
  ERROR                      → 해석 불가

Transitions:
  EXPECT_FIELD_OR_RELATION + segment:
    if segment in model.fields → EXPECT_FIELD_OR_RELATION (scalar)
                               → EXPECT_TRANSFORM_OR_LOOKUP (if leaf)
    if segment in model.relations → EXPECT_FIELD_OR_RELATION (follow FK)
    if segment in model.reverseRelations → EXPECT_FIELD_OR_RELATION (follow reverse)
    else → ERROR

  EXPECT_TRANSFORM_OR_LOOKUP + segment:
    if segment in field.transforms → EXPECT_TRANSFORM_OR_LOOKUP (chain)
    if segment in field.lookups → COMPLETE
    else → ERROR (suggest closest match)

  End of input:
    if state == EXPECT_FIELD_OR_RELATION → implicit exact
    if state == EXPECT_TRANSFORM_OR_LOOKUP → implicit exact
    if state == COMPLETE → done
```

### 구현 인터페이스

```typescript
interface ParsedLookup {
  segments: string[];
  resolvedPath: ResolvedSegment[];
  finalField?: FieldInfo;
  finalLookup?: string;
  state: 'complete' | 'partial' | 'error';
  errorAt?: number;
  suggestions?: string[];
}

interface ResolvedSegment {
  name: string;
  kind: 'field' | 'relation' | 'reverse_relation' | 'transform' | 'lookup';
  modelLabel?: string;
  fieldInfo?: FieldInfo;
}

interface ResolutionState {
  currentModel: string;
  currentField?: FieldInfo;
  position: number;
  fsmState: 'EXPECT_FIELD_OR_RELATION' | 'EXPECT_TRANSFORM_OR_LOOKUP' | 'COMPLETE' | 'ERROR';
}
```

### 에러 복구 + 오타 교정

```typescript
function suggestCorrections(segment: string, candidates: string[]): string[] {
  // 1. prefix match
  const prefixMatches = candidates.filter(c => c.startsWith(segment));
  if (prefixMatches.length > 0) return prefixMatches;

  // 2. Levenshtein distance <= 2
  return candidates
    .map(c => ({ name: c, dist: levenshtein(segment, c) }))
    .filter(c => c.dist <= 2)
    .sort((a, b) => a.dist - b.dist)
    .map(c => c.name);
}
```

---

## [5] Completion Algorithm

### Hot Path Flow

```
1. 커서 위치에서 현재 lookup 문자열 추출
   예: .filter(author__profile__name__ico|)
   → prefix = "author__profile__name__ico"

2. __ 로 split → segments = ["author", "profile", "name", "ico"]
   → resolved = ["author", "profile", "name"], partial = "ico"

3. FSM으로 resolved segments 해석
   → author(FK→User) → profile(FK→Profile) → name(CharField)

4. 현재 상태 판단
   → CharField의 lookups/transforms에서 "ico" prefix search

5. RadixTrie.prefixSearch("ico")
   → ["icontains", "iexact", "in", "isnull", "istartswith"]

6. 랭킹:
   - exact match > prefix match > fuzzy match
   - builtin lookup > custom lookup
   - 최근 사용 가중치
   - 빈도 기반 정렬

7. CompletionItem[] 반환
```

### 랭킹 전략

```typescript
function rankCandidates(
  candidates: PrefixCandidate[],
  prefix: string,
  recentUsage: Map<string, number>
): PrefixCandidate[] {
  return candidates.sort((a, b) => {
    // 1. exact prefix match first
    const aPrefix = a.name.startsWith(prefix) ? 0 : 1;
    const bPrefix = b.name.startsWith(prefix) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;

    // 2. builtin > custom
    const aBuiltin = a.source === 'builtin' ? 0 : 1;
    const bBuiltin = b.source === 'builtin' ? 0 : 1;
    if (aBuiltin !== bBuiltin) return aBuiltin - bBuiltin;

    // 3. recency
    const aRecent = recentUsage.get(a.name) ?? 0;
    const bRecent = recentUsage.get(b.name) ?? 0;
    if (aRecent !== bRecent) return bRecent - aRecent;

    // 4. alphabetical
    return a.name.localeCompare(b.name);
  });
}
```

---

## [6] .venv Traversal Strategy

### 감지

```typescript
async function detectVenv(workspaceRoot: string): Promise<VenvInfo | undefined> {
  // 1. 설정에서 명시된 경로
  // 2. .venv, venv, .env 디렉토리 탐색
  // 3. pyvenv.cfg 파싱 → home, include-system-site-packages
  // 4. lib/pythonX.Y/site-packages 경로 확인
}

interface VenvInfo {
  root: string;
  sitePackages: string;
  pythonVersion: string;
  includeSystemSite: boolean;
}
```

### Lazy On-Demand 전략

```
.venv 인덱싱 규칙:

절대 하지 않는 것:
  ✗ .venv 전체 재귀 스캔
  ✗ 모든 패키지 AST 파싱
  ✗ hot path에서 .venv 파일 I/O

초기화 시 (eager, 1회):
  ✓ site-packages 최상위 디렉토리 목록만 수집 (~100ms)
  ✓ django, djangorestframework 등 알려진 패키지 감지
  ✓ editable install (.egg-link, .pth) 경로 수집

On-demand (lazy, import 시):
  ✓ import 해석 시 해당 모듈만 인덱싱
  ✓ 모델 정의가 있는 모듈만 상세 분석
  ✓ 나머지는 심볼 목록만 수집

캐시:
  ✓ 모듈별 개별 캐시
  ✓ 패키지 버전 기반 무효화
  ✓ workspace 캐시와 분리 저장
```

### .pyi vs .py vs runtime 우선순위 — Stub 경합 문제

#### 문제: Stub이 실제 소스보다 정보가 적은 경우

django-stubs, Pylance 내장 stub, Python extension의 bundled stub은 일반적인 타입 추론에는 유용하지만,
**Django ORM 필드/관계/lookup 분석에서는 실제 .py 소스보다 정보가 부족한 경우가 많다.**

```
django-stubs의 Manager.create() 시그니처:
  def create(self, **kwargs: Any) -> _T     ← generic, 구체 모델 타입 바인딩 안 됨

실제 Django .py 소스의 QuerySet.create():
  런타임에서 self.model로 인스턴스 생성   ← 정적 분석으로 모델 타입 추론 가능

Pylance가 보여주는 결과:
  company_question_thread: _BaseQuerySet.create(...)  ← 전체 표현식이 타입으로 추론됨
```

Stub이 "이기는" 경우:
- Pylance/mypy가 .pyi를 .py보다 우선하여 타입 정보를 축약된 generic으로 보여줌
- `Manager[_T]`, `QuerySet[_T]`의 generic `_T`가 구체 모델로 바인딩되지 않음
- `create()`, `get()`, `first()` 등의 반환 타입이 실제 모델이 아닌 generic으로 표시
- related manager (`question_thread_set`)가 stub에서는 `RelatedManager[Any]`로 축약

#### 이 extension의 전략: 용도별 소스 선택

| 용도 | 우선순위 | 이유 |
|------|---------|------|
| **모델/필드/관계 발견** | **.py > .pyi** | stub은 필드 정의를 축약하거나 생략. 실제 소스가 ForeignKey, CharField 등의 정확한 인자를 포함 |
| **필드 타입 분류** | **.py > .pyi** | `models.CharField(max_length=100)` 같은 정보는 .py에만 있음 |
| **reverse relation 이름** | **.py only** | `related_name='question_thread_set'`은 stub에 없음 |
| **lookup/transform 등록** | **.py only** | `register_lookup()`은 stub에 반영 안 됨 |
| **custom manager/queryset 메서드** | **.py > .pyi** | stub은 custom 메서드의 반환 타입을 모르거나 Any로 처리 |
| **일반 타입 어노테이션** | .pyi > .py | 파라미터/반환 타입 힌트는 stub이 더 정확할 수 있음 |
| **compiled package** | .pyi > runtime | 소스 없을 때 stub이 유일한 정적 정보 |
| **editable install** | 원본 .py | .egg-link → 실제 워크스페이스 경로 추적 |

#### 구현: Stub 우회 전략

```typescript
interface SourceResolution {
  pyPath?: string;      // 실제 .py 소스 경로
  pyiPath?: string;     // .pyi stub 경로
  source: 'py' | 'pyi' | 'runtime';
}

function resolveModuleSource(
  moduleName: string,
  sitePackages: string,
  stubPaths: string[]    // django-stubs, Pylance stubs 등
): SourceResolution {
  const pyPath = findPySource(moduleName, sitePackages);
  const pyiPath = findPyiStub(moduleName, stubPaths);

  // Django ORM 분석에서는 .py를 우선
  // 이유: stub은 필드 정의, related_name, register_lookup 등을 포함하지 않음
  if (pyPath) {
    return { pyPath, pyiPath, source: 'py' };
  }
  if (pyiPath) {
    return { pyiPath, source: 'pyi' };
  }
  return { source: 'runtime' };
}
```

#### Stub 충돌 방지: excludeDjangoStubs

현재 코드에 이미 `excludeDjangoStubs.ts`가 존재 — Pylance의 django-stubs 경로를
`python.analysis.exclude`에 추가하여 Pylance가 stub 대신 실제 소스를 참조하도록 함.

이 전략을 확장:
- django-stubs의 models/, db/, forms/ 등 ORM 관련 stub만 선택적 제외
- 나머지 Django stub (template, http, utils 등)은 Pylance가 사용하도록 유지
- third-party stub (djangorestframework-stubs 등)도 ORM 관련 부분만 제외

#### 핵심: 이 extension은 stub이 아닌 실제 소스에서 인덱스를 구축

```
Pylance의 역할: 일반 Python 타입 추론, 코드 내비게이션, 에러 진단
이 extension의 역할: Django ORM 필드/관계/lookup 전문 분석

→ Pylance는 stub을 사용해도 됨 (일반 타입 추론에 적합)
→ 이 extension은 stub을 무시하고 .py 소스에서 직접 인덱스를 구축
→ 두 extension이 각자의 강점을 활용하여 상호 보완
```

### 메모리 격리

```typescript
interface DependencyIndex {
  modules: Map<string, DependencyModuleEntry>;
  venvFingerprint: string;  // .venv 변경 감지용
}

interface DependencyModuleEntry {
  modulePath: string;
  packageName: string;
  packageVersion?: string;
  models: ModelInfo[];
  exportedSymbols: string[];
  indexedAt: number;
  source: 'pyi' | 'py' | 'runtime';
}
```

---

## [7] Compressed Radix Trie Design

### Why Compressed Radix Trie

일반 Trie: 각 문자가 노드 → `icontains`에 10개 노드
Compressed Radix Trie: 공통 접두사를 엣지에 압축 → `icontains`가 단일 엣지

1148 모델 × 평균 20 필드 = ~23000 필드명에서 메모리 50% 이상 절약.

### 노드 구조

```typescript
interface RadixTrieNode<T> {
  children: Map<string, RadixTrieEdge<T>>;  // edge label → child
  payload?: T;          // terminal node의 데이터
  isTerminal: boolean;
}

interface RadixTrieEdge<T> {
  label: string;        // 압축된 엣지 문자열 (1글자 이상)
  child: RadixTrieNode<T>;
}

class CompressedRadixTrie<T> {
  private root: RadixTrieNode<T> = { children: new Map(), isTerminal: false };

  insert(key: string, payload: T): void { /* ... */ }
  search(key: string): T | undefined { /* ... */ }
  prefixSearch(prefix: string, limit?: number): Array<{ key: string; payload: T }> { /* ... */ }
  delete(key: string): boolean { /* ... */ }

  // 압축: 단일 자식 노드 체인을 하나의 엣지로 병합
  private compress(node: RadixTrieNode<T>): void { /* ... */ }
}
```

### Trie 분리 전략

| Trie | 내용 | 크기 | 생명주기 |
|------|------|------|---------|
| **모델별 field trie** | 각 모델의 필드명+역참조명 | ~50 entries/model | 모델 변경 시 재구축 |
| **전역 lookup trie** | Django 기본+커스텀 lookups | ~30 entries | 거의 불변 |
| **전역 transform trie** | year, month, lower 등 | ~15 entries | 거의 불변 |
| **dependency symbol trie** | .venv 패키지 모델/필드 | lazy 생성 | 패키지 변경 시 |

---

## [8] Data Structures

```typescript
// === Workspace Index ===

interface WorkspaceIndex {
  models: Map<string, ModelInfo>;
  perFile: Map<string, FileIndexEntry>;
  modelLabelByName: Map<string, string>;
  fieldTrieByModel: Map<string, CompressedRadixTrie<FieldInfo>>;
  lookupTrie: CompressedRadixTrie<LookupInfo>;
  transformTrie: CompressedRadixTrie<TransformInfo>;
}

interface FileIndexEntry {
  uri: string;
  version: number;
  fingerprint: string;
  exportedModels: string[];
  importedSymbols: Map<string, string>; // alias → module.symbol
  containsModelDefs: boolean;
}

// === Dependency Index ===

interface DependencyIndex {
  modules: Map<string, DependencyModuleEntry>;
  venvRoot: string;
  sitePackagesPath: string;
  venvFingerprint: string;
}

interface DependencyModuleEntry {
  modulePath: string;
  packageName: string;
  packageVersion?: string;
  models: ModelInfo[];
  exportedSymbols: string[];
  indexedAt: number;
  source: 'pyi' | 'py' | 'runtime';
}

// === Model / Field / Relation ===

interface ModelInfo {
  label: string;              // "db.Company"
  objectName: string;         // "Company"
  module: string;             // "zuzu.db.models.company.company"
  filePath: string;
  fields: Map<string, FieldInfo>;
  relations: Map<string, RelationInfo>;
  reverseRelations: Map<string, RelationInfo>;
  managers: Map<string, ManagerInfo>;
  isAbstract: boolean;
  baseLabels: string[];
}

interface FieldInfo {
  name: string;
  fieldKind: string;          // "CharField", "IntegerField", "ForeignKey"
  isRelation: boolean;
  lookups: string[];          // ["exact", "icontains", ...]
  transforms: string[];       // ["lower", "upper", "year", ...]
}

interface RelationInfo {
  name: string;
  fieldKind: string;          // "ForeignKey", "OneToOneField", "ManyToManyField"
  targetModelLabel: string;
  relatedName?: string;
  direction: 'forward' | 'reverse';
}

interface ManagerInfo {
  name: string;
  querysetMethods: string[];
}

// === Lookup / Transform ===

interface LookupInfo {
  name: string;
  applicableFieldKinds: string[];   // ["CharField", "TextField", ...]
  source: 'builtin' | 'custom';
  description?: string;
}

interface TransformInfo {
  name: string;
  outputFieldKind: string;          // transform 후 필드 타입
  applicableFieldKinds: string[];
  source: 'builtin' | 'custom';
}

// === Resolution ===

interface ParsedLookup {
  segments: string[];
  resolvedPath: ResolvedSegment[];
  finalField?: FieldInfo;
  finalLookup?: string;
  state: 'complete' | 'partial' | 'error';
  errorAt?: number;
  suggestions?: string[];
}

interface ResolvedSegment {
  name: string;
  kind: 'field' | 'relation' | 'reverse_relation' | 'transform' | 'lookup';
  modelLabel?: string;
  fieldInfo?: FieldInfo;
}

// === Completion ===

interface CompletionContext {
  documentUri: string;
  position: { line: number; character: number };
  currentModel: string;
  parsedLookup: ParsedLookup;
  partialSegment: string;
}

interface PrefixCandidate {
  name: string;
  kind: 'field' | 'relation' | 'lookup' | 'transform';
  detail: string;
  source: 'builtin' | 'custom' | 'workspace' | 'dependency';
  sortPriority: number;
}

// === Cache Keys ===

interface ResolverCacheKey {
  modelLabel: string;
  lookupChain: string;  // "author__profile__name"
}

interface CompletionCacheKey {
  modelLabel: string;
  resolvedPrefix: string;
  partialSegment: string;
}

interface DependencyCacheKey {
  modulePath: string;
  packageVersion: string;
}

// === Radix Trie ===

interface RadixTrieNode<T> {
  children: Map<string, { label: string; child: RadixTrieNode<T> }>;
  payload?: T;
  isTerminal: boolean;
}
```

---

## [9] Indexing Strategy

### 초기 워크스페이스 스캔

```
1. manage.py에서 DJANGO_SETTINGS_MODULE 감지
2. 워크스페이스 Python 파일 목록 수집 (.venv, __pycache__ 등 제외)
3. 디렉토리 fingerprint 기반 캐시 히트 확인
4. 변경된 파일만 AST 파싱:
   - class 정의에서 models.Model 상속 탐지
   - cross-module 상속 (_expand_model_candidates_via_imports)
   - 필드 정의 추출 (ForeignKey, CharField, etc.)
   - related_name 파싱
   - Meta.app_label 추출
5. 모델 메타데이터를 WorkspaceIndex에 적재
6. 모델별 field RadixTrie 구축
7. 캐시 저장 (파일별 fingerprint 포함)
```

### 증분 인덱싱 (파일 변경 시)

```
1. didSave 이벤트 → 해당 파일만 재분석
2. 이전 FileIndexEntry와 비교:
   - exportedModels 변경 → 관련 모델 재구축
   - importedSymbols 변경 → 의존 모델 확인
   - 변경 없음 → skip
3. 영향받는 모델의 field trie만 재구축
4. 역참조에 영향받는 다른 모델도 갱신
```

### Import 해석 전략

```
우선순위:
1. 같은 파일 내 정의
2. 워크스페이스 내 import 해석 (FileIndexEntry.exportedSymbols)
3. .venv site-packages (DependencyIndex, lazy on-demand)
4. runtime fallback (Python daemon, cold path only)
```

---

## [10] Invalidation Rules

| Event | WorkspaceIndex | DependencyIndex | RadixTrie | PerFileCache | CompletionCache |
|-------|---------------|-----------------|-----------|-------------|-----------------|
| **File edited** (unsaved) | - | - | - | 해당 파일 무효화 | 해당 파일 무효화 |
| **File saved** | 해당 모델 갱신 | - | 해당 모델 trie 재구축 | 해당 파일 갱신 | 전체 무효화 |
| **File created** | 새 모델 추가 (있으면) | - | 새 trie 추가 | 새 entry 추가 | 전체 무효화 |
| **File deleted** | 해당 모델 제거 | - | 해당 trie 제거 | entry 제거 | 전체 무효화 |
| **File renamed** | delete + create | - | delete + create | delete + create | 전체 무효화 |
| **Import changed** | 의존 모델 확인 | on-demand 트리거 | 영향 모델 갱신 | 해당 파일 갱신 | 전체 무효화 |
| **Model field 변경** | 해당 모델 갱신 | - | 해당 trie 재구축 | - | 전체 무효화 |
| **register_lookup() 변경** | custom lookup 갱신 | - | lookup trie 갱신 | - | 전체 무효화 |
| **Interpreter 변경** | 전체 재구축 | 전체 재구축 | 전체 재구축 | 전체 무효화 | 전체 무효화 |
| **.venv 재생성** | - | 전체 재구축 | dependency trie 재구축 | - | 전체 무효화 |
| **Package install/remove** | - | 해당 패키지 재인덱싱 | 해당 trie 갱신 | - | 전체 무효화 |

---

## [11] VS Code + LSP Implementation Plan

### Extension Activation

```typescript
// extension.ts
export function activate(context: vscode.ExtensionContext) {
  const serverModule = context.asAbsolutePath('out/server/server.js');
  const client = new LanguageClient('django-orm-ls', serverOptions, clientOptions);

  // watcher: workspace Python 파일만 (단순 glob)
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/*.py',
    false, false, false
  );
  // .venv, __pycache__, node_modules 등은 files.watcherExclude로 제외

  client.start();
}
```

### Language Server Lifecycle

```
startup:
  1. initialize → workspace root, settings 수신
  2. .venv 감지 → site-packages 경로 확인
  3. 캐시 로드 시도
  4. 워크스페이스 초기 스캔 (background, progress 보고)
  5. RadixTrie 구축
  6. initialized 응답

didOpen:
  → PerFileCache 확인, 없으면 파일 분석
  → import 해석 → dependency on-demand 인덱싱

didChange:
  → incremental sync → 해당 파일 PerFileCache만 무효화
  → 모델 정의 변경 감지 시 WorkspaceIndex 증분 갱신

didSave:
  → 파일 재분석 → 인덱스 갱신 → 캐시 저장

completion:
  → CurrentDocumentResolver로 context 추출
  → FSM으로 lookup chain 해석
  → RadixTrie prefix search
  → CompletionEngine 랭킹
  → CompletionItem[] 반환

cancellation:
  → 모든 async 작업에 CancellationToken 전파
  → background indexing은 별도 취소 가능
```

---

## [12] File Layout

```
src/
├── extension.ts                  # VS Code extension entry
├── server/
│   ├── server.ts                 # Language Server entry (LSP)
│   ├── workspaceIndexer.ts       # 워크스페이스 초기/증분 인덱서
│   ├── dependencyIndexer.ts      # .venv lazy 인덱서
│   ├── djangoModelScanner.ts     # AST 기반 모델/필드 스캐너
│   ├── importResolver.ts         # import 해석 (workspace + .venv)
│   ├── lookupResolver.ts         # __ 세그먼트 FSM 파서
│   ├── completionProvider.ts     # LSP completion handler
│   ├── radixTrie.ts              # Compressed Radix Trie
│   ├── cache.ts                  # 파일별/모델별 캐시 관리
│   ├── ranking.ts                # 완성 후보 랭킹
│   ├── invalidation.ts           # 무효화 규칙 엔진
│   └── types.ts                  # 모든 인터페이스/타입
├── python/
│   └── daemon/                   # Python runtime fallback (기존)
└── test/
    ├── radixTrie.test.ts
    ├── lookupResolver.test.ts
    └── workspaceIndexer.test.ts
```

---

## [13] Benchmarks and Performance Budget

| Metric | 1K files | 5K files | 10K files | Target | Phase 0 실측 (11853 files) |
|--------|----------|----------|-----------|--------|---------------------------|
| Cold start (no cache) | <1s | <3s | <5s | acceptable | 5.44s (1차, surface miss) |
| Cold start (cached) | <200ms | <500ms | <1s | good | **1.03s** (전체 캐시 hit) ✓ |
| Single file reindex | <20ms | <20ms | <20ms | O(1) | (Phase 1) |
| Dependency module index | <100ms | <100ms | <100ms | per module | (Phase 2) |
| Completion p50 | <5ms | <5ms | <5ms | O(k) | 0ms (no context 시) |
| Completion p95 | <15ms | <20ms | <25ms | acceptable | (측정 예정) |
| Memory (workspace) | <10MB | <30MB | <50MB | proportional | — |
| Memory (dependencies) | <5MB | <5MB | <5MB | lazy, capped | (Phase 2) |
| .venv discovery | <5ms | <5ms | <5ms | O(1) | — |
| LS buildWorkspaceIndex | — | — | — | <50ms | **9-38ms** ✓ |
| didChange burst skip | — | — | — | 무폭주 | **6 events skipped** ✓ |

### Phase 0 실측 상세 (11853 파일, 1139 모델, macOS APFS)

```
                              1차 실행 (surface miss)    2차 실행 (전체 캐시 hit)
snapshot_python_sources       0.87s                      0.46s
discover_workspace            0.01s                      0.00s
load_cached_static_index      0.60s (full)               0.43s (full)
load_cached_runtime           0.09s                      0.07s
surface_index                 3.87s (prebuild, miss)     0.07s (캐시 hit)
합계                          5.44s                      1.03s
```

### 벤치마크 분리

```
workspace 비용:  time(initialScan) + time(incrementalUpdate) + memory(workspaceIndex)
dependency 비용: time(onDemandIndex) + memory(dependencyIndex)
hot path 비용:   time(segmentParse) + time(trieLookup) + time(ranking)

각각 독립적으로 측정하여 병목 식별
```

---

## [14] Step-by-Step Implementation Roadmap

### Phase 0: MVP ✅ 완료

```
목표: Language Server 분리 + 기본 인덱스 + __ 파서 + 초기 로딩 최적화
구현:
  ✓ vscode-languageserver 기반 서버 스켈레톤
  ✓ 기존 surfaceIndex를 WorkspaceIndex 형태로 마이그레이션
  ✓ __ 세그먼트 FSM 파서
  ✓ RadixTrie 기본 구현
  ✓ snapshot_python_sources 병렬화 (ThreadPoolExecutor 8 workers)
  ✓ StaticIndex 전체 디스크 캐싱 (static-index-full.json, fingerprint 일치 시 즉시 복원)
  ✓ surface_index 디스크 캐싱 (surface-index.json, prebuild 완전 스킵)
  ✓ didChange 초기 동기화 burst detection (고정 grace period → 빈도 기반 감지)
  □ completion에서 daemon IPC 완전 제거
결과: hot path <50ms, cold start 캐시 hit 시 1.03s (11853 파일, 1139 모델)
```

#### Phase 0 초기 로딩 병목 분석

**전체 시퀀스 (직렬 실행, 모두 blocking)**

```
┌─ VS Code Extension Activation ────────────────────────────────────────────┐
│                                                                           │
│  1. activate()                                              ~50ms        │
│     ├─ AnalysisDaemon 생성                                               │
│     ├─ HealthStatusView, HealthDiagnostics 생성                           │
│     ├─ 5개 command 등록                                                   │
│     ├─ registerPythonProviders                                            │
│     ├─ excludeDjangoStubsFromPylance (async, non-blocking)               │
│     └─ normalizePythonInterpreterSettings (async, non-blocking)          │
│                                                                           │
│  2. LanguageClient 시작                                     ~100ms       │
│     ├─ LanguageClient(serverModule, IPC) 생성                             │
│     ├─ languageClient.start() → server.ts 프로세스 spawn                  │
│     └─ feedSurfaceIndexToServer() 콜백 등록                               │
│                                                                           │
│  3. daemon.start() (autoStart=true && python 파일 열림 시)                │
│     ├─ resolvePythonInterpreter()                           ~50ms        │
│     ├─ buildPythonEnvironment()                             ~10ms        │
│     └─ spawn('python', ['-m', 'django_orm_intellisense'])   ~200ms       │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
                    │
                    │  JSON-RPC: initialize request (timeout: 60s)
                    ▼
┌─ Python Daemon _initialize() ─────────────────────────────────────────────┐
│                                                                           │
│  ⓐ snapshot_python_sources(workspace_root)          ██░░░░░  ~1-5s      │
│     └─ os.walk() 전체 워크스페이스 + stat() per file                      │
│     └─ 11858 파일 → fingerprint 생성                                     │
│     └─ directory_fingerprints 빌드                                       │
│                                                                           │
│  ⓑ discover_workspace()                             ░░░░░░░  ~50ms      │
│     └─ manage.py 존재 확인                                               │
│     └─ settings.py 후보 탐색                                             │
│                                                                           │
│  ⓒ build_static_index() OR load_cached()            ██████░  ~2-15s     │
│     캐시 miss 시:                                                         │
│       └─ 11858 파일 전부 read_text() + ast.parse()                       │
│       └─ _build_module_index() per file                                  │
│       └─ class 정의, import, model candidate 추출                        │
│       └─ cross-module inheritance 확장                                   │
│     캐시 hit 시:                                                          │
│       └─ JSON 역직렬화 (~200ms)                                          │
│                                                                           │
│  ⓓ inspect_runtime() OR load_cached() OR defer      ██████░  ~1-30s     │
│     캐시 miss + defer=false:                                              │
│       └─ django.setup() (모든 앱 import + ready())                       │
│       └─ apps.get_app_configs() → 모든 모델 순회                         │
│       └─ _meta.get_fields() per model                                    │
│     캐시 hit 시:                                                          │
│       └─ JSON 역직렬화 (~100ms)                                          │
│     defer=true (현재 기본값):                                             │
│       └─ 즉시 pending 반환 (~1ms)                                        │
│       └─ background thread에서 비동기 실행                                │
│                                                                           │
│  ⓔ prebuild_member_surface_cache()                   ████░░░  ~1-5s     │
│     └─ 모든 concrete 모델 × 5 receiver kinds                             │
│     └─ ORM member surface 계산 (필드, 관계, 역관계, 매니저)               │
│     └─ build_surface_index() → lightweight dict                          │
│                                                                           │
│  ⓕ JSON-RPC 응답 직렬화                              ░░░░░░░  ~50ms     │
│     └─ surfaceIndex + modelNames → JSON                                  │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
                    │
                    │  InitializeResult (surfaceIndex, modelNames, health)
                    ▼
┌─ TS Client 후속 처리 ─────────────────────────────────────────────────────┐
│                                                                           │
│  4. daemon response 처리                                    ~10ms        │
│     ├─ modelNames → Set                                                  │
│     ├─ surfaceIndex → 저장                                               │
│     └─ modelLabelByName 역매핑 구축                                      │
│                                                                           │
│  5. feedSurfaceIndexToServer()                              ~50ms        │
│     └─ languageClient.sendNotification('django/updateSurfaceIndex')      │
│                                                                           │
│  6. Language Server: buildWorkspaceIndex()                   ~100ms       │
│     ├─ surfaceIndex → ModelInfo Map 변환                                  │
│     ├─ per-model field RadixTrie 구축                                    │
│     └─ global lookup/transform trie 구축                                 │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
              Completion 가능 상태
```

**시간 분석 (11853 파일, 1139 모델 프로젝트 실측)**

| 단계 | 최적화 전 (캐시 hit) | 최적화 후 1차 | 최적화 후 2차 (전체 캐시 hit) | 적용된 최적화 |
|------|---------------------|-------------|-------------------------------|-------------|
| ⓐ snapshot_python_sources | 1-5s | 0.87s | **0.46s** | ThreadPoolExecutor(8) 병렬 stat |
| ⓑ discover_workspace | ~50ms | ~10ms | ~0ms | (변경 없음) |
| ⓒ static_index | ~200ms (partial) | 0.60s (full) | **0.43s** (full) | StaticIndex 전체 디스크 캐싱 |
| ⓓ runtime inspection | ~100ms | 0.09s | **0.07s** | (기존 캐시, 변경 없음) |
| ⓔ surface_index | 1-5s (**항상**) | 3.87s (miss) | **0.07s** (hit) | surface-index.json 디스크 캐싱 |
| ⓕ 응답 직렬화 | ~50ms | ~10ms | ~0ms | (변경 없음) |
| **합계** | **3-10s** | **5.44s** | **1.03s** | |

**해결된 병목 3가지:**

1. ✅ **snapshot_python_sources 병렬화 (1-5s → 0.46s)**
   - `ThreadPoolExecutor(max_workers=8)`로 stat + fingerprint 병렬 처리
   - os.walk는 단일 스레드 유지 (순차 디렉토리 탐색), stat만 병렬
   - macOS APFS에서 ~2-4배 개선
   - 파일: `python/django_orm_intellisense/discovery/workspace.py`

2. ✅ **surface_index 디스크 캐싱 (1-5s → 0.07s)**
   - `surface-index.json`에 prebuild 결과 저장
   - 캐시 키: `source_fingerprint + runtime_fingerprint`
   - 캐시 hit 시 `prebuild_member_surface_cache()` 완전 스킵
   - 파일: `python/django_orm_intellisense/cache/store.py`, `server/app.py`

3. ✅ **StaticIndex 전체 디스크 캐싱 (~200ms → 0.43s, but 구조적 개선)**
   - `static-index-full.json`에 StaticIndex 전체 저장
   - rootTreeFingerprint 정확 일치 시 `StaticIndex.from_cache_dict()`로 즉시 복원
   - per-module 역직렬화 + `_expand_model_candidates` + `_resolve_fields` 재실행 제거
   - 부분 변경 시에도 partial fallback 경로 유지
   - CACHE_SCHEMA_VERSION 7 → 8
   - 파일: `python/django_orm_intellisense/cache/store.py`

4. ✅ **didChange 초기 동기화 burst detection**
   - 고정 5초 grace period → 이벤트 빈도 기반 burst 감지로 전환
   - 2초 윈도우 내 10개 이상 고유 파일 변경 시 burst로 판단, 무시
   - VS Code가 수십 초에 걸쳐 문서를 보내도 정확히 감지
   - 파일: `src/server/server.ts`

---

#### 병목 #1 상세 분석: prebuild_member_surface_cache

**문제 요약:** 캐시 hit/miss 여부와 관계없이 매 시작마다 1-5초 소요. 디스크 캐싱 없음.

##### 호출 구조

```
_initialize() (app.py:250)
  └─ prebuild_member_surface_cache(static_index, runtime)     (orm_members.py:188)
       ├─ [1단계] 캐시 프리빌드: 모든 모델 × 5 receiver kinds
       │    for candidate in static_index.model_candidates:    # 1148 모델
       │      if candidate.is_abstract: continue               # ~50 abstract 제외 → ~1100 concrete
       │      for kind in ['instance', 'model_class', 'manager', 'queryset', 'related_manager']:
       │        _surface_cache.get_list(static_index, runtime, label, kind, None)
       │                                                       # 1100 × 5 = 5500 surface 계산
       │
       └─ [2단계] surface_index 빌드: build_surface_index()
            for candidate in static_index.model_candidates:    # 1100 concrete 모델 (다시 순회)
              for kind in receiver_kinds:                      # 5 kinds
                surface = _surface_cache.get_list(...)         # 캐시 hit (1단계에서 이미 빌드)
                for item in surface:
                  if item.return_kind:
                    kind_entry[item.name] = [return_kind, return_model_label]
```

##### _surface_cache 동작

```python
class _MemberSurfaceCache:                                     # orm_members.py:15
    _owner: tuple[int, int]       # (id(static_index), id(runtime))
    _list_cache: dict[...]        # (label, kind, manager) → [OrmMemberItem, ...]
    _dict_cache: dict[...]        # (label, kind, manager) → {name: OrmMemberItem}

    def get_list(...):
        self._check_owner(static_index, runtime)               # id() 비교 → 다르면 전체 클리어
        key = (model_label, receiver_kind, manager_name)
        cached = self._list_cache.get(key)
        if cached is not None:
            self._hits += 1; return cached                     # O(1) hit
        self._misses += 1
        surface = _member_surface(...)                         # 실제 계산 (아래 상세)
        self._list_cache[key] = surface
        self._dict_cache[key] = {item.name: item for item in surface}
        return surface
```

**핵심 문제:** `_check_owner`가 `id(static_index)`로 비교.
- 프로세스 재시작 시 새 객체 → 항상 전체 클리어 → 1단계에서 5500회 miss.
- 메모리 캐시만 존재, 디스크 캐시 없음.

##### _member_surface() 각 receiver kind별 비용

```
receiver_kind     호출 경로                                     비용
─────────────────────────────────────────────────────────────────────────
instance          _instance_surface()                           가장 비쌈
                  ├─ static_index.fields_for_model(label)       필드 순회
                  │   └─ 모델의 모든 필드+상속 필드 수집         O(fields × bases)
                  ├─ _static_model_method_items()               AST 메서드 추출
                  │   └─ 모델 class body에서 def 추출           O(methods)
                  └─ _project_model_method_items()              프로젝트 메서드
                      └─ 런타임 메서드와 교차                   O(methods)

model_class       _model_class_surface()                        중간
                  ├─ _manager_name_items()                      매니저 이름 수집
                  ├─ _static_model_method_items(model_class)
                  └─ _project_model_method_items(model_class)

manager           _manager_surface()                            중간
                  ├─ _builtin_method_items(BUILTIN_MANAGER)     22개 고정 메서드
                  ├─ _static_manager_method_items()             커스텀 매니저 메서드
                  └─ _runtime_callable_member_items()           런타임 inspect
                      └─ inspect.getmembers() 사용 시 비쌈     O(manager_methods)

queryset          _queryset_surface()                           중간
                  ├─ _builtin_method_items(BUILTIN_QUERYSET)    21개 고정 메서드
                  ├─ _static_manager_method_items()             공유 로직
                  └─ _runtime_callable_member_items()           런타임 inspect

related_manager   _related_manager_surface()                    가벼움
                  └─ _builtin_method_items(BUILTIN_MANAGER)     22개 고정
```

##### 비용 분해 (1100 모델 기준 추정)

```
                      호출 횟수    개당 비용      총 비용
instance              1100         ~1ms           ~1.1s
model_class           1100         ~0.5ms         ~0.55s
manager               1100         ~0.5ms         ~0.55s
queryset              1100         ~0.5ms         ~0.55s
related_manager       1100         ~0.2ms         ~0.22s
─────────────────────────────────────────────────────────
                      5500                        ~3.0s
build_surface_index   5500 (hit)   ~0.01ms        ~0.05s
─────────────────────────────────────────────────────────
합계                                              ~3.05s
```

가장 비싼 부분: **instance surface** (필드 수집 + 상속 체인 + 메서드 추출)

##### 왜 디스크 캐싱이 안 되는 구조인가

```
현재 캐시 구조:
  _surface_cache (메모리) ─── _check_owner(id(static_index), id(runtime))
                              └─ 프로세스 재시작 → 새 객체 → id 변경 → 전체 miss

필요한 캐시 구조:
  디스크 캐시 ─── 키: (static_index.fingerprint, runtime.fingerprint, model_label, kind)
                  └─ 파일: surface-cache.json 또는 별도 파일
                  └─ static_index, runtime이 변경되지 않았으면 디스크에서 로드
```

##### surface_index vs _surface_cache 관계

```
prebuild_member_surface_cache()가 반환하는 것:
  surface_index (dict) ─── TS에 전송, Language Server의 WorkspaceIndex로 변환
                           구조: { "app.Model": { "instance": { "field": ["kind", "label"] } } }
                           용도: completion에서 O(1) 필드/관계 조회

_surface_cache가 보관하는 것:
  _list_cache (dict) ─── Python daemon 내부 IPC 응답용
                          구조: (label, kind, manager) → [OrmMemberItem(...), ...]
                          용도: resolveOrmMembers, resolveOrmMemberChain 등 IPC 핸들러

→ surface_index는 _surface_cache의 경량 투영(projection)
→ surface_index만 디스크 캐싱하면 TS 전송 비용은 제거 가능
→ 그러나 _surface_cache도 캐싱하지 않으면 IPC 핸들러 첫 호출이 느림
```

##### 개선 방안

```
방안 A: surface_index 디스크 캐싱 (최소 변경)
  ─ prebuild 결과 surface_index를 JSON으로 저장
  ─ 키: sha256(static_index.fingerprint + runtime.fingerprint)
  ─ 캐시 hit 시: prebuild 전체 스킵, surface_index 즉시 반환 → -1~5s
  ─ _surface_cache는 여전히 cold → IPC 첫 호출은 느림
  ─ 장점: 구현 1시간 이내, 초기 로딩 영향 즉시 해소
  ─ 단점: IPC 핸들러 cold start 여전

방안 B: _surface_cache 전체 디스크 캐싱 (완전 해결)
  ─ OrmMemberItem 리스트 전체를 직렬화/역직렬화
  ─ 캐시 hit 시: _surface_cache 복원 + surface_index 즉시 생성 → -1~5s
  ─ IPC 핸들러도 즉시 warm
  ─ 장점: 완전한 cold start 제거
  ─ 단점: OrmMemberItem 직렬화/역직렬화 코드 필요, JSON 크기 증가

방안 C: Language Server에서 직접 surface 계산 (Phase 2)
  ─ surfaceIndex를 TS Language Server가 직접 구축
  ─ Python daemon의 prebuild 자체를 제거
  ─ 장점: Python 프로세스 의존성 제거, 가장 빠름
  ─ 단점: Django 런타임 정보 (custom manager, register_lookup) 반영 불가

권장: 방안 A 우선 적용 (즉시 효과) → Phase 1에서 방안 B 전환
```

---

#### 병목 #2 상세 분석: build_static_index 파일별 캐시

**문제 요약:** 캐시 miss 시 11858 파일 전부 read + ast.parse. 캐시 hit 시에도 build_static_index 재실행.

##### 전체 호출 흐름

```
_initialize() (app.py:162-181)
  │
  ├─ [A] load_cached_static_index(workspace_root, source_snapshot)   (store.py:21)
  │    ├─ 캐시 파일 로드: {workspace_cache_dir}/static-index.json
  │    ├─ schemaVersion, workspaceRoot 검증
  │    ├─ _load_reusable_module_indices()                            ← 핵심: 파일별 재사용 판단
  │    │    ├─ source_snapshot.directory_fingerprints vs 캐시 비교
  │    │    ├─ 변경 안 된 디렉토리 식별 (unchanged_directories)
  │    │    └─ 파일별: fingerprint 일치 OR 상위 디렉토리 unchanged → 재사용
  │    │
  │    └─ 재사용 가능한 ModuleIndex가 있으면:
  │         build_static_index(root, files, cached_module_indices=reusable)
  │         └─ 캐시 hit 파일은 skip, miss 파일만 AST 파싱
  │
  ├─ [B] 캐시 완전 miss (파일 없거나 schemaVersion 불일치):
  │    build_static_index(root, python_files=source_snapshot.files)
  │    └─ 11858 파일 전부 read_text() + ast.parse()
  │
  └─ save_static_index(workspace_root, source_snapshot, static_index)  (store.py:74)
       └─ 파일별 ModuleIndex + fingerprint를 JSON 저장
```

##### 캐시 저장 구조 (static-index.json)

```json
{
  "metadata": {
    "schemaVersion": 7,
    "workspaceRoot": "/path/to/project",
    "rootTreeFingerprint": "sha256...",
    "createdAt": "2026-04-09T..."
  },
  "payload": {
    "directoryFingerprints": {
      "": "sha256(root)",                           // 루트 디렉토리
      "zuzu": "sha256(zuzu/)",
      "zuzu/db": "sha256(zuzu/db/)",
      "zuzu/db/models": "sha256(zuzu/db/models/)",  // 각 디렉토리별
      ...                                            // 11858 파일 → ~2000 디렉토리
    },
    "moduleEntries": {
      "zuzu/db/models/company.py": {                 // 파일별 엔트리
        "fileFingerprint": "sha256(path+size+mtime)",
        "moduleIndex": {                             // ModuleIndex.to_dict()
          "moduleName": "zuzu.db.models.company",
          "filePath": "/path/to/company.py",
          "isPackageInit": false,
          "definedSymbols": ["Company", ...],
          "symbolDefinitions": { "Company": { "filePath": "...", "line": 10, ... } },
          "importBindings": [...],
          "modelCandidates": [...],
          "pendingFields": [...],
          "classBaseRefs": { "Company": ["TimeStampedModel", "models.Model"] }
        }
      },
      ...                                            // 11858 파일 전부 저장
    }
  }
}
```

##### 캐시 히트 판단 로직 (_load_reusable_module_indices)

```python
# store.py:246-281
def _load_reusable_module_indices(...):
    # Step 1: 디렉토리 fingerprint 비교
    unchanged_directories = {
        dir_path
        for dir_path, fp in source_snapshot.directory_fingerprints.items()
        if cached_directory_fingerprints.get(dir_path) == fp         # 현재 vs 캐시
    }
    # → 디렉토리 fingerprint = sha256(소속 파일들의 fingerprint + 하위 디렉토리 fingerprint)
    # → 파일 1개 변경 → 해당 디렉토리 + 모든 상위 디렉토리 fingerprint 변경

    # Step 2: 파일별 재사용 판단
    for entry in source_snapshot.entries:                             # 11858 파일 순회
        cached_entry = cached_module_entries.get(entry.relative_path)
        file_is_unchanged = cached_entry['fileFingerprint'] == entry.fingerprint
        tree_is_unchanged = _is_under_unchanged_tree(
            entry.directory_path, unchanged_directories             # 상위 디렉토리 체크
        )
        if file_is_unchanged or tree_is_unchanged:
            reusable_modules[entry.relative_path] = ModuleIndex.from_dict(...)
                                                    ↑ 역직렬화 비용
    return reusable_modules
```

##### 핵심 비용 분해

```
시나리오 1: 캐시 완전 miss (첫 실행 또는 schemaVersion 변경)
────────────────────────────────────────────────────────────────────
  iter_python_files()        os.walk + 파일 수집              ~0.2s
  for 11858 files:
    read_text()              파일 읽기 (I/O)                  ~2-5s
    ast.parse()              AST 파싱 (CPU)                   ~3-8s
    _build_module_index()    class/import/field 추출          ~1-3s
  _static_index_from_modules()
    _expand_model_candidates_via_imports()                     ~0.5-2s
    StaticIndex.__post_init__()
      _resolve_fields()      필드 해석 + 상속 + 역참조        ~0.5-1s
  save_static_index()        JSON 직렬화 + 파일 쓰기         ~0.5-2s
  ──────────────────────────────────────────────────────────────
  합계                                                        ~7-21s


시나리오 2: 캐시 히트 (파일 변경 없음)
────────────────────────────────────────────────────────────────────
  _read_cache_payload()      JSON 파일 읽기                   ~0.1-0.5s
  json.loads()               JSON 역직렬화                    ~0.1-0.5s
  _load_reusable_module_indices():
    for 11858 entries:
      fingerprint 비교       O(1) per file                    ~0.01s
      ModuleIndex.from_dict() 역직렬화 per file               ~0.5-2s ←★ 병목
  build_static_index():
    for 11858 files:
      cached_modules.get()   dict lookup (캐시 hit)           ~0.01s
    _static_index_from_modules():
      expand_inheritance=False (캐시에서 온 경우 has_fresh=False? 아님!)
  ──────────────────────────────────────────────────────────────
  합계                                                        ~0.7-3s


시나리오 3: 부분 캐시 히트 (파일 1-100개 변경)
────────────────────────────────────────────────────────────────────
  캐시 JSON 로드 + 역직렬화                                   ~0.1-0.5s
  _load_reusable_module_indices():
    11858 entries 순회 + 재사용 판단                           ~0.5-2s
    변경된 파일이 속한 디렉토리 → 해당 디렉토리 파일만 miss
    나머지 재사용 (ModuleIndex.from_dict per file)
  build_static_index():
    캐시 hit: dict lookup                                     ~0.01s × ~11758
    캐시 miss: read_text + ast.parse + _build_module_index    ~1-3ms × ~100
  _static_index_from_modules():
    has_fresh_modules=True → _expand_model_candidates 재실행  ~0.5-2s
    StaticIndex.__post_init__() → _resolve_fields() 재실행    ~0.5-1s
  save_static_index()                                         ~0.5-2s
  ──────────────────────────────────────────────────────────────
  합계                                                        ~2-7.5s
```

##### 캐시 설계의 구조적 문제

```
문제 1: "캐시 hit"에서도 build_static_index를 재실행
  ─ load_cached_static_index()는 StaticIndex를 직접 복원하지 않음
  ─ reusable ModuleIndex dict를 만들어 build_static_index()에 전달
  ─ build_static_index()가 다시 11858 파일 순회 + _static_index_from_modules() 실행
  ─ StaticIndex.__post_init__()에서 _resolve_fields() (필드 해석 + 역참조 생성) 매번 재실행

  → 캐시 hit여도 StaticIndex 객체 재구축에 0.5-2s 소요

문제 2: ModuleIndex.from_dict() 역직렬화 비용
  ─ 11858개 ModuleIndex를 JSON dict → dataclass로 변환
  ─ 각 ModuleIndex 내부:
    definedSymbols: set 생성
    symbolDefinitions: DefinitionLocation.from_dict() × N
    importBindings: ImportBinding.from_dict() × N
    modelCandidates: ModelCandidate.from_dict() × N
    pendingFields: PendingFieldCandidate.from_dict() × N
    classBaseRefs: dict comprehension
  ─ 11858 파일 × 평균 ~10 심볼 = ~120000 객체 생성

  → 역직렬화만으로 0.5-2s

문제 3: 부분 변경 시에도 _expand_model_candidates + _resolve_fields 전체 재실행
  ─ has_fresh_modules=True이면 expand_inheritance=True
  ─ _expand_model_candidates_via_imports(): 전체 모듈 그래프 순회
  ─ _resolve_fields(): 전체 모델의 필드 상속 체인 재계산
  ─ 파일 1개 변경해도 전체 모델에 대해 O(models × fields) 재실행

  → 증분 변경 비용이 전체 재빌드에 근접

문제 4: save_static_index()가 매번 전체 파일 다시 쓰기
  ─ 11858개 ModuleIndex를 JSON 직렬화 → 단일 파일에 쓰기
  ─ 파일 1개 변경해도 전체 캐시 파일 재생성
  ─ JSON 직렬화 비용: ~0.5-2s (큰 프로젝트)

  → 매 save마다 수 MB JSON 재작성
```

##### 디렉토리 fingerprint 체계 상세

```
_build_directory_fingerprints() (workspace.py:210-273)

구조:
  파일 fingerprint = sha256(relative_path + size + mtime_ns)
  디렉토리 fingerprint = sha256(
    직접 소속 파일들의 (name, fingerprint) 정렬 +
    직접 하위 디렉토리들의 (name, fingerprint) 정렬
  )

예시 (파일 1개 변경 시 전파):
  zuzu/db/models/company.py 변경
  → "zuzu/db/models/company.py" fingerprint 변경
  → "zuzu/db/models" 디렉토리 fingerprint 변경
  → "zuzu/db" 디렉토리 fingerprint 변경
  → "zuzu" 디렉토리 fingerprint 변경
  → "" (루트) 디렉토리 fingerprint 변경

결과:
  unchanged_directories에서 "zuzu/db/models"와 모든 상위 제외
  BUT "zuzu/db/models" 내 다른 파일들도 tree_is_unchanged=False
  → 개별 file_is_unchanged로 재사용 가능 (fingerprint 직접 비교)

실제 영향:
  company.py 1개 변경 → "zuzu/db/models/" 내 ~50 파일의 tree_is_unchanged=False
  BUT 각 파일의 file_is_unchanged=True → 대부분 재사용 성공
  → 디렉토리 fingerprint는 "빠른 경로" 용, 실패해도 파일별 비교로 커버
```

##### 개선 방안

```
방안 A: StaticIndex 전체를 직접 캐싱 (가장 효과적)
  현재: 캐시에서 ModuleIndex dict 복원 → build_static_index() 재실행
  개선: StaticIndex 전체를 직렬화/역직렬화
  ─ StaticIndex.from_cache_dict() 이미 존재 (indexer.py:396)
  ─ 캐시 파일에 StaticIndex 전체 저장 (modules + model_candidates + fields)
  ─ 캐시 hit 시: StaticIndex.from_cache_dict()로 즉시 복원
  ─ 캐시 miss 시: 기존 로직 (build_static_index)
  ─ 부분 miss 시: 기존 로직 (reusable modules)

  예상 효과:
    캐시 완전 hit: ~0.5s → ~0.3s (ModuleIndex 역직렬화 불필요, _resolve_fields 불필요)
    BUT: fields도 캐시해야 하므로 JSON 크기 증가

방안 B: 증분 _resolve_fields (부분 변경 최적화)
  현재: has_fresh_modules=True → 전체 모델 필드 재해석
  개선: 변경된 모듈에 속한 모델만 필드 재해석
  ─ 이전 StaticIndex의 fields를 유지
  ─ 변경된 파일에 속한 모델만 필드 재계산
  ─ 해당 모델을 참조하는 역참조만 갱신

  예상 효과:
    부분 miss: ~2-7.5s → ~1-3s (변경 모델만 재해석)

방안 C: ModuleIndex 역직렬화 최적화
  현재: JSON dict → dataclass (11858 × ~10 객체 = ~120000 객체 생성)
  개선: pickle 또는 msgpack 사용
  ─ pickle: 역직렬화 ~5-10x 빠름, 파일 크기 유사
  ─ msgpack: JSON보다 2-3x 빠름, 바이너리 형식

  예상 효과:
    캐시 hit: ~0.5-2s → ~0.1-0.4s (역직렬화 비용 감소)

방안 D: 캐시 파일 분할 (save_static_index 최적화)
  현재: 단일 static-index.json에 11858 모듈 전부 저장
  개선: 디렉토리별 또는 앱별 분할 캐시
  ─ zuzu-db-models.json, zuzu-api-views.json 등
  ─ 변경된 파일이 속한 분할만 재작성

  예상 효과:
    save: ~0.5-2s → ~0.1s (변경 분할만 쓰기)

권장 순서:
  1. 방안 A (StaticIndex 직접 캐싱) — 캐시 hit 시 최대 효과, from_cache_dict 이미 존재
  2. 방안 C (역직렬화 최적화) — 방안 A와 병행 가능
  3. 방안 B (증분 필드 해석) — 부분 변경 시나리오 개선
  4. 방안 D (캐시 분할) — 대규모 프로젝트 save 최적화
```

---

#### 병목 #3 상세 분석: snapshot_python_sources

**문제 요약:** 캐시 유효성 판단의 전제 조건으로, 매 시작마다 전체 워크스페이스를 os.walk + stat. 캐시 불가.

##### 호출 구조

```
_initialize() (app.py:145)
  └─ snapshot_python_sources(workspace_root)             (workspace.py:95)
       ├─ [1] iter_python_files(root)                    (workspace.py:77)
       │    └─ os.walk(root)
       │         dirnames[:] = [제외 목록 필터링]
       │         SKIP_DIRS: .git, .hg, .mypy_cache, .pytest_cache,
       │                    .ruff_cache, .svn, .tox, .venv,
       │                    __pycache__, build, dist, node_modules, out, venv
       │         + 모든 dot-prefix 디렉토리 제외
       │    └─ .py로 끝나는 파일만 수집
       │    └─ python_files.sort()                       ← 정렬 (안정적 fingerprint 위해)
       │
       ├─ [2] for python_file in python_files:           11858 파일 순회
       │    ├─ python_file.stat()                        ← syscall: lstat per file
       │    ├─ python_file.relative_to(root).as_posix()  ← Path 연산
       │    └─ _file_fingerprint(path, size, mtime_ns)   ← sha256 per file
       │         └─ sha256(relative_path + size + mtime_ns)
       │
       └─ [3] _build_directory_fingerprints(entries)     11858 entries → ~2000 dirs
            ├─ Phase A: 디렉토리 트리 구축
            │    for entry in entries:                    11858회
            │      direct_files[dir].append((name, fp))
            │      while dir != "":                      평균 depth ~4
            │        direct_directories[parent].add(child)
            │        dir = parent
            │
            ├─ Phase B: 리프→루트 순서로 fingerprint 계산
            │    ordered_directories = sorted(dirs, by depth, reverse=True)
            │    for dir in ordered_directories:         ~2000회
            │      sha256(소속 파일 fingerprint + 하위 디렉토리 fingerprint)
            │
            └─ 결과: { "": "root_fp", "zuzu": "fp", "zuzu/db": "fp", ... }
```

##### 비용 분해 (11858 파일 기준)

```
단계                          연산                           횟수          비용
──────────────────────────────────────────────────────────────────────────────
[1] os.walk()                 readdir syscall per dir        ~2000 dirs    ~0.2-0.5s
    dirnames 필터링           list comprehension per dir     ~2000         무시
    .py 확인                  str.endswith per file          ~20000+       무시
    sort()                    Tim sort, 11858 Path           1             ~0.01s

[2] stat() per file           lstat syscall                  11858         ~0.3-1.5s ←★
    relative_to + as_posix    Path 연산                      11858         ~0.05s
    _file_fingerprint         sha256(~50 bytes)              11858         ~0.02s
    PythonSourceEntry 생성    dataclass 인스턴스화            11858         ~0.01s

[3] _build_directory_fingerprints:
    Phase A: 트리 구축        dict.setdefault + while loop   11858 × ~4    ~0.05s
    Phase B: fingerprint      sha256 per dir                 ~2000         ~0.01s
    sorted(dirs, by depth)    정렬                           ~2000         ~0.001s

──────────────────────────────────────────────────────────────────────────────
합계                                                                       ~0.6-2.1s
```

**지배적 비용: os.walk (~0.2-0.5s) + stat × 11858 (~0.3-1.5s) = ~0.5-2s**

나머지 (sha256, Path 연산, 디렉토리 fingerprint) 합계 < 0.1s로 무시 가능.

##### 왜 이 단계가 캐싱 불가능한가

```
snapshot_python_sources의 목적:
  1. 전체 .py 파일 목록 생성     → build_static_index에 전달
  2. 파일별 fingerprint 생성     → 캐시 유효성 판단의 기준
  3. 디렉토리 fingerprint 생성   → 디렉토리 단위 캐시 hit/miss 판단

순환 의존:
  "캐시가 유효한가?" 를 판단하려면 현재 파일 상태를 알아야 함
  현재 파일 상태를 알려면 os.walk + stat 해야 함
  → snapshot 자체를 캐싱하면 "캐시의 캐시"가 필요 → 근본적으로 불가

근본 원인:
  Python daemon은 프로세스 시작 시 파일 시스템 상태를 모름
  VS Code의 file watcher 이벤트를 받지 못함 (VS Code ↔ daemon 직접 연결 없음)
  → 매번 처음부터 전체 스캔해야 함
```

##### 실제 syscall 비용 (macOS/Linux 차이)

```
macOS (APFS):
  lstat() per file: ~20-50μs (메타데이터 캐시 hit 시 ~5μs)
  readdir() per dir: ~50-200μs
  11858 × 30μs = ~0.36s (warm) ~ 0.59s (cold)
  2000 × 100μs = ~0.2s (warm) ~ 0.4s (cold)
  합계: ~0.56s (warm) ~ 1.0s (cold)

Linux (ext4/btrfs):
  lstat() per file: ~5-15μs (dentry 캐시 hit 시 ~2μs)
  readdir() per dir: ~10-50μs
  11858 × 8μs = ~0.09s (warm) ~ 0.18s (cold)
  2000 × 25μs = ~0.05s (warm) ~ 0.1s (cold)
  합계: ~0.14s (warm) ~ 0.28s (cold)

→ macOS에서 Linux보다 3-5배 느림 (APFS 메타데이터 성능)
→ 첫 실행(cold)과 재실행(warm)의 차이: ~2x (OS 페이지 캐시 유무)
```

##### snapshot_python_sources 결과의 다운스트림 사용처

```
source_snapshot은 4곳에서 소비:

1. discover_workspace(root, settings_module, python_files=source_snapshot.files)
   └─ 파일 목록에서 settings.py 후보 검색
   └─ source_snapshot.files만 사용 (fingerprint 불필요)

2. build_static_index(root, python_files=source_snapshot.files)
   └─ 파일 목록을 순회하며 AST 파싱
   └─ source_snapshot.files만 사용

3. load_cached_static_index(workspace_root, source_snapshot)
   └─ source_snapshot.directory_fingerprints: 디렉토리 단위 캐시 비교
   └─ source_snapshot.entries: 파일별 fingerprint 비교
   └─ 이 두 데이터가 snapshot의 핵심 목적

4. _runtime_source_fingerprint(source_snapshot, static_index, settings_module)
   └─ source_snapshot.directory_fingerprints: scope root별 fingerprint
   └─ source_snapshot.entries_by_path: scope root .py 파일 fingerprint
   └─ 런타임 캐시 유효성 판단

5. save_static_index(workspace_root, source_snapshot, static_index)
   └─ source_snapshot.entries_by_path: 파일별 fingerprint 저장
   └─ source_snapshot.directory_fingerprints: 디렉토리 fingerprint 저장
   └─ source_snapshot.fingerprint: 루트 fingerprint 메타데이터
```

##### 개선 방안

```
방안 A: VS Code file watcher → daemon에 변경 파일 목록 전달 (근본 해결)
  현재:  daemon이 매번 os.walk + stat으로 직접 파일 목록 생성
  개선:  extension.ts가 VS Code의 FileSystemWatcher로 변경 추적
         → daemon initialize 시 "변경된 파일 목록"만 전달
         → daemon은 이전 snapshot + 변경 목록으로 새 snapshot 생성

  구현:
    Extension 측:
      const watcher = vscode.workspace.createFileSystemWatcher('**/*.py');
      watcher.onDidCreate / onDidChange / onDidDelete → 변경 추적
      initialize 요청에 changedFiles: string[] 포함

    Daemon 측:
      이전 snapshot을 디스크에 저장 (이미 save_static_index에서 부분적으로 함)
      changedFiles가 있으면:
        이전 snapshot에서 변경 파일만 re-stat
        새 파일은 stat 추가, 삭제 파일은 제거
        변경 파일의 디렉토리만 fingerprint 재계산

  예상 효과:
    11858 파일 전체 스캔 → 변경 파일 ~10개 stat = ~0.001s
    하지만 최초 실행은 여전히 전체 스캔 필요

  난이도: 높음
    ─ Extension ↔ daemon 프로토콜 확장 필요
    ─ watcher 이벤트 누락 시 불일치 위험 (fullSync fallback 필요)
    ─ VS Code 재시작 시 watcher 이력 소실 → fallback to full scan

방안 B: 이전 snapshot 디스크 캐시 + stat 최소화 (실용적)
  현재:  snapshot 결과를 메모리에만 보관 (프로세스 재시작 시 소실)
  개선:  이전 snapshot의 entries를 디스크에 저장
         재시작 시 이전 entries 로드 → 파일별 mtime만 빠르게 비교
         변경 없는 파일은 이전 fingerprint 재사용

  구현:
    1. snapshot-entries.json 저장: { "path": { "size": N, "mtime_ns": N, "fp": "..." } }
    2. 재시작 시 로드 → os.walk()로 현재 파일 목록 수집 (이건 여전히 필요)
    3. 각 파일에 대해:
       - 이전 entries에 존재 AND mtime_ns 동일 → fingerprint 재사용 (stat 필요 없음?)
         → 아니다, mtime 비교 자체가 stat 필요. 이 방안은 효과 없음.

  결론: stat() 자체를 줄일 수 없으므로 이 방안은 무효.
        os.walk가 이미 stat을 암묵적으로 수행하지 않음 → 별도 stat 필요.

방안 C: os.walk + stat 병렬화 (즉시 효과)
  현재:  단일 스레드에서 순차적으로 stat
  개선:  os.scandir() 사용 (os.walk보다 빠름, DirEntry.stat() 일부 OS에서 무료)
         또는 concurrent.futures로 디렉토리별 병렬 stat

  구현:
    os.scandir() 사용 시:
      Linux: DirEntry.stat()가 d_type으로 파일/디렉토리 판별 → stat syscall 절약
      macOS: DirEntry.stat()는 여전히 lstat 필요 (APFS 한계)
      → Linux에서만 효과

    병렬 stat:
      ThreadPoolExecutor(max_workers=8)로 디렉토리별 병렬 처리
      → GIL이 있지만 stat은 I/O-bound이므로 스레드 병렬화 유효

  예상 효과:
    순차: ~0.6-2.1s → 병렬(8 workers): ~0.15-0.5s (3-4배 개선)

  난이도: 낮음

방안 D: Language Server의 file watcher로 snapshot 대체 (Phase 2, 근본 해결)
  현재:  Python daemon이 직접 파일 시스템 스캔
  개선:  Language Server (Node.js)가 VS Code의 file watcher 이벤트를 수신
         → 자체 파일 목록 + fingerprint 유지
         → daemon에는 "캐시 유효/무효" 신호만 전달
         → 또는 daemon 자체를 LS로 대체 (Phase 2-3 목표)

  이점:
    VS Code의 files.watcherExclude를 존중
    OS 네이티브 watcher 사용 (fsevents/inotify)
    파일 변경 시 즉시 알림 → polling/full scan 불필요

  난이도: Phase 2 아키텍처 변경과 연동

권장 순서:
  1. 방안 C (병렬 stat) — 즉시 적용 가능, ~3-4배 개선
  2. 방안 A (watcher 전달) — Phase 1에서 daemon 프로토콜 확장 시 병행
  3. 방안 D (LS watcher 대체) — Phase 2 아키텍처 전환 시 자연 해결
```

### Phase 1: Performance (2주 → 4주)

```
목표: 증분 인덱싱 + 캐시 최적화
구현:
  □ didSave 기반 단일 파일 증분 인덱싱
  □ 디렉토리 fingerprint 기반 캐시
  □ 모델별 RadixTrie lazy 생성
  □ completion 결과 캐시
  □ 벤치마크 인프라 구축
결과: cold start <2s, completion p50 <5ms
```

### Phase 2: Precision (.venv + lookup 테이블) ✅ 완료

```
목표: .venv 지원 + 필드별 lookup/transform
구현:
  ✓ .venv 감지 + site-packages resolver (pyvenv.cfg 파싱, python version, site-packages 경로)
  □ lazy dependency indexer (Phase 3으로 이관 — runtime inspection이 이미 모든 installed 모델 커버)
  ✓ 필드 타입별 lookup 하드코딩 테이블 (Phase 0에서 완료, fieldLookups.ts: 38 field types)
  ✓ transform 체인 지원 (Phase 0에서 완료, FSM: synthetic FieldInfo + 무한 체이닝)
  ✓ custom lookup 감지 (register_lookup) — runtime에서 Field.get_lookups() 수집, LS에 전달
결과: custom lookup 자동완성, .venv 메타데이터 해석
```

### Phase 3: Polish (6주 → 8주)

```
목표: 에러 복구 + 랭킹 + 대규모 벤치마크
구현:
  □ 오타 교정 제안
  □ 사용 빈도 기반 랭킹
  □ 5000+ 모델 프로젝트 벤치마크
  □ editable install 지원
  □ partial stub 대응
결과: 프로덕션 품질
```
