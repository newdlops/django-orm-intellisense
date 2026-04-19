//! P4.2: resolve `PendingFieldCandidate` into `FieldCandidate` with
//! forward-relation targets, then synthesize reverse-relation fields on
//! the pointed-to models. Also performs inheritance expansion — any
//! class whose declared base is (transitively) a known Django model
//! gets registered even if its file was not originally scanned as a
//! models module.
//!
//! Still deferred: editable-install source dir walk; per-field
//! transforms beyond static known names.

use std::collections::{HashMap, HashSet, VecDeque};

use super::types::{
    FieldCandidate, ImportBinding, ModelCandidate, ModuleIndex, PendingFieldCandidate,
};

/// Expand the model candidate set by following import → inheritance
/// chains. A class declared in module B with base `Foo` imported from
/// module A where A contains a model named `Foo` is itself a model. BFS
/// over a reverse-import index keeps this O(modules × base_refs).
pub fn expand_via_inheritance(
    initial: &[ModelCandidate],
    modules: &mut [ModuleIndex],
) -> Vec<ModelCandidate> {
    let mut registered: HashSet<(String, String)> = initial
        .iter()
        .map(|c| (c.module.clone(), c.object_name.clone()))
        .collect();
    let mut all_candidates: Vec<ModelCandidate> = initial.to_vec();

    let mut names_by_module: HashMap<String, HashSet<String>> = HashMap::new();
    for c in initial {
        names_by_module
            .entry(c.module.clone())
            .or_default()
            .insert(c.object_name.clone());
    }

    // reverse_imports[(source_module, symbol)] = [(importing_module, alias)]
    let mut reverse_imports: HashMap<(String, String), Vec<(String, String)>> = HashMap::new();
    for m in modules.iter() {
        for b in &m.import_bindings {
            if b.is_star {
                continue;
            }
            if let Some(sym) = &b.symbol {
                reverse_imports
                    .entry((b.module.clone(), sym.clone()))
                    .or_default()
                    .push((m.module_name.clone(), b.alias.clone()));
            }
        }
    }

    // importers[importing_module] = {local_alias_of_known_model, ...}
    let mut importers: HashMap<String, HashSet<String>> = HashMap::new();
    for c in initial {
        if let Some(dests) = reverse_imports.get(&(c.module.clone(), c.object_name.clone())) {
            for (importing, alias) in dests {
                importers
                    .entry(importing.clone())
                    .or_default()
                    .insert(alias.clone());
            }
        }
    }

    let mut queue: VecDeque<String> = importers.keys().cloned().collect();
    let mut visited: HashSet<String> = HashSet::new();

    // For rewriting into the owning ModuleIndex we need an index map.
    let mut module_index_by_name: HashMap<String, usize> = HashMap::new();
    for (i, m) in modules.iter().enumerate() {
        module_index_by_name.insert(m.module_name.clone(), i);
    }

    while let Some(module_name) = queue.pop_front() {
        if !visited.insert(module_name.clone()) {
            continue;
        }
        let Some(&mod_idx) = module_index_by_name.get(&module_name) else {
            continue;
        };

        // Snapshot sets used for base resolution. Any class whose base
        // tail name matches a known symbol in this module qualifies.
        let locals = names_by_module
            .get(&module_name)
            .cloned()
            .unwrap_or_default();
        let imports_aliases = importers.get(&module_name).cloned().unwrap_or_default();
        let known: HashSet<String> = locals.union(&imports_aliases).cloned().collect();

        // Collect discoveries first to avoid borrowing conflicts.
        let mut discovered: Vec<(String, Vec<String>)> = Vec::new();
        {
            let module_index = &modules[mod_idx];
            for (class_name, bases) in &module_index.class_base_refs {
                if registered.contains(&(module_name.clone(), class_name.clone())) {
                    continue;
                }
                let matched = bases.iter().any(|b| {
                    if known.contains(b) {
                        return true;
                    }
                    let tail = b.rsplit('.').next().unwrap_or(b);
                    known.contains(tail)
                });
                if matched {
                    discovered.push((class_name.clone(), bases.clone()));
                }
            }
        }

        for (class_name, bases) in discovered {
            let app_label = module_name
                .split('.')
                .next()
                .unwrap_or(&module_name)
                .to_string();
            let module_index = &mut modules[mod_idx];
            let candidate = ModelCandidate {
                app_label: app_label.clone(),
                object_name: class_name.clone(),
                label: format!("{app_label}.{class_name}"),
                module: module_name.clone(),
                file_path: module_index.file_path.clone(),
                line: 0,
                column: 0,
                is_abstract: false,
                base_class_refs: bases,
                source: "static".into(),
            };
            module_index.model_candidates.push(candidate.clone());
            all_candidates.push(candidate);
            registered.insert((module_name.clone(), class_name.clone()));
            names_by_module
                .entry(module_name.clone())
                .or_default()
                .insert(class_name.clone());

            // Propagate: anyone importing this newly-discovered model
            // re-enters the queue.
            if let Some(dests) = reverse_imports
                .get(&(module_name.clone(), class_name.clone()))
                .cloned()
            {
                for (importing, alias) in dests {
                    importers
                        .entry(importing.clone())
                        .or_default()
                        .insert(alias);
                    if !visited.contains(&importing) {
                        queue.push_back(importing);
                    }
                }
            }
        }
    }

    all_candidates
}

