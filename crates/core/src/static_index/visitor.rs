//! AST visitor extracting Django model/field candidates from a single
//! parsed Python module. Operates directly on the
//! `rustpython_ast::Mod::Module` tree with location-aware nodes.

use rustpython_ast::text_size::TextRange;
use rustpython_ast::{self as ast, Expr, Ranged, Stmt};
use rustpython_parser::source_code::{LineIndex, OneIndexed, SourceCode};

use super::types::{
    is_django_field_class, is_relation_field_kind, DefinitionLocation, ImportBinding,
    ModelCandidate, ModuleIndex, PendingFieldCandidate,
};

/// Walk the module AST, populating `ModuleIndex`. `module_name` is the
/// dotted Python module name (e.g. `myapp.models`). `file_path` is the
/// absolute path used for diagnostics and cache keys.
pub fn visit_module(
    body: &[Stmt],
    source: &str,
    module_name: &str,
    file_path: &str,
    is_package_init: bool,
) -> ModuleIndex {
    let line_index = LineIndex::from_source_text(source);
    let src = SourceCode::new(source, &line_index);
    let mut v = Visitor::new(src, module_name, file_path, is_package_init);
    v.visit_stmts(body);
    v.finalize()
}

struct Visitor<'a> {
    src: SourceCode<'a, 'a>,
    module_name: String,
    file_path: String,
    is_package_init: bool,

    defined_symbols: Vec<String>,
    symbol_definitions: Vec<(String, DefinitionLocation)>,
    import_bindings: Vec<ImportBinding>,
    explicit_all: Option<Vec<String>>,
    model_candidates: Vec<ModelCandidate>,
    pending_fields: Vec<PendingFieldCandidate>,
    class_base_refs: Vec<(String, Vec<String>)>,
    field_class_names: Vec<String>,
    field_aliases: Vec<(String, String)>,
}

impl<'a> Visitor<'a> {
    fn new(
        src: SourceCode<'a, 'a>,
        module_name: &str,
        file_path: &str,
        is_package_init: bool,
    ) -> Self {
        Self {
            src,
            module_name: module_name.to_string(),
            file_path: file_path.to_string(),
            is_package_init,
            defined_symbols: Vec::new(),
            symbol_definitions: Vec::new(),
            import_bindings: Vec::new(),
            explicit_all: None,
            model_candidates: Vec::new(),
            pending_fields: Vec::new(),
            class_base_refs: Vec::new(),
            field_class_names: Vec::new(),
            field_aliases: Vec::new(),
        }
    }

    fn finalize(mut self) -> ModuleIndex {
        self.defined_symbols.sort();
        self.defined_symbols.dedup();
        ModuleIndex {
            module_name: self.module_name,
            file_path: self.file_path,
            is_package_init: self.is_package_init,
            defined_symbols: self.defined_symbols,
            symbol_definitions: self.symbol_definitions,
            import_bindings: self.import_bindings,
            explicit_all: self.explicit_all,
            model_candidates: self.model_candidates,
            pending_fields: self.pending_fields,
            class_base_refs: self.class_base_refs,
            field_class_names: self.field_class_names,
            field_aliases: self.field_aliases,
        }
    }

    fn location_of(&self, range: TextRange) -> (u32, u32) {
        let loc = self.src.source_location(range.start());
        (raw_line(loc.row), raw_col(loc.column))
    }

    fn visit_stmts(&mut self, stmts: &[Stmt]) {
        for stmt in stmts {
            self.visit_stmt(stmt);
        }
    }

