#!/usr/bin/env node
import { Command } from 'commander';
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

const program = new Command();

program
  .name('react-to-lit')
  .description('Transpile React components to Lit web components')
  .version('0.1.0');

program
  .requiredOption('-p, --package <name>', 'npm package to discover components from (e.g. "@cloudscape-design/components")')
  .requiredOption('-s, --source <path>', 'Source directory containing component implementations')
  .requiredOption('-o, --output <path>', 'Output directory')
  .option('-c, --component <name>', 'Process a single component by name')
  .option('--dry-run', 'Print output to stdout instead of writing files')
  .option('--verbose', 'Log parsing decisions')
  .option('--preset <name>', 'Use a built-in preset (e.g. "cloudscape")')
  .option('--host-display <file>', 'Path to host display JSON map (from extract-host-display script)')
  .action(async (opts) => {
    const config = await loadConfig(undefined, opts.preset);
    const sourceRoot = path.resolve(opts.source);
    const outputRoot = path.resolve(opts.output);

    const analyzer = new PackageAnalyzer(opts.package);
    const discovered = discoverComponents(opts.package);
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

    const toProcess = opts.component
      ? componentEntries.filter(c => c.name === opts.component)
      : componentEntries;

    if (opts.component && toProcess.length === 0) {
      console.error(`Component '${opts.component}' not found in ${opts.package}`);
      process.exit(1);
    }

    let hostDisplayMap: Record<string, string | null> = {};
    if (opts.hostDisplay) {
      hostDisplayMap = JSON.parse(fs.readFileSync(path.resolve(opts.hostDisplay), 'utf-8'));
    }

    await processComponents(toProcess, outputRoot, opts, config, hostDisplayMap);
  });

program.parse();

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

async function processComponents(
  components: Array<{ name: string; dir: string; keepProps: Set<string>; classifiedProps: Map<string, ClassifiedProp>; passthroughProps: Set<string>; knownComponents: Set<string>; reactFrameworkAttributes: string[]; hookMappings: HookRegistry }>,
  outputRoot: string,
  opts: { dryRun?: boolean; verbose?: boolean },
  config: CompilerConfig,
  hostDisplayMap: Record<string, string | null> = {},
): Promise<void> {
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

      const output = emitComponent(transformed);

      if (opts.dryRun) {
        console.log(`\n=== ${name} ===`);
        console.log(output);
      } else {
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, output, 'utf-8');
        if (opts.verbose) {
          console.log(`✓ ${name} → ${outputFile}`);
        }
      }
      succeeded++;
    } catch (err) {
      failed++;
      const errMsg = (err as Error).message;
      failures.push({ name, error: errMsg });
      if (opts.verbose) {
        console.error(`✗ ${name}: ${errMsg}`);
      }
    }
  }

  console.log(`\nResults: ${succeeded} succeeded, ${failed} failed out of ${components.length} total`);

  if (failures.length > 0) {
    console.log('\nFailed components:');
    for (const f of failures) {
      console.log(`  ✗ ${f.name}: ${f.error}`);
    }
  }
}
