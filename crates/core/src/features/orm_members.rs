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
use crate::static_index::{FieldCandidate, ModelCandidate, StaticIndex};

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
    OrmMemberItem {
        name: field.name.clone(),
        member_kind: "field".into(),
        model_label: field.model_label.clone(),
        receiver_kind: "instance".into(),
        detail: field.field_kind.clone(),
        source: field.source.clone(),
        return_kind: Some(if field.is_relation {
            if field.relation_direction.as_deref() == Some("reverse") {
                "related_manager".into()
            } else {
                "instance".into()
            }
        } else {
            "scalar".into()
        }),
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

fn instance_surface_with_fields(
    model_label: &str,
    fields: &[FieldCandidate],
) -> Vec<OrmMemberItem> {
    let mut out: Vec<OrmMemberItem> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for f in fields {
        if seen.insert(f.name.clone()) {
            out.push(field_member_item(f));
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
    let _ = static_index;
    let mut out = Vec::new();
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
            instance: receiver_map_from_items(&instance_surface_with_fields(label, &fields_ref)),
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
        let inst = receiver_map_from_items(&instance_surface_with_fields(label, &fields_ref));
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
}
