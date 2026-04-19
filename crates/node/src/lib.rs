#![deny(clippy::all)]

use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Instant;

use napi::bindgen_prelude::{Buffer, Error as NapiError, Result as NapiResult, Status};
use napi_derive::napi;

use django_orm_core::cache::{self, CacheError, CacheLoad};
use django_orm_core::discovery;
use django_orm_core::features;
use django_orm_core::semantic::{build_model_graph, ModelGraph};
use django_orm_core::static_index::{self, StaticIndex};

/// Process-global resolved workspace state. `native_init` populates it
/// from a workspace root; fast-path query fns read under a shared lock.
/// Rebuilds on subsequent `native_init` calls with a different root or
/// explicit cache-bust flag.
static NATIVE_STATE: RwLock<Option<NativeState>> = RwLock::new(None);

struct NativeState {
    root: PathBuf,
    static_index: StaticIndex,
    graph: ModelGraph,
    built_at_ms: u128,
}

#[napi]
pub fn hello(name: String) -> String {
    django_orm_core::hello(&name)
}

#[napi]
pub fn native_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Save a pre-serialized metadata + payload blob to disk as a bincode
/// cache envelope. Inputs are raw bytes so the TS side can own its own
/// serialization (typically JSON-stringified for now; typed structs
/// later). Returns once the atomic rename completes.
#[napi]
pub fn save_cache_blob(path: String, metadata: Buffer, payload: Buffer) -> NapiResult<()> {
    let meta_bytes: &[u8] = &metadata;
    let payload_bytes: &[u8] = &payload;
    cache::save(
        &PathBuf::from(path),
        &meta_bytes.to_vec(),
        &payload_bytes.to_vec(),
    )
    .map_err(cache_to_napi)
}

/// Load a cache envelope. Returns `null` on miss, otherwise
/// `{ metadata, payload }` as opaque byte buffers. The caller performs
/// their own metadata comparison — this keeps the napi layer type-free.
#[napi(object)]
pub struct CacheHit {
    pub metadata: Buffer,
    pub payload: Buffer,
}

#[napi]
pub fn load_cache_blob(path: String) -> NapiResult<Option<CacheHit>> {
    let result: CacheLoad<Vec<u8>, Vec<u8>> =
        cache::load(&PathBuf::from(path), |_| true).map_err(cache_to_napi)?;
    Ok(match result {
        CacheLoad::Hit { metadata, payload } => Some(CacheHit {
            metadata: metadata.into(),
            payload: payload.into(),
        }),
        CacheLoad::Miss => None,
    })
}

/// Compute the per-workspace cache directory path. Mirrors the Python
/// side `_workspace_cache_dir`.
#[napi]
pub fn workspace_cache_dir(cache_root: String, workspace_root: String) -> String {
    cache::workspace_cache_dir(
        std::path::Path::new(&cache_root),
        std::path::Path::new(&workspace_root),
    )
    .to_string_lossy()
    .into_owned()
}

#[napi]
pub fn cache_schema_version() -> u32 {
    cache::CACHE_SCHEMA_VERSION
}

fn cache_to_napi(err: CacheError) -> NapiError {
    NapiError::new(Status::GenericFailure, err.to_string())
}

#[napi(object)]
pub struct PythonSourceEntryJs {
    pub relative_path: String,
    pub size: u32,
    pub mtime_ns: String,
    pub fingerprint: String,
}

#[napi(object)]
pub struct PythonSourceSnapshotJs {
    pub root: String,
    pub fingerprint: String,
    pub entries: Vec<PythonSourceEntryJs>,
    pub directory_fingerprints: Vec<Vec<String>>,
}

