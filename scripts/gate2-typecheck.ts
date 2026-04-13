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
      const ir = parseComponent(path.join(CLOUDSCAPE_SRC, name), {});
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
import type { PropertyValues, CSSResultGroup } from 'lit';
export class CsBaseElement extends LitElement {
  static styles: CSSResultGroup;
  // ARIA properties that generated components override
  ariaLabel: string | null;
  ariaRequired: string | null;
  ariaDescribedby: string | null;
  ariaControls: string | null;
  ariaExpanded: string | null;
  ariaHaspopup: string | null;
  role: string | null;
  title: string;
  hidden: boolean;
  tabIndex: number;
  render(): unknown;
  connectedCallback(): void;
  disconnectedCallback(): void;
  willUpdate(changedProperties: PropertyValues): void;
  updated(changedProperties: PropertyValues): void;
  firstUpdated(changedProperties: PropertyValues): void;
}
`;

const EVENTS_STUB = `\
export declare function fireNonCancelableEvent(target: EventTarget, name: string, detail?: any, nativeEvent?: Event): void;
export declare function fireCancelableEvent(target: EventTarget, name: string, detail?: any, event?: Event): boolean;
export declare function isPlainLeftClick(event: MouseEvent): boolean;
export declare function hasModifierKeys(event: KeyboardEvent): boolean;
export type NonCancelableCustomEvent<T = any> = CustomEvent<T>;
export type BaseKeyDetail = { keyCode: number; key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };
export type BaseChangeDetail = { value: any };
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
export type FormFieldContext = FormFieldContextValue;
`;

const BUTTON_CONTEXT_STUB = `\
export declare const buttonContext: any;
export declare const defaultButtonContext: any;
export interface ButtonContextValue {
  [key: string]: any;
}
export type ButtonContext = ButtonContextValue;
`;

const INTERNAL_TYPES_STUB = `\
export type SomeRequired<Type, Keys extends keyof Type> = Type & {
  [Key in Keys]-?: Type[Key];
};
export default {} as any;
`;

const BASE_COMPONENT_STUB = `\
export interface BaseComponentProps {
  [key: string]: any;
}
export default {} as any;
`;

function makeStylesStub(): string {
  return `\
import type { CSSResult } from 'lit';
export declare const componentStyles: CSSResult;
export declare const sharedStyles: CSSResult;
`;
}

function makeInterfacesStub(componentName: string, namespaceMembersMap: Map<string, Set<string>>): string {
  const pascal = toPascalCase(componentName);
  const propsName = `${pascal}Props`;

  // Collect all namespace members needed for this component's Props namespace
  const members = namespaceMembersMap.get(propsName) ?? new Set<string>();

  // Always include common members as fallback
  const commonMembers = [
    'Type', 'Size', 'Variant', 'Status', 'Placement', 'Position',
    'Direction', 'Overflow', 'Step', 'Option', 'Item', 'Column',
    'Row', 'Node', 'Group', 'Tab', 'Link', 'Tag', 'Token', 'Page',
    'Message', 'Action', 'Selection', 'Filter', 'Preferences',
    'I18nStrings', 'ChangeDetail', 'DismissDetail', 'FollowDetail',
    'ClickDetail', 'SubmitDetail', 'SelectDetail',
    'ExpandableChangeDetail', 'FilteringChangeDetail',
    'PaginationChangeDetail', 'TextFilterChangeDetail',
    'PropertyFilterProps', 'Color', 'Ref',
  ];
  for (const m of commonMembers) {
    members.add(m);
  }

  // Build namespace body — all types are generic by default (safe: unused type params are ignored)
  const lines: string[] = [];
  for (const member of [...members].sort()) {
    if (member === 'ChangeDetail') {
      lines.push(`  type ${member}<T = any> = { value: any; [key: string]: any };`);
    } else {
      lines.push(`  type ${member}<T = any> = any;`);
    }
  }

  return `\
