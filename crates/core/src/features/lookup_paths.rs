//! Static lookup-path resolution. Rust port of `features/lookup_paths.py`.
//!
//! Covered:
//!   - Built-in lookup operator table (matches Python
//!     `DEFAULT_LOOKUP_OPERATORS`).
//!   - Method classification (`FILTER_LOOKUP_METHODS`, etc).
//!   - `resolve_lookup_path` — walks `__`-separated segments across
//!     forward relations and identifies the terminal field or lookup
//!     operator.
//!   - `list_lookup_path_completions` — bulk completion item generator
//!     for `filter()`/`select_related()`/etc argument positions.
//!
//! Deferred (still served by Python runtime inspector):
//!   - Custom lookups registered via `Field.register_lookup`.
//!   - Per-field `transforms` (date, time, jsonfield keys).

use std::collections::{BTreeMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::semantic::ModelGraph;
use crate::static_index::FieldCandidate;

pub const RELATION_ONLY_METHODS: &[&str] = &["select_related", "prefetch_related"];
pub const ATTRIBUTE_PATH_METHODS: &[&str] =
    &["select_related", "prefetch_related", "only", "defer"];
pub const FILTER_LOOKUP_METHODS: &[&str] = &[
    "filter",
    "exclude",
    "get",
    "get_or_create",
    "update_or_create",
];
pub const DEFAULT_LOOKUP_OPERATORS: &[&str] = &[
    "exact",
    "iexact",
    "contains",
    "icontains",
    "in",
    "gt",
    "gte",
    "lt",
    "lte",
    "startswith",
    "istartswith",
    "endswith",
    "iendswith",
    "range",
    "isnull",
    "regex",
    "iregex",
    "date",
    "year",
    "month",
    "day",
    "week",
    "week_day",
    "quarter",
    "time",
    "hour",
    "minute",
    "second",
];

pub fn is_filter_method(method: &str) -> bool {
    FILTER_LOOKUP_METHODS.contains(&method)
}

pub fn is_relation_only_method(method: &str) -> bool {
    RELATION_ONLY_METHODS.contains(&method)
}

pub fn is_attribute_path_method(method: &str) -> bool {
    ATTRIBUTE_PATH_METHODS.contains(&method)
}

pub fn is_default_lookup_operator(name: &str) -> bool {
    DEFAULT_LOOKUP_OPERATORS.contains(&name)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupSegment {
    pub name: String,
    pub kind: String,
    pub model_label: Option<String>,
    pub field_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LookupResolution {
    Resolved {
        target: LookupSegment,
        #[serde(rename = "resolvedSegments")]
        resolved_segments: Vec<LookupSegment>,
        #[serde(rename = "baseModelLabel")]
        base_model_label: String,
        #[serde(rename = "lookupOperator")]
        lookup_operator: Option<String>,
    },
    Unresolved {
        reason: String,
        #[serde(rename = "resolvedSegments", skip_serializing_if = "Option::is_none")]
        resolved_segments: Option<Vec<LookupSegment>>,
        #[serde(rename = "missingSegment", skip_serializing_if = "Option::is_none")]
        missing_segment: Option<String>,
    },
}

/// Walk a `__`-separated lookup path starting from `base_model_label`
/// and report whether it resolves to a concrete field (and optionally
/// a lookup operator on the terminal scalar field).
///
/// Custom runtime lookups are not consulted — a falling-through path
/// will be reported as `Unresolved { reason: "segment_not_found" }`
/// and the Python runtime can be asked as a secondary step.
pub fn resolve_lookup_path(
    graph: &ModelGraph,
    base_model_label: &str,
    path: &str,
    method: &str,
) -> LookupResolution {
    let normalized = normalize_lookup_path(path, method);
    if normalized.is_empty() {
        return LookupResolution::Unresolved {
            reason: "empty".into(),
            resolved_segments: None,
            missing_segment: None,
        };
    }

    let segments: Vec<&str> = normalized.split("__").filter(|s| !s.is_empty()).collect();
    let mut current_label = base_model_label.to_string();
    let mut resolved: Vec<LookupSegment> = Vec::new();
    let mut terminal: Option<FieldCandidate> = None;
    let mut lookup_operator: Option<String> = None;

    for (i, segment) in segments.iter().enumerate() {
        let field = graph.find_field(&current_label, segment).cloned();
        let Some(field) = field else {
            // Terminal-field scalar lookup fallthrough.
            if is_filter_method(method) && terminal.is_some() {
                if is_default_lookup_operator(segment) {
                    // Only accept if remaining segments collapse into a
                    // single operator — chained transforms require
                    // runtime knowledge.
                    if i == segments.len() - 1 {
                        lookup_operator = Some((*segment).to_string());
                        break;
                    }
                }
            }
            return LookupResolution::Unresolved {
                reason: "segment_not_found".into(),
                resolved_segments: Some(resolved),
                missing_segment: Some((*segment).to_string()),
            };
        };

        resolved.push(LookupSegment {
            name: field.name.clone(),
            kind: if field.is_relation {
                "relation".into()
            } else {
                "field".into()
            },
            model_label: Some(current_label.clone()),
            field_kind: Some(field.field_kind.clone()),
        });
        terminal = Some(field.clone());

        let is_last = i == segments.len() - 1;
        if is_last {
            break;
        }

        if field.is_relation && field.related_model_label.is_some() {
            current_label = field.related_model_label.clone().unwrap();
            continue;
        }

        // Scalar mid-path on a filter method: remaining segments are
        // treated as lookup operators.
        if is_filter_method(method) {
            let remaining: Vec<&str> = segments[i + 1..].to_vec();
            if remaining.len() == 1 && is_default_lookup_operator(remaining[0]) {
                lookup_operator = Some(remaining[0].to_string());
                break;
            }
            return LookupResolution::Unresolved {
                reason: "unknown_lookup".into(),
                resolved_segments: Some(resolved),
                missing_segment: remaining.first().map(|s| (*s).to_string()),
            };
        }

        return LookupResolution::Unresolved {
            reason: "non_relation_intermediate".into(),
            resolved_segments: Some(resolved),
            missing_segment: Some((*segment).to_string()),
        };
    }

    let Some(terminal) = terminal else {
        return LookupResolution::Unresolved {
            reason: "empty".into(),
            resolved_segments: None,
            missing_segment: None,
        };
    };

    if is_relation_only_method(method) && !terminal.is_relation {
        return LookupResolution::Unresolved {
            reason: "relation_required".into(),
            resolved_segments: Some(resolved),
            missing_segment: None,
        };
    }

    LookupResolution::Resolved {
        target: LookupSegment {
            name: terminal.name.clone(),
            kind: if terminal.is_relation {
                "relation".into()
            } else {
                "field".into()
            },
            // Owning model where the terminal field is declared.
            // Mirrors Python's `_lookup_item_dict`:
            //   modelLabel = field.model_label  (owner)
            //   relatedModelLabel = field.related_model_label  (target)
            // The TS hover surfaces `Owner model:` from this field.
            model_label: Some(terminal.model_label.clone()),
            field_kind: Some(terminal.field_kind.clone()),
        },
        resolved_segments: resolved,
        base_model_label: base_model_label.to_string(),
        lookup_operator,
    }
}

fn normalize_lookup_path(path: &str, method: &str) -> String {
    let trimmed = path.trim();
    if method == "order_by" && trimmed.starts_with('-') {
        return trimmed[1..].to_string();
    }
    trimmed.to_string()
}

// ---------------------------------------------------------------------
// Bulk lookup-path completions (port of `list_lookup_path_completions`).
// ---------------------------------------------------------------------

/// Single completion item. Wire-compatible with the TS
/// `LookupPathItem` shape (camelCase fields, optional fields omitted
/// when `None`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupPathItem {
    pub name: String,
    pub model_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_model_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub field_kind: String,
    pub is_relation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relation_direction: Option<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lookup_operator: Option<String>,
}

/// Aggregate response mirroring TS `LookupPathCompletionsResult`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupPathCompletionsResult {
    pub items: Vec<LookupPathItem>,
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_model_label: Option<String>,
    pub truncated: bool,
}

fn allows_related_query_aliases(method: &str) -> bool {
    !is_attribute_path_method(method)
}

fn is_hidden_lookup_field_name(name: &str) -> bool {
    name.ends_with('+')
}

fn is_related_query_alias_field(
    graph: &ModelGraph,
    model_label: &str,
    field: &FieldCandidate,
) -> bool {
    if field.source == "related_query_alias" {
        return true;
    }

    if field.relation_direction.as_deref() != Some("reverse") || field.name.ends_with("_set") {
        return false;
    }

    let Some(target_model_label) = field.related_model_label.as_ref() else {
        return false;
    };

    graph.fields_for_model(model_label).iter().any(|candidate| {
        candidate.name != field.name
            && candidate.relation_direction.as_deref() == Some("reverse")
            && candidate.related_model_label.as_ref() == Some(target_model_label)
            && candidate.name.ends_with("_set")
    })
}

/// Fields eligible for `method` on `model_label`. Matches the Python
/// `_lookup_fields_for_method` filter: hides `+`-suffixed reverse
/// relation placeholders, and for attribute-path methods also hides
/// `related_query_alias` synthetic entries.
fn lookup_fields_for_method<'g>(
    graph: &'g ModelGraph,
    model_label: &str,
    method: &str,
) -> Vec<&'g FieldCandidate> {
    let fields = graph.fields_for_model(model_label);
    let allow_alias = allows_related_query_aliases(method);
    fields
        .iter()
        .filter(|f| !is_hidden_lookup_field_name(&f.name))
        .filter(|f| allow_alias || !is_related_query_alias_field(graph, model_label, f))
        .collect()
}