/// Walk the workspace and compute per-file + per-directory fingerprints
/// in parallel. Rust port of `snapshot_python_sources`.
#[napi]
pub fn snapshot_python_sources(
    root: String,
    extra_roots: Option<Vec<String>>,
) -> PythonSourceSnapshotJs {
    let root_path = PathBuf::from(&root);
    let extras_owned: Vec<PathBuf> = extra_roots
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let extras: Vec<&std::path::Path> = extras_owned.iter().map(|p| p.as_path()).collect();

    let snap = discovery::snapshot_python_sources(&root_path, &extras);

    PythonSourceSnapshotJs {
        root: snap.root,
        fingerprint: snap.fingerprint,
        entries: snap
            .entries
            .into_iter()
            .map(|e| PythonSourceEntryJs {
                relative_path: e.relative_path,
                size: e.size.min(u32::MAX as u64) as u32,
                mtime_ns: e.mtime_ns.to_string(),
                fingerprint: e.fingerprint,
            })
            .collect(),
        directory_fingerprints: snap
            .directory_fingerprints
            .into_iter()
            .map(|(k, v)| vec![k, v])
            .collect(),
    }
}

#[napi]
pub fn file_fingerprint(relative_path: String, size: u32, mtime_ns: String) -> NapiResult<String> {
    let mtime: i128 = mtime_ns
        .parse()
        .map_err(|_| NapiError::new(Status::InvalidArg, "mtime_ns must be a decimal integer"))?;
    Ok(discovery::file_fingerprint(
        &relative_path,
        size as u64,
        mtime,
    ))
}

/// Build a static index over the given workspace. Returns the index as
/// JSON bytes (serde_json). The TS side parses what it needs — no
/// structural napi coupling to the Rust type layout.
#[napi]
pub fn build_static_index_json(root: String, files: Vec<String>) -> NapiResult<Buffer> {
    let root_path = PathBuf::from(root);
    let paths: Vec<PathBuf> = files.into_iter().map(PathBuf::from).collect();
    let idx = static_index::build_static_index(&root_path, &paths);
    let bytes = serde_json::to_vec(&idx)
        .map_err(|e| NapiError::new(Status::GenericFailure, e.to_string()))?;
    Ok(bytes.into())
}

/// Parse a single module. Useful for incremental reindex.
#[napi]
pub fn parse_module_json(root: String, file_path: String) -> Option<Buffer> {
    let idx = static_index::parse_module(&PathBuf::from(root), &PathBuf::from(file_path))?;
    serde_json::to_vec(&idx).ok().map(Into::into)
}

/// End-to-end pipeline: discover → parse → resolve → build surfaceIndex.
/// Output shape matches the TS `SurfaceIndex` consumed by
/// `workspaceIndexer.ts::buildWorkspaceIndex` — one napi call is all
/// the TS LSP needs to populate its workspace index from a cold start
/// without any Python round-trip.
#[napi]
pub fn build_surface_index_json(root: String) -> NapiResult<Buffer> {
    let root_path = PathBuf::from(root);
    let snap = discovery::snapshot_python_sources(&root_path, &[]);
    let files: Vec<PathBuf> = snap
        .entries
        .iter()
        .map(|e| root_path.join(&e.relative_path))
        .collect();
    let idx = static_index::build_static_index_resolved(&root_path, &files);
    let surface = features::build_wire_surface_index(&idx);
    let bytes = serde_json::to_vec(&surface)
        .map_err(|e| NapiError::new(Status::GenericFailure, e.to_string()))?;
    Ok(bytes.into())
}

// ---------------------------------------------------------------------
// Resident fast-path state for TS LSP queries.
// ---------------------------------------------------------------------

/// Info returned from a `native_init` call so the TS side can log
/// what got built and how long it took.
#[napi(object)]
pub struct NativeInitResult {
    pub root: String,
    pub model_count: u32,
    pub field_count: u32,
    pub edge_count: u32,
    pub elapsed_ms: u32,
    pub rebuilt: bool,
    /// Source tag: "ast" | "surface" | "hybrid".
    pub source: String,
    pub parsed_file_count: u32,
    pub parse_failure_count: u32,
    pub direct_model_count: u32,
    pub expanded_model_count: u32,
}

