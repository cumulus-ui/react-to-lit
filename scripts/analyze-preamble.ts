#!/usr/bin/env tsx
/**
 * Analysis script: classify all bodyPreamble statements across all 91 components.
 *
 * Uses the existing parse + transform pipeline to get post-transform preambles,
 * then classifies each statement.
 */
import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';
import { parseComponent } from '../src/parser/index.js';
import { transformAll } from '../src/transforms/index.js';
import type { ComponentIR, TemplateNodeIR } from '../src/ir/types.js';

// ---------------------------------------------------------------------------
// Component discovery (copied from cli.ts)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '__a11y__', '__integ__', '__tests__', '__motion__',
  'internal', 'contexts', 'i18n', 'interfaces.ts',
  'test-utils', 'theming', 'node_modules', 'plugins',
]);

function findComponentDirs(sourceRoot: string): string[] {
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('__')) continue;
    const componentDir = path.join(sourceRoot, entry.name);
    const hasIndex =
      fs.existsSync(path.join(componentDir, 'index.tsx')) ||
      fs.existsSync(path.join(componentDir, 'index.ts'));
    if (hasIndex) dirs.push(componentDir);
  }
  return dirs.sort();
}

// ---------------------------------------------------------------------------
// Statement classification
// ---------------------------------------------------------------------------

type Category =
  | 'props_state_only'     // Cat 1: variable decl referencing only props/state
  | 'external_functions'   // Cat 2: variable decl referencing external functions
  | 'chain_dependency'     // Cat 3: variable decl referencing other preamble vars
  | 'conditional'          // Cat 4: if/else statements
  | 'other';               // Cat 5: anything else

interface ClassifiedStatement {
  component: string;
  category: Category;
  text: string;
  declaredVars: string[];        // variable names declared by this statement
  referencedIdentifiers: string[]; // identifiers used in the RHS
  externalFunctions: string[];   // function calls in the RHS
  referencedInTemplate: boolean;
}

function classifyStatement(
  text: string,
  ir: ComponentIR,
  allPreambleVarsSoFar: Set<string>,
): ClassifiedStatement {
  const result: ClassifiedStatement = {
    component: ir.name,
    category: 'other',
    text,
    declaredVars: [],
    referencedIdentifiers: [],
    externalFunctions: [],
    referencedInTemplate: false,
  };

  const trimmed = text.trim();

  // Category 4: Conditional statements
  if (trimmed.startsWith('if ') || trimmed.startsWith('if(')) {
    result.category = 'conditional';
    // Check if any variable names appear in the template
    result.referencedInTemplate = false; // conditionals don't declare vars
    return result;
  }

  // Check if it's a variable declaration
  const isVarDecl = trimmed.startsWith('const ') || trimmed.startsWith('let ') || trimmed.startsWith('var ');
  if (!isVarDecl) {
    result.category = 'other';
    return result;
  }

  // Parse the statement to extract declared vars and RHS
  const declaredVars = extractDeclaredVars(trimmed);
  result.declaredVars = declaredVars;

  // Extract function calls from the RHS
  const rhsStart = trimmed.indexOf('=');
  const rhs = rhsStart >= 0 ? trimmed.slice(rhsStart + 1).trim() : '';

  const functionCalls = extractFunctionCalls(rhs);
  result.externalFunctions = functionCalls;

  // Extract all identifiers from the RHS
  const rhsIdentifiers = extractIdentifiers(rhs);
  result.referencedIdentifiers = rhsIdentifiers;

  // Build set of prop names and state names
  const propNames = new Set(ir.props.map(p => p.name));
  const stateNames = new Set(ir.state.map(s => s.name));
  const stateSetters = new Set(ir.state.map(s => s.setter));
  const refNames = new Set(ir.refs.map(r => r.name));
  const handlerNames = new Set(ir.handlers.map(h => h.name));
  const computedNames = new Set(ir.computedValues.map(c => c.name));
  
  // All "known" component members (after this. rewriting)
  const knownMembers = new Set([
    ...propNames, ...stateNames, ...stateSetters,
    ...refNames, ...handlerNames, ...computedNames,
  ]);

  // Check if any RHS identifiers reference other preamble variables
  const refsPreambleVars = rhsIdentifiers.some(id => allPreambleVarsSoFar.has(id));

  // Check if any RHS has function calls (that aren't simple property access)
  const hasExternalFunctions = functionCalls.length > 0;

  // Determine category
  if (refsPreambleVars) {
    result.category = 'chain_dependency';
  } else if (hasExternalFunctions) {
    result.category = 'external_functions';
  } else {
    // Check if all identifiers are props/state/known or simple expressions
    // After transforms, props become this.propName, state becomes this._stateName
    // So we look for this.xxx patterns and raw identifiers
    result.category = 'props_state_only';
  }

  // Check if declared vars are referenced in the template
  const templateText = collectTemplateText(ir.template);
  result.referencedInTemplate = declaredVars.some(v => {
    // After identifier rewriting, preamble vars might be this.xxx or still raw
    // Check both raw name and this.name patterns
    return templateText.includes(v) || templateText.includes(`this.${v}`) || templateText.includes(`this._${v}`);
  });

  return result;
}