    fn visit_stmt(&mut self, stmt: &Stmt) {
        match stmt {
            Stmt::Import(i) => {
                for alias in &i.names {
                    let (module, symbol) = split_first_dot(&alias.name);
                    let binding_alias = alias
                        .asname
                        .as_ref()
                        .map(|s| s.as_str().to_string())
                        .unwrap_or_else(|| module.clone());
                    self.import_bindings.push(ImportBinding {
                        module: alias.name.as_str().to_string(),
                        symbol,
                        alias: binding_alias.clone(),
                        is_star: false,
                    });
                    self.defined_symbols.push(binding_alias);
                }
            }
            Stmt::ImportFrom(i) => {
                let module = i.module.as_ref().map(|m| m.as_str().to_string());
                if let Some(module) = module {
                    for alias in &i.names {
                        if alias.name.as_str() == "*" {
                            self.import_bindings.push(ImportBinding {
                                module: module.clone(),
                                symbol: None,
                                alias: String::from("*"),
                                is_star: true,
                            });
                            continue;
                        }
                        let symbol_name = alias.name.as_str().to_string();
                        let binding_alias = alias
                            .asname
                            .as_ref()
                            .map(|s| s.as_str().to_string())
                            .unwrap_or_else(|| symbol_name.clone());
                        self.import_bindings.push(ImportBinding {
                            module: module.clone(),
                            symbol: Some(symbol_name),
                            alias: binding_alias.clone(),
                            is_star: false,
                        });
                        self.defined_symbols.push(binding_alias);
                    }
                }
            }
            Stmt::ClassDef(c) => {
                let name = c.name.as_str().to_string();
                let (line, column) = self.location_of(stmt.range());
                self.defined_symbols.push(name.clone());
                self.symbol_definitions.push((
                    name.clone(),
                    DefinitionLocation {
                        file_path: self.file_path.clone(),
                        line,
                        column,
                    },
                ));

                let base_refs: Vec<String> = c.bases.iter().map(dotted_name).collect();
                self.class_base_refs.push((name.clone(), base_refs.clone()));

                if self.looks_like_model(&base_refs) {
                    let object_name = name.clone();
                    let is_abstract = extract_is_abstract(&c.body);
                    let app_label = extract_meta_app_label(&c.body)
                        .unwrap_or_else(|| infer_app_label(&self.module_name));
                    let label = format!("{app_label}.{object_name}");
                    let candidate = ModelCandidate {
                        app_label: app_label.clone(),
                        object_name: object_name.clone(),
                        label: label.clone(),
                        module: self.module_name.clone(),
                        file_path: self.file_path.clone(),
                        line,
                        column,
                        is_abstract,
                        base_class_refs: base_refs.clone(),
                        source: "static".into(),
                    };

                    self.extract_fields(&c.body, &label, &app_label);
                    self.model_candidates.push(candidate);
                }

                // Recurse into nested classes for nested model defs.
                self.visit_stmts(&c.body);
            }
            Stmt::FunctionDef(f) => {
                let (line, column) = self.location_of(stmt.range());
                let name = f.name.as_str().to_string();
                self.defined_symbols.push(name.clone());
                self.symbol_definitions.push((
                    name,
                    DefinitionLocation {
                        file_path: self.file_path.clone(),
                        line,
                        column,
                    },
                ));
            }
            Stmt::AsyncFunctionDef(f) => {
                let (line, column) = self.location_of(stmt.range());
                let name = f.name.as_str().to_string();
                self.defined_symbols.push(name.clone());
                self.symbol_definitions.push((
                    name,
                    DefinitionLocation {
                        file_path: self.file_path.clone(),
                        line,
                        column,
                    },
                ));
            }
            Stmt::Assign(a) => {
                if let Some(target) = a.targets.first() {
                    if let Expr::Name(n) = target {
                        let name = n.id.as_str().to_string();
                        if name == "__all__" {
                            self.explicit_all = extract_string_sequence(&a.value);
                        }
                        self.defined_symbols.push(name);
                    }
                }
                // Track `FooField = models.CharField` style aliases at
                // module scope so class bodies can detect them later.
                if let (Some(Expr::Name(target)), Expr::Attribute(_) | Expr::Name(_)) =
                    (a.targets.first(), a.value.as_ref())
                {
                    let rhs = dotted_name(&a.value);
                    if !rhs.is_empty() {
                        let last = rhs.rsplit('.').next().unwrap_or(&rhs);
                        if is_django_field_class(last) {
                            self.field_aliases
                                .push((target.id.as_str().to_string(), last.to_string()));
                        }
                    }
                }
            }
            Stmt::If(i) => {
                // Skip TYPE_CHECKING blocks so runtime imports aren't
                // accidentally treated as available.
                if !is_type_checking_guard(&i.test) {
                    self.visit_stmts(&i.body);
                }
                self.visit_stmts(&i.orelse);
            }
            _ => {}
        }
    }

    /// Returns true if any base expression plausibly refers to a Django
    /// `Model`. We accept `models.Model`, `Model`, and any locally
    /// declared name that could be a base (loose — later resolution
    /// prunes false positives; intentional, matches Python behavior).
    fn looks_like_model(&self, base_refs: &[String]) -> bool {
        for base in base_refs {
            let tail = base.rsplit('.').next().unwrap_or(base);
            if tail == "Model" || base == "models.Model" {
                return true;
            }
            // Known wagtail-style bases routed through `Page` etc live
            // behind explicit class detection and are out of scope here.
        }
        false
    }

    fn extract_fields(&mut self, body: &[Stmt], model_label: &str, app_label: &str) {
        for stmt in body {
            let Stmt::Assign(a) = stmt else { continue };
            let Some(Expr::Name(target)) = a.targets.first() else {
                continue;
            };
            let Expr::Call(call) = a.value.as_ref() else {
                continue;
            };

            let call_ref = dotted_name(&call.func);
            if call_ref.is_empty() {
                continue;
            }
            let field_kind = call_ref.rsplit('.').next().unwrap_or(&call_ref).to_string();
            if !is_django_field_class(&field_kind) {
                continue;
            }

            let (line, column) = self.location_of(stmt.range());
            let is_relation = is_relation_field_kind(&field_kind);

            let (ref_kind, ref_value) = if is_relation {
                extract_related_model_reference(call)
            } else {
                (None, None)
            };
            let related_name = if is_relation {
                extract_keyword_string(call, "related_name")
            } else {
                None
            };
            let related_query_name = if is_relation {
                extract_keyword_string(call, "related_query_name")
            } else {
                None
            };

            self.pending_fields.push(PendingFieldCandidate {
                model_label: model_label.to_string(),
                model_module: self.module_name.clone(),
                app_label: app_label.to_string(),
                name: target.id.as_str().to_string(),
                file_path: self.file_path.clone(),
                line,
                column,
                field_call_ref: call_ref,
                field_kind: field_kind.clone(),
                is_relation,
                related_model_ref_kind: ref_kind,
                related_model_ref_value: ref_value,
                related_name,
                related_query_name,
            });
        }
    }
}