fn lookup_field_for_method<'g>(
    graph: &'g ModelGraph,
    model_label: &str,
    field_name: &str,
    method: &str,
) -> Option<&'g FieldCandidate> {
    let field = graph.find_field(model_label, field_name)?;
    if is_hidden_lookup_field_name(&field.name) {
        return None;
    }
    if !allows_related_query_aliases(method)
        && is_related_query_alias_field(graph, model_label, field)
    {
        return None;
    }
    Some(field)
}

fn split_lookup_prefix(prefix: &str) -> (Vec<String>, String) {
    if prefix.is_empty() {
        return (Vec::new(), String::new());
    }
    if prefix.ends_with("__") {
        return (
            prefix
                .split("__")
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect(),
            String::new(),
        );
    }
    let parts: Vec<&str> = prefix.split("__").collect();
    let (head, tail) = parts.split_at(parts.len() - 1);
    (
        head.iter()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect(),
        tail[0].to_string(),
    )
}

fn item_from_field(field: &FieldCandidate) -> LookupPathItem {
    LookupPathItem {
        name: field.name.clone(),
        model_label: field.model_label.clone(),
        related_model_label: field.related_model_label.clone(),
        file_path: if field.file_path.is_empty() {
            None
        } else {
            Some(field.file_path.clone())
        },
        line: if field.line == 0 { None } else { Some(field.line) },
        column: if field.column == 0 {
            None
        } else {
            Some(field.column)
        },
        field_kind: field.field_kind.clone(),
        is_relation: field.is_relation,
        field_path: Some(field.name.clone()),
        relation_direction: field.relation_direction.clone(),
        source: field.source.clone(),
        lookup_operator: None,
    }
}