fn current_time_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Walk the workspace, parse all .py files with ruff, resolve forward
/// relations, synthesize reverse relations, and build the semantic
/// model graph — all in Rust, in one napi call. The result lives in a
/// process-global `RwLock` so subsequent fast-path queries complete in
/// microseconds without re-parsing.
///
/// Call again (with the same root) after significant workspace edits
/// to refresh. `force_rebuild=true` always rebuilds; otherwise a second
/// call on the same root is a no-op hit.
#[napi]
pub fn native_init(root: String, force_rebuild: Option<bool>) -> NapiResult<NativeInitResult> {
    let force = force_rebuild.unwrap_or(false);
    let root_path = PathBuf::from(&root);

    {
        let guard = NATIVE_STATE.read().map_err(poisoned)?;
        if !force {
            if let Some(existing) = guard.as_ref() {
                if existing.root == root_path {
                    return Ok(NativeInitResult {
                        root,
                        model_count: existing.static_index.model_candidates.len() as u32,
                        field_count: existing.static_index.fields.len() as u32,
                        edge_count: existing
                            .graph
                            .edges_by_source_label
                            .values()
                            .map(|v| v.len() as u32)
                            .sum(),
                        elapsed_ms: 0,
                        rebuilt: false,
                        source: "cache".into(),
                        parsed_file_count: 0,
                        parse_failure_count: 0,
                        direct_model_count: existing.static_index.model_candidates.len() as u32,
                        expanded_model_count: 0,
                    });
                }
            }
        }
    }

    let t0 = Instant::now();
    let snap = discovery::snapshot_python_sources(&root_path, &[]);
    let files: Vec<PathBuf> = snap
        .entries
        .iter()
        .map(|e| root_path.join(&e.relative_path))
        .collect();
    let mut idx = static_index::build_static_index(&root_path, &files);
    let parsed_file_count = idx.modules.len() as u32;
    let parse_failure_count = files.len().saturating_sub(idx.modules.len()) as u32;
    let direct_model_count = idx.model_candidates.len() as u32;
    idx.model_candidates =
        static_index::expand_via_inheritance(&idx.model_candidates, &mut idx.modules);
    let expanded_model_count = idx
        .model_candidates
        .len()
        .saturating_sub(direct_model_count as usize) as u32;
    let forward = static_index::resolve_fields(&idx.model_candidates, &idx.modules);
    let reverse = static_index::synthesize_reverse_relations(&forward, &idx.model_candidates);
    idx.fields = forward;
    idx.fields.extend(reverse);
    let graph = build_model_graph(&idx);
    let elapsed_ms = t0.elapsed().as_millis() as u32;

    let result = NativeInitResult {
        root: root.clone(),
        model_count: idx.model_candidates.len() as u32,
        field_count: idx.fields.len() as u32,
        edge_count: graph
            .edges_by_source_label
            .values()
            .map(|v| v.len() as u32)
            .sum(),
        elapsed_ms,
        rebuilt: true,
        source: "ast".into(),
        parsed_file_count,
        parse_failure_count,
        direct_model_count,
        expanded_model_count,
    };

    let mut guard = NATIVE_STATE.write().map_err(poisoned)?;
    *guard = Some(NativeState {
        root: root_path,
        static_index: idx,
        graph,
        built_at_ms: current_time_ms(),
    });
    Ok(result)
}

#[napi]
pub fn native_drop() {
    if let Ok(mut guard) = NATIVE_STATE.write() {
        *guard = None;
    }
}

