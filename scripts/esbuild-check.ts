import { transform } from 'esbuild';
import path from 'path';
import fs from 'fs';
import { parseComponent } from '../src/parser/index.js';
import { transformAll } from '../src/transforms/index.js';
import { emitComponent } from '../src/emitter/index.js';

const SRC = path.resolve(import.meta.dirname, '../vendor/cloudscape-source/src');
const skip = new Set(['internal','contexts','i18n','plugins','theming','test-utils','node_modules','interfaces.ts']);
const dirs = fs.readdirSync(SRC, { withFileTypes: true })
  .filter(e => e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('__'))
  .filter(e => fs.existsSync(path.join(SRC, e.name, 'index.tsx')) || fs.existsSync(path.join(SRC, e.name, 'index.ts')))
  .map(e => e.name).sort();

const pass: string[] = [];
const fail: Array<{ name: string; err: string }> = [];

for (const name of dirs) {
  try {
    const ir = parseComponent(path.join(SRC, name), { prefix: 'cs' });
    const out = emitComponent(transformAll(ir));
    await transform(out, {
      loader: 'ts', format: 'esm', logLevel: 'silent',
      tsconfigRaw: JSON.stringify({ compilerOptions: { experimentalDecorators: true, target: 'ES2022' } }),
    });
    pass.push(name);
  } catch (e: any) {
    const errLine = e.message?.split('\n').find((l: string) => l.includes('ERROR'))?.trim() || 'unknown';
    fail.push({ name, err: errLine });
  }
}

console.log(`Pass: ${pass.length}/${dirs.length}`);
console.log(`Fail: ${fail.length}`);
if (fail.length > 0) {
  console.log('\nFailures:');
  for (const f of fail) {
    console.log(`  ${f.name}: ${f.err.slice(0, 120)}`);
  }
}