export interface ${propsName} {
  [key: string]: any;
}
export declare namespace ${propsName} {
${lines.join('\n')}
}
`;
}

// ---------------------------------------------------------------------------
// Scan generated output to discover all Props.Member namespace references
// ---------------------------------------------------------------------------

function scanNamespaceMembers(generated: GeneratedComponent[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  // Regex to find PascalCase namespace member access: e.g. ButtonProps.Ref, BoxProps.Color
  // Allow alphanumeric in namespace name to handle S3ResourceSelectorProps etc.
  const nsRegex = /\b([A-Z][A-Za-z0-9]*Props)\.([A-Z][A-Za-z]+)/g;

  for (const comp of generated) {
    if (comp.error || !comp.output) continue;
    let match: RegExpExecArray | null;
    while ((match = nsRegex.exec(comp.output)) !== null) {
      const [, ns, member] = match;
      if (!result.has(ns)) {
        result.set(ns, new Set());
      }
      result.get(ns)!.add(member);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scan generated output to discover all cross-component namespace references
// (namespaces used but NOT from the component's own interfaces)
// ---------------------------------------------------------------------------

function scanCrossComponentNamespaces(generated: GeneratedComponent[]): Map<string, Set<string>> {
  // Returns map: namespace name -> set of members used
  // Only includes namespaces that are used in components OTHER than the one defining them
  const allUsages = new Map<string, Set<string>>();
  const nsRegex = /\b([A-Z][A-Za-z0-9]*(?:Props|ListProps))\.([\w]+)/g;

  for (const comp of generated) {
    if (comp.error || !comp.output) continue;
    let match: RegExpExecArray | null;
    while ((match = nsRegex.exec(comp.output)) !== null) {
      const [, ns, member] = match;
      if (!allUsages.has(ns)) {
        allUsages.set(ns, new Set());
      }
      allUsages.get(ns)!.add(member);
    }
  }
  return allUsages;
}

// ---------------------------------------------------------------------------
// Build ambient declarations for cross-component types and other globals
// ---------------------------------------------------------------------------

function buildGlobalDeclarations(generated: GeneratedComponent[]): string {
  const crossNs = scanCrossComponentNamespaces(generated);

  // Also scan for other non-Props namespaces: Ace
  const otherNsRegex = /\b(Ace)\.([\w]+)/g;
  const aceMembers = new Set<string>();
  for (const comp of generated) {
    if (comp.error || !comp.output) continue;
    let match: RegExpExecArray | null;
    while ((match = otherNsRegex.exec(comp.output)) !== null) {
      aceMembers.add(match[2]);
    }
  }

  // Determine which namespaces are used cross-component (i.e. from a file that doesn't import them)
  const componentPropsByName = new Map<string, string>(); // compName -> PropsName
  for (const comp of generated) {
    if (comp.error) continue;
    componentPropsByName.set(comp.name, `${toPascalCase(comp.name)}Props`);
  }

  // For each namespace usage, check if any component uses it without importing it
  const crossComponentNs = new Map<string, Set<string>>();
  const nsRegex = /\b([A-Z][A-Za-z0-9]*(?:Props|ListProps))\.([\w]+)/g;
  for (const comp of generated) {
    if (comp.error || !comp.output) continue;
    const ownProps = componentPropsByName.get(comp.name)!;
    let match: RegExpExecArray | null;
    while ((match = nsRegex.exec(comp.output)) !== null) {
      const [, ns, member] = match;
      if (ns !== ownProps) {
        // Cross-component reference — this namespace needs to be globally available
        if (!crossComponentNs.has(ns)) {
          crossComponentNs.set(ns, new Set());
        }
        crossComponentNs.get(ns)!.add(member);
      }
    }
  }

  // Also check for NonCancelableCustomEvent usage
  let hasNonCancelableCustomEvent = false;
  for (const comp of generated) {
    if (comp.error || !comp.output) continue;
    if (comp.output.includes('NonCancelableCustomEvent')) {
      hasNonCancelableCustomEvent = true;
      break;
    }
  }

  // Build a pure ambient script file (no imports/exports = script, not module)
  // This makes all declarations globally available
  const lines: string[] = [
    '// Auto-generated ambient declarations for cross-component types',
    '// This file is a script (not a module) so all declarations are global.',
    '',
  ];

  // JSX namespace
  lines.push('declare namespace JSX {');
  lines.push('  interface IntrinsicElements { [elemName: string]: any; }');
  lines.push('}');

  // Ace namespace
  if (aceMembers.size > 0) {
    lines.push('');
    lines.push('declare namespace Ace {');
    for (const m of aceMembers) {
      lines.push(`  interface ${m} { [key: string]: any; }`);
    }
    lines.push('}');
  }

  // NonCancelableCustomEvent
  if (hasNonCancelableCustomEvent) {
    lines.push('');
    lines.push('type NonCancelableCustomEvent<T = any> = CustomEvent<T>;');
  }

  // Cross-component Props namespaces
  for (const [nsName, members] of crossComponentNs) {
    const allMembers = crossNs.get(nsName) ?? members;
    lines.push('');
    lines.push(`interface ${nsName} { [key: string]: any; }`);
    lines.push(`declare namespace ${nsName} {`);
    for (const member of [...allMembers].sort()) {
      lines.push(`  type ${member} = any;`);
    }
    lines.push('}');
  }

  // Scan generated output for undeclared type-like names (PascalCase) that
  // come from stripped imports. Declare them as ambient types to avoid TS2304.
  // Detect generic arity by scanning for Name<T, U> patterns.
  const allOutput = generated.map(g => g.output).join('\n');
  const missingTypes = new Map<string, number>(); // name → max generic arity
  // Broader scan: any PascalCase name in type positions
  const missingTypePattern = /(?:extends|implements|:|\||<|,)\s*([A-Z][a-z]\w*)(?:<([^>]*)>)?/g;
  let m: RegExpExecArray | null;
  const knownNames = new Set([
    'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'Element', 'Event',
    'EventTarget', 'Node', 'Document', 'Window', 'CustomEvent', 'FocusEvent',
    'KeyboardEvent', 'MouseEvent', 'PropertyValues', 'TemplateResult',
    'CSSResult', 'CSSResultGroup', 'LitElement', 'Map', 'Set', 'Array',
    'Record', 'Partial', 'Required', 'Readonly', 'Promise', 'Date',
    'RegExp', 'Error', 'Function', 'Object', 'Boolean', 'Number', 'String',
    'CsBaseElement', 'FormControlMixin', 'ControllableController',
    'Base', 'Type', 'Keys', 'Key',
  ]);
  const declaredText = lines.join('\n');
  while ((m = missingTypePattern.exec(allOutput)) !== null) {
    const name = m[1];
    if (!knownNames.has(name)) {
      if (!declaredText.includes(`declare type ${name}`) && !declaredText.includes(`declare interface ${name}`)) {
        const genericArgs = m[2];
        const arity = genericArgs ? genericArgs.split(',').length : 0;
        const current = missingTypes.get(name) ?? 0;
        missingTypes.set(name, Math.max(current, arity));
      }
    }
    // Also scan generic args for type names: ReadonlyArray<Series> → Series
    if (m[2]) {
      const innerPattern = /\b([A-Z][a-z]\w*)(?:<([^>]*)>)?/g;
      let inner: RegExpExecArray | null;
      while ((inner = innerPattern.exec(m[2])) !== null) {
        const innerName = inner[1];
        if (knownNames.has(innerName)) continue;
        if (declaredText.includes(`declare type ${innerName}`) || declaredText.includes(`declare interface ${innerName}`)) continue;
        const innerArity = inner[2] ? inner[2].split(',').length : 0;
        const current = missingTypes.get(innerName) ?? 0;
        missingTypes.set(innerName, Math.max(current, innerArity));
      }
    }
  }
  // Also do a direct scan for Name< patterns to detect generic type usage.
  // [^>]* doesn't handle nested <>, so just look for Name<anything to set arity >= 1.
  const genericUsagePattern = /\b([A-Z][a-z]\w*)<(?!\/)/g;
  while ((m = genericUsagePattern.exec(allOutput)) !== null) {
    const name = m[1];
    if (knownNames.has(name)) continue;
    const current = missingTypes.get(name) ?? 0;
    missingTypes.set(name, Math.max(current, 1));
  }
  if (missingTypes.size > 0) {
    lines.push('');
    lines.push('// Ambient type stubs for types from stripped imports');
    const typeParamNames = ['T', 'U', 'V', 'W'];
    for (const [name, arity] of [...missingTypes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (arity > 0) {
        const params = typeParamNames.slice(0, arity).map(p => `${p} = any`).join(', ');
        lines.push(`declare type ${name}<${params}> = any;`);
      } else {
        lines.push(`declare type ${name} = any;`);
      }
    }
  }

  return lines.join('\n') + '\n';
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

  // Scan all generated output to discover namespace members
  const namespaceMembersMap = scanNamespaceMembers(generated);

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

  // Internal types — preserve real SomeRequired definition to avoid `never` narrowing
  fs.writeFileSync(path.join(internalDir, 'types.d.ts'), INTERNAL_TYPES_STUB);
  fs.writeFileSync(path.join(internalDir, 'types.js'), '// stub\n');

  // Base component types
  const baseComponentDir = path.join(internalDir, 'base-component');
  fs.mkdirSync(baseComponentDir, { recursive: true });
  fs.writeFileSync(path.join(baseComponentDir, 'index.d.ts'), BASE_COMPONENT_STUB);
  fs.writeFileSync(path.join(baseComponentDir, 'index.js'), '// stub\n');

  // Write each component
  for (const comp of generated) {
    if (comp.error) continue; // skip generation failures

    const compDir = path.join(OUTPUT_DIR, comp.name);
    fs.mkdirSync(compDir, { recursive: true });

    // Write the generated component
    fs.writeFileSync(path.join(compDir, 'index.ts'), comp.output);

    // Write per-component stubs (with dynamically discovered namespace members)
    fs.writeFileSync(path.join(compDir, 'styles.d.ts'), makeStylesStub());
    fs.writeFileSync(path.join(compDir, 'styles.js'), '// stub\n');
    fs.writeFileSync(
      path.join(compDir, 'interfaces.d.ts'),
      makeInterfacesStub(comp.name, namespaceMembersMap),
    );
    fs.writeFileSync(path.join(compDir, 'interfaces.js'), '// stub\n');
  }

  // Build and write global ambient declarations for cross-component types
  const globalDecl = buildGlobalDeclarations(generated);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'global.d.ts'), globalDecl);

  // Auto-generate stubs for any imported modules that don't have declarations yet.
  // Scan all generated output for relative import paths and create catch-all .d.ts files.
  autoStubMissingModules(generated);

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
    exclude: [],
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Auto-stub missing modules
// ---------------------------------------------------------------------------

/**
 * Scan generated output for relative import paths and create catch-all
 * declaration stubs for any module that doesn't already have one.
 */
function autoStubMissingModules(generated: GeneratedComponent[]): void {
  // Scan for types used in type guard patterns (e.g., `t is TokenGroup`).
  // These types need interface stubs (not `= any`) so union narrowing works.
  const typeGuardTypes = new Set<string>();
  const typeGuardPattern = /\w+\s+is\s+([A-Z]\w+)/g;
  for (const comp of generated) {
    if (comp.error || !comp.output) continue;
    let tgMatch;
    while ((tgMatch = typeGuardPattern.exec(comp.output)) !== null) {
      typeGuardTypes.add(tgMatch[1]);
    }
  }
  // Also find types used in the same union as a type-guard type.
  // Pattern: (param: TypeA | TypeB): param is TypeA => ...
  // Both TypeA and TypeB need interface stubs for narrowing to work.
  const unionTypeGuardPattern = /\(\s*\w+\s*:\s*([A-Z]\w+(?:\s*\|\s*[A-Z]\w+)+)\s*\)\s*(?::\s*\w+\s+is\s+[A-Z]\w+\s*)?=>/g;
  for (const comp of generated) {
    if (comp.error || !comp.output) continue;
    let uMatch;
    while ((uMatch = unionTypeGuardPattern.exec(comp.output)) !== null) {
      const unionStr = uMatch[1];
      const types = unionStr.split('|').map(t => t.trim());
      if (types.some(t => typeGuardTypes.has(t))) {
        for (const t of types) {
          if (/^[A-Z]/.test(t)) typeGuardTypes.add(t);
        }
      }
    }
  }
  // Also scan for type annotations with union types involving type-guard types:
  // e.g., `tokenOrGroup: Token | TokenGroup`
  const typeAnnotationPattern = /:\s*([A-Z]\w+(?:\s*\|\s*[A-Z]\w+)+)/g;
  for (const comp of generated) {
    if (comp.error || !comp.output) continue;
    let taMatch;
    while ((taMatch = typeAnnotationPattern.exec(comp.output)) !== null) {
      const unionStr = taMatch[1];
      const types = unionStr.split('|').map(t => t.trim());
      if (types.some(t => typeGuardTypes.has(t))) {
        for (const t of types) {
          if (/^[A-Z]/.test(t)) typeGuardTypes.add(t);
        }
      }
    }
  }

  // Collect all relative import module specifiers and their named imports
  const importRegex = /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+))\s+from\s+'(\.[^']+)'/g;
  const neededModules = new Map<string, Set<string>>(); // resolved path → named imports

  for (const comp of generated) {
    if (comp.error || !comp.output) continue;
    let match;
    while ((match = importRegex.exec(comp.output)) !== null) {
      const [, namedStr, defaultName, specifier] = match;
      // Resolve from the component's directory
      const compDir = path.join(OUTPUT_DIR, comp.name);
      const resolved = path.resolve(compDir, specifier);
      const relToOutput = path.relative(OUTPUT_DIR, resolved);

      // Check if a .ts, .d.ts, or .js file exists for this module
      // Strip .js extension if present (bundler resolution)
      const baseRelPath = relToOutput.replace(/\.js$/, '');

      if (!neededModules.has(baseRelPath)) {
        neededModules.set(baseRelPath, new Set());
      }
      const names = neededModules.get(baseRelPath)!;
      if (namedStr) {
        for (const n of namedStr.split(',').map(s => s.trim()).filter(Boolean)) {
          // Handle 'Type as Alias' and 'type Name'
          const clean = n.replace(/^type\s+/, '').replace(/\s+as\s+\w+$/, '').trim();
          if (clean) names.add(clean);
        }
      }
      if (defaultName) names.add(defaultName);
    }

    // Also scan for <el-internal-xxx> custom element tags in templates.
    // These correspond to internal component imports that may have been
    // dropped by the import collector (e.g., when JSX was converted inline
    // and the original PascalCase identifier is no longer referenced).
    const tagRegex = /<el-internal-([\w-]+)/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(comp.output)) !== null) {
      const tagSuffix = tagMatch[1]; // e.g., "radio-button", "status-icon"
      const modulePath = `internal/components/${tagSuffix}`;
      if (!neededModules.has(modulePath)) {
        neededModules.set(modulePath, new Set());
      }
      // Derive PascalCase name from kebab-case tag for the named export
      const pascalName = tagSuffix
        .split('-')
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join('');
      neededModules.get(modulePath)!.add(pascalName);
    }
  }

  // Create stub declaration files
  for (const [modulePath, names] of neededModules) {
    const stubDir = path.join(OUTPUT_DIR, path.dirname(modulePath));
    fs.mkdirSync(stubDir, { recursive: true });

    const stubLines = [
      `// Auto-generated stub for ${modulePath}`,
    ];
    for (const name of [...names].sort()) {
      // Detect generic arity by scanning the output for Name<T, U, ...> patterns
      const genericArity = detectGenericArity(name, generated);

      // Declare as both value and type (covers classes, enums, type aliases, and constants).
      // Types used in type guards / union discrimination get interface stubs
      // with a unique brand property so TypeScript can structurally distinguish
      // them in unions (preventing narrowing to `never`).
      if (/^[A-Z]/.test(name)) {
        stubLines.push(`export declare const ${name}: any;`);
        const useInterface = typeGuardTypes.has(name);
        if (genericArity > 0) {
          const params = Array.from({ length: genericArity }, (_, i) =>
            `T${i > 0 ? i + 1 : ''} = any`,
          ).join(', ');
          if (useInterface) {
            stubLines.push(`export interface ${name}<${params}> { __brand?: '${name}'; [key: string]: any; }`);
          } else {
            stubLines.push(`export declare type ${name}<${params}> = any;`);
          }
        } else {
          if (useInterface) {
            stubLines.push(`export interface ${name} { __brand?: '${name}'; [key: string]: any; }`);
          } else {
            stubLines.push(`export declare type ${name} = any;`);
          }
        }
      } else {
        stubLines.push(`export declare const ${name}: any;`);
      }
    }
    // Catch-all for any other imports
    stubLines.push(`export default {} as any;`);

    const stubPath = path.join(OUTPUT_DIR, modulePath + '.d.ts');
    if (!fs.existsSync(stubPath)) {
      fs.writeFileSync(stubPath, stubLines.join('\n') + '\n');
      // Also write a .js file so module resolution works
      fs.writeFileSync(path.join(OUTPUT_DIR, modulePath + '.js'), '// stub\n');
    } else {
      // Append missing exports to existing stub file.
      // Check by exported name (not exact line) to avoid re-declaring
      // names that already have correct definitions.
      const existing = fs.readFileSync(stubPath, 'utf-8');
      const missingExports = stubLines.filter(line => {
        if (!line.startsWith('export')) return false;
        // Extract the exported name from the line
        const nameMatch = line.match(/export\s+declare\s+(?:const|type|function|class|interface)\s+(\w+)/);
        if (nameMatch) {
          // Check if this name is already exported in the existing file
          const name = nameMatch[1];
          const nameExported = new RegExp(`export\\s+(?:declare\\s+)?(?:const|type|function|class|interface)\\s+${name}\\b`).test(existing);
          if (nameExported) return false;
        }
        return !existing.includes(line);
      });
      if (missingExports.length > 0) {
        fs.appendFileSync(stubPath, '\n' + missingExports.join('\n') + '\n');
      }
    }
  }
}