/// Build the resident state from a Python-produced surfaceIndex. This
/// is the reliable coverage path — Python has already done the full
/// semantic analysis (import alias resolution, abstract base chains,
/// runtime managers) and packs everything into a compact wire format.
/// We rehydrate that into the same in-memory shapes the fast-path
/// queries expect.
///
/// `surface_bytes` must be JSON matching the TS `SurfaceIndex` shape:
///   { "app.Model": { "instance": { "name": ["returnKind", "returnModelLabel", "memberKind", "fieldKind"] } } }
///
/// Fields where `returnKind == "instance"` become forward-relation
/// FieldCandidates; `"related_manager"` become reverse; others become
/// scalar fields. This is less precise than AST-derived state (no
/// file/line info for fields, synthetic `fieldKind` when unknown) but
/// gives exact parity with Python's model coverage.
#[napi]
pub fn native_init_from_surface(
    root: String,
    surface_bytes: Buffer,
) -> NapiResult<NativeInitResult> {
    use django_orm_core::static_index::{
        DefinitionLocation, FieldCandidate, ModelCandidate, ModuleIndex, StaticIndex,
    };
    use std::collections::BTreeMap;

    let t0 = Instant::now();
    let root_path = PathBuf::from(&root);

    let surface_json: BTreeMap<String, BTreeMap<String, BTreeMap<String, Vec<Option<String>>>>> =
        serde_json::from_slice(&surface_bytes).map_err(|e| {
            NapiError::new(
                Status::InvalidArg,
                format!("surfaceIndex JSON parse failed: {e}"),
            )
        })?;

    let mut model_candidates: Vec<ModelCandidate> = Vec::with_capacity(surface_json.len());
    let mut fields: Vec<FieldCandidate> = Vec::new();

    for (label, receivers) in &surface_json {
        let (app_label, object_name) = match label.split_once('.') {
            Some((a, b)) => (a.to_string(), b.to_string()),
            None => (String::new(), label.clone()),
        };

        model_candidates.push(ModelCandidate {
            app_label: app_label.clone(),
            object_name: object_name.clone(),
            label: label.clone(),
            module: format!("{app_label}.models"),
            file_path: String::new(),
            line: 0,
            column: 0,
            is_abstract: false,
            base_class_refs: Vec::new(),
            source: "surface".into(),
        });

        if let Some(instance) = receivers.get("instance") {
            for (name, tuple) in instance {
                let return_kind = tuple.first().and_then(|s| s.as_ref().map(|x| x.as_str()));
                let return_target = tuple.get(1).and_then(|s| s.as_ref().cloned());
                let member_kind = tuple.get(2).and_then(|s| s.as_ref().map(|x| x.as_str()));
                if member_kind.is_some()
                    && member_kind != Some("field")
                    && member_kind != Some("relation")
                    && member_kind != Some("reverse_relation")
                {
                    continue;
                }
                if member_kind.is_none()
                    && features::INSTANCE_BUILTIN_METHODS
                        .iter()
                        .any(|m| m.name == name.as_str())
                {
                    continue;
                }
                let explicit_field_kind = tuple.get(3).and_then(|s| s.as_ref().cloned());

                let (is_relation, direction, fallback_field_kind) = match return_kind {
                    Some("instance") => (true, Some("forward".to_string()), "ForeignKey"),
                    Some("related_manager") => {
                        (true, Some("reverse".to_string()), "ReverseRelation")
                    }
                    Some("scalar") => (false, None, "Field"),
                    _ => continue,
                };
                let field_kind =
                    explicit_field_kind.unwrap_or_else(|| fallback_field_kind.to_string());
                let related_model_label = if is_relation {
                    return_target.clone()
                } else {
                    None
                };

                fields.push(FieldCandidate {
                    model_label: label.clone(),
                    name: name.clone(),
                    file_path: String::new(),
                    line: 0,
                    column: 0,
                    field_kind,
                    is_relation,
                    relation_direction: direction,
                    related_model_label: related_model_label.clone(),
                    declared_model_label: related_model_label,
                    related_name: None,
                    related_query_name: None,
                    source: "surface".into(),
                });
            }
        }
    }

    // No per-file ModuleIndex data from surface; leave empty. Graph
    // only needs model_candidates + fields.
    let static_index = StaticIndex {
        model_candidates: model_candidates.clone(),
        fields,
        modules: Vec::<ModuleIndex>::new(),
    };

    // Graph build from resolved fields.
    let graph = build_model_graph(&static_index);
    let elapsed_ms = t0.elapsed().as_millis() as u32;

    let edge_count: u32 = graph
        .edges_by_source_label
        .values()
        .map(|v| v.len() as u32)
        .sum();

    let result = NativeInitResult {
        root: root.clone(),
        model_count: static_index.model_candidates.len() as u32,
        field_count: static_index.fields.len() as u32,
        edge_count,
        elapsed_ms,
        rebuilt: true,
        source: "surface".into(),
        parsed_file_count: 0,
        parse_failure_count: 0,
        direct_model_count: static_index.model_candidates.len() as u32,
        expanded_model_count: 0,
    };

    let mut guard = NATIVE_STATE.write().map_err(poisoned)?;
    *guard = Some(NativeState {
        root: root_path,
        static_index,
        graph,
        built_at_ms: current_time_ms(),
    });
    // Silence unused import warning — DefinitionLocation is a type we
    // may need once we accept richer field metadata from surface.
    let _ = std::marker::PhantomData::<DefinitionLocation>;
    Ok(result)
}

