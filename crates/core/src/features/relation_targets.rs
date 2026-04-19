//! Rust port of `features/relation_targets.py`. Given a `ModelGraph`,
//! list all targetable models or resolve a user-supplied relation
//! string (e.g. "shop.User", "User") to a specific node.

use serde::Serialize;

use crate::semantic::{ModelGraph, ModelGraphNode};

const LIST_PREVIEW_LIMIT: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationTarget {
    pub app_label: String,
    pub object_name: String,
    pub label: String,
    pub module: String,
    pub import_path: String,
    pub source: String,
    pub field_names: Vec<String>,
    pub relation_names: Vec<String>,
    pub reverse_relation_names: Vec<String>,
    pub manager_names: Vec<String>,
    pub file_path: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

impl RelationTarget {
    fn from_node(node: &ModelGraphNode) -> Self {
        let preview = |v: &[String]| v.iter().take(LIST_PREVIEW_LIMIT).cloned().collect();
        RelationTarget {
            app_label: node.app_label.clone(),
            object_name: node.object_name.clone(),
            label: node.label.clone(),
            module: node.module.clone(),
            import_path: node.import_path.clone(),
            source: "static".into(),
            field_names: preview(&node.field_names),
            relation_names: preview(&node.relation_names),
            reverse_relation_names: preview(&node.reverse_relation_names),
            manager_names: node.manager_names.clone(),
            file_path: node.file_path.clone(),
            line: node.line,
            column: node.column,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolutionResult {
    Resolved {
        #[serde(rename = "matchKind")]
        match_kind: String,
        target: RelationTarget,
    },
    Ambiguous {
        reason: String,
        candidates: Vec<RelationTarget>,
    },
    Unresolved {
        reason: String,
    },
}

pub fn list_relation_targets(graph: &ModelGraph, prefix: Option<&str>) -> Vec<RelationTarget> {
    let normalized = prefix.unwrap_or("").trim().to_ascii_lowercase();
    let mut out: Vec<RelationTarget> = graph
        .nodes_by_label
        .values()
        .map(RelationTarget::from_node)
        .collect();

    if !normalized.is_empty() {
        out.retain(|t| matches_prefix(t, &normalized));
    }

    out.sort_by(|a, b| {
        // Future: runtime nodes first; here all static, so fall through.
        a.label
            .to_ascii_lowercase()
            .cmp(&b.label.to_ascii_lowercase())
    });

    out
}

pub fn resolve_relation_target(graph: &ModelGraph, value: &str) -> ResolutionResult {
    let normalized = value.trim();
    if normalized.is_empty() {
        return ResolutionResult::Unresolved {
            reason: "empty".into(),
        };
    }
    if normalized == "self" {
        return ResolutionResult::Unresolved {
            reason: "self_requires_context".into(),
        };
    }

    if let Some(node) = graph.node_for_model(normalized) {
        return ResolutionResult::Resolved {
            match_kind: "exact_label".into(),
            target: RelationTarget::from_node(node),
        };
    }

    if let Some(node) = graph.node_for_import_path(normalized) {
        return ResolutionResult::Resolved {
            match_kind: "exact_import_path".into(),
            target: RelationTarget::from_node(node),
        };
    }

    if !normalized.contains('.') {
        let nodes = graph.nodes_for_object_name(normalized);
        match nodes.len() {
            1 => {
                return ResolutionResult::Resolved {
                    match_kind: "unique_object_name".into(),
                    target: RelationTarget::from_node(nodes[0]),
                };
            }
            n if n > 1 => {
                return ResolutionResult::Ambiguous {
                    reason: "ambiguous_object_name".into(),
                    candidates: nodes.iter().map(|n| RelationTarget::from_node(n)).collect(),
                };
            }
            _ => {}
        }
    }

    ResolutionResult::Unresolved {
        reason: "not_found".into(),
    }
}

fn matches_prefix(target: &RelationTarget, normalized_prefix: &str) -> bool {
    target
        .label
        .to_ascii_lowercase()
        .starts_with(normalized_prefix)
        || target
            .object_name
            .to_ascii_lowercase()
            .starts_with(normalized_prefix)
        || target
            .module
            .to_ascii_lowercase()
            .starts_with(normalized_prefix)
        || target
            .import_path
            .to_ascii_lowercase()
            .starts_with(normalized_prefix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::build_model_graph;
    use crate::static_index::build_static_index_resolved;
    use std::fs;

    fn write(root: &std::path::Path, files: &[(&str, &str)]) {
        for (rel, content) in files {
            let full = root.join(rel);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(full, content).unwrap();
        }
    }

    fn sample_graph() -> ModelGraph {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            &[
                (
                    "shop/models.py",
                    "from django.db import models\nclass User(models.Model):\n    pass\nclass Order(models.Model):\n    pass\n",
                ),
                (
                    "billing/models.py",
                    "from django.db import models\nclass User(models.Model):\n    pass\n",
                ),
            ],
        );
        let idx = build_static_index_resolved(
            root,
            &[root.join("shop/models.py"), root.join("billing/models.py")],
        );
        build_model_graph(&idx)
    }

    #[test]
    fn list_sorts_by_label() {
        let g = sample_graph();
        let all = list_relation_targets(&g, None);
        let labels: Vec<&str> = all.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(labels, vec!["billing.User", "shop.Order", "shop.User"]);
    }

    #[test]
    fn list_filters_by_prefix() {
        let g = sample_graph();
        let shops = list_relation_targets(&g, Some("shop"));
        assert!(shops.iter().all(|t| t.label.starts_with("shop.")));
    }

    #[test]
    fn resolves_exact_label() {
        let g = sample_graph();
        let r = resolve_relation_target(&g, "shop.User");
        assert!(matches!(
            r,
            ResolutionResult::Resolved { match_kind, .. } if match_kind == "exact_label"
        ));
    }

    #[test]
    fn resolves_import_path() {
        let g = sample_graph();
        let r = resolve_relation_target(&g, "shop.models.User");
        assert!(matches!(
            r,
            ResolutionResult::Resolved { match_kind, .. } if match_kind == "exact_import_path"
        ));
    }

    #[test]
    fn ambiguous_object_name() {
        let g = sample_graph();
        let r = resolve_relation_target(&g, "User");
        assert!(matches!(r, ResolutionResult::Ambiguous { .. }));
    }

    #[test]
    fn not_found_on_missing() {
        let g = sample_graph();
        let r = resolve_relation_target(&g, "missing.Thing");
        assert!(matches!(r, ResolutionResult::Unresolved { reason } if reason == "not_found"));
    }

    #[test]
    fn self_reserved() {
        let g = sample_graph();
        let r = resolve_relation_target(&g, "self");
        assert!(
            matches!(r, ResolutionResult::Unresolved { reason } if reason == "self_requires_context")
        );
    }
}
