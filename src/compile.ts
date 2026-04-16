/**
 * Programmatic API for react-to-lit compilation.
 *
 * Extracts the full compilation pipeline (discover, classify, parse,
 * transform, emit) into a single `compile()` function that can be
 * called from the CLI, scripts, or other tooling.
 */

import path from 'node:path';
import fs from 'node:fs';
import { parseComponent } from './parser/index.js';
import { transformAll } from './transforms/index.js';
import { emitComponent } from './emitter/index.js';
import { discoverComponents } from './config.js';
import { PackageAnalyzer } from './package-analyzer.js';
import { loadConfig } from './config-loader.js';
import type { CompilerConfig } from './config.js';
import type { HookRegistry } from './hooks/registry.js';
import type { ClassifiedProp } from './package-analyzer.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompileOptions {
  /** npm package name for type discovery (e.g. "@cloudscape-design/components") */
  package: string;
  /** Path to React source directory */
  source: string;
  /** Output directory (default: './dist') */
  output?: string;
  /** Preset name (e.g. 'cloudscape') */
  preset?: string;
  /** Process single component by name */
  component?: string;
  /** Print output instead of writing files */
  dryRun?: boolean;
  /** Log parsing decisions */
  verbose?: boolean;
  /** Path to host display JSON map (optional -- auto-detected if not provided) */
  hostDisplay?: string;
}

export interface CompileResult {
  succeeded: number;
  failed: number;
  total: number;
  failures: Array<{ name: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Main compile function
// ---------------------------------------------------------------------------

export async function compile(options: CompileOptions): Promise<CompileResult> {
  const output = options.output ?? './dist';
  const config = await loadConfig(undefined, options.preset);
  const sourceRoot = path.resolve(options.source);
  const outputRoot = path.resolve(output);

  const analyzer = new PackageAnalyzer(options.package);
  const discovered = discoverComponents(options.package);
  const knownComponents = new Set(discovered.map(c => c.name));
  const reactFrameworkAttributes = analyzer.getReactFrameworkAttributes();

  const componentEntries = discovered.map(c => {
    const keepProps = new Set<string>();
    let classifiedProps = new Map<string, ClassifiedProp>();

    if (c.propsType && c.propsFile) {
      const propsType = analyzer.getPropsType(c.propsType, c.propsFile);
      if (propsType) {
        for (const prop of propsType.getProperties()) {
          keepProps.add(prop.name);
        }
        classifiedProps = analyzer.classifyAllProps(propsType);
      }
    }

    const skipTags = config.cleanup?.skipJsDocTags ?? [];
    const passthroughProps = new Set<string>();
    for (const [name, classified] of classifiedProps) {
      if (classified.classification === 'passthrough') passthroughProps.add(name);
      if (skipTags.length > 0 && classified.jsDocTags.some(tag => skipTags.includes(tag))) {
        passthroughProps.add(name);
      }
    }

    return {
      name: c.name,
      dir: path.resolve(sourceRoot, c.dir.replace(/^\.\//, '')),
      keepProps,
      classifiedProps,
      passthroughProps,
      knownComponents,
      reactFrameworkAttributes,
      hookMappings: config.hooks,
    };
  });

  const toProcess = options.component
    ? componentEntries.filter(c => c.name === options.component)
    : componentEntries;

  if (options.component && toProcess.length === 0) {
    return { succeeded: 0, failed: 1, total: 1, failures: [{ name: options.component, error: `Component '${options.component}' not found in ${options.package}` }] };
  }

  // Resolve host display map: explicit path > auto-detect next to source > empty
  let hostDisplayMap: Record<string, string | null> = {};
  if (options.hostDisplay) {
    hostDisplayMap = JSON.parse(fs.readFileSync(path.resolve(options.hostDisplay), 'utf-8'));
  } else {
    const autoPath = path.resolve(sourceRoot, '..', 'host-display.json');
    if (fs.existsSync(autoPath)) {
      hostDisplayMap = JSON.parse(fs.readFileSync(autoPath, 'utf-8'));
    }
  }

  return processComponents(toProcess, outputRoot, options, config, hostDisplayMap);
}

// ---------------------------------------------------------------------------
// Internal processing
// ---------------------------------------------------------------------------

function processComponents(
  components: Array<{ name: string; dir: string; keepProps: Set<string>; classifiedProps: Map<string, ClassifiedProp>; passthroughProps: Set<string>; knownComponents: Set<string>; reactFrameworkAttributes: string[]; hookMappings: HookRegistry }>,
  outputRoot: string,
  opts: { dryRun?: boolean; verbose?: boolean },
  config: CompilerConfig,
  hostDisplayMap: Record<string, string | null> = {},
): CompileResult {
  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ name: string; error: string }> = [];

  for (const { name, dir, keepProps, classifiedProps, passthroughProps, knownComponents, reactFrameworkAttributes, hookMappings } of components) {
    const outputFile = path.join(outputRoot, path.basename(dir), 'index.ts');

    try {
      const ir = parseComponent(dir, { keepProps, knownComponents, reactFrameworkAttributes, hookMappings });

      for (const prop of ir.props) {
        const classified = classifiedProps.get(prop.name);
        if (classified?.deprecated) prop.deprecated = true;
        if (classified?.optional) prop.optional = true;
      }

      // Extend removeAttributes with passthrough/system-tagged prop names so template bindings are stripped
      const componentConfig = passthroughProps.size > 0
        ? {
            ...config,
            cleanup: {
              ...config.cleanup,
              removeAttributes: [...(config.cleanup?.removeAttributes ?? []), ...passthroughProps],
            },
          }
        : config;
      const transformed = transformAll(ir, { knownComponents, config: componentConfig, skipProps: passthroughProps });

      const display = hostDisplayMap[name];
      if (display) transformed.hostDisplay = display;

      const output = emitComponent(transformed, { output: config.output });

      if (opts.dryRun) {
        console.log(`\n=== ${name} ===`);
        console.log(output);
      } else {
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, output, 'utf-8');
        if (opts.verbose) {
          console.log(`\u2713 ${name} \u2192 ${outputFile}`);
        }
      }
      succeeded++;
    } catch (err) {
      failed++;
      const errMsg = (err as Error).message;
      failures.push({ name, error: errMsg });
      if (opts.verbose) {
        console.error(`\u2717 ${name}: ${errMsg}`);
      }
    }
  }

  return { succeeded, failed, total: components.length, failures };
}