#[napi(object)]
pub struct NativeStateInfo {
    pub initialized: bool,
    pub root: Option<String>,
    pub model_count: u32,
    pub field_count: u32,
    pub built_at_ms: String,
}

#[napi]
pub fn native_state_info() -> NativeStateInfo {
    if let Ok(guard) = NATIVE_STATE.read() {
        if let Some(s) = guard.as_ref() {
            return NativeStateInfo {
                initialized: true,
                root: Some(s.root.to_string_lossy().into_owned()),
                model_count: s.static_index.model_candidates.len() as u32,
                field_count: s.static_index.fields.len() as u32,
                built_at_ms: s.built_at_ms.to_string(),
            };
        }
    }
    NativeStateInfo {
        initialized: false,
        root: None,
        model_count: 0,
        field_count: 0,
        built_at_ms: "0".into(),
    }
}

fn poisoned(_: impl std::fmt::Display) -> NapiError {
    NapiError::new(
        Status::GenericFailure,
        "native state lock poisoned".to_string(),
    )
}

fn with_state<T>(f: impl FnOnce(&NativeState) -> NapiResult<T>) -> NapiResult<Option<T>> {
    let guard = NATIVE_STATE.read().map_err(poisoned)?;
    match guard.as_ref() {
        Some(s) => f(s).map(Some),
        None => Ok(None),
    }
}

/// Fast-path `resolveRelationTarget`. Returns JSON bytes matching the
/// shape the TS daemon currently receives from the Python side:
///   { resolved: bool, matchKind?, target?, candidates?, reason? }
/// Returns null when the native state is not yet initialised — caller
/// should fall back to Python IPC.
#[napi]
pub fn native_resolve_relation_target(value: String) -> NapiResult<Option<Buffer>> {
    with_state(|s| {
        let result = features::resolve_relation_target(&s.graph, &value);
        let v = relation_resolution_to_wire(&result);
        serde_json::to_vec(&v)
            .map(Into::into)
            .map_err(|e| NapiError::new(Status::GenericFailure, e.to_string()))
    })
}

fn relation_resolution_to_wire(result: &features::ResolutionResult) -> serde_json::Value {
    use serde_json::json;
    match result {
        features::ResolutionResult::Resolved { match_kind, target } => json!({
            "resolved": true,
            "matchKind": match_kind,
            "target": target,
        }),
        features::ResolutionResult::Ambiguous { reason, candidates } => json!({
            "resolved": false,
            "reason": reason,
            "candidates": candidates,
        }),
        features::ResolutionResult::Unresolved { reason } => json!({
            "resolved": false,
            "reason": reason,
        }),
    }
}

#[napi]
pub fn native_list_relation_targets(prefix: Option<String>) -> NapiResult<Option<Buffer>> {
    with_state(|s| {
        let list = features::list_relation_targets(&s.graph, prefix.as_deref());
        serde_json::to_vec(&list)
            .map(Into::into)
            .map_err(|e| NapiError::new(Status::GenericFailure, e.to_string()))
    })
}

/// Fast-path `resolveLookupPath`. Returns JSON matching the Python
/// daemon's shape with `resolved: bool`, `resolvedSegments`, `target`,
/// `lookupOperator` fields. null → caller should try Python.
#[napi]
pub fn native_resolve_lookup_path(
    base_model_label: String,
    value: String,
    method: String,
) -> NapiResult<Option<Buffer>> {
    with_state(|s| {
        let result = features::resolve_lookup_path(&s.graph, &base_model_label, &value, &method);
        let v = lookup_resolution_to_wire(s, &result);
        serde_json::to_vec(&v)
            .map(Into::into)
            .map_err(|e| NapiError::new(Status::GenericFailure, e.to_string()))
    })
}