fn item_with_path_name(path_name: &str, field: &FieldCandidate) -> LookupPathItem {
    let mut item = item_from_field(field);
    item.name = path_name.to_string();
    item.field_path = Some(path_name.to_string());
    item
}

fn lookup_operator_item(
    owner_model_label: &str,
    operator: &str,
    field_path: Option<&str>,
) -> LookupPathItem {
    LookupPathItem {
        name: operator.to_string(),
        model_label: owner_model_label.to_string(),
        related_model_label: None,
        file_path: None,
        line: None,
        column: None,
        field_kind: "lookup_operator".into(),
        is_relation: false,
        field_path: field_path.map(|s| s.to_string()),
        relation_direction: None,
        source: "django_lookup".into(),
        lookup_operator: Some(operator.to_string()),
    }
}

enum CompletionMode {
    Field,
    FieldAndLookup,
    LookupChain,
}

struct TraversalResult {
    resolved: bool,
    reason: Option<String>,
    current_model_label: Option<String>,
    completion_mode: Option<CompletionMode>,
    lookup_field_owner: Option<String>,
    lookup_field_name: Option<String>,
}

impl TraversalResult {
    fn unresolved(reason: &str) -> Self {
        Self {
            resolved: false,
            reason: Some(reason.into()),
            current_model_label: None,
            completion_mode: None,
            lookup_field_owner: None,
            lookup_field_name: None,
        }
    }
}

