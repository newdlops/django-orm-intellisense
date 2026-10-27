import { getLookupsForField, getTransformsForField, pythonTypeForKind } from './fieldLookups';
import type { FieldInfo, WorkspaceIndex } from './types';
import { parseLookupChain } from './lookupResolver';

export interface AnnotationOutputSpec {
  fieldKind: string;
  sourcePath?: string;
  baseField?: AnnotationOutputSpec;
  average?: boolean;
}

/** Reuse the lookup FSM for annotate()/alias() output fields. */
export function virtualLookupIndex(
  source: WorkspaceIndex, label: string, name: string, kind: string, output?: AnnotationOutputSpec,
): WorkspaceIndex {
  let lookupTypes = source.lookupTypes;
  let generated = 0;
  function typedField(fieldKind: string): FieldInfo {
    const typeId = source.lookupCatalog?.kinds?.[fieldKind];
    const runtimeField = typeId == null ? undefined : source.lookupTypes?.get(typeId);
    const field: FieldInfo = runtimeField ? { ...runtimeField, name, isRelation: false } : {
      name, fieldKind, isRelation: false,
      lookups: getLookupsForField(fieldKind), transforms: getTransformsForField(fieldKind),
    };
    if (fieldKind === 'annotation' || (!runtimeField && pythonTypeForKind(fieldKind) === 'Any')) {
      field.lookupType = { fieldKind, lookups: field.lookups, transforms: {},
        runtimeTransforms: true, runtimeLookups: true };
    }
    return field;
  }
  function describe(spec: AnnotationOutputSpec): FieldInfo {
    let field = typedField(spec.fieldKind);
    if (spec.sourcePath) {
      const parsed = parseLookupChain(spec.sourcePath, label, source, 'f_expression');
      if (parsed.state !== 'error' && !parsed.runtimeRequired && parsed.finalField) {
        field = { ...(parsed.finalField.expressionField ?? parsed.finalField), name, isRelation: false };
        if (spec.average) {
          const baseKind = field.lookupType?.baseKind ?? field.fieldKind;
          if (pythonTypeForKind(baseKind) === 'int') field = typedField('FloatField');
          else if (baseKind === 'DecimalField') field = typedField('DecimalField');
        }
      }
    }
    if (spec.baseField) {
      const base = describe(spec.baseField);
      if (lookupTypes === source.lookupTypes) lookupTypes = new Map(source.lookupTypes);
      const baseId = `__annotation_${generated++}`;
      const arrayId = `__annotation_${generated++}`;
      lookupTypes!.set(baseId, base);
      const transforms = { ...field.lookupType?.transforms };
      if (!field.transforms.includes('len')) {
        const lenId = `__annotation_${generated++}`;
        lookupTypes!.set(lenId, typedField('IntegerField'));
        transforms.len = lenId;
        field.lookups = [...new Set([...field.lookups, 'contained_by', 'overlap'])];
        field.transforms = ['len'];
      }
      field.lookupType = {
        fieldKind: 'ArrayField', lookups: field.lookups,
        transforms,
        runtimeTransforms: source.lookupCatalog?.kinds?.ArrayField ? field.lookupType?.runtimeTransforms : undefined,
        runtimeLookups: source.lookupCatalog?.kinds?.ArrayField ? field.lookupType?.runtimeLookups : undefined,
        dynamicTransform: { kind: 'index', outputType: baseId, sliceType: arrayId },
      };
      lookupTypes!.set(arrayId, field);
    }
    return field;
  }
  const field = output ? describe(output) : typedField(kind);
  return {
    ...source,
    lookupTypes,
    fieldTrieByModel: new Map(),
    models: new Map([[label, {
      label, objectName: label.split('.').at(-1) ?? label, module: '', filePath: '',
      fields: new Map([[name, field]]), relations: new Map(), reverseRelations: new Map(),
      isAbstract: false, baseLabels: [],
    }]]),
  };
}