/// Lift a `LookupSegment` into a wire-format `LookupPathItem` by
/// consulting the resident static index for extra metadata (filePath,
/// line, column, isRelation flag, source provenance). Matches the
/// shape TS `protocol.ts::LookupPathItem` expects from the Python
/// daemon.
fn enrich_lookup_segment(
    state: &NativeState,
    seg: &features::LookupSegment,
    lookup_operator: Option<&str>,
) -> serde_json::Value {
    use serde_json::json;
    let model_label = seg.model_label.as_deref().unwrap_or("");
    let mut is_relation = seg.kind == "relation";
    let mut field_kind = seg.field_kind.clone();
    let mut related_model_label: Option<String> = None;
    let mut relation_direction: Option<String> = None;
    let mut file_path: Option<String> = None;
    let mut line: Option<u32> = None;
    let mut column: Option<u32> = None;
    let mut source = "static".to_string();

    if !model_label.is_empty() {
        if let Some(f) = state
            .static_index
            .fields
            .iter()
            .find(|f| f.model_label == model_label && f.name == seg.name)
        {
            is_relation = f.is_relation;
            field_kind = Some(f.field_kind.clone());
            related_model_label = f.related_model_label.clone();
            relation_direction = f.relation_direction.clone();
            file_path = Some(f.file_path.clone());
            line = Some(f.line);
            column = Some(f.column);
            source = f.source.clone();
        }
    }

    json!({
        "name": seg.name,
        "modelLabel": model_label,
        "relatedModelLabel": related_model_label,
        "filePath": file_path,
        "line": line,
        "column": column,
        "fieldKind": field_kind.unwrap_or_else(|| "Unknown".into()),
        "isRelation": is_relation,
        "fieldPath": serde_json::Value::Null,
        "relationDirection": relation_direction,
        "source": source,
        "lookupOperator": lookup_operator,
    })
}

fn lookup_resolution_to_wire(
    state: &NativeState,
    result: &features::LookupResolution,
) -> serde_json::Value {
    use serde_json::json;
    match result {
        features::LookupResolution::Resolved {
            target,
            resolved_segments,
            base_model_label,
            lookup_operator,
        } => {
            let segs: Vec<serde_json::Value> = resolved_segments
                .iter()
                .map(|s| enrich_lookup_segment(state, s, None))
                .collect();
            let enriched_target = enrich_lookup_segment(state, target, lookup_operator.as_deref());
            json!({
                "resolved": true,
                "target": enriched_target,
                "resolvedSegments": segs,
                "baseModelLabel": base_model_label,
                "lookupOperator": lookup_operator,
            })
        }
        features::LookupResolution::Unresolved {
            reason,
            resolved_segments,
            missing_segment,
        } => {
            let segs: Option<Vec<serde_json::Value>> = resolved_segments.as_ref().map(|v| {
                v.iter()
                    .map(|s| enrich_lookup_segment(state, s, None))
                    .collect()
            });
            json!({
                "resolved": false,
                "reason": reason,
                "resolvedSegments": segs,
                "missingSegment": missing_segment,
            })
        }
    }
}

/// Fast-path `resolveOrmMember`. Builds a per-call OrmMemberItem for
/// `(modelLabel, receiverKind, name)` using the resident static index.
/// Returns JSON matching what the Python daemon sends, or null if we
/// don't know this member yet (caller falls back to Python for runtime
/// methods).
#[napi]
pub fn native_resolve_orm_member(
    model_label: String,
    receiver_kind: String,
    name: String,
    manager_name: Option<String>,
) -> NapiResult<Option<Buffer>> {
    let _ = manager_name; // reserved for custom-manager support (P6.2 follow-up)

    with_state(|s| {
        let maybe = resolve_member_from_state(&s.static_index, &model_label, &receiver_kind, &name);
        match maybe {
            Some(item) => serde_json::to_vec(&item)
                .map(Into::into)
                .map_err(|e| NapiError::new(Status::GenericFailure, e.to_string())),
            None => Ok(Buffer::from(b"null".to_vec())),
        }
    })
}