fn analyze_lookup_completion_context(
    graph: &ModelGraph,
    base_model_label: &str,
    segments: &[String],
    method: &str,
) -> TraversalResult {
    let mut current_model_label = base_model_label.to_string();
    let mut last_field: Option<FieldCandidate> = None;
    let mut index = 0usize;
    let mut visited_models: HashSet<String> = HashSet::new();
    visited_models.insert(base_model_label.to_string());

    while index < segments.len() {
        let segment = &segments[index];
        let field =
            match lookup_field_for_method(graph, &current_model_label, segment.as_str(), method) {
                Some(f) => f.clone(),
                None => return TraversalResult::unresolved("segment_not_found"),
            };

        let next_segment = if index + 1 < segments.len() {
            Some(segments[index + 1].as_str())
        } else {
            None
        };
        last_field = Some(field.clone());

        match next_segment {
            None => {
                if field.is_relation && field.related_model_label.is_some() {
                    let target = field.related_model_label.clone().unwrap();
                    if FILTER_LOOKUP_METHODS.contains(&method) {
                        return TraversalResult {
                            resolved: true,
                            reason: None,
                            current_model_label: Some(target),
                            completion_mode: Some(CompletionMode::FieldAndLookup),
                            lookup_field_owner: Some(field.model_label.clone()),
                            lookup_field_name: Some(field.name.clone()),
                        };
                    }
                    return TraversalResult {
                        resolved: true,
                        reason: None,
                        current_model_label: Some(target),
                        completion_mode: Some(CompletionMode::Field),
                        lookup_field_owner: None,
                        lookup_field_name: None,
                    };
                }
                if FILTER_LOOKUP_METHODS.contains(&method) {
                    return TraversalResult {
                        resolved: true,
                        reason: None,
                        current_model_label: None,
                        completion_mode: Some(CompletionMode::LookupChain),
                        lookup_field_owner: Some(field.model_label.clone()),
                        lookup_field_name: Some(field.name.clone()),
                    };
                }
                return TraversalResult::unresolved("non_relation_intermediate");
            }
            Some(next_name) => {
                if field.is_relation && field.related_model_label.is_some() {
                    let target = field.related_model_label.clone().unwrap();
                    let next_field = lookup_field_for_method(graph, &target, next_name, method);
                    if next_field.is_some() {
                        if visited_models.contains(&target) {
                            // Cycle detected — stop and report current model.
                            return TraversalResult {
                                resolved: true,
                                reason: None,
                                current_model_label: Some(target),
                                completion_mode: Some(CompletionMode::Field),
                                lookup_field_owner: None,
                                lookup_field_name: None,
                            };
                        }
                        visited_models.insert(target.clone());
                        current_model_label = target;
                        index += 1;
                        continue;
                    }
                    if FILTER_LOOKUP_METHODS.contains(&method) {
                        return TraversalResult {
                            resolved: true,
                            reason: None,
                            current_model_label: None,
                            completion_mode: Some(CompletionMode::LookupChain),
                            lookup_field_owner: Some(field.model_label.clone()),
                            lookup_field_name: Some(field.name.clone()),
                        };
                    }
                    return TraversalResult::unresolved("segment_not_found");
                }

                if FILTER_LOOKUP_METHODS.contains(&method) {
                    return TraversalResult {
                        resolved: true,
                        reason: None,
                        current_model_label: None,
                        completion_mode: Some(CompletionMode::LookupChain),
                        lookup_field_owner: Some(field.model_label.clone()),
                        lookup_field_name: Some(field.name.clone()),
                    };
                }
                return TraversalResult::unresolved("non_relation_intermediate");
            }
        }
    }

    if let Some(last) = last_field {
        if FILTER_LOOKUP_METHODS.contains(&method) && !last.is_relation {
            return TraversalResult {
                resolved: true,
                reason: None,
                current_model_label: None,
                completion_mode: Some(CompletionMode::LookupChain),
                lookup_field_owner: Some(last.model_label.clone()),
                lookup_field_name: Some(last.name.clone()),
            };
        }
    }

    TraversalResult {
        resolved: true,
        reason: None,
        current_model_label: Some(current_model_label),
        completion_mode: Some(CompletionMode::Field),
        lookup_field_owner: None,
        lookup_field_name: None,
    }
}

