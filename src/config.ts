/**
 * Compiler configuration interfaces and factory functions.
 *
 * Defines the shape of a CompilerConfig object that controls every aspect
 * of the React → Lit transpilation pipeline: input resolution, output
 * naming, cleanup rules, component mapping, and event dispatch.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Top-level configuration for the React → Lit compiler. */
import type { HookRegistry } from './hooks/registry.js';

export interface CompilerConfig {
  input: InputConfig;
  output: OutputConfig;
  cleanup: CleanupConfig;
  components: ComponentsConfig;
  events: EventsConfig;
  hooks: HookRegistry;
}

/** Controls how input source files are located and read. */
export interface InputConfig {
  /** Package name for published declaration files (e.g., '@cloudscape-design/components'). */
  declarationsPackage?: string;
  /** Directory names to skip during batch processing. */
  skipDirectories?: string[];
}

/** Controls the shape of the generated Lit output. */
export interface OutputConfig {
  /** Base class for generated components. */
  baseClass: { name: string; import: string };
  /** Class name prefix (e.g., 'Cs'). */
  classPrefix: string;
  /** Class name suffix (e.g., 'Internal'). */
  classSuffix: string;
  /** Custom element tag prefix (e.g., 'el-'). */
  tagPrefix: string;
  /** File extension for imports (e.g., '.js'). */
  importExtension: string;
}

/** Rules for stripping React/infrastructure artefacts from the output. */
export interface CleanupConfig {
  skipPrefixes: string[];
  removeAttributes: string[];
  removeAttributePrefixes: string[];
  infraFunctions: string[];
  /** Component names to unwrap (keep children, discard wrapper). */
  unwrapComponents: string[];
  /** JSDoc tag names whose props should be skipped (e.g., ['awsuiSystem']). */
  skipJsDocTags?: string[];
}

/** Component name → tag mapping and resolution strategy. */
export interface ComponentsConfig {
  /** Map of React component name → custom element tag or '__UNWRAP__'. */
  registry: Record<string, string | '__UNWRAP__'>;
  /** Whether to auto-derive tag from PascalCase for unknown components. */
  autoDerive: boolean;
  /** Prefixes to strip from component function names (e.g., ['Internal']). */
  stripPrefixes: string[];
}

/** Event dispatch configuration. */
export interface EventsConfig {
  /** Map of dispatch function name → config. */
  dispatchFunctions: Record<string, { import: string; cancelable: boolean }>;
  /** How events are dispatched: 'helper' uses imported functions, 'native' uses this.dispatchEvent. */
  dispatchMode: 'helper' | 'native';
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

/**
 * Create a sensible zero-config default configuration.
 *
 * React builtins are unwrapped, `__` prefixes are skipped, and events
 * use native `this.dispatchEvent`.
 */
export function createDefaultConfig(): CompilerConfig {
  return {
    input: {
      declarationsPackage: undefined,
      skipDirectories: [],
    },
    output: {
      baseClass: { name: 'LitElement', import: 'lit' },
      classPrefix: '',
      classSuffix: '',
      tagPrefix: 'el-',
      importExtension: '.js',
    },
    cleanup: {
      skipPrefixes: ['__'],
      removeAttributes: ['key', 'ref'],
      removeAttributePrefixes: ['__'],
      infraFunctions: [],
      unwrapComponents: [
        'Fragment',
        'React.Fragment',
        'Suspense',
        'StrictMode',
        'Profiler',
      ],
      skipJsDocTags: [],
    },
    components: {
      registry: {},
      autoDerive: true,
      stripPrefixes: [],
    },
    events: {
      dispatchFunctions: {},
      dispatchMode: 'native',
    },
    hooks: {},
  };
}

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

export interface PackageComponent {
  name: string;
  dir: string;
  propsType?: string;
  propsFile?: string;
}

/**
 * Discover public components from an npm package's barrel export.
 *
 * Uses the TypeScript type checker (with @types/react in scope) to
 * resolve each export, determine if it's a React component, and
 * extract its props type and source file from the type graph.
 */
export function discoverComponents(packageName: string): PackageComponent[] {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  const pkgRoot = path.dirname(pkgJsonPath);

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const mainEntry = pkgJson.main ?? pkgJson.module ?? './index.js';
  const dtsPath = path.join(pkgRoot, mainEntry.replace(/\.js$/, '.d.ts'));

  const program = ts.createProgram([dtsPath], {
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: pkgRoot,
  });

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(dtsPath);
  if (!sourceFile) return [];

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];

  const exports = checker.getExportsOfModule(moduleSymbol);
  const components: PackageComponent[] = [];

  for (const sym of exports) {
    const resolved = sym.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(sym)
      : sym;

    const type = checker.getTypeOfSymbol(resolved);
    const callSignatures = type.getCallSignatures();
    if (!callSignatures.length) continue;

    const firstParam = callSignatures[0].getParameters()[0];
    if (!firstParam) continue;

    const returnType = callSignatures[0].getReturnType();
    if (!isJsxReturnType(returnType, checker)) continue;

    const dir = resolveExportDir(sym, sourceFile);
    if (!dir) continue;

    const paramType = checker.getTypeOfSymbol(firstParam);
    const component: PackageComponent = { name: sym.name, dir };

    const propsSymbol = resolvePropsSymbol(paramType);
    if (propsSymbol) {
      component.propsType = propsSymbol.getName();
      const declarations = propsSymbol.getDeclarations();
      if (declarations?.length) {
        component.propsFile = declarations[0].getSourceFile().fileName;
      }
    }

    components.push(component);
  }

  return components;
}

function isJsxReturnType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const typeName = checker.typeToString(type);
  return typeName.includes('Element') || typeName.includes('ReactNode');
}

function resolveExportDir(sym: ts.Symbol, barrelFile: ts.SourceFile): string | undefined {
  for (const statement of barrelFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;

    for (const specifier of statement.exportClause.elements) {
      if (specifier.name.text === sym.name) {
        return statement.moduleSpecifier.text;
      }
    }
  }
  return undefined;
}

function resolvePropsSymbol(paramType: ts.Type): ts.Symbol | undefined {
  const direct = paramType.aliasSymbol ?? paramType.getSymbol?.();
  if (direct && direct.getName() !== '__type') return direct;

  // Intersection: Props & RefAttributes<...> → find the non-React member
  if (paramType.isIntersection()) {
    for (const member of paramType.types) {
      const sym = member.aliasSymbol ?? member.getSymbol?.();
      if (!sym) continue;
      const name = sym.getName();
      if (name !== '__type' && name !== 'RefAttributes') return sym;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Cloudscape preset (convenience re-export)
// ---------------------------------------------------------------------------

/**
 * Create a CompilerConfig pre-populated with Cloudscape design-system values.
 *
 * This is a convenience re-export of `createCloudscapeConfig` from the
 * `presets/cloudscape` module.
 */
export { createCloudscapeConfig } from './presets/cloudscape.js';
