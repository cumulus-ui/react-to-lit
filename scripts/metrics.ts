#!/usr/bin/env node
/**
 * Compiler output metrics.
 *
 * Scans the gate2 output directory and counts known compiler issues,
 * producing a dashboard that tracks progress on filed GitHub issues.
 *
 * Prerequisites: run `npm run gate2` first to generate .gate2-output/.
 *
 * Usage: npx tsx scripts/metrics.ts
 *        npx tsx scripts/metrics.ts --json          # machine-readable
 *        npx tsx scripts/metrics.ts --component alert  # single component
 */
import path from 'node:path';
import fs from 'node:fs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.resolve(PROJECT_ROOT, '.gate2-output');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComponentMetrics {
  name: string;
  classNameObjectObject: number;
  ariaPropertyBindings: number;
  changedHasDottedPath: number;
  residualDotCurrent: number;
  returnNull: number;
  missingIfDefined: number;
  deadEventCallbackProps: number;
  anyStubFields: number;
  staticClassDynamicBinding: number;
  voidElementClosingTags: number;
}

interface Summary {
  totalComponents: number;
  components: ComponentMetrics[];
  totals: Omit<ComponentMetrics, 'name'>;
  cleanComponents: string[];
  issueBreakdown: { issue: string; count: number; components: string[] }[];
}

// ---------------------------------------------------------------------------
// Scanners — one per GitHub issue
// ---------------------------------------------------------------------------

/** #32: className="[object Object]" */
function countClassNameObjectObject(source: string): number {
  return (source.match(/className="\[object Object\]"/g) || []).length;
}

/** #33: .aria-* property bindings instead of attribute bindings */
function countAriaPropertyBindings(source: string): number {
  // Match .aria-xxx= and .role= as property bindings in template context
  // Exclude lines that are clearly type annotations or comments
  const matches = source.match(/\.aria-[\w-]+=\$/g) || [];
  const roleMatches = source.match(/\.role=\$/g) || [];
  return matches.length + roleMatches.length;
}

/** #34: changed.has('dotted.path') or changed.has('obj?.prop') */
function countChangedHasDottedPath(source: string): number {
  const matches = source.match(/changed\.has\('[^']*[.?][^']*'\)/g) || [];
  return matches.length;
}

/** #35: Residual .current on fields typed as any */
function countResidualDotCurrent(source: string): number {
  // Count this._xxx.current where _xxx is a private field (not a known ref pattern)
  // Exclude import lines and comments
  const codeOnly = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const matches = codeOnly.match(/this\._\w+\.current\b/g) || [];
  return matches.length;
}

/** #36: return null instead of return nothing */
function countReturnNull(source: string): number {
  // Only count in render methods and render helper methods
  const matches = source.match(/return\s+null\s*;/g) || [];
  return matches.length;
}

/** #37: Missing ifDefined() — count attribute bindings with possible undefined */
function countMissingIfDefined(source: string): number {
  // This is harder to count precisely. We approximate by checking:
  // 1. Zero uses of ifDefined in the file
  // 2. Attribute bindings (non-property, non-boolean) that contain ternary with undefined
  //    or nullish coalescing with undefined
  const hasIfDefined = source.includes('ifDefined');
  if (hasIfDefined) return 0;

  // Count attribute bindings where the expression contains 'undefined'
  // Pattern: non-property, non-boolean binding with undefined in expression
  // This is an approximation — a precise count would require AST analysis
  const templateSection = source.slice(source.indexOf('override render()'));
  if (!templateSection) return 0;

  // Count expressions in html`` that reference undefined
  const undefinedInBindings = templateSection.match(
    /(?<!\.)(?<![\?!])[\w-]+=\$\{[^}]*\bundefined\b[^}]*\}/g
  ) || [];
  return undefinedInBindings.length;
}

/** #38: Dead event callback props */
function countDeadEventCallbackProps(source: string): number {
  const matches = source.match(/^\s+on\w+\?\s*:\s*\(\.\.\.\s*args\s*:\s*any\[\]\)\s*=>\s*void\s*;/gm) || [];
  return matches.length;
}

/** #39: private _xxx: any stub fields */
function countAnyStubFields(source: string): number {
  const matches = source.match(/^\s+private\s+_\w+\s*:\s*any\s*;/gm) || [];
  return matches.length;
}

