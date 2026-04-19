//! Rust port of `features/reexports.py` + the parts of
//! `static_index/indexer.py` that answer `resolve_export_origin` and
//! `resolve_module`.
//!
//! These queries walk `__init__.py` re-export chains across modules
//! and return the origin definition site. Python currently serves them
//! via a recursive export map built on demand; the Rust version uses
//! the same algorithm but operates on the in-memory `StaticIndex` with
//! no IPC hop.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;

use crate::static_index::{ImportBinding, ModuleIndex, StaticIndex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResolution {
    pub requested_module: String,
    pub symbol: String,
    pub resolved: bool,
    pub origin_module: Option<String>,
    pub origin_symbol: Option<String>,
    pub origin_file_path: Option<String>,
    pub origin_line: Option<u32>,
    pub origin_column: Option<u32>,
    pub via_modules: Vec<String>,
    pub resolution_kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleResolution {
    pub requested_module: String,
    pub resolved: bool,
    pub file_path: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

fn find_module<'a>(index: &'a StaticIndex, module_name: &str) -> Option<&'a ModuleIndex> {
    index.modules.iter().find(|m| m.module_name == module_name)
}

fn symbol_location<'a>(
    module: &'a ModuleIndex,
    symbol: &str,
) -> Option<&'a crate::static_index::DefinitionLocation> {
    module
        .symbol_definitions
        .iter()
        .find_map(|(name, loc)| if name == symbol { Some(loc) } else { None })
}

fn locate_module_or_symbol(
    index: &StaticIndex,
    module_name: &str,
    symbol: Option<&str>,
) -> Option<(String, u32, u32)> {
    let module = find_module(index, module_name)?;
    match symbol {
        None => Some((module.file_path.clone(), 1, 1)),
        Some(sym) => {
            let loc = symbol_location(module, sym)?;
            Some((loc.file_path.clone(), loc.line, loc.column))
        }
    }
}

fn apply_export_filter(
    module: &ModuleIndex,
    mut exports: HashMap<String, ExportResolution>,
) -> HashMap<String, ExportResolution> {
    match &module.explicit_all {
        Some(list) => {
            let allowed: HashSet<&str> = list.iter().map(|s| s.as_str()).collect();
            exports.retain(|name, _| allowed.contains(name.as_str()));
            exports
        }
        None => {
            exports.retain(|name, _| !name.starts_with('_'));
            exports
        }
    }
}

fn prepend_module(
    resolution: &ExportResolution,
    requested_module: &str,
    module_name: &str,
    resolution_kind: &str,
    symbol: Option<&str>,
) -> ExportResolution {
    let mut via_modules = vec![module_name.to_string()];
    for name in &resolution.via_modules {
        if name != module_name {
            via_modules.push(name.clone());
        }
    }
    ExportResolution {
        requested_module: requested_module.to_string(),
        symbol: symbol.map(String::from).unwrap_or_else(|| resolution.symbol.clone()),
        resolved: resolution.resolved,
        origin_module: resolution.origin_module.clone(),
        origin_symbol: resolution.origin_symbol.clone(),
        origin_file_path: resolution.origin_file_path.clone(),
        origin_line: resolution.origin_line,
        origin_column: resolution.origin_column,
        via_modules,
        resolution_kind: resolution_kind.to_string(),
    }
}

/// Per-`StaticIndex` cache of `module_name → symbol_exports`. Keyed
/// by the `modules` slice pointer so a rebuild invalidates cleanly.
type ExportCacheEntry = HashMap<String, HashMap<String, ExportResolution>>;
type ExportCache = HashMap<usize, ExportCacheEntry>;

fn export_cache() -> &'static Mutex<ExportCache> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Mutex<ExportCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Invalidate the export-origin memoization. Call after rebuilding the
/// resident static index.
pub fn clear_export_cache() {
    if let Ok(mut guard) = export_cache().lock() {
        guard.clear();
    }
}

fn cache_key(index: &StaticIndex) -> usize {
    index.modules.as_ptr() as usize
}

