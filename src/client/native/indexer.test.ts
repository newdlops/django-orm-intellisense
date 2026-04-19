// TS → Rust napi static_index E2E.
// Invoke: node out/client/native/indexer.test.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNative } from './loader';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

interface ModelCandidate {
  appLabel: string;
  objectName: string;
  label: string;
  module: string;
  isAbstract: boolean;
}

interface PendingField {
  name: string;
  fieldKind: string;
  isRelation: boolean;
  relatedModelRefValue: string | null;
  relatedName: string | null;
}

interface ModuleIndex {
  moduleName: string;
  pendingFields: PendingField[];
  modelCandidates: ModelCandidate[];
}

interface StaticIndex {
  modelCandidates: ModelCandidate[];
  modules: ModuleIndex[];
}

function main(): void {
  const n = loadNative();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-indexer-'));
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
        'class Product(models.Model):',
        '    name = models.CharField(max_length=100)',
        "    seller = models.ForeignKey('shop.User', on_delete=models.CASCADE, related_name='products')",
      ].join('\n'),
    );

    const buf = n.buildStaticIndexJson(tmpDir, [path.join(tmpDir, 'shop/models.py')]);
    const idx = JSON.parse(buf.toString('utf-8')) as StaticIndex;

    assert(idx.modelCandidates.length === 2, `expected 2 models, got ${idx.modelCandidates.length}`);
    const labels = idx.modelCandidates.map((m) => m.label).sort();
    assert(labels[0] === 'shop.Product' && labels[1] === 'shop.User', `unexpected labels: ${labels.join(',')}`);

    const shopModule = idx.modules.find((m) => m.moduleName === 'shop.models');
    assert(shopModule !== undefined, 'shop.models module present');
    const seller = shopModule!.pendingFields.find((f) => f.name === 'seller');
    assert(seller !== undefined, 'seller field present');
    assert(seller!.fieldKind === 'ForeignKey', 'ForeignKey kind');
    assert(seller!.isRelation, 'ForeignKey is relation');
    assert(seller!.relatedModelRefValue === 'shop.User', 'seller target = shop.User');
    assert(seller!.relatedName === 'products', 'seller related_name = products');

    const singleBuf = n.parseModuleJson(tmpDir, path.join(tmpDir, 'shop/models.py'));
    assert(singleBuf !== null, 'parseModuleJson returns data');
    const singleModule = JSON.parse(singleBuf!.toString('utf-8')) as ModuleIndex;
    assert(singleModule.moduleName === 'shop.models', 'single module name');
    assert(singleModule.modelCandidates.length === 2, 'single module has 2 models');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('static_index napi bindings OK');
}

main();
