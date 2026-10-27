import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadNative } from '../native/loader';
import { withKnownNativeMemberReturn } from './ormMemberConfidence';
import type { OrmMemberResolution } from '../protocol';

const native = loadNative();
async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-member-confidence-'));
  try {
    fs.mkdirSync(path.join(root, 'shop'));
    fs.writeFileSync(path.join(root, 'shop', '__init__.py'), '');
    fs.writeFileSync(path.join(root, 'shop', 'models.py'), [
      'from django.db import models',
      'class Detail(models.Model):',
      '    code = models.CharField(max_length=30)',
      'class Order(models.Model):',
      '    name = models.CharField(max_length=30)',
      '    @property',
      '    def primary_detail(self) -> Detail | None:',
      '        return None',
    ].join('\n'));
    native.nativeInit(root);
    assert.ok(await native.nativeEnsureAstModules(root));
    const resolve = (name: string): OrmMemberResolution => {
      const buffer = native.nativeResolveOrmMember('shop.Order', 'instance', name, null);
      assert.ok(buffer);
      return { resolved: true, item: JSON.parse(buffer.toString()) };
    };
    const property = resolve('primary_detail');
    assert.equal(property.item?.memberKind, 'property', JSON.stringify(property));
    assert.equal(property.item?.returnKind, 'unknown');
    assert.ok(property.item?.filePath);
    assert.equal(withKnownNativeMemberReturn(property), undefined,
      'A source location alone must not make an unknown property return authoritative');
  assert.equal(withKnownNativeMemberReturn(property, ['unknown', 'shop.Order', 'property', null]), undefined);
  assert.equal(withKnownNativeMemberReturn(property, ['instance', null, 'property', null]), undefined,
    'A receiver kind still requires a known target model');
    const enriched = withKnownNativeMemberReturn(property, ['instance', 'shop.Detail', 'property', null]);
    assert.equal(enriched?.item?.returnKind, 'instance');
    assert.equal(enriched?.item?.returnModelLabel, 'shop.Detail');
    assert.equal(enriched?.item?.filePath, property.item?.filePath);
    assert.equal(property.item?.returnKind, 'unknown', 'Keep the older native result immutable');
    const field = resolve('name');
    assert.equal(withKnownNativeMemberReturn(field), field, 'Declared fields retain the native path');
    const builtin = resolve('save');
    assert.equal(withKnownNativeMemberReturn(builtin), builtin, 'Built-ins retain the native path');
    console.log('ormMemberConfidence.test: actual native property return, surface enrichment, fallback and field/builtin checks passed');
  } finally {
    native.nativeDrop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
