use django_orm_core::static_index::{build_static_index_resolved, parse_module, ModuleIndex};
use std::fs;

fn module(source: &str) -> ModuleIndex {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("models.py");
    fs::write(&file, source).unwrap();
    parse_module(dir.path(), &file).expect("valid Python source")
}

#[test]
fn declarations_use_one_based_columns() {
    let index = module("from django.db import models\nclass Post(models.Model):\n    title = models.CharField(max_length=20)\n    def display(self):\n        return self.title\n");
    assert_eq!((index.model_candidates[0].line, index.model_candidates[0].column), (2, 1));
    assert_eq!((index.pending_fields[0].line, index.pending_fields[0].column), (3, 5));
    assert_eq!((index.methods[0].line, index.methods[0].column), (4, 5));
    let (_, definition) = index.symbol_definitions.iter().find(|(name, _)| name == "Post").unwrap();
    assert_eq!((definition.line, definition.column), (2, 1));
}

#[test]
fn same_line_unicode_prefix_uses_utf16_editor_units() {
    let prefix = "    marker = '한😀'; ";
    let index = module(&format!("from django.db import models\nclass Post(models.Model):\n{prefix}title = models.CharField(max_length=20)\n"));
    let field = index.pending_fields.iter().find(|field| field.name == "title").unwrap();
    assert_eq!(field.column, prefix.encode_utf16().count() as u32 + 1);
    assert_ne!(field.column, prefix.len() as u32 + 1, "UTF-8 bytes are not editor columns");
    assert_ne!(field.column, prefix.chars().count() as u32 + 1, "non-BMP characters use two UTF-16 units");
    let json = serde_json::to_value(&index).unwrap();
    assert_eq!(json["pendingFields"][0]["column"], prefix.encode_utf16().count() as u32 + 1);
}

#[test]
fn tabs_and_python_line_endings_keep_character_positions() {
    for newline in ["\n", "\r\n", "\r"] {
        let index = module(&["from django.db import models", "class Post(models.Model):", "\ttitle = models.CharField(max_length=20)", ""].join(newline));
        assert_eq!((index.pending_fields[0].line, index.pending_fields[0].column), (3, 2), "newline {newline:?}");
    }
}

#[test]
fn resolved_fields_and_json_keep_corrected_locations_without_changing_shape() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("models.py");
    fs::write(&file, "from django.db import models\nclass Post(models.Model):\n    title = models.CharField(max_length=20)\n").unwrap();
    let index = build_static_index_resolved(dir.path(), &[file]);
    let field = index.fields.iter().find(|field| field.name == "title").unwrap();
    assert_eq!((field.line, field.column), (3, 5));
    let json = serde_json::to_value(&index.modules[0]).unwrap();
    assert_eq!(json["pendingFields"][0]["column"], 5);
    let restored: ModuleIndex = serde_json::from_value(json).unwrap();
    assert_eq!(restored.pending_fields[0].column, 5);
    // Opaque legacy JSON hydration must not shift unknown or caller-owned data.
    let mut legacy = serde_json::to_value(&restored).unwrap();
    legacy["pendingFields"][0]["line"] = 0.into();
    legacy["pendingFields"][0]["column"] = 0.into();
    let restored: ModuleIndex = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(restored).unwrap(), legacy);
}