/// Reverse-name derivation matching the Python
/// `_default_reverse_name` / `_reverse_query_name` semantics:
///   - `related_name="+"` → hidden, no reverse emitted.
///   - OneToOneField → `<source_object_name_lower>`
///   - Other relations → `<source_object_name_lower>_set`
///   - Explicit `related_name` overrides both.
fn derive_reverse_name(field: &FieldCandidate, source_object_name: &str) -> Option<String> {
    if field
        .related_name
        .as_deref()
        .map(|n| n.ends_with('+'))
        .unwrap_or(false)
    {
        return None;
    }
    if let Some(name) = &field.related_name {
        return Some(name.clone());
    }
    let lower = source_object_name.to_ascii_lowercase();
    if field.field_kind == "OneToOneField" {
        Some(lower)
    } else {
        Some(format!("{lower}_set"))
    }
}

/// Emit reverse-relation FieldCandidates on each target model. Assumes
/// the input `forward_fields` already have `related_model_label` set.
pub fn synthesize_reverse_relations(
    forward_fields: &[FieldCandidate],
    model_candidates: &[ModelCandidate],
) -> Vec<FieldCandidate> {
    let by_label: HashMap<&str, &ModelCandidate> = model_candidates
        .iter()
        .map(|m| (m.label.as_str(), m))
        .collect();
    let mut out = Vec::new();
    for f in forward_fields {
        if !f.is_relation {
            continue;
        }
        let Some(target_label) = f.related_model_label.as_deref() else {
            continue;
        };
        let Some(source_model) = by_label.get(f.model_label.as_str()) else {
            continue;
        };
        let Some(reverse_name) = derive_reverse_name(f, &source_model.object_name) else {
            continue;
        };
        out.push(FieldCandidate {
            model_label: target_label.to_string(),
            name: reverse_name,
            file_path: f.file_path.clone(),
            line: f.line,
            column: f.column,
            field_kind: f.field_kind.clone(),
            is_relation: true,
            relation_direction: Some("reverse".into()),
            related_model_label: Some(f.model_label.clone()),
            declared_model_label: Some(f.model_label.clone()),
            related_name: f.related_name.clone(),
            related_query_name: f.related_query_name.clone(),
            source: "static".into(),
        });
    }
    out
}