fn raw_line(row: OneIndexed) -> u32 {
    u32::try_from(row.get()).unwrap_or(u32::MAX)
}

fn raw_col(col: OneIndexed) -> u32 {
    // OneIndexed -> 0-indexed column for editor convention. Python AST
    // returns col_offset 0-indexed, so subtract 1.
    let v = col.get();
    u32::try_from(v.saturating_sub(1)).unwrap_or(0)
}

fn split_first_dot(s: &str) -> (String, Option<String>) {
    match s.find('.') {
        Some(idx) => (s[..idx].to_string(), Some(s[idx + 1..].to_string())),
        None => (s.to_string(), None),
    }
}

fn dotted_name(expr: &Expr) -> String {
    match expr {
        Expr::Name(n) => n.id.as_str().to_string(),
        Expr::Attribute(a) => {
            let base = dotted_name(&a.value);
            if base.is_empty() {
                a.attr.as_str().to_string()
            } else {
                format!("{}.{}", base, a.attr.as_str())
            }
        }
        _ => String::new(),
    }
}

fn extract_string_sequence(expr: &Expr) -> Option<Vec<String>> {
    match expr {
        Expr::List(l) => extract_string_elts(&l.elts),
        Expr::Tuple(t) => extract_string_elts(&t.elts),
        _ => None,
    }
}

fn extract_string_elts(elts: &[Expr]) -> Option<Vec<String>> {
    let mut out = Vec::with_capacity(elts.len());
    for elt in elts {
        if let Some(s) = as_string_literal(elt) {
            out.push(s);
        } else {
            return None;
        }
    }
    Some(out)
}

fn as_string_literal(expr: &Expr) -> Option<String> {
    if let Expr::Constant(c) = expr {
        if let ast::Constant::Str(s) = &c.value {
            return Some(s.clone());
        }
    }
    None
}

fn is_type_checking_guard(expr: &Expr) -> bool {
    // `if TYPE_CHECKING:` or `if typing.TYPE_CHECKING:`.
    dotted_name(expr).ends_with("TYPE_CHECKING")
}

fn extract_is_abstract(body: &[Stmt]) -> bool {
    for stmt in body {
        let Stmt::ClassDef(c) = stmt else { continue };
        if c.name.as_str() != "Meta" {
            continue;
        }
        for inner in &c.body {
            let Stmt::Assign(a) = inner else { continue };
            let Some(Expr::Name(target)) = a.targets.first() else {
                continue;
            };
            if target.id.as_str() != "abstract" {
                continue;
            }
            if let Expr::Constant(c) = a.value.as_ref() {
                if let ast::Constant::Bool(b) = &c.value {
                    return *b;
                }
            }
        }
    }
    false
}

fn extract_meta_app_label(body: &[Stmt]) -> Option<String> {
    for stmt in body {
        let Stmt::ClassDef(c) = stmt else { continue };
        if c.name.as_str() != "Meta" {
            continue;
        }
        for inner in &c.body {
            let Stmt::Assign(a) = inner else { continue };
            let Some(Expr::Name(target)) = a.targets.first() else {
                continue;
            };
            if target.id.as_str() != "app_label" {
                continue;
            }
            if let Some(s) = as_string_literal(&a.value) {
                return Some(s);
            }
        }
    }
    None
}

fn infer_app_label(module_name: &str) -> String {
    // Django convention: the first path segment of the module is the app.
    module_name
        .split('.')
        .next()
        .unwrap_or(module_name)
        .to_string()
}

fn extract_related_model_reference(call: &ast::ExprCall) -> (Option<String>, Option<String>) {
    // Priority: positional args[0], then keyword `to=`.
    if let Some(first) = call.args.first() {
        if let Some(s) = as_string_literal(first) {
            return (Some("string".into()), Some(s));
        }
        let name = dotted_name(first);
        if !name.is_empty() {
            return (Some("name".into()), Some(name));
        }
    }
    if let Some(to) = extract_keyword_expr(call, "to") {
        if let Some(s) = as_string_literal(to) {
            return (Some("string".into()), Some(s));
        }
        let name = dotted_name(to);
        if !name.is_empty() {
            return (Some("name".into()), Some(name));
        }
    }
    (None, None)
}

fn extract_keyword_string(call: &ast::ExprCall, name: &str) -> Option<String> {
    extract_keyword_expr(call, name).and_then(as_string_literal)
}

fn extract_keyword_expr<'a>(call: &'a ast::ExprCall, name: &str) -> Option<&'a Expr> {
    for kw in &call.keywords {
        if let Some(arg) = &kw.arg {
            if arg.as_str() == name {
                return Some(&kw.value);
            }
        }
    }
    None
}
