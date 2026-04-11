#!/usr/bin/env node
/**
 * Output quality analysis.
 *
 * Checks every generated component for correctness issues:
 * - React patterns that should have been transformed
 * - Invalid Lit syntax
 * - Missing expected output sections
 *
 * Usage: npx tsx scripts/diff-analysis.ts
 */
import path from 'node:path';
import fs from 'node:fs';
import { parseComponent } from '../src/parser/index.js';
import { transformAll } from '../src/transforms/index.js';
import { emitComponent } from '../src/emitter/index.js';

const CLOUDSCAPE_SRC = path.resolve(import.meta.dirname, '../vendor/cloudscape-source/src');

interface AnalysisResult {
  component: string;
  issues: string[];
  warnings: string[];
  stats: {
    props: number;
    state: number;
    effects: number;
    handlers: number;
    publicMethods: number;
    helpers: number;
    hasLifecycle: boolean;
    hasEventDispatch: boolean;
  };
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

function analyzeComponent(componentName: string): AnalysisResult {
  const result: AnalysisResult = {
    component: componentName,
    issues: [],
    warnings: [],
    stats: {
      props: 0, state: 0, effects: 0, handlers: 0,
      publicMethods: 0, helpers: 0, hasLifecycle: false, hasEventDispatch: false,
    },
  };

  try {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, componentName), { prefix: 'cs' });
    const transformed = transformAll(ir);
    const output = emitComponent(transformed);

    // Stats
    result.stats.props = ir.props.filter((p) => p.category !== 'event' && p.category !== 'slot').length;
    result.stats.state = ir.state.length;
    result.stats.effects = ir.effects.length;
    result.stats.handlers = ir.handlers.length;
    result.stats.publicMethods = ir.publicMethods.length;
    result.stats.helpers = ir.helpers.length;
    result.stats.hasLifecycle = output.includes('connectedCallback') || output.includes('willUpdate') || output.includes('override updated');
    result.stats.hasEventDispatch = output.includes('fireNonCancelableEvent(this,') || output.includes('dispatchEvent');

    // --- ISSUES (broken output) ---
    const classSection = output.slice(output.indexOf('export class'));
    const renderSection = output.slice(output.indexOf('override render()'));

    // React patterns that should not survive in Lit output
    if (renderSection.includes('WithNativeAttributes')) {
      result.issues.push('WithNativeAttributes in render — React wrapper not unwrapped');
    }
    if (renderSection.includes('className=')) {
      result.issues.push('className in render — should be class=');
    }
    if (renderSection.match(/clsx\(/)) {
      result.issues.push('clsx() in render — should be classMap()');
    }
    if (classSection.includes('React.')) {
      // Check if it's only in comments
      const codeOnly = classSection.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (codeOnly.includes('React.')) {
        result.issues.push('React. reference in class body');
      }
    }
    if (output.includes("from 'react'")) {
      result.issues.push('React import in output');
    }

    // Lit output structure checks
    if (!output.includes('export class Cs')) {
      result.issues.push('Missing class declaration');
    }
    if (!output.includes('override render()')) {
      result.issues.push('Missing render method');
    }
    if (!output.includes("from 'lit'")) {
      result.issues.push('Missing lit import');
    }

    // --- WARNINGS (suboptimal but not broken) ---
    if (output.replace(/\/\/.*$/gm, '').includes('__internalRootRef')) {
      result.warnings.push('__internalRootRef reference remains');
    }
    if (output.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').includes('baseProps')) {
      result.warnings.push('baseProps reference remains');
    }
    if (ir.effects.length > 0 && !result.stats.hasLifecycle) {
      result.warnings.push(`${ir.effects.length} effect(s) parsed but no lifecycle emitted`);
    }
    if (ir.props.some((p) => p.category === 'event') && !result.stats.hasEventDispatch) {
      // Only warn if the component has no child custom elements that could
      // dispatch events on its behalf (event bubbling through shadow DOM)
      const hasChildComponents = /<cs-[\w-]+/.test(output);
      if (!hasChildComponents) {
        result.warnings.push('Event props parsed but no event dispatch emitted');
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
const clean = results.filter((r) => r.issues.length === 0 && r.warnings.length === 0);
const withIssues = results.filter((r) => r.issues.length > 0);
const withWarnings = results.filter((r) => r.issues.length === 0 && r.warnings.length > 0);

console.log('=== Output Quality Analysis ===');
console.log(`Total components: ${components.length}`);
console.log(`Clean (no issues, no warnings): ${clean.length}`);
console.log(`With issues (broken output): ${withIssues.length}`);
console.log(`With warnings only: ${withWarnings.length}`);
console.log('');

// Issue breakdown
if (withIssues.length > 0) {
  const issueTypes = new Map<string, string[]>();
  for (const r of withIssues) {
    for (const issue of r.issues) {
      if (!issueTypes.has(issue)) issueTypes.set(issue, []);
      issueTypes.get(issue)!.push(r.component);
    }
  }
  console.log('--- Issues (broken output) ---');
  for (const [issue, comps] of [...issueTypes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${comps.length}x ${issue}`);
    for (const c of comps) console.log(`      - ${c}`);
  }
  console.log('');
}

// Warning breakdown
if (withWarnings.length > 0) {
  const warnTypes = new Map<string, string[]>();
  for (const r of withWarnings) {
    for (const warn of r.warnings) {
      if (!warnTypes.has(warn)) warnTypes.set(warn, []);
      warnTypes.get(warn)!.push(r.component);
    }
  }
  console.log('--- Warnings (suboptimal but not broken) ---');
  for (const [warn, comps] of [...warnTypes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${comps.length}x ${warn}`);
    for (const c of comps) console.log(`      - ${c}`);
  }
  console.log('');
}

// Clean components
console.log(`--- Clean Components (${clean.length}) ---`);
for (const r of clean) {
  const s = r.stats;
  const parts = [`${s.props}p`];
  if (s.state > 0) parts.push(`${s.state}s`);
  if (s.effects > 0) parts.push(`${s.effects}e`);
  if (s.handlers > 0) parts.push(`${s.handlers}h`);
  if (s.publicMethods > 0) parts.push(`${s.publicMethods}m`);
  console.log(`  ✓ ${r.component} [${parts.join(',')}]`);
}
