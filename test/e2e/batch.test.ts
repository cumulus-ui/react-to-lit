/**
 * Batch generation test — Phase 5.
 *
 * Tests that ALL Cloudscape components can be parsed, transformed, and emitted
 * without errors.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
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

function findComponentDirs(): string[] {
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

function fullPipeline(componentName: string): string {
  const ir = parseComponent(path.join(CLOUDSCAPE_SRC, componentName));
  const transformed = transformAll(ir);
  return emitComponent(transformed);
}

describe('Phase 5: Full generation — all Cloudscape components', () => {
  const components = findComponentDirs();

  it(`should discover 90+ components`, () => {
    expect(components.length).toBeGreaterThanOrEqual(90);
  });

  const results: Array<{ name: string; success: boolean; output?: string; error?: string }> = [];

  for (const componentName of components) {
    it(`should transpile ${componentName}`, () => {
      try {
        const output = fullPipeline(componentName);
        results.push({ name: componentName, success: true, output });

        // Basic structural checks
        expect(output).toContain('export class');
        expect(output).toContain('extends');
        expect(output).toContain('override render()');
        expect(output).toContain("from 'lit'");
      } catch (err) {
        results.push({ name: componentName, success: false, error: (err as Error).message });
        throw err;
      }
    });
  }

  it('should report generation summary', () => {
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    console.log(`\nGeneration summary: ${succeeded} succeeded, ${failed} failed out of ${results.length}`);

    if (failed > 0) {
      console.log('Failed:');
      for (const r of results.filter((r) => !r.success)) {
        console.log(`  ✗ ${r.name}: ${r.error}`);
      }
    }

    // Phase 5 target: 100% success
    expect(failed).toBe(0);
  });

  it('should generate output with correct class names', () => {
    for (const r of results.filter((r) => r.success)) {
      const output = r.output!;
      // Should have CsXxxInternal class pattern
      expect(output).toMatch(/export class Cs\w+Internal extends/);
    }
  });

  it('should not contain React imports in any output', () => {
    for (const r of results.filter((r) => r.success)) {
      const output = r.output!;
      expect(output).not.toContain("from 'react'");
      expect(output).not.toContain("import React");
    }
  });

  it('should use Lit imports in all output', () => {
    for (const r of results.filter((r) => r.success)) {
      const output = r.output!;
      expect(output).toContain("from 'lit'");
    }
  });
});