// Per-graph descendant-completion cache. Keyed by (graph_addr,
// model_label, method, relation_only). Cleared when the caller passes
// a graph with a different memory address.
type DescendantCacheKey = (usize, String, String, bool);
type DescendantCacheVal = Vec<LookupPathItem>;

fn descendant_cache() -> &'static Mutex<BTreeMap<DescendantCacheKey, DescendantCacheVal>> {
    static CACHE: OnceLock<Mutex<BTreeMap<DescendantCacheKey, DescendantCacheVal>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Invalidate the descendant completion cache. Call when the resident
/// model graph is rebuilt.
pub fn clear_descendant_cache() {
    if let Ok(mut guard) = descendant_cache().lock() {
        guard.clear();
    }
}

fn descendant_completion_items(
    graph: &ModelGraph,
    model_label: &str,
    method: &str,
    relation_only: bool,
) -> Vec<LookupPathItem> {
    let graph_addr = graph as *const _ as usize;
    let key = (
        graph_addr,
        model_label.to_string(),
        method.to_string(),
        relation_only,
    );

    if let Ok(mut guard) = descendant_cache().lock() {
        if let Some(hit) = guard.get(&key) {
            return hit.clone();
        }

        let mut items_by_name: BTreeMap<String, LookupPathItem> = BTreeMap::new();
        for relation_field in lookup_fields_for_method(graph, model_label, method) {
            if !relation_field.is_relation {
                continue;
            }
            let Some(ref target_label) = relation_field.related_model_label else {
                continue;
            };
            for child_field in lookup_fields_for_method(graph, target_label, method) {
                if relation_only && !child_field.is_relation {
                    continue;
                }
                let path_name = format!("{}__{}", relation_field.name, child_field.name);
                items_by_name
                    .entry(path_name.clone())
                    .or_insert_with(|| item_with_path_name(&path_name, child_field));
            }
        }
        let result: Vec<LookupPathItem> = items_by_name.into_values().collect();
        guard.insert(key, result.clone());
        return result;
    }

    Vec::new()
}

fn lookup_chain_completion_items(
    owner_model_label: &str,
    field_path: Option<&str>,
    current_partial: &str,
) -> Vec<LookupPathItem> {
    DEFAULT_LOOKUP_OPERATORS
        .iter()
        .filter(|op| op.starts_with(current_partial))
        .map(|op| lookup_operator_item(owner_model_label, op, field_path))
        .collect()
}

fn prefixed_lookup_chain_items(
    owner_model_label: &str,
    fields: &[&FieldCandidate],
) -> Vec<LookupPathItem> {
    let mut items_by_name: BTreeMap<String, LookupPathItem> = BTreeMap::new();
    for field in fields {
        for operator in DEFAULT_LOOKUP_OPERATORS {
            let path_name = format!("{}__{}", field.name, operator);
            items_by_name.entry(path_name.clone()).or_insert_with(|| {
                let mut item =
                    lookup_operator_item(owner_model_label, operator, Some(&field.name));
                item.name = path_name.clone();
                item
            });
        }
    }
    items_by_name.into_values().collect()
}

fn lookup_completion_group(item: &LookupPathItem) -> u8 {
    if item.field_kind == "lookup_operator" || item.field_kind == "lookup_transform" {
        return 1;
    }
    if item.name.contains("__") {
        return 2;
    }
    0
}

