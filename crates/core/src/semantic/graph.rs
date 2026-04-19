//! Minimal `ModelGraph` built from resolved `FieldCandidate`s.
//!
//! Scope: forward-edge graph keyed by model label, with indices by
//! object name and module import path. Reverse relations are *not*
//! synthesized yet — downstream consumers that need them must wait on
//! full P4.2 (reverse-relation emission) or fall back to the Python
//! side.
//!
//! Shape mirrors the Python `ModelGraph` enough that the same BFS and
//! lookup methods are available.

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::static_index::{FieldCandidate, ModelCandidate, StaticIndex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelGraphNode {
    pub label: String,
    pub app_label: String,
    pub object_name: String,
    pub module: String,
    /// Python import path: `<module>.<object_name>`. Stable id used by
    /// the relation-target resolver.
    pub import_path: String,
    pub file_path: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub field_names: Vec<String>,
    pub relation_names: Vec<String>,
    pub reverse_relation_names: Vec<String>,
    pub manager_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelGraphEdge {
    pub source_label: String,
    pub target_label: String,
    pub direction: String,
    pub field_names: Vec<String>,
    pub field_kinds: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ModelGraph {
    pub fields_by_model_label: BTreeMap<String, Vec<FieldCandidate>>,
    pub nodes_by_label: BTreeMap<String, ModelGraphNode>,
    pub nodes_by_object_name: BTreeMap<String, Vec<String>>,
    pub node_by_import_path: BTreeMap<String, String>,
    pub edges_by_source_label: BTreeMap<String, Vec<ModelGraphEdge>>,
}

impl ModelGraph {
    pub fn fields_for_model(&self, label: &str) -> &[FieldCandidate] {
        self.fields_by_model_label
            .get(label)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn find_field(&self, label: &str, name: &str) -> Option<&FieldCandidate> {
        self.fields_by_model_label
            .get(label)
            .and_then(|v| v.iter().find(|f| f.name == name))
    }

    pub fn node_for_model(&self, label: &str) -> Option<&ModelGraphNode> {
        self.nodes_by_label.get(label)
    }

    pub fn nodes_for_object_name(&self, name: &str) -> Vec<&ModelGraphNode> {
        self.nodes_by_object_name
            .get(name)
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(|l| self.nodes_by_label.get(l))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn unique_node_for_object_name(&self, name: &str) -> Option<&ModelGraphNode> {
        let nodes = self.nodes_for_object_name(name);
        if nodes.len() == 1 {
            Some(nodes[0])
        } else {
            None
        }
    }

    pub fn node_for_import_path(&self, import_path: &str) -> Option<&ModelGraphNode> {
        self.node_by_import_path
            .get(import_path)
            .and_then(|label| self.nodes_by_label.get(label))
    }

    pub fn edges_for_model(&self, label: &str, direction: Option<&str>) -> Vec<&ModelGraphEdge> {
        let edges = match self.edges_by_source_label.get(label) {
            Some(v) => v,
            None => return Vec::new(),
        };
        match direction {
            Some(d) => edges.iter().filter(|e| e.direction == d).collect(),
            None => edges.iter().collect(),
        }
    }

    pub fn adjacent_model_labels(&self, label: &str, include_reverse: bool) -> Vec<String> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        if let Some(edges) = self.edges_by_source_label.get(label) {
            for edge in edges {
                if !include_reverse && edge.direction == "reverse" {
                    continue;
                }
                if seen.insert(edge.target_label.clone()) {
                    out.push(edge.target_label.clone());
                }
            }
        }
        out
    }

    pub fn bfs_labels(&self, root: &str, include_reverse: bool) -> Vec<String> {
        if !self.nodes_by_label.contains_key(root) {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut q: VecDeque<String> = VecDeque::from([root.to_string()]);
        let mut seen = std::collections::HashSet::new();
        seen.insert(root.to_string());
        while let Some(label) = q.pop_front() {
            out.push(label.clone());
            for adj in self.adjacent_model_labels(&label, include_reverse) {
                if seen.insert(adj.clone()) {
                    q.push_back(adj);
                }
            }
        }
        out
    }
}

/// Build the graph from a resolved `StaticIndex`. Callers should pass
/// an index produced by `build_static_index_resolved` so that
/// `FieldCandidate` entries carry `related_model_label`.
pub fn build_model_graph(static_index: &StaticIndex) -> ModelGraph {
    let mut fields_by_label: HashMap<String, Vec<FieldCandidate>> = HashMap::new();
    for f in &static_index.fields {
        fields_by_label
            .entry(f.model_label.clone())
            .or_default()
            .push(f.clone());
    }

    let mut nodes_by_label: BTreeMap<String, ModelGraphNode> = BTreeMap::new();
    let mut nodes_by_object_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut node_by_import_path: BTreeMap<String, String> = BTreeMap::new();

    for m in &static_index.model_candidates {
        let node = build_node(m, &fields_by_label);
        nodes_by_object_name
            .entry(node.object_name.clone())
            .or_default()
            .push(node.label.clone());
        node_by_import_path.insert(node.import_path.clone(), node.label.clone());
        nodes_by_label.insert(node.label.clone(), node);
    }

    // Edges: one per (source, target, direction) triplet, collecting
    // every field that connects them. Both forward and reverse edges
    // are emitted using the FieldCandidate.relation_direction tag.
    let mut edges_by_source_label: BTreeMap<String, Vec<ModelGraphEdge>> = BTreeMap::new();
    for (source_label, fields) in &fields_by_label {
        let mut grouped: HashMap<(String, String), ModelGraphEdge> = HashMap::new();
        for field in fields.iter().filter(|f| f.is_relation) {
            let Some(target) = &field.related_model_label else {
                continue;
            };
            let direction = field
                .relation_direction
                .clone()
                .unwrap_or_else(|| "forward".into());
            let entry = grouped
                .entry((target.clone(), direction.clone()))
                .or_insert_with(|| ModelGraphEdge {
                    source_label: source_label.clone(),
                    target_label: target.clone(),
                    direction,
                    field_names: Vec::new(),
                    field_kinds: Vec::new(),
                });
            entry.field_names.push(field.name.clone());
            entry.field_kinds.push(field.field_kind.clone());
        }
        let mut v: Vec<ModelGraphEdge> = grouped.into_values().collect();
        v.sort_by(|a, b| {
            a.target_label
                .cmp(&b.target_label)
                .then(a.direction.cmp(&b.direction))
        });
        edges_by_source_label.insert(source_label.clone(), v);
    }

    let fields_by_model_label: BTreeMap<String, Vec<FieldCandidate>> =
        fields_by_label.into_iter().collect();

    ModelGraph {
        fields_by_model_label,
        nodes_by_label,
        nodes_by_object_name,
        node_by_import_path,
        edges_by_source_label,
    }
}

fn build_node(
    model: &ModelCandidate,
    fields_by_label: &HashMap<String, Vec<FieldCandidate>>,
) -> ModelGraphNode {
    let mut field_names = Vec::new();
    let mut relation_names = Vec::new();
    let mut reverse_relation_names = Vec::new();
    if let Some(fields) = fields_by_label.get(&model.label) {
        for f in fields {
            if f.relation_direction.as_deref() == Some("reverse") {
                reverse_relation_names.push(f.name.clone());
                continue;
            }
            field_names.push(f.name.clone());
            if f.is_relation {
                relation_names.push(f.name.clone());
            }
        }
    }
    field_names.sort();
    relation_names.sort();
    reverse_relation_names.sort();

    ModelGraphNode {
        label: model.label.clone(),
        app_label: model.app_label.clone(),
        object_name: model.object_name.clone(),
        module: model.module.clone(),
        import_path: format!("{}.{}", model.module, model.object_name),
        file_path: Some(model.file_path.clone()),
        line: Some(model.line),
        column: Some(model.column),
        field_names,
        relation_names,
        reverse_relation_names,
        manager_names: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn graph_has_nodes_and_forward_edges() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\n\nclass User(models.Model):\n    pass\n\nclass Order(models.Model):\n    buyer = models.ForeignKey('shop.User', on_delete=models.CASCADE)\n",
            )],
        );
        let idx = build_static_index_resolved(root, &[root.join("shop/models.py")]);
        let g = build_model_graph(&idx);

        assert!(g.node_for_model("shop.User").is_some());
        assert!(g.node_for_model("shop.Order").is_some());

        let edges = g.edges_for_model("shop.Order", Some("forward"));
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target_label, "shop.User");
        assert_eq!(edges[0].field_names, vec!["buyer"]);
    }

    #[test]
    fn bfs_traverses_forward_relations() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            &[(
                "app/models.py",
                "from django.db import models\n\nclass A(models.Model):\n    pass\n\nclass B(models.Model):\n    a = models.ForeignKey('app.A', on_delete=models.CASCADE)\n\nclass C(models.Model):\n    b = models.ForeignKey('app.B', on_delete=models.CASCADE)\n",
            )],
        );
        let idx = build_static_index_resolved(root, &[root.join("app/models.py")]);
        let g = build_model_graph(&idx);

        let from_c = g.bfs_labels("app.C", false);
        assert_eq!(from_c, vec!["app.C", "app.B", "app.A"]);
    }

    #[test]
    fn reverse_relation_emits_edge_from_target_to_source() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\nclass User(models.Model):\n    pass\nclass Order(models.Model):\n    buyer = models.ForeignKey('shop.User', on_delete=models.CASCADE, related_name='orders')\n",
            )],
        );
        let idx = build_static_index_resolved(root, &[root.join("shop/models.py")]);
        let g = build_model_graph(&idx);

        let user_node = g.node_for_model("shop.User").unwrap();
        assert_eq!(user_node.reverse_relation_names, vec!["orders"]);

        let reverse = g.edges_for_model("shop.User", Some("reverse"));
        assert_eq!(reverse.len(), 1);
        assert_eq!(reverse[0].target_label, "shop.Order");
        assert_eq!(reverse[0].field_names, vec!["orders"]);
    }

    #[test]
    fn object_name_and_import_path_lookups() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            &[(
                "app/models.py",
                "from django.db import models\nclass Widget(models.Model):\n    pass\n",
            )],
        );
        let idx = build_static_index_resolved(root, &[root.join("app/models.py")]);
        let g = build_model_graph(&idx);

        let by_name = g.nodes_for_object_name("Widget");
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].label, "app.Widget");

        let by_path = g.node_for_import_path("app.models.Widget");
        assert!(by_path.is_some());
        assert_eq!(by_path.unwrap().label, "app.Widget");
    }
}
