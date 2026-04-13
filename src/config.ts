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
export interface CompilerConfig {
  /** Settings that control how input source files are located and read. */
  input: InputConfig;
  /** Settings that control the shape of the generated Lit output. */
  output: OutputConfig;
  /** Rules for stripping React/infrastructure artefacts from the output. */
  cleanup: CleanupConfig;
  /** Component name → tag mapping and resolution strategy. */
  components: ComponentsConfig;
  /** Event dispatch configuration. */
  events: EventsConfig;
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
  /** Props to completely remove from generated components. */
  skipProps: string[];
  /** Prop name prefixes indicating internal infrastructure. */
  skipPrefixes: string[];
  /** Template attributes to strip. */
  removeAttributes: string[];
  /** Attribute prefixes to strip. */
  removeAttributePrefixes: string[];
  /** Infrastructure function names to strip. */
  infraFunctions: string[];
  /** Component names to unwrap (keep children, discard wrapper). */
  unwrapComponents: string[];
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
      skipProps: [],
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
  };
}

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

export interface PackageComponent {
  name: string;
  dir: string;
}

/**
 * Discover public components from an npm package's barrel export.
 *
 * Reads the package's index.d.ts and extracts every default export,
 * each of which is a React component.
 */
export function discoverComponents(packageName: string): PackageComponent[] {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  const pkgRoot = path.dirname(pkgJsonPath);

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const mainEntry = pkgJson.main ?? pkgJson.module ?? './index.js';
  const dtsPath = path.join(pkgRoot, mainEntry.replace(/\.js$/, '.d.ts'));

  const { statements } = ts.createSourceFile(
    dtsPath, readFileSync(dtsPath, 'utf-8'), ts.ScriptTarget.Latest, true,
  );

  const components: PackageComponent[] = [];

  for (const statement of statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;

    const dir = statement.moduleSpecifier.text;

    for (const specifier of statement.exportClause.elements) {
      if (specifier.propertyName?.text === 'default') {
        components.push({ name: specifier.name.text, dir });
        break;
      }
    }
  }

  return components;
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
