// End-to-end scale benchmark for the buildSurfaceIndexJson napi pipeline.
// Generates synthetic projects of increasing size and measures the full
// cold-start cost (stat + rayon walk + ruff AST + resolve + reverse
// synthesis + surface build + JSON serialise) as the TS side sees it.
//
// Invoke: node out/client/native/surface.bench.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadNative } from './loader';

function makeProject(root: string, modelCount: number): void {
  const perApp = 50;
  for (let i = 0; i < modelCount; i++) {
    const appIdx = Math.floor(i / perApp);
    const appDir = path.join(root, `app${appIdx}`);
    fs.mkdirSync(appDir, { recursive: true });
    if (!fs.existsSync(path.join(appDir, '__init__.py'))) {
      fs.writeFileSync(path.join(appDir, '__init__.py'), '');
    }
    const fields: string[] = [];
    for (let f = 0; f < 15; f++) {
      fields.push(`    field_${f} = models.CharField(max_length=200)`);
    }
    // two FKs with related_name
    for (let r = 0; r < 2; r++) {
      const target = (i + r + 1) % modelCount;
      fields.push(
        `    fk_${r} = models.ForeignKey('app${Math.floor(target / perApp)}.Model${target}', on_delete=models.CASCADE, related_name='back_${i}_${r}')`,
      );
    }
    const content =
      `from django.db import models\n\nclass Model${i}(models.Model):\n` +
      fields.join('\n') +
      `\n    class Meta:\n        app_label = 'app${appIdx}'\n`;
    fs.writeFileSync(path.join(appDir, `model_${i}.py`), content);
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function run(scale: number, runs: number): void {
  const n = loadNative();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `django-orm-surface-bench-${scale}-`));
  try {
    makeProject(tmpDir, scale);
    // warm-up
    const warm = n.buildSurfaceIndexJson(tmpDir);
    const modelsFound = Object.keys(JSON.parse(warm.toString('utf-8'))).length;

    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      n.buildSurfaceIndexJson(tmpDir);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    const bufSize = warm.length;

    console.log(
      `scale=${String(scale).padStart(5)} models=${String(modelsFound).padStart(5)} ` +
        `bytes=${String(bufSize).padStart(9)} ` +
        `full p50=${p50.toFixed(1).padStart(7)}ms p95=${p95.toFixed(1).padStart(7)}ms`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main(): void {
  console.log('--- TS → napi → full Rust pipeline (discover + AST + resolve + surface) ---');
  const runs = 5;
  for (const scale of [100, 500, 1500]) {
    run(scale, runs);
  }
  // Heavier scales with fewer runs.
  for (const scale of [5000, 15000]) {
    run(scale, 3);
  }
}

main();
