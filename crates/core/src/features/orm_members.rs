//! Static portion of `features/orm_members.py`. Rust port of the
//! surface-index building logic that does not require Python runtime
//! introspection (no `inspect.signature`, no `get_type_hints`).
//!
//! Covered:
//!   - `OrmMemberItem` struct mirroring the Python dataclass.
//!   - `build_surface_index` — compact per-model surface suitable for
//!     the TS `SurfaceIndex` consumer (receiver_kind → member_name →
//!     (return_kind, return_model_label, member_kind, field_kind)).
//!   - Static sources: fields (from resolver.rs), built-in methods,
//!     manager names declared in class bodies. Custom methods declared
//!     via `def` on a model are detected statically (no return-type
//!     inference — `return_kind = "unknown"` for those).
//!
//! Not covered (still served by Python runtime daemon):
//!   - Project-defined method return types derived from type hints.
//!   - Dynamic managers installed via `add_to_class`.
//!   - Runtime lookups registered via `register_lookup`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::features::django_builtins::{
    BuiltinMethodInfo, BuiltinReturnKind, INSTANCE_BUILTIN_METHODS, MANAGER_BUILTIN_METHODS,
    QUERYSET_BUILTIN_METHODS,
};
use crate::static_index::{FieldCandidate, ModelCandidate, ProjectMethod, StaticIndex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrmMemberItem {
    pub name: String,
    pub member_kind: String,
    pub model_label: String,
    pub receiver_kind: String,
    pub detail: String,
    pub source: String,
    pub return_kind: Option<String>,
    pub return_model_label: Option<String>,
    pub manager_name: Option<String>,
    pub file_path: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub field_kind: Option<String>,
    pub is_relation: bool,
    pub signature: Option<String>,
}

fn return_kind_str(k: BuiltinReturnKind) -> &'static str {
    match k {
        BuiltinReturnKind::Queryset => "queryset",
        BuiltinReturnKind::Instance => "instance",
        BuiltinReturnKind::Scalar => "scalar",
        BuiltinReturnKind::None => "none",
        BuiltinReturnKind::Bool => "bool",
        BuiltinReturnKind::Unknown => "unknown",
    }
}

fn field_member_item(field: &FieldCandidate) -> OrmMemberItem {
    let member_kind = if field.is_relation {
        if field.relation_direction.as_deref() == Some("reverse") {
            "reverse_relation"
        } else {
            "relation"
        }
    } else {
        "field"
    };
    let return_kind = if field.is_relation {
        if matches!(
            field.field_kind.as_str(),
            "ForeignKey" | "OneToOneField" | "reverse_OneToOneField"
        ) {
            "instance"
        } else {
            "related_manager"
        }
    } else {
        "scalar"
    };
    let detail = if field.is_relation {
        match &field.related_model_label {
            Some(label) => format!("{} -> {label}", field.field_kind),
            None => field.field_kind.clone(),
        }
    } else {
        field.field_kind.clone()
    };
    OrmMemberItem {
        name: field.name.clone(),
        member_kind: member_kind.into(),
        model_label: field.model_label.clone(),
        receiver_kind: "instance".into(),
        detail,
        source: field.source.clone(),
        return_kind: Some(return_kind.into()),
        return_model_label: field.related_model_label.clone(),
        manager_name: None,
        file_path: Some(field.file_path.clone()),
        line: Some(field.line),
        column: Some(field.column),
        field_kind: Some(field.field_kind.clone()),
        is_relation: field.is_relation,
        signature: None,
    }
}