function extractDeclaredVars(text: string): string[] {
  const vars: string[] = [];
  
  // const { a, b, c } = ...  (destructuring)
  const destructMatch = text.match(/(?:const|let|var)\s+\{([^}]+)\}/);
  if (destructMatch) {
    const inner = destructMatch[1];
    // Parse each binding: "a", "b: c", "a = default"
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // "original: renamed" → renamed
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx >= 0) {
        const renamed = trimmed.slice(colonIdx + 1).trim().split(/[\s=]/)[0];
        vars.push(renamed);
      } else {
        const name = trimmed.split(/[\s=]/)[0];
        vars.push(name);
      }
    }
    return vars;
  }

  // const [a, b] = ... (array destructuring)
  const arrayMatch = text.match(/(?:const|let|var)\s+\[([^\]]+)\]/);
  if (arrayMatch) {
    const inner = arrayMatch[1];
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (trimmed && trimmed !== '...') {
        vars.push(trimmed.replace(/^\.\.\./, ''));
      }
    }
    return vars;
  }

  // const foo = ... (simple)
  const simpleMatch = text.match(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/);
  if (simpleMatch) {
    vars.push(simpleMatch[1]);
  }

  return vars;
}

function extractFunctionCalls(rhs: string): string[] {
  const calls: string[] = [];
  // Match identifier( or identifier.identifier( patterns
  // But skip common non-function patterns
  const callPattern = /\b([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\s*\(/g;
  let match;
  while ((match = callPattern.exec(rhs)) !== null) {
    const name = match[1];
    // Skip keywords and common non-functions
    if (['if', 'else', 'for', 'while', 'switch', 'catch', 'typeof', 'instanceof', 'new', 'return', 'void'].includes(name)) continue;
    // Skip this.xxx (class member references, not external)
    if (name.startsWith('this.')) continue;
    // Skip property chains like a.b.c if a is "this"
    calls.push(name);
  }
  return [...new Set(calls)];
}

function extractIdentifiers(rhs: string): string[] {
  const ids: string[] = [];
  const idPattern = /\b([a-zA-Z_$][\w$]*)\b/g;
  let match;
  const keywords = new Set([
    'const', 'let', 'var', 'if', 'else', 'for', 'while', 'switch',
    'case', 'break', 'continue', 'return', 'function', 'class',
    'new', 'delete', 'typeof', 'instanceof', 'void', 'in', 'of',
    'true', 'false', 'null', 'undefined', 'this', 'super',
    'import', 'export', 'default', 'as', 'from',
    'string', 'number', 'boolean', 'any', 'object', 'symbol',
  ]);
  while ((match = idPattern.exec(rhs)) !== null) {
    const name = match[1];
    if (!keywords.has(name) && name.length > 1) {
      ids.push(name);
    }
  }
  return [...new Set(ids)];
}

function collectTemplateText(node: TemplateNodeIR): string {
  let text = '';
  
  if (node.expression) {
    text += ' ' + node.expression;
  }
  
  if (node.condition) {
    text += ' ' + node.condition.expression;
    if (node.condition.alternate) {
      text += ' ' + collectTemplateText(node.condition.alternate);
    }
  }
  
  if (node.loop) {
    text += ' ' + node.loop.iterable;
  }
  
  for (const attr of node.attributes) {
    if (typeof attr.value === 'string') {
      text += ' ' + attr.value;
    } else {
      text += ' ' + attr.value.expression;
    }
  }
  
  for (const child of node.children) {
    text += ' ' + collectTemplateText(child);
  }
  
  return text;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

const sourceRoot = path.resolve('vendor/cloudscape-source/src');
const componentDirs = findComponentDirs(sourceRoot);

console.log(`Found ${componentDirs.length} component directories\n`);

interface ComponentResult {
  name: string;
  dirName: string;
  preambleCount: number;
  statements: ClassifiedStatement[];
  error?: string;
}

const results: ComponentResult[] = [];
let totalSucceeded = 0;
let totalFailed = 0;

for (const dir of componentDirs) {
  const dirName = path.basename(dir);
  try {
    const ir = parseComponent(dir, { prefix: 'cs' });
    const transformed = transformAll(ir);

    const statements: ClassifiedStatement[] = [];
    const allPreambleVarsSoFar = new Set<string>();

    for (const stmt of transformed.bodyPreamble) {
      const classified = classifyStatement(stmt, transformed, allPreambleVarsSoFar);
      statements.push(classified);
      // Track declared vars for chain detection
      for (const v of classified.declaredVars) {
        allPreambleVarsSoFar.add(v);
      }
    }

    results.push({
      name: ir.name,
      dirName,
      preambleCount: transformed.bodyPreamble.length,
      statements,
    });
    totalSucceeded++;
  } catch (err) {
    results.push({
      name: dirName,
      dirName,
      preambleCount: 0,
      statements: [],
      error: (err as Error).message,
    });
    totalFailed++;
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

console.log('='.repeat(80));
console.log('BODY PREAMBLE ANALYSIS REPORT');
console.log('='.repeat(80));
console.log(`\nComponents processed: ${totalSucceeded} succeeded, ${totalFailed} failed out of ${componentDirs.length} total`);

if (totalFailed > 0) {
  console.log('\nFailed components:');
  for (const r of results.filter(r => r.error)) {
    console.log(`  - ${r.dirName}: ${r.error}`);
  }
}

// Aggregate stats
const allStatements = results.flatMap(r => r.statements);
const totalPreambleStatements = allStatements.length;
const componentsWithPreamble = results.filter(r => r.preambleCount > 0);
const componentsWithoutPreamble = results.filter(r => r.preambleCount === 0 && !r.error);

console.log(`\n${'─'.repeat(80)}`);
console.log('SUMMARY');
console.log('─'.repeat(80));
console.log(`Total preamble statements: ${totalPreambleStatements}`);
console.log(`Components with preamble: ${componentsWithPreamble.length}`);
console.log(`Components without preamble: ${componentsWithoutPreamble.length}`);

// Count per category
const categoryCounts: Record<Category, number> = {
  props_state_only: 0,
  external_functions: 0,
  chain_dependency: 0,
  conditional: 0,
  other: 0,
};
for (const s of allStatements) {
  categoryCounts[s.category]++;
}

console.log(`\n${'─'.repeat(80)}`);
console.log('CATEGORY BREAKDOWN');
console.log('─'.repeat(80));
console.log(`  Cat 1 - Variable decls referencing only props/state: ${categoryCounts.props_state_only}`);
console.log(`  Cat 2 - Variable decls referencing external functions: ${categoryCounts.external_functions}`);
console.log(`  Cat 3 - Variable decls referencing other preamble vars: ${categoryCounts.chain_dependency}`);
console.log(`  Cat 4 - Conditional statements: ${categoryCounts.conditional}`);
console.log(`  Cat 5 - Other: ${categoryCounts.other}`);

// Template reference stats (for cats 1-3)
const varDecls = allStatements.filter(s => ['props_state_only', 'external_functions', 'chain_dependency'].includes(s.category));
const referencedInTemplate = varDecls.filter(s => s.referencedInTemplate);
const notReferencedInTemplate = varDecls.filter(s => !s.referencedInTemplate);

console.log(`\n${'─'.repeat(80)}`);
console.log('TEMPLATE REFERENCE (for variable declarations, Cat 1-3)');
console.log('─'.repeat(80));
console.log(`  Total variable declarations: ${varDecls.length}`);
console.log(`  Referenced in template: ${referencedInTemplate.length}`);
console.log(`  NOT referenced in template: ${notReferencedInTemplate.length}`);

// Per-category template refs
for (const cat of ['props_state_only', 'external_functions', 'chain_dependency'] as Category[]) {
  const catStmts = allStatements.filter(s => s.category === cat);
  const catRefed = catStmts.filter(s => s.referencedInTemplate);
  console.log(`    ${cat}: ${catRefed.length}/${catStmts.length} referenced in template`);
}

// Top 10 external function dependencies
console.log(`\n${'─'.repeat(80)}`);
console.log('TOP 10 MOST COMMON EXTERNAL FUNCTION DEPENDENCIES');
console.log('─'.repeat(80));
const funcCounts = new Map<string, number>();
for (const s of allStatements) {
  for (const fn of s.externalFunctions) {
    funcCounts.set(fn, (funcCounts.get(fn) || 0) + 1);
  }
}
const topFuncs = [...funcCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [fn, count] of topFuncs) {
  console.log(`  ${count}x  ${fn}`);
}

// Top 10 most common variable names
console.log(`\n${'─'.repeat(80)}`);
console.log('TOP 10 MOST COMMON VARIABLE NAMES');
console.log('─'.repeat(80));
const varNameCounts = new Map<string, number>();
for (const s of allStatements) {
  for (const v of s.declaredVars) {
    varNameCounts.set(v, (varNameCounts.get(v) || 0) + 1);
  }
}
const topVars = [...varNameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [name, count] of topVars) {
  console.log(`  ${count}x  ${name}`);
}

// ---------------------------------------------------------------------------
// Per-component detail
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(80)}`);
console.log('PER-COMPONENT DETAILS');
console.log('─'.repeat(80));

// Sort by preamble count descending
const sorted = [...results].sort((a, b) => b.preambleCount - a.preambleCount);

for (const r of sorted) {
  if (r.error) {
    console.log(`\n[ERROR] ${r.dirName}: ${r.error}`);
    continue;
  }
  if (r.preambleCount === 0) continue;
  
  console.log(`\n── ${r.name} (${r.dirName}) ── ${r.preambleCount} statement(s)`);
  for (let i = 0; i < r.statements.length; i++) {
    const s = r.statements[i];
    const templateFlag = s.referencedInTemplate ? ' [IN_TEMPLATE]' : ' [NOT_IN_TEMPLATE]';
    const category = s.category.toUpperCase();
    const vars = s.declaredVars.length > 0 ? ` vars=[${s.declaredVars.join(', ')}]` : '';
    const funcs = s.externalFunctions.length > 0 ? ` calls=[${s.externalFunctions.join(', ')}]` : '';
    
    // Truncate text for display
    const displayText = s.text.length > 120 ? s.text.slice(0, 120) + '...' : s.text;
    console.log(`  [${i + 1}] ${category}${vars}${funcs}${templateFlag}`);
    console.log(`      ${displayText}`);
  }
}

// ---------------------------------------------------------------------------
// Full external functions list (all unique)
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(80)}`);
console.log('ALL EXTERNAL FUNCTION CALLS (complete list with counts)');
console.log('─'.repeat(80));
const allFuncsSorted = [...funcCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [fn, count] of allFuncsSorted) {
  console.log(`  ${count}x  ${fn}`);
}

// ---------------------------------------------------------------------------
// All unique variable names
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(80)}`);
console.log('ALL VARIABLE NAMES (complete list with counts)');
console.log('─'.repeat(80));
const allVarsSorted = [...varNameCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [name, count] of allVarsSorted) {
  console.log(`  ${count}x  ${name}`);
}

// ---------------------------------------------------------------------------
// Components without preamble
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(80)}`);
console.log('COMPONENTS WITHOUT PREAMBLE');
console.log('─'.repeat(80));
for (const r of componentsWithoutPreamble) {
  console.log(`  ${r.name} (${r.dirName})`);
}
