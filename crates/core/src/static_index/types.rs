//! Rust counterparts to the Python dataclasses in
//! `static_index/indexer.py`. Field names use snake_case on the Rust
//! side and camelCase on the wire (serde rename) so JSON from either
//! side round-trips.

use serde::{Deserialize, Serialize};

/// Subset of Django field classes we recognize by name alone. Matches
/// `DJANGO_FIELD_CLASS_NAMES` in Python. Keep this in sync — adding a
/// field type here enables its detection project-wide.
pub const DJANGO_FIELD_CLASS_NAMES: &[&str] = &[
    "AutoField",
    "BigAutoField",
    "BigIntegerField",
    "BinaryField",
    "BooleanField",
    "CharField",
    "CommaSeparatedIntegerField",
    "CompositePrimaryKey",
    "DateField",
    "DateTimeField",
    "DecimalField",
    "DurationField",
    "EmailField",
    "Field",
    "FileField",
    "FilePathField",
    "FloatField",
    "ForeignKey",
    "GeneratedField",
    "GenericIPAddressField",
    "IPAddressField",
    "ImageField",
    "IntegerField",
    "JSONField",
    "ManyToManyField",
    "NullBooleanField",
    "OneToOneField",
    "PositiveBigIntegerField",
    "PositiveIntegerField",
    "PositiveSmallIntegerField",
    "SlugField",
    "SmallAutoField",
    "SmallIntegerField",
    "TextField",
    "TimeField",
    "URLField",
    "UUIDField",
];

pub const RELATION_FIELD_KINDS: &[&str] = &[
    "ForeignKey",
    "OneToOneField",
    "ManyToManyField",
    "ParentalKey",
    "ParentalManyToManyField",
];

pub const KNOWN_EXTERNAL_FIELD_CLASS_NAMES: &[&str] = &["ParentalKey", "ParentalManyToManyField"];

pub fn is_django_field_class(name: &str) -> bool {
    DJANGO_FIELD_CLASS_NAMES.contains(&name) || KNOWN_EXTERNAL_FIELD_CLASS_NAMES.contains(&name)
}

/// Django field-class name -> concrete Python type (display string).
///
/// SINGLE SOURCE OF TRUTH (mirrored verbatim in two other files — keep in
/// sync; a parity test enforces this):
///   - python/django_orm_intellisense/features/field_types.py (FIELD_KIND_PYTHON_TYPE)
///   - src/server/fieldLookups.ts                             (FIELD_KIND_PYTHON_TYPE)
///
/// Relation kinds map to "Any"; a relation terminal's type is surfaced via
/// the related model, not this table.
pub const FIELD_KIND_PYTHON_TYPE: &[(&str, &str)] = &[
    // String-like
    ("CharField", "str"),
    ("TextField", "str"),
    ("SlugField", "str"),
    ("URLField", "str"),
    ("EmailField", "str"),
    ("FilePathField", "str"),
    ("GenericIPAddressField", "str"),
    ("IPAddressField", "str"),
    ("CommaSeparatedIntegerField", "str"),
    ("FileField", "str"),
    ("ImageField", "str"),
    // Integer-like
    ("IntegerField", "int"),
    ("BigIntegerField", "int"),
    ("SmallIntegerField", "int"),
    ("PositiveIntegerField", "int"),
    ("PositiveSmallIntegerField", "int"),
    ("PositiveBigIntegerField", "int"),
    ("AutoField", "int"),
    ("BigAutoField", "int"),
    ("SmallAutoField", "int"),
    // Real numbers
    ("FloatField", "float"),
    ("DecimalField", "decimal.Decimal"),
    // Boolean
    ("BooleanField", "bool"),
    ("NullBooleanField", "bool"),
    // Date/time
    ("DateField", "datetime.date"),
    ("DateTimeField", "datetime.datetime"),
    ("TimeField", "datetime.time"),
    ("DurationField", "datetime.timedelta"),
    // Misc scalars
    ("UUIDField", "uuid.UUID"),
    ("JSONField", "Any"),
    ("BinaryField", "bytes"),
    // Computed — value type is the output_field, not statically knowable.
    ("GeneratedField", "Any"),
    // Relations
    ("ForeignKey", "Any"),
    ("OneToOneField", "Any"),
    ("ManyToManyField", "Any"),
];

/// Map a Django field-class name to its concrete Python display type.
/// Falls back to "Any" for custom or unrecognized field kinds.
pub fn python_type_for_kind(field_kind: &str) -> &'static str {
    FIELD_KIND_PYTHON_TYPE
        .iter()
        .find(|(kind, _)| *kind == field_kind)
        .map(|(_, py)| *py)
        .unwrap_or("Any")
}

pub fn is_relation_field_kind(kind: &str) -> bool {
    RELATION_FIELD_KINDS.contains(&kind)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionLocation {
    pub file_path: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCandidate {
    pub app_label: String,
    pub object_name: String,
    /// `<app_label>.<object_name>`; pre-joined for cheap equality.
    pub label: String,
    pub module: String,
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    #[serde(default)]
    pub is_abstract: bool,
    #[serde(default)]
    pub base_class_refs: Vec<String>,
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "static".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFieldCandidate {
    pub model_label: String,
    pub model_module: String,
    pub app_label: String,
    pub name: String,
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub field_call_ref: String,
    pub field_kind: String,
    pub is_relation: bool,
    pub related_model_ref_kind: Option<String>,
    pub related_model_ref_value: Option<String>,
    pub related_name: Option<String>,
    pub related_query_name: Option<String>,
}

/// Project-defined method on a model class (regular `def`, async `def`,
/// classmethod, staticmethod, or property). Extracted statically from
/// the class body — used to surface hover/completion details without a
/// Python round-trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMethod {
    pub model_label: String,
    pub name: String,
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    /// "method" | "classmethod" | "staticmethod" | "property" |
    /// "cached_property" | "async_method"
    pub kind: String,
    #[serde(default)]
    pub return_annotation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldCandidate {
    pub model_label: String,
    pub name: String,
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub field_kind: String,
    pub is_relation: bool,
    pub relation_direction: Option<String>,
    pub related_model_label: Option<String>,
    #[serde(default)]
    pub declared_model_label: Option<String>,
    #[serde(default)]
    pub related_name: Option<String>,
    #[serde(default)]
    pub related_query_name: Option<String>,
    #[serde(default = "default_source")]
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBinding {
    pub module: String,
    pub symbol: Option<String>,
    pub alias: String,
    pub is_star: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleIndex {
    pub module_name: String,
    pub file_path: String,
    pub is_package_init: bool,
    pub defined_symbols: Vec<String>,
    pub symbol_definitions: Vec<(String, DefinitionLocation)>,
    pub import_bindings: Vec<ImportBinding>,
    #[serde(default)]
    pub explicit_all: Option<Vec<String>>,
    pub model_candidates: Vec<ModelCandidate>,
    pub pending_fields: Vec<PendingFieldCandidate>,
    #[serde(default)]
    pub class_base_refs: Vec<(String, Vec<String>)>,
    #[serde(default)]
    pub field_class_names: Vec<String>,
    #[serde(default)]
    pub field_aliases: Vec<(String, String)>,
    #[serde(default)]
    pub methods: Vec<ProjectMethod>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticIndex {
    pub model_candidates: Vec<ModelCandidate>,
    pub fields: Vec<FieldCandidate>,
    pub modules: Vec<ModuleIndex>,
    #[serde(default)]
    pub methods: Vec<ProjectMethod>,
}