/**
 * Detect the generic arity of a type name by scanning all generated output
 * for patterns like `Name<T>`, `Name<T, U>`, etc.
 * Returns the maximum number of type params found, or 0 if not generic.
 */
function detectGenericArity(name: string, generated: GeneratedComponent[]): number {
  const pattern = new RegExp(`\\b${name}<([^>]+)>`, 'g');
  let maxArity = 0;

  for (const comp of generated) {
    if (!comp.output) continue;
    let match;
    while ((match = pattern.exec(comp.output)) !== null) {
      // Count top-level commas in the generic params to determine arity
      const params = match[1];
      let depth = 0;
      let commas = 0;
      for (const ch of params) {
        if (ch === '<' || ch === '(' || ch === '{') depth++;
        else if (ch === '>' || ch === ')' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) commas++;
      }
      maxArity = Math.max(maxArity, commas + 1);
    }
  }

  return maxArity;
}

// ---------------------------------------------------------------------------
// Run tsc
// ---------------------------------------------------------------------------

interface TypeCheckResult {
  totalErrors: number;
  errorsByFile: Map<string, string[]>;
  rawOutput: string;
}

function runTypeCheck(generated: GeneratedComponent[]): TypeCheckResult {
  const tscPath = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsc');
  const errorsByFile = new Map<string, string[]>();
  let totalErrors = 0;
  let rawOutput = '';

  // Type-check each component individually to prevent error cascade.
  // Each invocation checks only that component's index.ts against the
  // shared stubs, types, and declarations in the output directory.
  for (const comp of generated) {
    if (comp.error) continue;

    const indexFile = path.join(comp.name, 'index.ts');
    const absIndex = path.join(OUTPUT_DIR, indexFile);
    if (!fs.existsSync(absIndex)) continue;

    let compOutput = '';
    try {
      compOutput = execSync(
        `"${tscPath}" --noEmit --strict false --skipLibCheck --experimentalDecorators ` +
        `--useDefineForClassFields false --target ES2022 --module ES2022 --moduleResolution bundler ` +
        `--lib ES2022,DOM,DOM.Iterable ` +
        `--paths '{"lit":["${path.join(PROJECT_ROOT, 'node_modules', 'lit')}"],"lit/*":["${path.join(PROJECT_ROOT, 'node_modules', 'lit', '*')}"],"@lit/context":["${path.join(PROJECT_ROOT, 'node_modules', '@lit', 'context')}"]}' ` +
        `"${absIndex}" 2>&1`,
        { cwd: OUTPUT_DIR, encoding: 'utf-8', timeout: 30_000 },
      );
    } catch (err: any) {
      compOutput = err.stdout || err.stderr || err.message || '';
    }

    if (compOutput.trim()) {
      rawOutput += compOutput;
      for (const line of compOutput.split('\n')) {
        const match = line.match(/^(.+?\.ts)\(\d+,\d+\):\s+error\s+(TS\d+):\s+(.+)$/);
        if (match) {
          const [, filePath, code, message] = match;
          const relPath = path.relative(OUTPUT_DIR, path.resolve(OUTPUT_DIR, filePath));
          if (!errorsByFile.has(relPath)) {
            errorsByFile.set(relPath, []);
          }
          errorsByFile.get(relPath)!.push(`${code}: ${message}`);
          totalErrors++;
        }
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
const typecheck = runTypeCheck(generated);
console.log('Done.\n');

report(components, generated, typecheck);

const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\nTotal runtime: ${elapsed}s`);
