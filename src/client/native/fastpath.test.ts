// E2E fast-path smoke test: native_init → native_resolve_* round-trips.
// Invoke: node out/client/native/fastpath.test.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNative } from './loader';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function main(): void {
  const n = loadNative();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-fastpath-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'shop'));
    fs.writeFileSync(path.join(tmpDir, 'shop/__init__.py'), '');
    fs.writeFileSync(
      path.join(tmpDir, 'shop/models.py'),
      [
        'from django.db import models',
        '',
        'class User(models.Model):',
        '    email = models.CharField(max_length=200)',
        '    age = models.IntegerField()',
        '',
        'class Order(models.Model):',
        "    buyer = models.ForeignKey('shop.User', on_delete=models.CASCADE, related_name='orders')",
        '    qty = models.IntegerField()',
      ].join('\n'),
    );

    const init = n.nativeInit(tmpDir);
    assert(init.modelCount === 2, `init modelCount = ${init.modelCount}`);
    assert(init.rebuilt === true, 'first init rebuilt');

    const info = n.nativeStateInfo();
    assert(info.initialized === true, 'state initialized');
    assert(info.modelCount === 2, 'state.modelCount = 2');

    // Second init on same root is a no-op hit.
    const init2 = n.nativeInit(tmpDir);
    assert(init2.rebuilt === false, 'second init not rebuilt');
    assert(init2.elapsedMs === 0, 'no-op init zero ms');

    // resolveRelationTarget — exact label
    const tRel0 = performance.now();
    const relBuf = n.nativeResolveRelationTarget('shop.User');
    const relMs = performance.now() - tRel0;
    assert(relBuf !== null, 'relation target non-null');
    const rel = JSON.parse(relBuf!.toString('utf-8'));
    assert(rel.resolved === true, `resolved: ${JSON.stringify(rel)}`);
    assert(rel.matchKind === 'exact_label', `matchKind=${rel.matchKind}`);
    assert(rel.target.label === 'shop.User', 'target label');

    // ambiguous: "User" matches nothing here since there's only one
    const ambigBuf = n.nativeResolveRelationTarget('Missing');
    const ambig = JSON.parse(ambigBuf!.toString('utf-8'));
    assert(ambig.resolved === false, 'Missing unresolved');

    // resolveLookupPath — simple field
    const tLook0 = performance.now();
    const lookBuf = n.nativeResolveLookupPath('shop.Order', 'qty', 'filter');
    const lookMs = performance.now() - tLook0;
    assert(lookBuf !== null, 'lookup buf');
    const look = JSON.parse(lookBuf!.toString('utf-8'));
    assert(look.resolved === true, 'lookup resolved');
    assert(look.target.name === 'qty', 'terminal = qty');

    // chained: buyer__email
    const chainBuf = n.nativeResolveLookupPath('shop.Order', 'buyer__email', 'filter');
    const chain = JSON.parse(chainBuf!.toString('utf-8'));
    assert(chain.resolved === true, 'chain resolved');
    assert(chain.target.name === 'email', 'chain terminal email');

    // with operator
    const opBuf = n.nativeResolveLookupPath('shop.Order', 'qty__gte', 'filter');
    const op = JSON.parse(opBuf!.toString('utf-8'));
    assert(op.resolved === true, 'operator resolved');
    assert(op.lookupOperator === 'gte', 'operator gte');

    // resolveOrmMember — declared field
    const memBuf = n.nativeResolveOrmMember('shop.Order', 'instance', 'buyer', null);
    assert(memBuf !== null, 'member non-null');
    const mem = JSON.parse(memBuf!.toString('utf-8'));
    assert(mem.name === 'buyer', 'member name');
    assert(mem.returnModelLabel === 'shop.User', 'member target');

    // resolveOrmMember — builtin method on instance
    const saveBuf = n.nativeResolveOrmMember('shop.Order', 'instance', 'save', null);
    assert(saveBuf !== null, 'save non-null');
    const save = JSON.parse(saveBuf!.toString('utf-8'));
    assert(save.signature !== undefined, 'save has signature');

    // unknown member → null JSON
    const unkBuf = n.nativeResolveOrmMember('shop.Order', 'instance', 'nonexistent_zz', null);
    assert(unkBuf !== null, 'unknown returns buffer');
    const unk = JSON.parse(unkBuf!.toString('utf-8'));
    assert(unk === null, 'unknown returns null JSON');

    // Rehydrate from Python-style surfaceIndex. This is the production
    // path during the Rust migration: methods in the instance receiver
    // must not be treated as fields.
    const surface = {
      'shop.User': {
        instance: {
          email: ['scalar', 'shop.User', 'field', 'CharField'],
          orders: ['related_manager', 'shop.Order', 'reverse_relation', 'ReverseRelation'],
        },
      },
      'shop.Order': {
        instance: {
          buyer: ['instance', 'shop.User', 'relation', 'ForeignKey'],
          total: ['scalar', 'shop.Order', 'field', 'DecimalField'],
          save: ['none', 'shop.Order', 'method', null],
          computed: ['scalar', 'shop.Order', 'method', null],
        },
      },
    };
    const surfaceInit = n.nativeInitFromSurface(
      tmpDir,
      Buffer.from(JSON.stringify(surface), 'utf-8'),
    );
    assert(surfaceInit.source === 'surface', `surface source=${surfaceInit.source}`);
    assert(surfaceInit.modelCount === 2, `surface modelCount=${surfaceInit.modelCount}`);
    assert(surfaceInit.edgeCount === 2, `surface edgeCount=${surfaceInit.edgeCount}`);

    const totalBuf = n.nativeResolveOrmMember('shop.Order', 'instance', 'total', null);
    assert(totalBuf !== null, 'surface total non-null');
    const total = JSON.parse(totalBuf!.toString('utf-8'));
    assert(total.memberKind === 'field', 'surface scalar field stays field');
    assert(total.fieldKind === 'DecimalField', 'surface field kind preserved');

    const computedBuf = n.nativeResolveOrmMember('shop.Order', 'instance', 'computed', null);
    assert(computedBuf !== null, 'surface method returns buffer');
    assert(JSON.parse(computedBuf!.toString('utf-8')) === null, 'surface method falls back to Python');

    const ordersBuf = n.nativeResolveOrmMember('shop.User', 'instance', 'orders', null);
    assert(ordersBuf !== null, 'surface reverse relation non-null');
    const orders = JSON.parse(ordersBuf!.toString('utf-8'));
    assert(orders.returnKind === 'related_manager', 'surface reverse relation returns related_manager');
    assert(orders.returnModelLabel === 'shop.Order', 'surface reverse relation target preserved');

    const buyerLookupBuf = n.nativeResolveLookupPath('shop.Order', 'buyer__email', 'filter');
    assert(buyerLookupBuf !== null, 'surface relation lookup non-null');
    const buyerLookup = JSON.parse(buyerLookupBuf!.toString('utf-8'));
    assert(buyerLookup.resolved === true, `surface relation lookup resolved=${JSON.stringify(buyerLookup)}`);
    assert(buyerLookup.resolvedSegments?.[1]?.modelLabel === 'shop.User', 'surface relation lookup reaches related model');
    assert(buyerLookup.target?.name === 'email', 'surface relation lookup terminal field preserved');

    // relationTargets list
    const listBuf = n.nativeListRelationTargets(null);
    const list = JSON.parse(listBuf!.toString('utf-8'));
    assert(Array.isArray(list) && list.length === 2, 'list has 2 entries');

    // Bulk lookup path completions: re-init AST state to get descendants.
    n.nativeInit(tmpDir, true);

    const tLookCompl = performance.now();
    const lookComplBuf = n.nativeListLookupPathCompletions('shop.Order', '', 'filter');
    const lookComplMs = performance.now() - tLookCompl;
    assert(lookComplBuf !== null, 'lookup completions non-null');
    const lookCompl = JSON.parse(lookComplBuf!.toString('utf-8'));
    assert(lookCompl.resolved === true, 'lookup completions resolved');
    const lookNames: string[] = lookCompl.items.map((i: { name: string }) => i.name);
    assert(lookNames.includes('buyer'), 'bulk completion includes buyer');
    assert(lookNames.includes('qty'), 'bulk completion includes qty');
    assert(lookNames.some((n) => n.startsWith('buyer__')), 'bulk completion includes descendants');

    // Prefix narrows the result.
    const lookPrefixBuf = n.nativeListLookupPathCompletions('shop.Order', 'buyer__', 'filter');
    const lookPrefix = JSON.parse(lookPrefixBuf!.toString('utf-8'));
    assert(lookPrefix.resolved === true, 'prefix completions resolved');
    assert(lookPrefix.currentModelLabel === 'shop.User', 'prefix walks to related model');
    const prefixNames: string[] = lookPrefix.items.map((i: { name: string }) => i.name);
    assert(prefixNames.includes('email'), 'prefix completion includes email');
    assert(prefixNames.includes('age'), 'prefix completion includes age');

    // Bulk ORM member completions: instance surface.
    const tMemCompl = performance.now();
    const memComplBuf = n.nativeListOrmMemberCompletions('shop.Order', 'instance', null, null);
    const memComplMs = performance.now() - tMemCompl;
    assert(memComplBuf !== null, 'member completions non-null');
    const memCompl = JSON.parse(memComplBuf!.toString('utf-8'));
    assert(memCompl.resolved === true, 'member completions resolved');
    const memNames: string[] = memCompl.items.map((i: { name: string }) => i.name);
    assert(memNames.includes('buyer'), 'member completion includes buyer');
    assert(memNames.includes('qty'), 'member completion includes qty');
    assert(memNames.includes('save'), 'member completion includes save builtin');

    // Prefix filter on member completions.
    const memPrefixBuf = n.nativeListOrmMemberCompletions('shop.Order', 'instance', 'bu', null);
    const memPrefix = JSON.parse(memPrefixBuf!.toString('utf-8'));
    const memPrefixNames: string[] = memPrefix.items.map((i: { name: string }) => i.name);
    assert(memPrefixNames.includes('buyer'), 'member prefix includes buyer');
    assert(!memPrefixNames.includes('save'), 'member prefix excludes save');

    // --- resolveExportOrigin / resolveModule fast-path ---------------
    // Write a tiny re-export chain into the same tmpDir.
    fs.writeFileSync(
      path.join(tmpDir, 'shop/__init__.py'),
      'from .models import User as Person\n',
    );
    // After nativeInit (AST rebuild), modules are populated.
    n.nativeInit(tmpDir, true);

    const tExport = performance.now();
    const exportBuf = n.nativeResolveExportOrigin('shop', 'Person');
    const exportMs = performance.now() - tExport;
    assert(exportBuf !== null, 'export buf non-null');
    const exportRes = JSON.parse(exportBuf!.toString('utf-8'));
    assert(exportRes.resolved === true, `export resolved: ${JSON.stringify(exportRes)}`);
    assert(
      exportRes.originModule === 'shop.models',
      `origin module = ${exportRes.originModule}`,
    );
    assert(exportRes.originSymbol === 'User', `origin symbol = ${exportRes.originSymbol}`);

    const tModule = performance.now();
    const modBuf = n.nativeResolveModule('shop.models');
    const moduleMs = performance.now() - tModule;
    assert(modBuf !== null, 'module buf non-null');
    const modRes = JSON.parse(modBuf!.toString('utf-8'));
    assert(modRes.resolved === true, `module resolved: ${JSON.stringify(modRes)}`);
    assert(modRes.filePath?.endsWith('shop/models.py'), `file: ${modRes.filePath}`);

    // Unknown module reports unresolved rather than erroring.
    const missingBuf = n.nativeResolveModule('nonexistent.module.xyz');
    const missingRes = JSON.parse(missingBuf!.toString('utf-8'));
    assert(missingRes.resolved === false, 'missing module unresolved');

    // After nativeInitFromSurface (no modules), queries return null so
    // the caller falls through to Python.
    const surfaceAfter = { 'shop.Order': { instance: { buyer: ['instance', 'shop.User', 'relation', 'ForeignKey'] } } };
    n.nativeInitFromSurface(tmpDir, Buffer.from(JSON.stringify(surfaceAfter), 'utf-8'));
    const noModBuf = n.nativeResolveExportOrigin('shop', 'Person');
    assert(JSON.parse(noModBuf!.toString('utf-8')) === null, 'no modules -> null');

    // ensureAstModules repopulates modules without wiping model/field
    // state hydrated from the surface.
    const ensured = n.nativeEnsureAstModules(tmpDir);
    assert(ensured === true, 'ensureAstModules returns true');
    const afterEnsureBuf = n.nativeResolveExportOrigin('shop', 'Person');
    const afterEnsure = JSON.parse(afterEnsureBuf!.toString('utf-8'));
    assert(afterEnsure?.resolved === true, 'export resolved after ensureAstModules');

    // --- project method coverage on resolveOrmMember -------------------
    // Replace models.py with one containing project methods and rebuild.
    fs.writeFileSync(
      path.join(tmpDir, 'shop/models.py'),
      [
        'from django.db import models',
        '',
        'class Order(models.Model):',
        '    total = models.IntegerField()',
        '',
        '    def pretty_total(self) -> str:',
        '        return f"${self.total}"',
        '',
        '    @property',
        '    def display(self) -> str:',
        '        return self.pretty_total()',
        '',
        '    @classmethod',
        '    def from_json(cls, payload):',
        '        return cls()',
        '',
        '    @staticmethod',
        '    def default_label():',
        '        return "Order"',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tmpDir, 'shop/__init__.py'), '');
    n.nativeInit(tmpDir, true);

    const prettyBuf = n.nativeResolveOrmMember('shop.Order', 'instance', 'pretty_total', null);
    const prettyRes = JSON.parse(prettyBuf!.toString('utf-8'));
    assert(prettyRes, 'pretty_total resolves');
    assert(prettyRes.memberKind === 'method', `member kind ${prettyRes.memberKind}`);
    assert(prettyRes.source === 'project', `source ${prettyRes.source}`);

    const displayBuf = n.nativeResolveOrmMember('shop.Order', 'instance', 'display', null);
    const displayRes = JSON.parse(displayBuf!.toString('utf-8'));
    assert(displayRes?.memberKind === 'property', `display kind ${displayRes?.memberKind}`);

    // @classmethod / @staticmethod surface on the model class.
    const factoryBuf = n.nativeResolveOrmMember('shop.Order', 'model_class', 'from_json', null);
    const factoryRes = JSON.parse(factoryBuf!.toString('utf-8'));
    assert(factoryRes?.memberKind === 'classmethod', `factory kind ${factoryRes?.memberKind}`);

    const labelBuf = n.nativeResolveOrmMember('shop.Order', 'model_class', 'default_label', null);
    const labelRes = JSON.parse(labelBuf!.toString('utf-8'));
    assert(labelRes?.memberKind === 'staticmethod', `label kind ${labelRes?.memberKind}`);

    // Bulk completion includes them too.
    const instBulk = n.nativeListOrmMemberCompletions('shop.Order', 'instance', null, null);
    const instNames: string[] = JSON.parse(instBulk!.toString('utf-8'))
      .items.map((i: { name: string }) => i.name);
    assert(instNames.includes('pretty_total'), 'bulk instance includes pretty_total');
    assert(instNames.includes('display'), 'bulk instance includes @property');

    const clsBulk = n.nativeListOrmMemberCompletions('shop.Order', 'model_class', null, null);
    const clsNames: string[] = JSON.parse(clsBulk!.toString('utf-8'))
      .items.map((i: { name: string }) => i.name);
    assert(clsNames.includes('from_json'), 'bulk class includes classmethod');
    assert(clsNames.includes('default_label'), 'bulk class includes staticmethod');

    console.log(
      `fastpath napi OK: init=${init.elapsedMs}ms, ` +
        `relation_target=${relMs.toFixed(3)}ms, lookup_path=${lookMs.toFixed(3)}ms, ` +
        `lookup_completions=${lookComplMs.toFixed(3)}ms, member_completions=${memComplMs.toFixed(3)}ms, ` +
        `export_origin=${exportMs.toFixed(3)}ms, module=${moduleMs.toFixed(3)}ms`,
    );
  } finally {
    n.nativeDrop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