fn resolve_module_exports(
    index: &StaticIndex,
    module_name: &str,
    stack: &mut BTreeSet<String>,
) -> HashMap<String, ExportResolution> {
    // Cache hit?
    {
        if let Ok(guard) = export_cache().lock() {
            if let Some(per_index) = guard.get(&cache_key(index)) {
                if let Some(hit) = per_index.get(module_name) {
                    return hit.clone();
                }
            }
        }
    }

    if stack.contains(module_name) {
        return HashMap::new();
    }

    let module = match find_module(index, module_name) {
        Some(m) => m,
        None => return HashMap::new(),
    };

    let mut exports: HashMap<String, ExportResolution> = HashMap::new();
    stack.insert(module_name.to_string());

    for symbol in &module.defined_symbols {
        let (fp, line, col) = symbol_location(module, symbol)
            .map(|l| (l.file_path.clone(), l.line, l.column))
            .unwrap_or_else(|| (module.file_path.clone(), 1, 1));
        exports.insert(
            symbol.clone(),
            ExportResolution {
                requested_module: module_name.to_string(),
                symbol: symbol.clone(),
                resolved: true,
                origin_module: Some(module_name.to_string()),
                origin_symbol: Some(symbol.clone()),
                origin_file_path: Some(fp),
                origin_line: Some(line),
                origin_column: Some(col),
                via_modules: vec![module_name.to_string()],
                resolution_kind: "defined".into(),
            },
        );
    }

    for binding in &module.import_bindings {
        handle_binding_export(index, module_name, binding, &mut exports, stack);
    }

    stack.remove(module_name);

    let filtered = apply_export_filter(module, exports);

    if let Ok(mut guard) = export_cache().lock() {
        let per_index = guard.entry(cache_key(index)).or_default();
        per_index.insert(module_name.to_string(), filtered.clone());
    }

    filtered
}

fn handle_binding_export(
    index: &StaticIndex,
    module_name: &str,
    binding: &ImportBinding,
    exports: &mut HashMap<String, ExportResolution>,
    stack: &mut BTreeSet<String>,
) {
    if binding.is_star {
        let star_exports = resolve_module_exports(index, &binding.module, stack);
        for (name, res) in star_exports {
            if name.starts_with('_') {
                continue;
            }
            exports.entry(name.clone()).or_insert_with(|| {
                prepend_module(&res, module_name, module_name, "star_import", None)
            });
        }
        return;
    }

    match &binding.symbol {
        None => {
            let loc = locate_module_or_symbol(index, &binding.module, None);
            exports.insert(
                binding.alias.clone(),
                ExportResolution {
                    requested_module: module_name.to_string(),
                    symbol: binding.alias.clone(),
                    resolved: true,
                    origin_module: Some(binding.module.clone()),
                    origin_symbol: None,
                    origin_file_path: loc.as_ref().map(|l| l.0.clone()),
                    origin_line: loc.as_ref().map(|l| l.1),
                    origin_column: loc.as_ref().map(|l| l.2),
                    via_modules: vec![module_name.to_string(), binding.module.clone()],
                    resolution_kind: "module_import".into(),
                },
            );
        }
        Some(sym) => {
            let nested = resolve_module_exports(index, &binding.module, stack);
            if let Some(nested_res) = nested.get(sym) {
                if nested_res.resolved {
                    exports.insert(
                        binding.alias.clone(),
                        prepend_module(
                            nested_res,
                            module_name,
                            module_name,
                            "imported",
                            Some(&binding.alias),
                        ),
                    );
                    return;
                }
            }
            let loc = locate_module_or_symbol(index, &binding.module, Some(sym));
            exports.insert(
                binding.alias.clone(),
                ExportResolution {
                    requested_module: module_name.to_string(),
                    symbol: binding.alias.clone(),
                    resolved: true,
                    origin_module: Some(binding.module.clone()),
                    origin_symbol: Some(sym.clone()),
                    origin_file_path: loc.as_ref().map(|l| l.0.clone()),
                    origin_line: loc.as_ref().map(|l| l.1),
                    origin_column: loc.as_ref().map(|l| l.2),
                    via_modules: vec![module_name.to_string(), binding.module.clone()],
                    resolution_kind: "imported_fallback".into(),
                },
            );
        }
    }
}

