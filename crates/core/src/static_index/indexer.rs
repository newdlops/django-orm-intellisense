//! Parallel AST indexing driver. Given a workspace root + file list,
//! parse each with rustpython-parser and extract per-module info.

use std::fs;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use rustpython_ast::Mod;
use rustpython_parser::{parse, Mode};

use super::resolver::{expand_via_inheritance, resolve_fields, synthesize_reverse_relations};
use super::types::{ModuleIndex, StaticIndex};
use super::visitor::visit_module;

/// Parse a single file and return its `ModuleIndex`. Returns `None` on
/// I/O or parser failure — callers treat this as a skipped file rather
/// than a fatal error, matching Python behavior.
pub fn parse_module(root: &Path, file_path: &Path) -> Option<ModuleIndex> {
    let source = fs::read_to_string(file_path).ok()?;
    let relative = file_path.strip_prefix(root).unwrap_or(file_path);
    let module_name = module_name_from_path(relative);
    let is_package_init = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "__init__.py")
        .unwrap_or(false);

    let parsed = parse(&source, Mode::Module, &file_path.to_string_lossy()).ok()?;
    let body = match parsed {
        Mod::Module(m) => m.body,
        _ => return None,
    };

    Some(visit_module(
        &body,
        &source,
        &module_name,
        &file_path.to_string_lossy(),
        is_package_init,
    ))
}

/// Parse all files in parallel and return a merged `StaticIndex` with
/// model candidates and raw per-module pending fields.
pub fn build_static_index(root: &Path, files: &[PathBuf]) -> StaticIndex {
    let modules: Vec<ModuleIndex> = files
        .par_iter()
        .filter_map(|p| parse_module(root, p))
        .collect();

    let mut idx = StaticIndex::default();
    for module in &modules {
        idx.model_candidates.extend(module.model_candidates.clone());
        idx.methods.extend(module.methods.clone());
    }
    idx.modules = modules;
    idx
}

/// Same as `build_static_index` but also runs the P4.2 resolver
/// (inheritance expansion + forward-relation target resolution +
/// reverse-relation synthesis) to populate `StaticIndex.fields`.
pub fn build_static_index_resolved(root: &Path, files: &[PathBuf]) -> StaticIndex {
    let mut idx = build_static_index(root, files);
    // Step 1: expand model candidates via import/inheritance BFS.
    idx.model_candidates = expand_via_inheritance(&idx.model_candidates, &mut idx.modules);
    // Step 2: resolve forward-relation targets on pending fields.
    let forward = resolve_fields(&idx.model_candidates, &idx.modules);
    // Step 3: synthesize reverse-relation entries on pointed-to models.
    let reverse = synthesize_reverse_relations(&forward, &idx.model_candidates);
    idx.fields = forward;
    idx.fields.extend(reverse);
    idx
}

