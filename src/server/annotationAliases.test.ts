import { strict as assert } from 'assert';
import { defaultAggregateAlias, matchAnnotationAlias } from './annotationAliases';
import { djangoBuiltinAvailable } from './djangoVersion';
import { isPythonIdentifier, lookupKeywordStart, openStringContentStart } from './lookupSyntax';

assert.equal(defaultAggregateAlias('Count', 'id'), 'id__count');
assert.equal(defaultAggregateAlias('Sum', 'author__age'), 'author__age__sum');
assert.equal(defaultAggregateAlias('Avg', 'score'), 'score__avg');
assert.equal(defaultAggregateAlias('Count', '*'), undefined);
assert.equal(defaultAggregateAlias('Value', 'id'), undefined);
const fields = [{ name: 'id', fieldKind: 'CharField' }, { name: 'id__count', fieldKind: 'IntegerField' }];
assert.deepEqual(matchAnnotationAlias(fields, 'id__count__gte'), { field: fields[1], suffix: '__gte' });
assert.deepEqual(matchAnnotationAlias(fields, 'id__count'), { field: fields[1], suffix: '' });
assert.deepEqual(matchAnnotationAlias(fields, 'id__icontains'), { field: fields[0], suffix: '__icontains' });
assert.equal(matchAnnotationAlias(fields, 'identity'), undefined);
for (const version of ['5.2.18', '6.0.9', undefined]) {
  assert(!djangoBuiltinAvailable('totally_ordered', version));
  assert(!djangoBuiltinAvailable('fetch_mode', version));
  assert(djangoBuiltinAvailable('filter', version));
}
for (const version of ['6.1.2', '6.1rc1', '6.2.0', '2028', '2028.0', '2028.3']) {
  assert(djangoBuiltinAvailable('totally_ordered', version));
  assert(djangoBuiltinAvailable('fetch_mode', version));
}
console.log('annotationAliases.test: aliases, longest-prefix matching, and version gates passed');
for (const name of ['이름__icontains', 'payload__0__gte', 'payload__고객__0__', 'résumé__exact', '𐐀name__gte']) {
  assert(isPythonIdentifier(name), name);
  assert.equal(lookupKeywordStart(`filter(${name}`), 7);
}
assert(!isPythonIdentifier('customer name'));
assert(!isPythonIdentifier('0__gte'));
assert.equal(openStringContentStart("annotate(total=Count('id')).filter(total__g"), undefined);
assert.equal(openStringContentStart("values('payload__고객__0__"), 8);
assert.equal(openStringContentStart("# values('payload__"), undefined);
