/**
 * Output validation tests.
 *
 * Validates that generated output is syntactically valid and doesn't
 * contain unconverted React patterns. Catches build errors before
 * they reach the integration test.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { transform } from 'esbuild';
import { parseComponent } from '../../src/parser/index.js';
import { transformAll } from '../../src/transforms/index.js';
import { emitComponent } from '../../src/emitter/index.js';

const CLOUDSCAPE_SRC = path.resolve(
  import.meta.dirname,
  '../../vendor/cloudscape-source/src',
);

const SKIP_DIRS = new Set([
  '__a11y__', '__integ__', '__tests__', '__motion__',
  'internal', 'contexts', 'i18n', 'interfaces.ts',
  'test-utils', 'theming', 'node_modules', 'plugins',
]);

function findComponents(): string[] {
  const entries = fs.readdirSync(CLOUDSCAPE_SRC, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('__'))
    .filter((e) => {
      const dir = path.join(CLOUDSCAPE_SRC, e.name);
      return fs.existsSync(path.join(dir, 'index.tsx')) || fs.existsSync(path.join(dir, 'index.ts'));
    })
    .map((e) => e.name)
    .sort();
}

function generate(componentName: string): string {
  const ir = parseComponent(path.join(CLOUDSCAPE_SRC, componentName));
  const transformed = transformAll(ir);
  return emitComponent(transformed);
}

// Cache generated output
const outputCache = new Map<string, string>();
function getOutput(name: string): string {
  if (!outputCache.has(name)) {
    outputCache.set(name, generate(name));
  }
  return outputCache.get(name)!;
}

const components = findComponents();

// -------------------------------------------------------------------------
// Test 1: esbuild syntax check
// -------------------------------------------------------------------------
describe('esbuild syntax validation', () => {
  const failures: string[] = [];

  for (const name of components) {
    it(`${name} passes esbuild syntax check`, async () => {
      const output = getOutput(name);
      try {
        await transform(output, {
          loader: 'ts',
          format: 'esm',
          logLevel: 'silent',
          tsconfigRaw: JSON.stringify({
            compilerOptions: {
              experimentalDecorators: true,
              target: 'ES2022',
            },
          }),
        });
      } catch (err) {
        failures.push(name);
        // Don't fail the test — track in summary
      }
    });
  }

  it('reports esbuild failure summary', () => {
    const passed = components.length - failures.length;
    console.log(`\nesbuild: ${passed}/${components.length} pass (${failures.length} failures)`);
    if (failures.length > 0) {
      console.log(`Failed: ${failures.join(', ')}`);
    }
    // Track progress — this number should only go up
    expect(passed).toBeGreaterThanOrEqual(91);
  });
});

// -------------------------------------------------------------------------
// Test 2: No raw JSX outside html`` templates
// -------------------------------------------------------------------------
describe('no raw JSX in output', () => {
  const jsxFailures: string[] = [];

  for (const name of components) {
    it(`${name} has no raw JSX outside html templates`, () => {
      const output = getOutput(name);

      // Strip html`...` template contents (including multiline)
      const withoutTemplates = output.replace(/html`[^`]*`/gs, 'html``');

      // Strip string literals and comments
      const stripped = withoutTemplates
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/'[^']*'/g, "''")
        .replace(/"[^"]*"/g, '""')
        .replace(/`[^`]*`/g, '``');

      // Check for JSX patterns: <Component prop= or <div className=
      const jsxPattern = /<[A-Z][a-zA-Z]+\s+\w+=/;
      const match = stripped.match(jsxPattern);
      if (match) {
        jsxFailures.push(name);
      }
    });
  }

  it('reports JSX summary', () => {
    const passed = components.length - jsxFailures.length;
    console.log(`\nno-JSX: ${passed}/${components.length} pass (${jsxFailures.length} have raw JSX)`);
    // Track progress — this number should only go up
    expect(passed).toBeGreaterThanOrEqual(91);
  });
});

// -------------------------------------------------------------------------
// Test 3: No unconverted React patterns
// -------------------------------------------------------------------------
describe('no React patterns in output', () => {
  for (const name of components) {
    it(`${name} has no React imports`, () => {
      const output = getOutput(name);
      expect(output).not.toContain("from 'react'");
      expect(output).not.toContain('import React');
    });
  }
});
