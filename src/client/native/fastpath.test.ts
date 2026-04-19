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

    console.log(
      `fastpath napi OK: init=${init.elapsedMs}ms, ` +
        `relation_target=${relMs.toFixed(3)}ms, lookup_path=${lookMs.toFixed(3)}ms`,
    );
  } finally {
    n.nativeDrop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