fn module_name_from_path(relative: &Path) -> String {
    let mut parts: Vec<String> = relative
        .with_extension("")
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    // drop trailing __init__
    if parts.last().map(|s| s.as_str()) == Some("__init__") {
        parts.pop();
    }
    parts.join(".")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_tree(root: &Path, files: &[(&str, &str)]) {
        for (rel, content) in files {
            let full = root.join(rel);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(full, content).unwrap();
        }
    }

    #[test]
    fn detects_basic_model_and_fields() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\n\nclass Product(models.Model):\n    name = models.CharField(max_length=100)\n    stock = models.IntegerField(default=0)\n    seller = models.ForeignKey('shop.User', on_delete=models.CASCADE, related_name='products')\n",
            )],
        );

        let idx = build_static_index(root, &[root.join("shop/models.py")]);
        assert_eq!(idx.model_candidates.len(), 1);
        let model = &idx.model_candidates[0];
        assert_eq!(model.object_name, "Product");
        assert_eq!(model.app_label, "shop");
        assert_eq!(model.label, "shop.Product");
        assert!(!model.is_abstract);

        let module = idx
            .modules
            .iter()
            .find(|m| m.module_name == "shop.models")
            .expect("module present");
        assert_eq!(module.pending_fields.len(), 3);
        let seller = module
            .pending_fields
            .iter()
            .find(|f| f.name == "seller")
            .unwrap();
        assert_eq!(seller.field_kind, "ForeignKey");
        assert!(seller.is_relation);
        assert_eq!(seller.related_model_ref_value.as_deref(), Some("shop.User"));
        assert_eq!(seller.related_name.as_deref(), Some("products"));
    }

    #[test]
    fn respects_explicit_app_label_and_abstract() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "pkg/models.py",
                "from django.db import models\n\nclass Base(models.Model):\n    class Meta:\n        abstract = True\n        app_label = 'other'\n    name = models.CharField(max_length=10)\n",
            )],
        );

        let idx = build_static_index(root, &[root.join("pkg/models.py")]);
        let model = &idx.model_candidates[0];
        assert!(model.is_abstract);
        assert_eq!(model.app_label, "other");
        assert_eq!(model.label, "other.Base");
    }

    #[test]
    fn skips_non_model_classes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "m.py",
                "class Foo:\n    pass\n\nclass Bar(object):\n    pass\n",
            )],
        );
        let idx = build_static_index(root, &[root.join("m.py")]);
        assert!(idx.model_candidates.is_empty());
    }

    #[test]
    fn parses_multiple_files_in_parallel() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut files = Vec::new();
        for i in 0..20 {
            let rel = format!("app{i}/models.py");
            write_tree(
                root,
                &[(
                    rel.as_str(),
                    &format!(
                        "from django.db import models\n\nclass Thing{i}(models.Model):\n    name = models.CharField(max_length=20)\n",
                    ),
                )],
            );
            files.push(root.join(rel));
        }
        let idx = build_static_index(root, &files);
        assert_eq!(idx.model_candidates.len(), 20);
    }

    #[test]
    fn extracts_project_methods_with_decorator_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "shop/models.py",
                r#"from django.db import models
from functools import cached_property

class Order(models.Model):
    total = models.IntegerField()

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)

    async def send_email(self) -> None:
        pass

    @property
    def formatted_total(self) -> str:
        return f'${self.total}'

    @cached_property
    def line_count(self) -> int:
        return 0

    @classmethod
    def from_json(cls, payload):
        return cls()

    @staticmethod
    def default_label():
        return 'Order'
"#,
            )],
        );

        let idx = build_static_index(root, &[root.join("shop/models.py")]);
        let methods: Vec<&super::super::types::ProjectMethod> = idx
            .methods
            .iter()
            .filter(|m| m.model_label == "shop.Order")
            .collect();
        let names: Vec<&str> = methods.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains(&"save"));
        assert!(names.contains(&"send_email"));
        assert!(names.contains(&"formatted_total"));
        assert!(names.contains(&"line_count"));
        assert!(names.contains(&"from_json"));
        assert!(names.contains(&"default_label"));

        let kind_of = |name: &str| -> String {
            methods
                .iter()
                .find(|m| m.name == name)
                .map(|m| m.kind.clone())
                .unwrap_or_default()
        };
        assert_eq!(kind_of("save"), "method");
        assert_eq!(kind_of("send_email"), "async_method");
        assert_eq!(kind_of("formatted_total"), "property");
        assert_eq!(kind_of("line_count"), "cached_property");
        assert_eq!(kind_of("from_json"), "classmethod");
        assert_eq!(kind_of("default_label"), "staticmethod");

        // Return annotations captured when present.
        let formatted = methods
            .iter()
            .find(|m| m.name == "formatted_total")
            .unwrap();
        assert_eq!(formatted.return_annotation.as_deref(), Some("str"));
    }

    #[test]
    fn skips_meta_inner_class_from_methods() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(
            root,
            &[(
                "shop/models.py",
                "from django.db import models\n\nclass Order(models.Model):\n    class Meta:\n        ordering = ['id']\n    def nothing(self):\n        pass\n",
            )],
        );
        let idx = build_static_index(root, &[root.join("shop/models.py")]);
        let methods: Vec<&str> = idx
            .methods
            .iter()
            .filter(|m| m.model_label == "shop.Order")
            .map(|m| m.name.as_str())
            .collect();
        assert!(methods.contains(&"nothing"));
        assert!(!methods.contains(&"Meta"));
    }
}
