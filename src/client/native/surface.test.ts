// E2E: workspace root → Rust pipeline (discovery + AST + resolve +
// surface) → TS-consumable SurfaceIndex. One napi call, no Python.
// Invoke: node out/client/native/surface.test.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNative } from './loader';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

interface WireSurface {
  [modelLabel: string]: {
    [receiverKind: string]: {
      [memberName: string]: [string, string | null];
    };
  };
}

function main(): void {
  const n = loadNative();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-surface-e2e-'));
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
        '',
        'class Order(models.Model):',
        "    buyer = models.ForeignKey('shop.User', on_delete=models.CASCADE, related_name='orders')",
        '    qty = models.IntegerField()',
      ].join('\n'),
    );

    const t0 = performance.now();
    const buf = n.buildSurfaceIndexJson(tmpDir);
    const elapsed = performance.now() - t0;
    const surface: WireSurface = JSON.parse(buf.toString('utf-8'));

    assert(
      Object.keys(surface).length === 2,
      `expected 2 models, got ${Object.keys(surface).length}`,
    );

    const order = surface['shop.Order'];
    assert(order.instance !== undefined, 'Order.instance present');
    assert(order.instance.buyer !== undefined, 'buyer field in instance');
    assert(order.instance.buyer[0] === 'instance', 'buyer returns instance');
    assert(order.instance.buyer[1] === 'shop.User', 'buyer targets shop.User');
    assert(order.instance.save !== undefined, 'save builtin present');

    const user = surface['shop.User'];
    assert(
      user.instance.orders !== undefined,
      'reverse relation orders present on User',
    );
    assert(user.instance.orders[0] === 'related_manager', 'reverse is related_manager');
    assert(user.instance.orders[1] === 'shop.Order', 'reverse points to Order');

    const order_manager = surface['shop.Order'].manager;
    assert(order_manager !== undefined, 'manager kind');
    assert(order_manager.filter !== undefined, 'filter in manager');

    console.log(
      `surface index napi OK: ${Object.keys(surface).length} models, ${elapsed.toFixed(1)}ms ` +
        `(includes walkdir + AST + resolve + serialize)`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