fn builtin_item(info: &BuiltinMethodInfo, model_label: &str, receiver_kind: &str) -> OrmMemberItem {
    OrmMemberItem {
        name: info.name.to_string(),
        member_kind: "method".into(),
        model_label: model_label.to_string(),
        receiver_kind: receiver_kind.to_string(),
        detail: info.description.to_string(),
        source: "builtin".into(),
        return_kind: Some(return_kind_str(info.return_kind).to_string()),
        return_model_label: if matches!(
            info.return_kind,
            BuiltinReturnKind::Queryset | BuiltinReturnKind::Instance
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

pub fn project_method_item(method: &ProjectMethod, receiver_kind: &str) -> OrmMemberItem {
    let member_kind = match method.kind.as_str() {
        "property" | "cached_property" => "property",
        "classmethod" => "classmethod",
        "staticmethod" => "staticmethod",
        _ => "method",
    };
    let detail = match method.kind.as_str() {
        "property" => "Project @property".to_string(),
        "cached_property" => "Project @cached_property".to_string(),
        "classmethod" => "Project @classmethod".to_string(),
        "staticmethod" => "Project @staticmethod".to_string(),
        "async_method" => "Project async method".to_string(),
        _ => "Project method".to_string(),
    };
    // Return-kind heuristic from annotation: match forward-relation
    // target names to their labels when possible. Without a resolver
    // we keep it conservative — "unknown" keeps Python behaviour.
    let return_kind = match method.kind.as_str() {
        "property" | "cached_property" => "unknown",
        _ => "unknown",
    };
    OrmMemberItem {
        name: method.name.clone(),
        member_kind: member_kind.into(),
        model_label: method.model_label.clone(),
        receiver_kind: receiver_kind.to_string(),
        detail,
        source: "project".into(),
        return_kind: Some(return_kind.into()),
        return_model_label: None,
        manager_name: None,
        file_path: Some(method.file_path.clone()),
        line: Some(method.line),
        column: Some(method.column),
        field_kind: None,
        is_relation: false,
        signature: method.return_annotation.as_ref().map(|s| format!("def {}(...) -> {s}", method.name)),
    }
}

fn methods_for_model<'a>(
    static_index: &'a StaticIndex,
    model_label: &'a str,
) -> impl Iterator<Item = &'a ProjectMethod> + 'a {
    static_index
        .methods
        .iter()
        .filter(move |m| m.model_label == model_label)
}

fn instance_surface_with_fields(
    model_label: &str,
    fields: &[FieldCandidate],
    static_index: Option<&StaticIndex>,
) -> Vec<OrmMemberItem> {
    let mut out: Vec<OrmMemberItem> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for f in fields {
        if seen.insert(f.name.clone()) {
            out.push(field_member_item(f));
        }
    }
    // Project-defined `def` / `@property` / `@cached_property` members
    // come before Django builtins — a project override of `save()` etc.
    // should be preferred by the caller's sort.
    if let Some(index) = static_index {
        for method in methods_for_model(index, model_label) {
            if !matches!(method.kind.as_str(), "classmethod" | "staticmethod") {
                if seen.insert(method.name.clone()) {
                    out.push(project_method_item(method, "instance"));
                }
            }
        }
    }
    for info in INSTANCE_BUILTIN_METHODS {
        if seen.insert(info.name.to_string()) {
            out.push(builtin_item(info, model_label, "instance"));
        }
    }
    out
}

fn manager_surface(static_index: &StaticIndex, model_label: &str) -> Vec<OrmMemberItem> {
    let _ = static_index;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // Manager composes QuerySet methods + its own.
    for info in QUERYSET_BUILTIN_METHODS {
        if seen.insert(info.name.to_string()) {
            out.push(builtin_item(info, model_label, "manager"));
        }
    }
    for info in MANAGER_BUILTIN_METHODS {
        if seen.insert(info.name.to_string()) {
            out.push(builtin_item(info, model_label, "manager"));
        }
    }
    out
}

fn queryset_surface(static_index: &StaticIndex, model_label: &str) -> Vec<OrmMemberItem> {
    let _ = static_index;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for info in QUERYSET_BUILTIN_METHODS {
        if seen.insert(info.name.to_string()) {
            out.push(builtin_item(info, model_label, "queryset"));
        }
    }
    out
}

fn related_manager_surface(static_index: &StaticIndex, model_label: &str) -> Vec<OrmMemberItem> {
    // Related manager supports the full QuerySet surface plus manager-only additions.
    let mut out = manager_surface(static_index, model_label);
    for item in out.iter_mut() {
        item.receiver_kind = "related_manager".into();
    }
    out
}

fn model_class_surface(
    static_index: &StaticIndex,
    model_candidate: &ModelCandidate,
) -> Vec<OrmMemberItem> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // The default manager. Projects can declare custom ones; we emit
    // `objects` unconditionally — if the user shadowed it, it still
    // resolves to the same kind.
    out.push(OrmMemberItem {
        name: "objects".into(),
        member_kind: "manager".into(),
        model_label: model_candidate.label.clone(),
        receiver_kind: "model_class".into(),
        detail: format!("Default manager for {}", model_candidate.label),
        source: "builtin".into(),
        return_kind: Some("manager".into()),
        return_model_label: Some(model_candidate.label.clone()),
        manager_name: Some("objects".into()),
        file_path: Some(model_candidate.file_path.clone()),
        line: Some(model_candidate.line),
        column: Some(model_candidate.column),
        field_kind: None,
        is_relation: false,
        signature: None,
    });
    seen.insert(String::from("objects"));

    // Project-level @classmethod / @staticmethod declarations on the
    // model class surface directly on `Model.<name>`.
    for method in methods_for_model(static_index, &model_candidate.label) {
        if matches!(method.kind.as_str(), "classmethod" | "staticmethod") {
            if seen.insert(method.name.clone()) {
                out.push(project_method_item(method, "model_class"));
            }
        }
    }
    out
}

/// Per-receiver-kind → per-member-name →
/// `[return_kind, return_role_or_target, member_kind, field_kind]`.
/// Wire format remains backward-compatible with the TS `SurfaceIndex`
/// consumer, which only requires the first two tuple entries.
pub type SurfaceReceiverMap = BTreeMap<String, Vec<Option<String>>>;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct SurfaceModelEntry {
    pub instance: SurfaceReceiverMap,
    pub model_class: SurfaceReceiverMap,
    pub manager: SurfaceReceiverMap,
    pub queryset: SurfaceReceiverMap,
    pub related_manager: SurfaceReceiverMap,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct SurfaceIndex {
    pub models: BTreeMap<String, SurfaceModelEntry>,
}

fn receiver_map_from_items(items: &[OrmMemberItem]) -> SurfaceReceiverMap {
    let mut out: SurfaceReceiverMap = BTreeMap::new();
    for it in items {
        let Some(rk) = &it.return_kind else {
            continue;
        };
        let tuple = vec![
            Some(rk.clone()),
            it.return_model_label
                .clone()
                .or_else(|| Some(it.model_label.clone())),
            Some(it.member_kind.clone()),
            it.field_kind.clone(),
        ];
        out.insert(it.name.clone(), tuple);
    }
    out
}

fn group_fields_by_label(
    fields: &[FieldCandidate],
) -> std::collections::HashMap<&str, Vec<&FieldCandidate>> {
    let mut out: std::collections::HashMap<&str, Vec<&FieldCandidate>> =
        std::collections::HashMap::new();
    for f in fields {
        out.entry(f.model_label.as_str()).or_default().push(f);
    }
    out
}

/// Build a surfaceIndex from a fully-resolved `StaticIndex`. Excludes
/// abstract base models (same as Python). Output shape matches the TS
/// `SurfaceIndex` type after JSON serialisation.
pub fn build_surface_index(static_index: &StaticIndex) -> SurfaceIndex {
    let grouped = group_fields_by_label(&static_index.fields);
    let empty: Vec<&FieldCandidate> = Vec::new();
    let mut out = SurfaceIndex::default();
    for candidate in &static_index.model_candidates {
        if candidate.is_abstract {
            continue;
        }
        let label = candidate.label.as_str();
        let fields_ref: Vec<FieldCandidate> = grouped
            .get(label)
            .unwrap_or(&empty)
            .iter()
            .map(|f| (*f).clone())
            .collect();
        let entry = SurfaceModelEntry {
            instance: receiver_map_from_items(&instance_surface_with_fields(label, &fields_ref, Some(static_index))),
            model_class: receiver_map_from_items(&model_class_surface(static_index, candidate)),
            manager: receiver_map_from_items(&manager_surface(static_index, label)),
            queryset: receiver_map_from_items(&queryset_surface(static_index, label)),
            related_manager: receiver_map_from_items(&related_manager_surface(static_index, label)),
        };
        out.models.insert(candidate.label.clone(), entry);
    }
    out
}

/// Alternate shape matching the TS wire format exactly:
///   { "app.Model": { "instance": { "field": ["scalar", null] }, ... } }
///
/// Serialise this with `serde_json::to_vec` on the Rust side and hand
/// the bytes over napi — no further conversion needed.
pub fn build_wire_surface_index(
    static_index: &StaticIndex,
) -> BTreeMap<String, BTreeMap<String, SurfaceReceiverMap>> {
    let grouped = group_fields_by_label(&static_index.fields);
    let empty: Vec<&FieldCandidate> = Vec::new();
    let mut out: BTreeMap<String, BTreeMap<String, SurfaceReceiverMap>> = BTreeMap::new();
    for candidate in &static_index.model_candidates {
        if candidate.is_abstract {
            continue;
        }
        let label = candidate.label.as_str();
        let fields_ref: Vec<FieldCandidate> = grouped
            .get(label)
            .unwrap_or(&empty)
            .iter()
            .map(|f| (*f).clone())
            .collect();

        let mut entry: BTreeMap<String, SurfaceReceiverMap> = BTreeMap::new();
        let inst = receiver_map_from_items(&instance_surface_with_fields(label, &fields_ref, Some(static_index)));
        if !inst.is_empty() {
            entry.insert("instance".into(), inst);
        }
        let cls = receiver_map_from_items(&model_class_surface(static_index, candidate));
        if !cls.is_empty() {
            entry.insert("model_class".into(), cls);
        }
        let mgr = receiver_map_from_items(&manager_surface(static_index, label));
        if !mgr.is_empty() {
            entry.insert("manager".into(), mgr);
        }
        let qs = receiver_map_from_items(&queryset_surface(static_index, label));
        if !qs.is_empty() {
            entry.insert("queryset".into(), qs);
        }
        let rm = receiver_map_from_items(&related_manager_surface(static_index, label));
        if !rm.is_empty() {
            entry.insert("related_manager".into(), rm);
        }
        if !entry.is_empty() {
            out.insert(candidate.label.clone(), entry);
        }
    }
    out
}

// ---------------------------------------------------------------------
// Bulk completion list (port of `list_orm_member_completions`).
// ---------------------------------------------------------------------

/// Aggregate completion response. Wire-compatible with the TS
/// `OrmMemberCompletionsResult` (camelCase fields, optional omitted).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrmMemberCompletionsResult {
    pub items: Vec<OrmMemberItem>,
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager_name: Option<String>,
}

fn manager_builtin_items(model_label: &str, receiver_kind: &str) -> Vec<OrmMemberItem> {
    let mut out: Vec<OrmMemberItem> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for info in QUERYSET_BUILTIN_METHODS {
        if seen.insert(info.name.to_string()) {
            out.push(builtin_item(info, model_label, receiver_kind));
        }
    }
    for info in MANAGER_BUILTIN_METHODS {
        if seen.insert(info.name.to_string()) {
            out.push(builtin_item(info, model_label, receiver_kind));
        }
    }
    out
}

/// Bulk list of ORM member completion items for `(model_label,
/// receiver_kind)` filtered by `prefix`. Returns the static
/// complement — project-defined `def` methods and dynamic managers
/// still require the Python inspector.
pub fn list_orm_member_completions(
    static_index: &StaticIndex,
    model_label: &str,
    receiver_kind: &str,
    prefix: Option<&str>,
    manager_name: Option<&str>,
) -> OrmMemberCompletionsResult {
    let prefix_trim = prefix.unwrap_or("").trim();
    let fields_for_model: Vec<&FieldCandidate> = static_index
        .fields
        .iter()
        .filter(|f| f.model_label == model_label)
        .collect();

    let mut items: Vec<OrmMemberItem> = match receiver_kind {
        "instance" => {
            let field_items: Vec<FieldCandidate> =
                fields_for_model.iter().map(|f| (*f).clone()).collect();
            instance_surface_with_fields(model_label, &field_items, Some(static_index))
        }
        "model_class" => {
            let candidate = static_index
                .model_candidates
                .iter()
                .find(|c| c.label == model_label);
            if let Some(candidate) = candidate {
                model_class_surface(static_index, candidate)
            } else {
                Vec::new()
            }
        }
        "manager" => {
            let mut v = manager_builtin_items(model_label, "manager");
            for item in v.iter_mut() {
                item.manager_name = manager_name.map(|s| s.to_string());
            }
            v
        }
        "related_manager" => {
            let mut v = manager_builtin_items(model_label, "related_manager");
            for item in v.iter_mut() {
                item.manager_name = manager_name.map(|s| s.to_string());
            }
            v
        }
        "queryset" => {
            let mut v: Vec<OrmMemberItem> = Vec::new();
            for info in QUERYSET_BUILTIN_METHODS {
                v.push(builtin_item(info, model_label, "queryset"));
            }
            for item in v.iter_mut() {
                item.manager_name = manager_name.map(|s| s.to_string());
            }
            v
        }
        _ => Vec::new(),
    };

    if !prefix_trim.is_empty() {
        items.retain(|item| item.name.starts_with(prefix_trim));
    }

    OrmMemberCompletionsResult {
        items,
        resolved: true,
        reason: None,
        receiver_kind: Some(receiver_kind.to_string()),
        model_label: Some(model_label.to_string()),
        manager_name: manager_name.map(|s| s.to_string()),
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

    fn sample_index() -> StaticIndex {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\nclass User(models.Model):\n    email = models.CharField(max_length=200)\nclass Order(models.Model):\n    buyer = models.ForeignKey('shop.User', on_delete=models.CASCADE, related_name='orders')\n    qty = models.IntegerField()\n",
            )],
        );
        build_static_index_resolved(root, &[root.join("shop/models.py")])
    }

    #[test]
    fn wire_surface_includes_fields_and_builtins() {
        let idx = sample_index();
        let wire = build_wire_surface_index(&idx);

        let order = wire.get("shop.Order").expect("Order present");
        let inst = order.get("instance").expect("instance map present");

        // Declared fields visible.
        assert!(inst.contains_key("buyer"));
        assert!(inst.contains_key("qty"));
        // Built-in instance methods visible.
        assert!(inst.contains_key("save"));
        assert!(inst.contains_key("delete"));

        // FK returns instance w/ target model label.
        let buyer = inst.get("buyer").unwrap();
        assert_eq!(buyer[0].as_deref(), Some("instance"));
        assert_eq!(buyer[1].as_deref(), Some("shop.User"));
    }

    #[test]
    fn abstract_models_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            &[(
                "pkg/models.py",
                "from django.db import models\n\nclass Base(models.Model):\n    class Meta:\n        abstract = True\n    name = models.CharField(max_length=10)\n\nclass Concrete(models.Model):\n    extra = models.IntegerField()\n",
            )],
        );
        let idx = build_static_index_resolved(root, &[root.join("pkg/models.py")]);
        let wire = build_wire_surface_index(&idx);
        assert!(!wire.contains_key("pkg.Base"));
        assert!(wire.contains_key("pkg.Concrete"));
    }

    #[test]
    fn reverse_relation_surface_as_related_manager_return_kind() {
        let idx = sample_index();
        let wire = build_wire_surface_index(&idx);
        let user = wire.get("shop.User").expect("User present");
        let inst = user.get("instance").unwrap();
        let orders = inst
            .get("orders")
            .expect("reverse relation 'orders' exposed");
        assert_eq!(orders[0].as_deref(), Some("related_manager"));
        assert_eq!(orders[1].as_deref(), Some("shop.Order"));
    }

    #[test]
    fn manager_surface_has_queryset_methods() {
        let idx = sample_index();
        let wire = build_wire_surface_index(&idx);
        let order = wire.get("shop.Order").unwrap();
        let mgr = order.get("manager").expect("manager kind present");
        assert!(mgr.contains_key("filter"));
        assert!(mgr.contains_key("get_queryset"));
    }

    #[test]
    fn bulk_completion_instance_lists_fields_and_builtins() {
        let idx = sample_index();
        let r = list_orm_member_completions(&idx, "shop.Order", "instance", None, None);
        assert!(r.resolved);
        let names: Vec<String> = r.items.iter().map(|i| i.name.clone()).collect();
        assert!(names.contains(&"buyer".to_string()));
        assert!(names.contains(&"qty".to_string()));
        assert!(names.contains(&"save".to_string()));
    }

    #[test]
    fn bulk_completion_prefix_filters() {
        let idx = sample_index();
        let r = list_orm_member_completions(&idx, "shop.Order", "instance", Some("bu"), None);
        assert!(r.resolved);
        let names: Vec<String> = r.items.iter().map(|i| i.name.clone()).collect();
        assert!(names.iter().any(|n| n == "buyer"));
        assert!(!names.iter().any(|n| n == "save"));
    }

    #[test]
    fn bulk_completion_manager_has_queryset_plus_manager_methods() {
        let idx = sample_index();
        let r = list_orm_member_completions(&idx, "shop.Order", "manager", None, Some("objects"));
        assert!(r.resolved);
        let names: Vec<String> = r.items.iter().map(|i| i.name.clone()).collect();
        assert!(names.contains(&"filter".to_string()));
        assert!(names.contains(&"get_queryset".to_string()));
        assert!(r.items.iter().all(|i| i.manager_name.as_deref() == Some("objects")));
    }

    #[test]
    fn bulk_completion_model_class_has_objects_default_manager() {
        let idx = sample_index();
        let r = list_orm_member_completions(&idx, "shop.Order", "model_class", None, None);
        assert!(r.resolved);
        let names: Vec<String> = r.items.iter().map(|i| i.name.clone()).collect();
        assert!(names.contains(&"objects".to_string()));
    }

    #[test]
    fn project_methods_surface_on_instance_and_model_class() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            &[(
                "shop/models.py",
                r#"from django.db import models

class Order(models.Model):
    total = models.IntegerField()

    def compute_total(self) -> int:
        return self.total

    @property
    def display(self) -> str:
        return '$'

    @classmethod
    def factory(cls):
        return cls()

    @staticmethod
    def label():
        return 'Order'
"#,
            )],
        );
        let idx = build_static_index_resolved(root, &[root.join("shop/models.py")]);
        let wire = build_wire_surface_index(&idx);

        // Instance surface includes the regular def and property.
        let inst = wire
            .get("shop.Order")
            .and_then(|m| m.get("instance"))
            .expect("instance surface present");
        assert!(inst.contains_key("compute_total"));
        assert!(inst.contains_key("display"));
        // Classmethod/staticmethod do NOT show up on instance (they
        // live on the class surface).
        assert!(!inst.contains_key("factory"));
        assert!(!inst.contains_key("label"));

        // Model class surface includes classmethod/staticmethod +
        // still exposes `objects`.
        let cls = wire
            .get("shop.Order")
            .and_then(|m| m.get("model_class"))
            .expect("model_class surface present");
        assert!(cls.contains_key("factory"));
        assert!(cls.contains_key("label"));
        assert!(cls.contains_key("objects"));

        // list_orm_member_completions picks up project methods too.
        let r = list_orm_member_completions(&idx, "shop.Order", "instance", None, None);
        let names: Vec<String> = r.items.iter().map(|i| i.name.clone()).collect();
        assert!(names.iter().any(|n| n == "compute_total"));
        assert!(names.iter().any(|n| n == "display"));

        let r = list_orm_member_completions(&idx, "shop.Order", "model_class", None, None);
        let names: Vec<String> = r.items.iter().map(|i| i.name.clone()).collect();
        assert!(names.iter().any(|n| n == "factory"));
        assert!(names.iter().any(|n| n == "label"));
        assert!(names.iter().any(|n| n == "objects"));
    }
}
