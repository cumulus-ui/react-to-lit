#!/usr/bin/env node
/**
 * Phase 6: Diff analysis script.
 *
 * Compares transpiler output against hand-written Lit components
 * in @cumulus-ui/components to identify behavioral gaps.
 *
 * Usage: npx tsx scripts/diff-analysis.ts
 */
import path from 'node:path';
import fs from 'node:fs';
import { parseComponent } from '../src/parser/index.js';
import { transformAll } from '../src/transforms/index.js';
import { emitComponent } from '../src/emitter/index.js';

const CLOUDSCAPE_SRC = path.resolve(import.meta.dirname, '../vendor/cloudscape-source/src');
const HANDWRITTEN_SRC = path.resolve(import.meta.dirname, '../../components/src');

interface DiffResult {
  component: string;
  hasHandwritten: boolean;
  hasGenerated: boolean;
  issues: string[];
  propsMissing: string[];
  propsExtra: string[];
  featureGaps: string[];
}

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

function analyzeComponent(componentName: string): DiffResult {
  const result: DiffResult = {
    component: componentName,
    hasHandwritten: false,
    hasGenerated: false,
    issues: [],
    propsMissing: [],
    propsExtra: [],
    featureGaps: [],
  };

  // Check if hand-written version exists
  const handwrittenPath = path.join(HANDWRITTEN_SRC, componentName, 'internal.ts');
  result.hasHandwritten = fs.existsSync(handwrittenPath);

  // Generate the transpiled version
  try {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, componentName), { prefix: 'cs' });
    const transformed = transformAll(ir);
    const output = emitComponent(transformed);
    result.hasGenerated = true;

    // Analyze output quality — focus on the class body (after 'export class')
    const classSection = output.slice(output.indexOf('export class'));
    const renderSection = output.slice(output.indexOf('override render()'));

    if (renderSection.includes('WithNativeAttributes')) {
      result.issues.push('Contains un-unwrapped WithNativeAttributes in render');
    }
    if (renderSection.includes('clsx(')) {
      result.issues.push('Contains un-transformed clsx() in render');
    }
    if (classSection.includes('baseProps') && !output.includes('// WARNING:')) {
      result.issues.push('Contains baseProps reference in class body');
    }
    if (classSection.includes('__internalRootRef')) {
      result.issues.push('Contains __internalRootRef in class body');
    }
    if (renderSection.includes('AbstractSwitch') || renderSection.includes('cs-abstract-switch')) {
      result.issues.push('Contains AbstractSwitch (needs inlining)');
    }
    if (output.includes('/* spread:')) {
      result.issues.push('Contains spread comment');
    }

    // Compare with hand-written version if available
    if (result.hasHandwritten) {
      const handwritten = fs.readFileSync(handwrittenPath, 'utf-8');

      // Check for features in hand-written that are missing in generated
      if (handwritten.includes('FormControlMixin') && !output.includes('FormControlMixin')) {
        result.featureGaps.push('Missing FormControlMixin');
      }
      if (handwritten.includes('@consume') && !output.includes('@consume')) {
        result.featureGaps.push('Missing @consume context');
      }
      if (handwritten.includes('fireNonCancelableEvent') && !output.includes('fireNonCancelableEvent')) {
        result.featureGaps.push('Missing event dispatch');
      }
      if (handwritten.includes('connectedCallback') && !output.includes('connectedCallback')) {
        result.featureGaps.push('Missing connectedCallback');
      }
      if (handwritten.includes('disconnectedCallback') && !output.includes('disconnectedCallback')) {
        result.featureGaps.push('Missing disconnectedCallback');
      }
      if (handwritten.includes('willUpdate') && !output.includes('willUpdate')) {
        result.featureGaps.push('Missing willUpdate');
      }
      if (handwritten.includes('focus(') && !output.includes('focus(')) {
        result.featureGaps.push('Missing focus() method');
      }

      // Compare property counts
      const hwPropCount = (handwritten.match(/@property/g) || []).length;
      const genPropCount = (output.match(/@property/g) || []).length;
      if (Math.abs(hwPropCount - genPropCount) > 3) {
        result.featureGaps.push(`Property count mismatch: hand-written=${hwPropCount}, generated=${genPropCount}`);
      }
    }
  } catch (err) {
    result.issues.push(`Generation failed: ${(err as Error).message}`);
  }

  return result;
}

// --- Main ---
const components = findComponents();
const results = components.map(analyzeComponent);

// --- Summary ---
const generated = results.filter((r) => r.hasGenerated);
const withHandwritten = results.filter((r) => r.hasHandwritten);
const withIssues = results.filter((r) => r.issues.length > 0);
const withGaps = results.filter((r) => r.featureGaps.length > 0);
const clean = results.filter((r) => r.hasGenerated && r.issues.length === 0);

console.log('=== Diff Analysis Summary ===');
console.log(`Total components: ${components.length}`);
console.log(`Generated successfully: ${generated.length}`);
console.log(`Have hand-written version: ${withHandwritten.length}`);
console.log(`Clean (no issues): ${clean.length}`);
console.log(`With output issues: ${withIssues.length}`);
console.log(`With feature gaps vs hand-written: ${withGaps.length}`);
console.log('');

// Issue breakdown
const issueTypes = new Map<string, number>();
for (const r of results) {
  for (const issue of r.issues) {
    issueTypes.set(issue, (issueTypes.get(issue) || 0) + 1);
  }
}
if (issueTypes.size > 0) {
  console.log('--- Output Issues ---');
  for (const [issue, count] of [...issueTypes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x ${issue}`);
  }
  console.log('');
}

// Feature gap breakdown
const gapTypes = new Map<string, number>();
for (const r of results) {
  for (const gap of r.featureGaps) {
    gapTypes.set(gap, (gapTypes.get(gap) || 0) + 1);
  }
}
if (gapTypes.size > 0) {
  console.log('--- Feature Gaps (vs hand-written) ---');
  for (const [gap, count] of [...gapTypes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x ${gap}`);
  }
  console.log('');
}

// Clean components
console.log('--- Clean Components (no issues) ---');
for (const r of clean) {
  const marker = r.hasHandwritten ? '✓' : '○';
  console.log(`  ${marker} ${r.component}`);
}
