'use strict';
const assert = require('node:assert/strict');
const { shareSurfaceTuplesInplace } = require('./probe-surface-pool-inplace.cjs');

for (const mode of ['json', 'nested', 'bucket', 'direct', 'methods']) {
  const wire = '{"__proto__":{"__proto__":{"__proto__":["scalar",null],"same":["scalar",null],"longer":["scalar",null,"field"],"empty":["",null],"nullString":["scalar","null"],"invalid":["scalar",3]}},"app.Model":{"manager":{"a":["queryset","app.Model","method"],"escape":["a\\\"b","c\\\\d"]},"queryset":{"a":["queryset","app.Model","method"],"other":["a","b\\\"c\\\\d"]}},"app.Other":{"manager":{"a":["queryset","app.Model","method"]}}}';
  const surface = JSON.parse(wire);
  const previous = JSON.parse(wire);
  const expected = JSON.stringify(surface);
  const oldTuple = surface['app.Model'].manager.a;
  assert.equal(shareSurfaceTuplesInplace(surface, mode), surface);
  assert.equal(JSON.stringify(surface), expected);
  assert.equal(Object.getPrototypeOf(surface), Object.prototype);
  assert.ok(Object.hasOwn(surface, '__proto__'));
  if (mode !== 'methods') assert.equal(surface.__proto__.__proto__.__proto__, surface.__proto__.__proto__.same);
  assert.notEqual(surface.__proto__.__proto__.__proto__, surface.__proto__.__proto__.longer);
  assert.notEqual(surface.__proto__.__proto__.__proto__, surface.__proto__.__proto__.nullString);
  assert.equal(surface['app.Model'].manager.a, surface['app.Model'].queryset.a);
  assert.equal(surface['app.Model'].manager.a, oldTuple);
  assert.ok(Object.isFrozen(oldTuple));
  assert.notEqual(surface['app.Model'].manager.a, surface['app.Other'].manager.a);
  assert.notEqual(surface['app.Model'].manager.a, previous['app.Model'].manager.a);
  assert.ok(!Object.isFrozen(surface.__proto__.__proto__.invalid));
  assert.throws(() => oldTuple.push('modified'), TypeError);
  surface['app.Model'].queryset.a = ['scalar', 'changed'];
  assert.equal(surface['app.Model'].manager.a, oldTuple);
  assert.equal(JSON.stringify(previous), expected);
  shareSurfaceTuplesInplace(surface, mode);
  assert.equal(surface['app.Model'].manager.a, oldTuple);
  console.log(`PASS: ${mode} complete values, own keys, exact length/value matching, model/message owner and immutable tuples`);
}