pub fn resolve_fields(
    model_candidates: &[ModelCandidate],
    modules: &[ModuleIndex],
) -> Vec<FieldCandidate> {
    // Build quick lookup tables.
    let mut by_label: HashMap<&str, &ModelCandidate> = HashMap::new();
    let mut by_object_name: HashMap<&str, Vec<&ModelCandidate>> = HashMap::new();
    for m in model_candidates {
        by_label.insert(m.label.as_str(), m);
        by_object_name
            .entry(m.object_name.as_str())
            .or_default()
            .push(m);
    }
    let modules_by_name: HashMap<&str, &ModuleIndex> = modules
        .iter()
        .map(|m| (m.module_name.as_str(), m))
        .collect();

    let mut out: Vec<FieldCandidate> = Vec::new();

    for module in modules {
        for pf in &module.pending_fields {
            let base = FieldCandidate {
                model_label: pf.model_label.clone(),
                name: pf.name.clone(),
                file_path: pf.file_path.clone(),
                line: pf.line,
                column: pf.column,
                field_kind: pf.field_kind.clone(),
                is_relation: pf.is_relation,
                relation_direction: if pf.is_relation {
                    Some("forward".into())
                } else {
                    None
                },
                related_model_label: None,
                declared_model_label: pf.related_model_ref_value.clone(),
                related_name: pf.related_name.clone(),
                related_query_name: pf.related_query_name.clone(),
                source: "static".into(),
            };

            if !pf.is_relation {
                out.push(base);
                continue;
            }

            let resolved =
                resolve_relation_target(pf, module, &by_label, &by_object_name, &modules_by_name);

            out.push(FieldCandidate {
                related_model_label: resolved,
                ..base
            });
        }
    }

    out
}

fn resolve_relation_target(
    pf: &PendingFieldCandidate,
    module: &ModuleIndex,
    by_label: &HashMap<&str, &ModelCandidate>,
    by_object_name: &HashMap<&str, Vec<&ModelCandidate>>,
    modules_by_name: &HashMap<&str, &ModuleIndex>,
) -> Option<String> {
    let raw = pf.related_model_ref_value.as_deref()?;

    // Handle sentinel `self` — resolves to the declaring model.
    if raw == "self" {
        return Some(pf.model_label.clone());
    }

    // Case 1: already a fully-qualified 'app.Model' reference. Prefer an
    // exact label match, falling back to a unique object-name match
    // using only the last segment.
    if let Some(m) = by_label.get(raw) {
        return Some(m.label.clone());
    }

    // Case 2: dotted Python name (e.g. `myapp.models.Foo`). Walk the
    // import bindings to see if the root segment resolves to a known
    // module, then find a model with matching object name.
    if raw.contains('.') {
        if let Some(by_dotted) =
            resolve_dotted_ref(raw, module, by_label, by_object_name, modules_by_name)
        {
            return Some(by_dotted);
        }
    }

    // Case 3: bare object name. Succeed only when unique.
    let tail = raw.rsplit('.').next().unwrap_or(raw);
    if let Some(candidates) = by_object_name.get(tail) {
        if candidates.len() == 1 {
            return Some(candidates[0].label.clone());
        }
        // Prefer one defined in the same module as the declaring field.
        if let Some(same_module) = candidates
            .iter()
            .find(|c| c.module == pf.model_module)
            .map(|c| c.label.clone())
        {
            return Some(same_module);
        }
    }

    None
}

fn resolve_dotted_ref(
    raw: &str,
    module: &ModuleIndex,
    by_label: &HashMap<&str, &ModelCandidate>,
    by_object_name: &HashMap<&str, Vec<&ModelCandidate>>,
    modules_by_name: &HashMap<&str, &ModuleIndex>,
) -> Option<String> {
    let parts: Vec<&str> = raw.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let object_name = *parts.last().unwrap();
    let namespace = &parts[..parts.len() - 1];
    let head = namespace[0];

    // Look for an import alias matching the head. If the head is the
    // alias of `from app.models import ...` or `import app.models as m`,
    // expand the namespace to the underlying module name.
    let mut resolved_namespace: Vec<String> = namespace.iter().map(|s| s.to_string()).collect();
    if let Some(binding) = module
        .import_bindings
        .iter()
        .find(|b| b.alias == head && !b.is_star)
    {
        resolved_namespace = expand_alias(binding, &namespace[1..]);
    }

    let module_name = resolved_namespace.join(".");
    if let Some(target_module) = modules_by_name.get(module_name.as_str()) {
        if let Some(target) = target_module
            .model_candidates
            .iter()
            .find(|m| m.object_name == object_name)
        {
            return Some(target.label.clone());
        }
    }

    // Fallback: unique object-name match anywhere.
    if let Some(candidates) = by_object_name.get(object_name) {
        if candidates.len() == 1 {
            return Some(candidates[0].label.clone());
        }
    }
    let _ = by_label; // silence unused when neither branch fires
    None
}