/// Generate completion items for `prefix` at an ORM call site on
/// `base_model_label` under `method` (e.g. `filter`, `select_related`).
///
/// Mirrors Python `list_lookup_path_completions` minus the runtime
/// inspector hook — custom runtime lookups (`Field.register_lookup`)
/// and transforms are not emitted; callers should still route through
/// Python for that coverage when needed.
pub fn list_lookup_path_completions(
    graph: &ModelGraph,
    base_model_label: &str,
    prefix: &str,
    method: &str,
) -> LookupPathCompletionsResult {
    let normalized = normalize_lookup_path(prefix, method);
    let (completed_segments, current_partial) = split_lookup_prefix(&normalized);
    let traversal =
        analyze_lookup_completion_context(graph, base_model_label, &completed_segments, method);
    if !traversal.resolved {
        return LookupPathCompletionsResult {
            items: Vec::new(),
            resolved: false,
            reason: traversal.reason,
            current_model_label: None,
            truncated: false,
        };
    }

    let include_prefixed_lookup_items = is_filter_method(method)
        && (!current_partial.is_empty() || completed_segments.is_empty());
    let include_eager_descendants = completed_segments.len() <= 2;

    let mut items: Vec<LookupPathItem> = Vec::new();
    match traversal.completion_mode {
        Some(CompletionMode::Field) | Some(CompletionMode::FieldAndLookup) => {
            let current_label = traversal
                .current_model_label
                .clone()
                .unwrap_or_else(|| base_model_label.to_string());
            let relation_only = is_relation_only_method(method);
            let matching_fields: Vec<&FieldCandidate> =
                lookup_fields_for_method(graph, &current_label, method)
                    .into_iter()
                    .filter(|f| (f.is_relation || !relation_only) && f.name.starts_with(&current_partial))
                    .collect();
            for field in &matching_fields {
                items.push(item_from_field(field));
            }
            if include_prefixed_lookup_items {
                items.extend(prefixed_lookup_chain_items(&current_label, &matching_fields));
            }
            if include_eager_descendants {
                items.extend(
                    descendant_completion_items(graph, &current_label, method, relation_only)
                        .into_iter()
                        .filter(|item| item.name.starts_with(&current_partial)),
                );
            }
            if matches!(
                traversal.completion_mode,
                Some(CompletionMode::FieldAndLookup)
            ) {
                if let (Some(owner), Some(_field_name)) = (
                    traversal.lookup_field_owner.as_deref(),
                    traversal.lookup_field_name.as_deref(),
                ) {
                    items.extend(lookup_chain_completion_items(
                        owner,
                        traversal.lookup_field_name.as_deref(),
                        &current_partial,
                    ));
                }
            }
        }
        Some(CompletionMode::LookupChain) => {
            if let (Some(owner), Some(_field_name)) = (
                traversal.lookup_field_owner.as_deref(),
                traversal.lookup_field_name.as_deref(),
            ) {
                items.extend(lookup_chain_completion_items(
                    owner,
                    traversal.lookup_field_name.as_deref(),
                    &current_partial,
                ));
            }
        }
        None => {}
    }

    // Sort: group (field→prefixed→lookup_op) → segment count → relations first → name.
    items.sort_by(|a, b| {
        lookup_completion_group(a)
            .cmp(&lookup_completion_group(b))
            .then(a.name.matches("__").count().cmp(&b.name.matches("__").count()))
            .then((!a.is_relation).cmp(&!b.is_relation))
            .then(a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
    });

    LookupPathCompletionsResult {
        items,
        resolved: true,
        reason: None,
        current_model_label: traversal.current_model_label,
        truncated: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::build_model_graph;
    use crate::static_index::build_static_index_resolved;
    use std::fs;

    fn sample_graph() -> ModelGraph {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("shop")).unwrap();
        fs::write(
            root.join("shop/models.py"),
            "from django.db import models\nclass User(models.Model):\n    email = models.CharField(max_length=200)\n    age = models.IntegerField()\n\nclass Order(models.Model):\n    buyer = models.ForeignKey('shop.User', on_delete=models.CASCADE)\n    quantity = models.IntegerField()\n",
        )
        .unwrap();
        let idx = build_static_index_resolved(root, &[root.join("shop/models.py")]);
        build_model_graph(&idx)
    }

    #[test]
    fn resolves_simple_field() {
        let g = sample_graph();
        let r = resolve_lookup_path(&g, "shop.Order", "quantity", "filter");
        match r {
            LookupResolution::Resolved { target, .. } => {
                assert_eq!(target.name, "quantity");
                assert_eq!(target.kind, "field");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn resolves_relation_traversal() {
        let g = sample_graph();
        let r = resolve_lookup_path(&g, "shop.Order", "buyer__email", "filter");
        match r {
            LookupResolution::Resolved {
                target,
                resolved_segments,
                ..
            } => {
                assert_eq!(resolved_segments.len(), 2);
                assert_eq!(resolved_segments[0].name, "buyer");
                assert_eq!(resolved_segments[1].name, "email");
                assert_eq!(target.name, "email");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn resolves_lookup_operator() {
        let g = sample_graph();
        let r = resolve_lookup_path(&g, "shop.Order", "quantity__gte", "filter");
        match r {
            LookupResolution::Resolved {
                lookup_operator,
                target,
                ..
            } => {
                assert_eq!(lookup_operator, Some("gte".into()));
                assert_eq!(target.name, "quantity");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn unresolved_when_segment_missing() {
        let g = sample_graph();
        let r = resolve_lookup_path(&g, "shop.Order", "bogus", "filter");
        match r {
            LookupResolution::Unresolved {
                reason,
                missing_segment,
                ..
            } => {
                assert_eq!(reason, "segment_not_found");
                assert_eq!(missing_segment.as_deref(), Some("bogus"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn relation_required_for_select_related() {
        let g = sample_graph();
        let r = resolve_lookup_path(&g, "shop.Order", "quantity", "select_related");
        match r {
            LookupResolution::Unresolved { reason, .. } => {
                assert_eq!(reason, "relation_required");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    fn completion_names(items: &[LookupPathItem]) -> Vec<String> {
        items.iter().map(|i| i.name.clone()).collect()
    }

    #[test]
    fn completion_empty_prefix_lists_all_fields_and_descendants() {
        clear_descendant_cache();
        let g = sample_graph();
        let r = list_lookup_path_completions(&g, "shop.Order", "", "filter");
        assert!(r.resolved);
        let names = completion_names(&r.items);
        assert!(names.contains(&"buyer".to_string()));
        assert!(names.contains(&"quantity".to_string()));
        assert!(names.iter().any(|n| n.starts_with("buyer__")));
    }

    #[test]
    fn completion_prefix_narrows_to_matching_field() {
        clear_descendant_cache();
        let g = sample_graph();
        let r = list_lookup_path_completions(&g, "shop.Order", "quan", "filter");
        assert!(r.resolved);
        let names = completion_names(&r.items);
        assert!(names.iter().any(|n| n == "quantity"));
        assert!(!names.iter().any(|n| n == "buyer"));
    }

    #[test]
    fn completion_after_relation_segment_lists_child_fields() {
        clear_descendant_cache();
        let g = sample_graph();
        let r = list_lookup_path_completions(&g, "shop.Order", "buyer__", "filter");
        assert!(r.resolved);
        assert_eq!(r.current_model_label.as_deref(), Some("shop.User"));
        let names = completion_names(&r.items);
        assert!(names.iter().any(|n| n == "email"));
        assert!(names.iter().any(|n| n == "age"));
    }

    #[test]
    fn completion_after_scalar_segment_lists_lookup_operators() {
        clear_descendant_cache();
        let g = sample_graph();
        let r = list_lookup_path_completions(&g, "shop.Order", "quantity__", "filter");
        assert!(r.resolved);
        let names = completion_names(&r.items);
        assert!(names.iter().any(|n| n == "gte"));
        assert!(names.iter().any(|n| n == "lt"));
        assert!(!names.iter().any(|n| n == "buyer"));
    }

    #[test]
    fn completion_for_select_related_filters_scalars() {
        clear_descendant_cache();
        let g = sample_graph();
        let r = list_lookup_path_completions(&g, "shop.Order", "", "select_related");
        assert!(r.resolved);
        let names = completion_names(&r.items);
        assert!(names.contains(&"buyer".to_string()));
        assert!(!names.contains(&"quantity".to_string()));
    }

    #[test]
    fn completion_segment_missing_reports_unresolved() {
        clear_descendant_cache();
        let g = sample_graph();
        let r = list_lookup_path_completions(&g, "shop.Order", "bogus__foo", "filter");
        assert!(!r.resolved);
        assert_eq!(r.reason.as_deref(), Some("segment_not_found"));
    }
}
