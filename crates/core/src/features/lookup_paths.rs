//! Static lookup-path resolution. Minimal Rust port of the portable
//! subset of `features/lookup_paths.py`.
//!
//! Covered:
//!   - Built-in lookup operator table (matches Python
//!     `DEFAULT_LOOKUP_OPERATORS`).
//!   - Method classification (`FILTER_LOOKUP_METHODS`, etc).
//!   - `resolve_lookup_path` — walks `__`-separated segments across
//!     forward relations and identifies the terminal field or lookup
//!     operator.
//!
//! Deferred (still served by Python runtime inspector):
//!   - Custom lookups registered via `Field.register_lookup`.
//!   - Per-field `transforms` (date, time, jsonfield keys).
//!   - Reverse-relation traversal (needs full P4.2).

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
            model_label: terminal.related_model_label.clone(),
            field_kind: Some(terminal.field_kind.clone()),
        },
        resolved_segments: resolved,
        base_model_label: base_model_label.to_string(),
        lookup_operator,
    }
}

fn normalize_lookup_path(path: &str, _method: &str) -> String {
    path.trim().trim_start_matches('-').to_string()
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
}