fn expand_alias(binding: &ImportBinding, tail: &[&str]) -> Vec<String> {
    // `import a.b as m` → module path is `a.b`.
    // `from a.b import X as Y` → binding.module = "a.b", symbol = "X".
    // In the latter, reaching `m.Z` means `a.b.X.Z` — still addressable
    // as a module only if X is a package, which we don't track here.
    let mut base: Vec<String> = binding.module.split('.').map(|s| s.to_string()).collect();
    if let Some(sym) = &binding.symbol {
        base.push(sym.clone());
    }
    for t in tail {
        base.push(t.to_string());
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::static_index::build_static_index;
    use std::fs;

    fn write_tree(root: &std::path::Path, files: &[(&str, &str)]) {
        for (rel, content) in files {
            let full = root.join(rel);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(full, content).unwrap();
        }
    }

    #[test]
    fn resolves_string_label_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\n\nclass User(models.Model):\n    pass\n\nclass Order(models.Model):\n    user = models.ForeignKey('shop.User', on_delete=models.CASCADE)\n",
            )],
        );
        let idx = build_static_index(root, &[root.join("shop/models.py")]);
        let fields = resolve_fields(&idx.model_candidates, &idx.modules);
        let user_fk = fields.iter().find(|f| f.name == "user").unwrap();
        assert_eq!(user_fk.related_model_label.as_deref(), Some("shop.User"));
        assert_eq!(user_fk.relation_direction.as_deref(), Some("forward"));
    }

    #[test]
    fn resolves_self_reference() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "tree/models.py",
                "from django.db import models\n\nclass Node(models.Model):\n    parent = models.ForeignKey('self', on_delete=models.CASCADE, null=True)\n",
            )],
        );
        let idx = build_static_index(root, &[root.join("tree/models.py")]);
        let fields = resolve_fields(&idx.model_candidates, &idx.modules);
        let parent = fields.iter().find(|f| f.name == "parent").unwrap();
        assert_eq!(parent.related_model_label.as_deref(), Some("tree.Node"));
    }

    #[test]
    fn resolves_bare_object_name_when_unique() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[
                (
                    "a/models.py",
                    "from django.db import models\nclass Foo(models.Model):\n    pass\n",
                ),
                (
                    "b/models.py",
                    "from django.db import models\nclass Bar(models.Model):\n    foo = models.ForeignKey(Foo, on_delete=models.CASCADE)\n",
                ),
            ],
        );
        let idx = build_static_index(root, &[root.join("a/models.py"), root.join("b/models.py")]);
        let fields = resolve_fields(&idx.model_candidates, &idx.modules);
        let foo_fk = fields.iter().find(|f| f.name == "foo").unwrap();
        assert_eq!(foo_fk.related_model_label.as_deref(), Some("a.Foo"));
    }

    #[test]
    fn emits_default_reverse_set_for_foreign_key() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\n\nclass User(models.Model):\n    pass\n\nclass Order(models.Model):\n    buyer = models.ForeignKey('shop.User', on_delete=models.CASCADE)\n",
            )],
        );
        let idx =
            crate::static_index::build_static_index_resolved(root, &[root.join("shop/models.py")]);
        let reverse: Vec<&FieldCandidate> = idx
            .fields
            .iter()
            .filter(|f| {
                f.model_label == "shop.User" && f.relation_direction.as_deref() == Some("reverse")
            })
            .collect();
        assert_eq!(reverse.len(), 1);
        assert_eq!(reverse[0].name, "order_set");
        assert_eq!(
            reverse[0].related_model_label.as_deref(),
            Some("shop.Order")
        );
    }

    #[test]
    fn emits_one_to_one_reverse_without_set_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\n\nclass User(models.Model):\n    pass\n\nclass Profile(models.Model):\n    user = models.OneToOneField('shop.User', on_delete=models.CASCADE)\n",
            )],
        );
        let idx =
            crate::static_index::build_static_index_resolved(root, &[root.join("shop/models.py")]);
        let reverse: Vec<&FieldCandidate> = idx
            .fields
            .iter()
            .filter(|f| {
                f.model_label == "shop.User" && f.relation_direction.as_deref() == Some("reverse")
            })
            .collect();
        assert_eq!(reverse.len(), 1);
        assert_eq!(reverse[0].name, "profile");
    }

    #[test]
    fn respects_related_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\n\nclass User(models.Model):\n    pass\n\nclass Order(models.Model):\n    buyer = models.ForeignKey('shop.User', on_delete=models.CASCADE, related_name='orders')\n",
            )],
        );
        let idx =
            crate::static_index::build_static_index_resolved(root, &[root.join("shop/models.py")]);
        let reverse: Vec<&FieldCandidate> = idx
            .fields
            .iter()
            .filter(|f| {
                f.model_label == "shop.User" && f.relation_direction.as_deref() == Some("reverse")
            })
            .collect();
        assert_eq!(reverse.len(), 1);
        assert_eq!(reverse[0].name, "orders");
    }

    #[test]
    fn hidden_related_name_suppresses_reverse() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\n\nclass User(models.Model):\n    pass\n\nclass Order(models.Model):\n    buyer = models.ForeignKey('shop.User', on_delete=models.CASCADE, related_name='+')\n",
            )],
        );
        let idx =
            crate::static_index::build_static_index_resolved(root, &[root.join("shop/models.py")]);
        let reverse: Vec<&FieldCandidate> = idx
            .fields
            .iter()
            .filter(|f| {
                f.model_label == "shop.User" && f.relation_direction.as_deref() == Some("reverse")
            })
            .collect();
        assert!(reverse.is_empty());
    }

    #[test]
    fn expands_model_via_inheritance_and_import() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[
                (
                    "base/models.py",
                    "from django.db import models\n\nclass TimestampedModel(models.Model):\n    created = models.DateTimeField(auto_now_add=True)\n    class Meta:\n        abstract = True\n",
                ),
                (
                    "shop/models.py",
                    "from base.models import TimestampedModel\n\nclass Product(TimestampedModel):\n    pass\n",
                ),
            ],
        );
        let idx = crate::static_index::build_static_index_resolved(
            root,
            &[root.join("base/models.py"), root.join("shop/models.py")],
        );
        let labels: Vec<&str> = idx
            .model_candidates
            .iter()
            .map(|m| m.label.as_str())
            .collect();
        // Both the declared base and the derived class should be present.
        assert!(labels.contains(&"base.TimestampedModel"));
        assert!(labels.contains(&"shop.Product"));
    }

    #[test]
    fn leaves_unresolved_when_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[
                (
                    "a/models.py",
                    "from django.db import models\nclass Dup(models.Model):\n    pass\n",
                ),
                (
                    "b/models.py",
                    "from django.db import models\nclass Dup(models.Model):\n    pass\n",
                ),
                (
                    "c/models.py",
                    "from django.db import models\nclass Ref(models.Model):\n    d = models.ForeignKey(Dup, on_delete=models.CASCADE)\n",
                ),
            ],
        );
        let idx = build_static_index(
            root,
            &[
                root.join("a/models.py"),
                root.join("b/models.py"),
                root.join("c/models.py"),
            ],
        );
        let fields = resolve_fields(&idx.model_candidates, &idx.modules);
        let ref_d = fields.iter().find(|f| f.name == "d").unwrap();
        assert!(ref_d.related_model_label.is_none());
    }
}
