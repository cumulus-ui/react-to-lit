#!/usr/bin/env node
/**
 * Gate 2: TypeScript type-check on generated Lit component output.
 *
 * Generates all Cloudscape components via the transpiler, writes them
 * to a temp directory with stub declaration files for internal imports,
 * then runs `tsc --noEmit` to find type errors.
 *
 * Usage: npx tsx scripts/gate2-typecheck.ts
 */
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { parseComponent } from '../src/parser/index.js';
import { transformAll } from '../src/transforms/index.js';
import { emitComponent } from '../src/emitter/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const CLOUDSCAPE_SRC = path.resolve(PROJECT_ROOT, 'vendor/cloudscape-source/src');
const OUTPUT_DIR = path.resolve(PROJECT_ROOT, '.gate2-output');

const SKIP_DIRS = new Set([
  '__a11y__', '__integ__', '__tests__', '__motion__',
  'internal', 'contexts', 'i18n', 'interfaces.ts',
  'test-utils', 'theming', 'node_modules', 'plugins',
]);

// ---------------------------------------------------------------------------
// Component discovery (same logic as batch.test.ts)
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
// Pascal-case helper
// ---------------------------------------------------------------------------

function toPascalCase(kebab: string): string {
  return kebab.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// ---------------------------------------------------------------------------
// Generate all components
// ---------------------------------------------------------------------------

interface GeneratedComponent {
  name: string;
  output: string;
  error?: string;
}

function generateAll(components: string[]): GeneratedComponent[] {
  const results: GeneratedComponent[] = [];
  for (const name of components) {
    try {
      const ir = parseComponent(path.join(CLOUDSCAPE_SRC, name), { prefix: 'cs' });
      const transformed = transformAll(ir);
      const output = emitComponent(transformed);
      results.push({ name, output });
    } catch (err) {
      results.push({ name, output: '', error: (err as Error).message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Stub declarations
// ---------------------------------------------------------------------------

const BASE_ELEMENT_STUB = `\
import { LitElement } from 'lit';
export class CsBaseElement extends LitElement {
  [key: string]: any;
}
`;

const EVENTS_STUB = `\
export declare function fireNonCancelableEvent(target: EventTarget, name: string, detail?: any): void;
export declare function fireCancelableEvent(target: EventTarget, name: string, detail?: any, event?: Event): boolean;
`;

const FORM_CONTROL_MIXIN_STUB = `\
import type { LitElement } from 'lit';
type Constructor<T = {}> = new (...args: any[]) => T;
export declare function FormControlMixin<T extends Constructor<LitElement>>(base: T): T;
`;

const CONTROLLABLE_STUB = `\
import type { ReactiveController, ReactiveControllerHost } from 'lit';
export declare class ControllableController implements ReactiveController {
  constructor(host: ReactiveControllerHost, ...args: any[]);
  hostConnected(): void;
  hostDisconnected(): void;
  [key: string]: any;
}
`;

const FORM_FIELD_CONTEXT_STUB = `\
export declare const formFieldContext: any;
export declare const defaultFormFieldContext: any;
export interface FormFieldContextValue {
  [key: string]: any;
}
`;

const BUTTON_CONTEXT_STUB = `\
export declare const buttonContext: any;
export declare const defaultButtonContext: any;
export interface ButtonContextValue {
  [key: string]: any;
}
`;

function makeStylesStub(): string {
  return `\
import type { CSSResult } from 'lit';
export declare const componentStyles: CSSResult;
export declare const sharedStyles: CSSResult;
`;
}

function makeInterfacesStub(componentName: string): string {
  const pascal = toPascalCase(componentName);
  return `\
export interface ${pascal}Props {
  [key: string]: any;
}
export declare namespace ${pascal}Props {
  type Type = string;
  type Size = string;
  type Variant = string;
  type Status = string;
  type Placement = string;
  type Position = string;
  type Direction = string;
  type Overflow = string;
  type Step = any;
  type Option = any;
  type Item = any;
  type Column = any;
  type Row = any;
  type Node = any;
  type Group = any;
  type Tab = any;
  type Link = any;
  type Tag = any;
  type Token = any;
  type Page = any;
  type Message = any;
  type Action = any;
  type Selection = any;
  type Filter = any;
  type SortingState<T = any> = any;
  type Preferences = any;
  type I18nStrings = any;
  type Definition<T = any> = any;
  type ChangeDetail = { value: any; [key: string]: any };
  type DismissDetail = any;
  type FollowDetail = any;
  type ClickDetail = any;
  type SubmitDetail = any;
  type SelectDetail = any;
  type ExpandableChangeDetail = any;
  type FilteringChangeDetail = any;
  type PaginationChangeDetail = any;
  type SortingChangeDetail<T = any> = any;
  type TextFilterChangeDetail = any;
  type PropertyFilterProps = any;
}
`;
}

// ---------------------------------------------------------------------------
// Write output tree
// ---------------------------------------------------------------------------

function writeOutputTree(generated: GeneratedComponent[]): void {
  // Clean and recreate
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Create internal stubs
  const internalDir = path.join(OUTPUT_DIR, 'internal');
  fs.mkdirSync(internalDir, { recursive: true });
  fs.writeFileSync(path.join(internalDir, 'base-element.d.ts'), BASE_ELEMENT_STUB);
  fs.writeFileSync(path.join(internalDir, 'base-element.js'), '// stub\n');
  fs.writeFileSync(path.join(internalDir, 'events.d.ts'), EVENTS_STUB);
  fs.writeFileSync(path.join(internalDir, 'events.js'), '// stub\n');

  const mixinsDir = path.join(internalDir, 'mixins');
  fs.mkdirSync(mixinsDir, { recursive: true });
  fs.writeFileSync(path.join(mixinsDir, 'form-control.d.ts'), FORM_CONTROL_MIXIN_STUB);
  fs.writeFileSync(path.join(mixinsDir, 'form-control.js'), '// stub\n');

  const controllersDir = path.join(internalDir, 'controllers');
  fs.mkdirSync(controllersDir, { recursive: true });
  fs.writeFileSync(path.join(controllersDir, 'controllable.d.ts'), CONTROLLABLE_STUB);
  fs.writeFileSync(path.join(controllersDir, 'controllable.js'), '// stub\n');

  const contextDir = path.join(internalDir, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, 'form-field-context.d.ts'), FORM_FIELD_CONTEXT_STUB);
  fs.writeFileSync(path.join(contextDir, 'form-field-context.js'), '// stub\n');
  fs.writeFileSync(path.join(contextDir, 'button-context.d.ts'), BUTTON_CONTEXT_STUB);
  fs.writeFileSync(path.join(contextDir, 'button-context.js'), '// stub\n');

  // Write each component
  for (const comp of generated) {
    if (comp.error) continue; // skip generation failures

    const compDir = path.join(OUTPUT_DIR, comp.name);
    fs.mkdirSync(compDir, { recursive: true });

    // Write the generated component
    fs.writeFileSync(path.join(compDir, 'index.ts'), comp.output);

    // Write per-component stubs
    fs.writeFileSync(path.join(compDir, 'styles.d.ts'), makeStylesStub());
    fs.writeFileSync(path.join(compDir, 'styles.js'), '// stub\n');
    fs.writeFileSync(path.join(compDir, 'interfaces.d.ts'), makeInterfacesStub(comp.name));
    fs.writeFileSync(path.join(compDir, 'interfaces.js'), '// stub\n');
  }

  // Write tsconfig.json for the output directory
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'bundler',
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      experimentalDecorators: true,
      useDefineForClassFields: false,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      typeRoots: [path.join(PROJECT_ROOT, 'node_modules', '@types')],
      paths: {
        'lit': [path.join(PROJECT_ROOT, 'node_modules', 'lit')],
        'lit/*': [path.join(PROJECT_ROOT, 'node_modules', 'lit', '*')],
        '@lit/context': [path.join(PROJECT_ROOT, 'node_modules', '@lit', 'context')],
      },
    },
    include: ['**/*.ts'],
    exclude: ['**/*.d.ts'],
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Run tsc
// ---------------------------------------------------------------------------

interface TypeCheckResult {
  totalErrors: number;
  errorsByFile: Map<string, string[]>;
  rawOutput: string;
}

function runTypeCheck(): TypeCheckResult {
  const tscPath = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsc');
  const tsconfigPath = path.join(OUTPUT_DIR, 'tsconfig.json');

  let rawOutput = '';
  try {
    execSync(`"${tscPath}" --project "${tsconfigPath}" --noEmit 2>&1`, {
      cwd: OUTPUT_DIR,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    // If tsc exits 0, no errors
    rawOutput = '';
  } catch (err: any) {
    rawOutput = err.stdout || err.stderr || err.message || '';
  }

  // Parse errors
  const errorsByFile = new Map<string, string[]>();
  let totalErrors = 0;

  if (rawOutput.trim()) {
    for (const line of rawOutput.split('\n')) {
      // tsc error format: path/file.ts(line,col): error TS1234: message
      const match = line.match(/^(.+?\.ts)\(\d+,\d+\):\s+error\s+(TS\d+):\s+(.+)$/);
      if (match) {
        const [, filePath, code, message] = match;
        // Normalize to just component name
        const relPath = path.relative(OUTPUT_DIR, path.resolve(OUTPUT_DIR, filePath));
        if (!errorsByFile.has(relPath)) {
          errorsByFile.set(relPath, []);
        }
        errorsByFile.get(relPath)!.push(`${code}: ${message}`);
        totalErrors++;
      }
    }
  }

  return { totalErrors, errorsByFile, rawOutput };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(
  components: string[],
  generated: GeneratedComponent[],
  typecheck: TypeCheckResult,
): void {
  const genSuccess = generated.filter((g) => !g.error);
  const genFail = generated.filter((g) => !!g.error);

  // Determine which components have type errors
  const componentsWithErrors = new Set<string>();
  for (const [filePath] of typecheck.errorsByFile) {
    // filePath looks like "alert/index.ts"
    const compName = filePath.split('/')[0];
    if (compName && compName !== 'internal') {
      componentsWithErrors.add(compName);
    }
  }

  const typeClean = genSuccess.filter((g) => !componentsWithErrors.has(g.name));
  const typeFail = genSuccess.filter((g) => componentsWithErrors.has(g.name));

  console.log('=== Gate 2: TypeScript Type-Check ===\n');
  console.log(`Total components:       ${components.length}`);
  console.log(`Generation succeeded:   ${genSuccess.length}/${components.length}`);
  if (genFail.length > 0) {
    console.log(`Generation failed:      ${genFail.length} (${genFail.map((g) => g.name).join(', ')})`);
  }
  console.log(`Type-check clean:       ${typeClean.length}/${components.length}`);
  console.log(`Type-check errors:      ${typeFail.length}`);
  console.log(`Total tsc errors:       ${typecheck.totalErrors}\n`);

  // --- Error categorization ---
  if (typecheck.totalErrors > 0) {
    // Count error codes
    const errorCodes = new Map<string, { count: number; message: string; components: Set<string> }>();
    for (const [filePath, errors] of typecheck.errorsByFile) {
      const compName = filePath.split('/')[0];
      for (const err of errors) {
        const codeMatch = err.match(/^(TS\d+):\s+(.+)$/);
        if (codeMatch) {
          const [, code, message] = codeMatch;
          if (!errorCodes.has(code)) {
            errorCodes.set(code, { count: 0, message: '', components: new Set() });
          }
          const entry = errorCodes.get(code)!;
          entry.count++;
          entry.message = message; // keep last message as example
          entry.components.add(compName);
        }
      }
    }

    // Sort by frequency
    const sorted = [...errorCodes.entries()].sort((a, b) => b[1].count - a[1].count);

    console.log('--- Error Breakdown by TS Error Code ---');
    for (const [code, info] of sorted) {
      console.log(`  ${code} (${info.count}x, ${info.components.size} components): ${info.message.slice(0, 100)}`);
    }
    console.log('');

    // Per-component error counts
    console.log('--- Per-Component Errors ---');
    const compErrors: Array<{ name: string; count: number }> = [];
    for (const comp of typeFail) {
      let count = 0;
      for (const [filePath, errors] of typecheck.errorsByFile) {
        if (filePath.startsWith(comp.name + '/')) {
          count += errors.length;
        }
      }
      compErrors.push({ name: comp.name, count });
    }
    compErrors.sort((a, b) => b.count - a.count);
    for (const { name, count } of compErrors) {
      console.log(`  ✗ ${name}: ${count} error(s)`);
    }
    console.log('');
  }

  // --- Clean components ---
  console.log(`--- Clean Components (${typeClean.length}) ---`);
  for (const comp of typeClean) {
    console.log(`  ✓ ${comp.name}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const t0 = performance.now();

console.log('Discovering components...');
const components = findComponentDirs();
console.log(`Found ${components.length} components.\n`);

console.log('Generating Lit output...');
const generated = generateAll(components);
const genOk = generated.filter((g) => !g.error).length;
console.log(`Generated ${genOk}/${components.length} successfully.\n`);

console.log('Writing output tree to .gate2-output/ ...');
writeOutputTree(generated);
console.log('Done.\n');

console.log('Running tsc --noEmit ...');
const typecheck = runTypeCheck();
console.log('Done.\n');

report(components, generated, typecheck);

const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\nTotal runtime: ${elapsed}s`);
