/**
 * Compiler configuration interfaces and factory functions.
 *
 * Defines the shape of a CompilerConfig object that controls every aspect
 * of the React → Lit transpilation pipeline: input resolution, output
 * naming, cleanup rules, component mapping, and event dispatch.
 */

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
    },
    events: {
      dispatchFunctions: {},
      dispatchMode: 'native',
    },
  };
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