fn resolve_direct_module_attribute(
    index: &StaticIndex,
    module_name: &str,
    symbol: &str,
    stack: &mut BTreeSet<String>,
) -> Option<ExportResolution> {
    let key = format!("{module_name}::{symbol}");
    if stack.contains(&key) {
        return None;
    }

    let module = find_module(index, module_name)?;

    if module.defined_symbols.iter().any(|s| s == symbol) {
        let (fp, line, col) = symbol_location(module, symbol)
            .map(|l| (l.file_path.clone(), l.line, l.column))
            .unwrap_or_else(|| (module.file_path.clone(), 1, 1));
        return Some(ExportResolution {
            requested_module: module_name.to_string(),
            symbol: symbol.to_string(),
            resolved: true,
            origin_module: Some(module_name.to_string()),
            origin_symbol: Some(symbol.to_string()),
            origin_file_path: Some(fp),
            origin_line: Some(line),
            origin_column: Some(col),
            via_modules: vec![module_name.to_string()],
            resolution_kind: "direct_defined".into(),
        });
    }

    stack.insert(key.clone());

    let bindings = module.import_bindings.clone();
    for binding in &bindings {
        if binding.is_star {
            let mut inner_stack = BTreeSet::new();
            let star_exports = resolve_module_exports(index, &binding.module, &mut inner_stack);
            if let Some(res) = star_exports.get(symbol) {
                if res.resolved {
                    stack.remove(&key);
                    return Some(prepend_module(
                        res,
                        module_name,
                        module_name,
                        "direct_star_import",
                        Some(symbol),
                    ));
                }
            }
            continue;
        }
        if binding.alias != symbol {
            continue;
        }
        match &binding.symbol {
            None => {
                let loc = locate_module_or_symbol(index, &binding.module, None);
                stack.remove(&key);
                return Some(ExportResolution {
                    requested_module: module_name.to_string(),
                    symbol: symbol.to_string(),
                    resolved: true,
                    origin_module: Some(binding.module.clone()),
                    origin_symbol: None,
                    origin_file_path: loc.as_ref().map(|l| l.0.clone()),
                    origin_line: loc.as_ref().map(|l| l.1),
                    origin_column: loc.as_ref().map(|l| l.2),
                    via_modules: vec![module_name.to_string(), binding.module.clone()],
                    resolution_kind: "direct_module_import".into(),
                });
            }
            Some(nested_sym) => {
                if let Some(nested_res) =
                    resolve_direct_module_attribute(index, &binding.module, nested_sym, stack)
                {
                    if nested_res.resolved {
                        stack.remove(&key);
                        return Some(prepend_module(
                            &nested_res,
                            module_name,
                            module_name,
                            "direct_imported",
                            Some(symbol),
                        ));
                    }
                }
                let loc = locate_module_or_symbol(index, &binding.module, Some(nested_sym));
                if loc.is_some() {
                    stack.remove(&key);
                    return Some(ExportResolution {
                        requested_module: module_name.to_string(),
                        symbol: symbol.to_string(),
                        resolved: true,
                        origin_module: Some(binding.module.clone()),
                        origin_symbol: Some(nested_sym.clone()),
                        origin_file_path: loc.as_ref().map(|l| l.0.clone()),
                        origin_line: loc.as_ref().map(|l| l.1),
                        origin_column: loc.as_ref().map(|l| l.2),
                        via_modules: vec![module_name.to_string(), binding.module.clone()],
                        resolution_kind: "direct_imported_fallback".into(),
                    });
                }
            }
        }
    }

    stack.remove(&key);
    None
}

/// Resolve `(module_name, symbol)` through `__init__.py` re-export
/// chains. Mirrors Python `StaticIndex.resolve_export_origin`.
pub fn resolve_export_origin(
    index: &StaticIndex,
    module_name: &str,
    symbol: &str,
) -> ExportResolution {
    let mut stack: BTreeSet<String> = BTreeSet::new();
    let exports = resolve_module_exports(index, module_name, &mut stack);
    if let Some(hit) = exports.get(symbol) {
        return hit.clone();
    }

    let mut direct_stack: BTreeSet<String> = BTreeSet::new();
    if let Some(direct) =
        resolve_direct_module_attribute(index, module_name, symbol, &mut direct_stack)
    {
        return direct;
    }

    ExportResolution {
        requested_module: module_name.to_string(),
        symbol: symbol.to_string(),
        resolved: false,
        origin_module: None,
        origin_symbol: None,
        origin_file_path: None,
        origin_line: None,
        origin_column: None,
        via_modules: vec![module_name.to_string()],
        resolution_kind: "unresolved".into(),
    }
}