/** #40: class=${'literal'} instead of class="literal" */
function countStaticClassDynamicBinding(source: string): number {
  const matches = source.match(/class=\$\{'[^']+'\}/g) || [];
  return matches.length;
}

/** #41: Void elements with closing tags */
function countVoidElementClosingTags(source: string): number {
  const voidElements = ['input', 'img', 'br', 'hr', 'area', 'base', 'col', 'embed', 'link', 'meta', 'source', 'track', 'wbr'];
  let count = 0;
  for (const tag of voidElements) {
    const regex = new RegExp(`</${tag}>`, 'g');
    count += (source.match(regex) || []).length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function scanComponent(name: string, source: string): ComponentMetrics {
  return {
    name,
    classNameObjectObject: countClassNameObjectObject(source),
    ariaPropertyBindings: countAriaPropertyBindings(source),
    changedHasDottedPath: countChangedHasDottedPath(source),
    residualDotCurrent: countResidualDotCurrent(source),
    returnNull: countReturnNull(source),
    missingIfDefined: countMissingIfDefined(source),
    deadEventCallbackProps: countDeadEventCallbackProps(source),
    anyStubFields: countAnyStubFields(source),
    staticClassDynamicBinding: countStaticClassDynamicBinding(source),
    voidElementClosingTags: countVoidElementClosingTags(source),
  };
}

function run(): Summary {
  if (!fs.existsSync(OUTPUT_DIR)) {
    console.error(`Error: ${OUTPUT_DIR} does not exist. Run 'npm run gate2' first.`);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const componentFilter = args.includes('--component')
    ? args[args.indexOf('--component') + 1]
    : undefined;

  const dirs = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => !componentFilter || name === componentFilter)
    .sort();

  const components: ComponentMetrics[] = [];

  for (const dir of dirs) {
    const indexPath = path.join(OUTPUT_DIR, dir, 'index.ts');
    if (!fs.existsSync(indexPath)) continue;
    const source = fs.readFileSync(indexPath, 'utf-8');
    components.push(scanComponent(dir, source));
  }

  // Compute totals
  const totals: Omit<ComponentMetrics, 'name'> = {
    classNameObjectObject: 0,
    ariaPropertyBindings: 0,
    changedHasDottedPath: 0,
    residualDotCurrent: 0,
    returnNull: 0,
    missingIfDefined: 0,
    deadEventCallbackProps: 0,
    anyStubFields: 0,
    staticClassDynamicBinding: 0,
    voidElementClosingTags: 0,
  };

  for (const c of components) {
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] += c[key];
    }
  }

  // Clean = zero bugs (quality issues don't count)
  const bugKeys: (keyof ComponentMetrics)[] = [
    'classNameObjectObject', 'ariaPropertyBindings', 'changedHasDottedPath',
    'residualDotCurrent', 'returnNull',
  ];
  const cleanComponents = components
    .filter((c) => bugKeys.every((k) => c[k] === 0))
    .map((c) => c.name);

  // Issue breakdown
  const issueMap: { key: keyof typeof totals; label: string; issue: string }[] = [
    { key: 'classNameObjectObject', label: '#32 className=[object Object]', issue: 'bug' },
    { key: 'ariaPropertyBindings', label: '#33 .aria-* property bindings', issue: 'bug' },
    { key: 'changedHasDottedPath', label: '#34 changed.has(dotted.path)', issue: 'bug' },
    { key: 'residualDotCurrent', label: '#35 residual .current', issue: 'bug' },
    { key: 'returnNull', label: '#36 return null', issue: 'bug' },
    { key: 'missingIfDefined', label: '#37 missing ifDefined()', issue: 'bug' },
    { key: 'deadEventCallbackProps', label: '#38 dead event callbacks', issue: 'quality' },
    { key: 'anyStubFields', label: '#39 any stub fields', issue: 'quality' },
    { key: 'staticClassDynamicBinding', label: '#40 static class dynamic binding', issue: 'quality' },
    { key: 'voidElementClosingTags', label: '#41 void closing tags', issue: 'quality' },
  ];

  const issueBreakdown = issueMap.map(({ key, label, issue }) => ({
    issue: `[${issue}] ${label}`,
    count: totals[key],
    components: components.filter((c) => c[key] > 0).map((c) => c.name),
  }));

  return {
    totalComponents: components.length,
    components,
    totals,
    cleanComponents,
    issueBreakdown,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const summary = run();
const jsonMode = process.argv.includes('--json');

if (jsonMode) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const { totals, totalComponents, cleanComponents, issueBreakdown } = summary;

  console.log('');
  console.log('=== react-to-lit Compiler Metrics ===');
  console.log('');

  // Bug totals
  const bugTotal = totals.classNameObjectObject + totals.ariaPropertyBindings +
    totals.changedHasDottedPath + totals.residualDotCurrent +
    totals.returnNull + totals.missingIfDefined;
  const qualityTotal = totals.deadEventCallbackProps + totals.anyStubFields +
    totals.staticClassDynamicBinding + totals.voidElementClosingTags;

  console.log(`Components scanned:   ${totalComponents}`);
  console.log(`Bug-free components:  ${cleanComponents.length} / ${totalComponents}`);
  console.log(`Total bug instances:  ${bugTotal}`);
  console.log(`Total quality issues: ${qualityTotal}`);
  console.log('');

  // Per-issue table
  console.log('Issue                                Count   Components');
  console.log('-----                                -----   ----------');
  for (const { issue, count, components } of issueBreakdown) {
    const pad = 37 - issue.length;
    const countStr = String(count).padStart(5);
    const compStr = count === 0 ? '-' : `${components.length} affected`;
    console.log(`${issue}${' '.repeat(Math.max(1, pad))}${countStr}   ${compStr}`);
  }
  console.log('');

  // Worst offenders
  const byBugs = summary.components
    .map((c) => ({
      name: c.name,
      bugs: c.classNameObjectObject + c.ariaPropertyBindings + c.changedHasDottedPath +
        c.residualDotCurrent + c.returnNull,
    }))
    .filter((c) => c.bugs > 0)
    .sort((a, b) => b.bugs - a.bugs)
    .slice(0, 10);

  if (byBugs.length > 0) {
    console.log('Worst offenders (most bugs):');
    for (const { name, bugs } of byBugs) {
      console.log(`  ${String(bugs).padStart(3)} bugs  ${name}`);
    }
    console.log('');
  }

  // Bug-free list
  if (cleanComponents.length > 0 && cleanComponents.length <= 20) {
    console.log(`Bug-free components (${cleanComponents.length}):`);
    console.log(`  ${cleanComponents.join(', ')}`);
    console.log('');
  }
}
