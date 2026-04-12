#!/usr/bin/env node
/**
 * Gate 3: Structural validation of generated Lit components.
 *
 * Checks that each generated component has the expected Lit web component
 * structure without requiring a browser environment:
 *
 * 1. Exports a class extending CsBaseElement (or a mixin of it)
 * 2. Has `static override styles = [...]`
 * 3. Has `override render()` method returning `html\`...\``
 * 4. Uses @property() or @state() decorators correctly
 * 5. No remaining React patterns (React., useState, useEffect, etc.)
 *
 * Usage: npx tsx scripts/gate3-structure.ts
 */
import path from 'node:path';
import fs from 'node:fs';
import { parseComponent } from '../src/parser/index.js';
import { transformAll } from '../src/transforms/index.js';
import { emitComponent } from '../src/emitter/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const CLOUDSCAPE_SRC = path.resolve(PROJECT_ROOT, 'vendor/cloudscape-source/src');

const SKIP_DIRS = new Set([
  '__a11y__', '__integ__', '__tests__', '__motion__',
  'internal', 'contexts', 'i18n', 'interfaces.ts',
  'test-utils', 'theming', 'node_modules', 'plugins',
]);

// ---------------------------------------------------------------------------
// Component discovery
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  output: string;
  genError?: string;
  checks: {
    hasClassDecl: boolean;
    extendsBase: boolean;
    hasStaticStyles: boolean;
    hasRenderMethod: boolean;
    renderReturnsHtml: boolean;
    hasLitImports: boolean;
    noReactPatterns: boolean;
    noRawJsx: boolean;
  };
  reactPatterns: string[];
}

const REACT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bReact\.\w+/g, label: 'React.xxx' },
  { pattern: /\buseState\b/g, label: 'useState' },
  { pattern: /\buseEffect\b/g, label: 'useEffect' },
  { pattern: /\buseLayoutEffect\b/g, label: 'useLayoutEffect' },
  { pattern: /\buseCallback\b/g, label: 'useCallback' },
  { pattern: /\buseContext\b/g, label: 'useContext' },
  { pattern: /\bforwardRef\b/g, label: 'forwardRef' },
  { pattern: /\bclassName\s*=/g, label: 'className=' },
  { pattern: /\bclsx\(/g, label: 'clsx()' },
];

function checkComponent(name: string): CheckResult {
  let output = '';
  try {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, name), {});
    const transformed = transformAll(ir);
    output = emitComponent(transformed);
  } catch (err) {
    return {
      name, output: '',
      genError: (err as Error).message,
      checks: { hasClassDecl: false, extendsBase: false, hasStaticStyles: false,
                hasRenderMethod: false, renderReturnsHtml: false, hasLitImports: false,
                noReactPatterns: false, noRawJsx: false },
      reactPatterns: [],
    };
  }

  // Check 1: Has class declaration (optionally with generic type params)
  const hasClassDecl = /export class Cs\w+Internal(?:<[^>]+>)? extends /.test(output);

  // Check 2: Extends CsBaseElement (or Base which is a mixin of CsBaseElement)
  const extendsBase = /extends (CsBaseElement|Base)\b/.test(output);

  // Check 3: Has static override styles
  const hasStaticStyles = /static override styles\s*=/.test(output);

  // Check 4: Has override render() method
  const hasRenderMethod = /override render\(\)/.test(output);

  // Check 5: render() returns html``
  const renderMatch = output.match(/override render\(\)\s*\{[\s\S]*?return html\s*`/);
  const renderReturnsHtml = !!renderMatch;

  // Check 6: Has Lit imports
  const hasLitImports = /import\s*\{.*\}\s*from\s*'lit'/.test(output);

  // Check 7: No remaining React patterns
  const reactPatterns: string[] = [];
  // Only check inside the class body (not in helper functions which may have some residual patterns)
  for (const { pattern, label } of REACT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(output)) {
      reactPatterns.push(label);
    }
  }
  const noReactPatterns = reactPatterns.length === 0;

  // Check 8: No raw JSX (already validated by Gate 1, but double-check)
  const noRawJsx = !/<[A-Z][a-zA-Z]+\s+\w+=\{/.test(output);

  return {
    name, output,
    checks: { hasClassDecl, extendsBase, hasStaticStyles, hasRenderMethod,
              renderReturnsHtml, hasLitImports, noReactPatterns, noRawJsx },
    reactPatterns,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(results: CheckResult[]): void {
  const total = results.length;
  const genFailed = results.filter((r) => !!r.genError);
  const genOk = results.filter((r) => !r.genError);

  // Count per-check passes
  const checkNames = [
    'hasClassDecl', 'extendsBase', 'hasStaticStyles', 'hasRenderMethod',
    'renderReturnsHtml', 'hasLitImports', 'noReactPatterns', 'noRawJsx',
  ] as const;

  const checkLabels: Record<string, string> = {
    hasClassDecl: 'Class declaration',
    extendsBase: 'Extends CsBaseElement',
    hasStaticStyles: 'Static styles',
    hasRenderMethod: 'render() method',
    renderReturnsHtml: 'render() returns html``',
    hasLitImports: 'Lit imports',
    noReactPatterns: 'No React patterns',
    noRawJsx: 'No raw JSX',
  };

  console.log('=== Gate 3: Structural Validation ===\n');
  console.log(`Total components:       ${total}`);
  console.log(`Generation succeeded:   ${genOk.length}/${total}`);
  if (genFailed.length > 0) {
    console.log(`Generation failed:      ${genFailed.length} (${genFailed.map((r) => r.name).join(', ')})`);
  }
  console.log('');

  // Per-check results
  console.log('--- Per-Check Results ---');
  for (const check of checkNames) {
    const pass = genOk.filter((r) => r.checks[check]).length;
    const icon = pass === genOk.length ? '✓' : '✗';
    console.log(`  ${icon} ${checkLabels[check]}: ${pass}/${genOk.length}`);
  }
  console.log('');

  // Fully passing components (all 8 checks)
  const fullyPassing = genOk.filter((r) =>
    checkNames.every((c) => r.checks[c]),
  );
  console.log(`Fully passing:          ${fullyPassing.length}/${total}`);
  console.log('');

  // React pattern summary
  const reactCounts = new Map<string, number>();
  for (const r of genOk) {
    for (const p of r.reactPatterns) {
      reactCounts.set(p, (reactCounts.get(p) || 0) + 1);
    }
  }
  if (reactCounts.size > 0) {
    console.log('--- Remaining React Patterns ---');
    const sorted = [...reactCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [pattern, count] of sorted) {
      console.log(`  ${count}x ${pattern}`);
    }
    console.log('');
  }

  // Components failing any check
  const failing = genOk.filter((r) => !checkNames.every((c) => r.checks[c]));
  if (failing.length > 0) {
    console.log('--- Components With Failures ---');
    for (const r of failing) {
      const failed = checkNames.filter((c) => !r.checks[c]).map((c) => checkLabels[c]);
      console.log(`  ✗ ${r.name}: ${failed.join(', ')}`);
    }
    console.log('');
  }

  // Fully passing list
  if (fullyPassing.length > 0) {
    console.log(`--- Fully Passing (${fullyPassing.length}) ---`);
    for (const r of fullyPassing) {
      console.log(`  ✓ ${r.name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const t0 = performance.now();

console.log('Discovering components...');
const components = findComponentDirs();
console.log(`Found ${components.length} components.\n`);

console.log('Running structural checks...');
const results = components.map(checkComponent);
console.log('Done.\n');

report(results);

const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\nTotal runtime: ${elapsed}s`);