fn resolve_member_from_state(
    static_index: &StaticIndex,
    model_label: &str,
    receiver_kind: &str,
    name: &str,
) -> Option<features::OrmMemberItem> {
    // For instance/model_class we look at declared fields + reverse
    // relations. For manager/queryset/related_manager the surface is
    // the static Django method tables.
    if receiver_kind == "instance" {
        if let Some(f) = static_index
            .fields
            .iter()
            .find(|f| f.model_label == model_label && f.name == name)
        {
            let is_reverse = f.relation_direction.as_deref() == Some("reverse");
            return Some(features::OrmMemberItem {
                name: f.name.clone(),
                member_kind: "field".into(),
                model_label: f.model_label.clone(),
                receiver_kind: "instance".into(),
                detail: f.field_kind.clone(),
                source: f.source.clone(),
                return_kind: Some(if f.is_relation {
                    if is_reverse {
                        "related_manager".into()
                    } else {
                        "instance".into()
                    }
                } else {
                    "scalar".into()
                }),
                return_model_label: f.related_model_label.clone(),
                manager_name: None,
                file_path: Some(f.file_path.clone()),
                line: Some(f.line),
                column: Some(f.column),
                field_kind: Some(f.field_kind.clone()),
                is_relation: f.is_relation,
                signature: None,
            });
        }
        if let Some(info) = features::INSTANCE_BUILTIN_METHODS
            .iter()
            .find(|m| m.name == name)
        {
            return Some(feature_info_to_item(info, model_label, "instance"));
        }
        return None;
    }

    if receiver_kind == "model_class" && name == "objects" {
        return Some(features::OrmMemberItem {
            name: "objects".into(),
            member_kind: "manager".into(),
            model_label: model_label.to_string(),
            receiver_kind: "model_class".into(),
            detail: format!("Default manager for {model_label}"),
            source: "builtin".into(),
            return_kind: Some("manager".into()),
            return_model_label: Some(model_label.to_string()),
            manager_name: Some("objects".into()),
            file_path: None,
            line: None,
            column: None,
            field_kind: None,
            is_relation: false,
            signature: None,
        });
    }

    if receiver_kind == "manager" || receiver_kind == "related_manager" {
        if let Some(info) = features::QUERYSET_BUILTIN_METHODS
            .iter()
            .find(|m| m.name == name)
        {
            return Some(feature_info_to_item(info, model_label, receiver_kind));
        }
        if let Some(info) = features::MANAGER_BUILTIN_METHODS
            .iter()
            .find(|m| m.name == name)
        {
            return Some(feature_info_to_item(info, model_label, receiver_kind));
        }
        return None;
    }

    if receiver_kind == "queryset" {
        if let Some(info) = features::QUERYSET_BUILTIN_METHODS
            .iter()
            .find(|m| m.name == name)
        {
            return Some(feature_info_to_item(info, model_label, "queryset"));
        }
        return None;
    }

    None
}

fn feature_info_to_item(
    info: &features::BuiltinMethodInfo,
    model_label: &str,
    receiver_kind: &str,
) -> features::OrmMemberItem {
    let rk = match info.return_kind {
        features::BuiltinReturnKind::Queryset => "queryset",
        features::BuiltinReturnKind::Instance => "instance",
        features::BuiltinReturnKind::Scalar => "scalar",
        features::BuiltinReturnKind::None => "none",
        features::BuiltinReturnKind::Bool => "bool",
        features::BuiltinReturnKind::Unknown => "unknown",
    };
    features::OrmMemberItem {
        name: info.name.to_string(),
        member_kind: "method".into(),
        model_label: model_label.to_string(),
        receiver_kind: receiver_kind.to_string(),
        detail: info.description.to_string(),
        source: "builtin".into(),
        return_kind: Some(rk.to_string()),
        return_model_label: if matches!(
            info.return_kind,
            features::BuiltinReturnKind::Queryset | features::BuiltinReturnKind::Instance
        ) {
            Some(model_label.to_string())
        } else {
            None
        },
        manager_name: None,
        file_path: None,
        line: None,
        column: None,
        field_kind: None,
        is_relation: false,
        signature: Some(info.signature.to_string()),
    }
}