/// Resolve a module path → file location.
pub fn resolve_module(index: &StaticIndex, module_name: &str) -> ModuleResolution {
    match find_module(index, module_name) {
        Some(module) => ModuleResolution {
            requested_module: module_name.to_string(),
            resolved: true,
            file_path: Some(module.file_path.clone()),
            line: Some(1),
            column: Some(1),
        },
        None => ModuleResolution {
            requested_module: module_name.to_string(),
            resolved: false,
            file_path: None,
            line: None,
            column: None,
        },
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

    fn build_index_for(files: &[(&str, &str)]) -> StaticIndex {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, files);
        let paths: Vec<std::path::PathBuf> = files
            .iter()
            .map(|(rel, _)| root.join(rel))
            .collect();
        let idx = build_static_index_resolved(root, &paths);
        // Leak the tempdir so paths survive tests (content already read).
        std::mem::forget(dir);
        idx
    }

    #[test]
    fn direct_defined_symbol_resolves() {
        clear_export_cache();
        let idx = build_index_for(&[(
            "shop/models.py",
            "from django.db import models\n\nclass Order(models.Model):\n    pass\n",
        )]);
        let res = resolve_export_origin(&idx, "shop.models", "Order");
        assert!(res.resolved, "got {:?}", res);
        assert_eq!(res.origin_module.as_deref(), Some("shop.models"));
        assert_eq!(res.origin_symbol.as_deref(), Some("Order"));
    }

    #[test]
    fn init_reexport_follows_chain() {
        clear_export_cache();
        let idx = build_index_for(&[
            (
                "shop/models.py",
                "from django.db import models\n\nclass User(models.Model):\n    pass\n",
            ),
            (
                "shop/__init__.py",
                "from .models import User\n",
            ),
        ]);
        let res = resolve_export_origin(&idx, "shop", "User");
        assert!(res.resolved, "got {:?}", res);
        assert_eq!(res.origin_module.as_deref(), Some("shop.models"));
        assert!(res.via_modules.contains(&"shop".to_string()));
        assert!(res.via_modules.contains(&"shop.models".to_string()));
    }

    #[test]
    fn alias_renames_symbol() {
        clear_export_cache();
        let idx = build_index_for(&[
            (
                "pkg/impl.py",
                "class Widget:\n    pass\n",
            ),
            (
                "pkg/__init__.py",
                "from .impl import Widget as Gadget\n",
            ),
        ]);
        let res = resolve_export_origin(&idx, "pkg", "Gadget");
        assert!(res.resolved);
        assert_eq!(res.origin_module.as_deref(), Some("pkg.impl"));
        assert_eq!(res.origin_symbol.as_deref(), Some("Widget"));
    }

    #[test]
    fn explicit_all_filters_export_map() {
        clear_export_cache();
        let idx = build_index_for(&[
            (
                "pkg/a.py",
                "class A:\n    pass\nclass B:\n    pass\n",
            ),
            (
                "pkg/__init__.py",
                "from .a import A, B\n__all__ = ['A']\n",
            ),
        ]);
        // A is in __all__, so resolved via the export map (resolution_kind="imported").
        let a = resolve_export_origin(&idx, "pkg", "A");
        assert!(a.resolved);
        assert_eq!(a.resolution_kind, "imported");
        // B is filtered out of the export map, but the direct-attribute
        // fallback still reports it (Python parity).
        let b = resolve_export_origin(&idx, "pkg", "B");
        assert!(b.resolved);
        assert!(b.resolution_kind.starts_with("direct_"), "got {:?}", b);
    }

    #[test]
    fn unknown_symbol_returns_unresolved() {
        clear_export_cache();
        let idx = build_index_for(&[(
            "shop/models.py",
            "from django.db import models\n",
        )]);
        let res = resolve_export_origin(&idx, "shop.models", "NonExistent");
        assert!(!res.resolved);
        assert_eq!(res.resolution_kind, "unresolved");
    }

    #[test]
    fn resolve_module_returns_file_path() {
        let idx = build_index_for(&[(
            "pkg/foo.py",
            "class Foo:\n    pass\n",
        )]);
        let res = resolve_module(&idx, "pkg.foo");
        assert!(res.resolved);
        assert!(res.file_path.as_deref().unwrap().ends_with("pkg/foo.py"));
        assert_eq!(res.line, Some(1));
        assert_eq!(res.column, Some(1));
    }

    #[test]
    fn resolve_module_missing_returns_unresolved() {
        let idx = build_index_for(&[]);
        let res = resolve_module(&idx, "missing.module");
        assert!(!res.resolved);
        assert!(res.file_path.is_none());
    }
}
