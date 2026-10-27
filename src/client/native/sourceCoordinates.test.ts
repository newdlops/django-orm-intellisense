// Run: node out/client/native/sourceCoordinates.test.js
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNative } from './loader';

async function main(): Promise<void> {
  const native = loadNative();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'django-orm-coordinates-'));
  const failures: string[] = [];
  let assertions = 0;
  function equal(actual: unknown, expected: unknown, label: string): void {
    assertions++;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
  }
  function decode(value: Buffer | null): any {
    if (value === null) throw new Error('native query unavailable');
    return JSON.parse(value.toString('utf8'));
  }
  try {
    fs.mkdirSync(path.join(root, 'blog'));
    fs.writeFileSync(path.join(root, 'blog/__init__.py'), 'from .models import Post as Article\n');
    const source = [
      'from django.db import models',
      'class Post(models.Model):',
      '    title = models.CharField(max_length=20)',
      "    marker = '한😀'; unicode_title = models.CharField(max_length=20)",
      '    def display(self):',
      '        return self.title',
      '',
    ].join('\r\n');
    const file = path.join(root, 'blog/models.py');
    fs.writeFileSync(file, source);
    const unicodeColumn = source.split('\r\n')[3].indexOf('unicode_title') + 1;
    const checkModule = (module: any, mode: string): void => {
      equal([module.modelCandidates[0].line, module.modelCandidates[0].column], [2, 1], `${mode}: model`);
      for (const [name, line, column] of [['title', 3, 5], ['unicode_title', 4, unicodeColumn]] as const) {
        const field = module.pendingFields.find((entry: any) => entry.name === name);
        equal([field?.line, field?.column], [line, column], `${mode}: ${name}`);
      }
      equal([module.methods[0].line, module.methods[0].column], [5, 5], `${mode}: method`);
      const definition = module.symbolDefinitions.find((entry: any) => entry[0] === 'Post')[1];
      equal([definition.line, definition.column], [2, 1], `${mode}: symbol`);
    };
    checkModule(decode(native.parseModuleJson(root, file)), 'parse');
    const index = decode(native.buildStaticIndexJson(root, [file]));
    checkModule(index.modules[0], 'build');
    const surface = Buffer.from(JSON.stringify({ 'blog.Post': { instance: {
      title: ['scalar', null, 'field', 'CharField'],
      unicode_title: ['scalar', null, 'field', 'CharField'],
    } } }));
    if (!native.nativeInitFromSurfaceAsync || !native.nativeInitFromSurfaceChunksAsync) throw new Error('async surface bindings required');
    const initializers: Array<[string, () => unknown]> = [
      ['ast', () => native.nativeInit(root, true)],
      ['surface', () => native.nativeInitFromSurface(root, surface)],
      ['async', () => native.nativeInitFromSurfaceAsync!(root, surface)],
      ['chunks', () => native.nativeInitFromSurfaceChunksAsync!(root, [surface.subarray(0, 17), surface.subarray(17)])],
    ];
    for (const [mode, initialize] of initializers) {
      await initialize();
      if (mode !== 'ast') {
        const before = decode(native.nativeResolveLookupPath('blog.Post', 'title', 'filter'));
        equal(Boolean(before.target?.filePath && before.target?.line && before.target?.column), false, `${mode}: missing source stays missing`);
        equal(await native.nativeEnsureAstModules(root), true, `${mode}: AST ready`);
      }
      for (const [name, line, column] of [['title', 3, 5], ['unicode_title', 4, unicodeColumn]] as const) {
        const lookup = decode(native.nativeResolveLookupPath('blog.Post', name, 'filter'));
        equal([lookup.target?.line, lookup.target?.column], [line, column], `${mode}: lookup ${name}`);
        equal(lookup.target?.filePath, file, `${mode}: lookup file ${name}`);
        const member = decode(native.nativeResolveOrmMember('blog.Post', 'instance', name, null));
        equal([member?.line, member?.column], [line, column], `${mode}: member ${name}`);
        equal(source.split('\r\n')[line - 1].slice(column - 1, column - 1 + name.length), name, `${mode}: exact declaration ${name}`);
      }
      const method = decode(native.nativeResolveOrmMember('blog.Post', 'instance', 'display', null));
      equal([method?.line, method?.column], [5, 5], `${mode}: method location`);
      const relation = decode(native.nativeResolveRelationTarget('blog.Post'));
      equal([relation.target?.line, relation.target?.column], [2, 1], `${mode}: relation target`);
      const origin = decode(native.nativeResolveExportOrigin('blog', 'Article'));
      equal([origin.originLine, origin.originColumn], [2, 1], `${mode}: export origin`);
      const module = decode(native.nativeResolveModule('blog.models'));
      equal([module.line, module.column], [1, 1], `${mode}: module start`);
      equal(decode(native.nativeResolveLookupPath('blog.Post', 'missing', 'filter')).resolved, false, `${mode}: unresolved lookup`);
    }
    // The binary cache owns opaque bytes; do not rewrite caller coordinates.
    const metadata = Buffer.from('{"column":0}');
    const payload = Buffer.from('{"column":1,"text":"한😀"}');
    const cache = path.join(root, 'opaque.bin');
    native.saveCacheBlob(cache, metadata, payload);
    const restored = native.loadCacheBlob(cache);
    equal(restored?.metadata.equals(metadata), true, 'opaque metadata byte identity');
    equal(restored?.payload.equals(payload), true, 'opaque payload byte identity');
    equal(native.cacheSchemaVersion(), 14, 'opaque binary schema unchanged');
    console.log(JSON.stringify({ assertions, failed: failures.length, failures }));
    if (failures.length) throw new Error(`${failures.length} source coordinate assertions failed`);
  } finally {
    native.nativeDrop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
