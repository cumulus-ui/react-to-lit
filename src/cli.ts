#!/usr/bin/env node
/**
 * CLI entry point for react-to-lit transpiler.
 *
 * Usage:
 *   npx react-to-lit --input vendor/cloudscape-source/src/badge --output src/badge/internal.ts
 *   npx react-to-lit --input vendor/cloudscape-source/src --output src --batch
 */
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { parseComponent } from './parser/index.js';
import { transformAll } from './transforms/index.js';
import { emitComponent } from './emitter/index.js';

/** Directories to skip (not components) */
const SKIP_DIRS = new Set([
  '__a11y__',
  '__integ__',
  '__tests__',
  '__motion__',
  'internal',
  'contexts',
  'i18n',
  'interfaces.ts',
  'test-utils',
  'theming',
  'node_modules',
  'plugins',
]);

const program = new Command();

program
  .name('react-to-lit')
  .description('Transpile React components to Lit web components')
  .version('0.1.0');

program
  .option('-i, --input <path>', 'Input directory (component dir or source root)')
  .option('-o, --output <path>', 'Output directory or file')
  .option('-b, --batch', 'Batch mode: process all components in input directory')
  .option('-c, --component <name>', 'Process a single component from batch input')
  .option('--dry-run', 'Print output to stdout instead of writing files')
  .option('--verbose', 'Log parsing decisions')
  .action(async (opts) => {
    const inputPath = path.resolve(opts.input);
    const outputPath = opts.output ? path.resolve(opts.output) : undefined;

    if (opts.batch) {
      // Batch mode requires --output
      if (!outputPath) {
        console.error('Error: --output is required in batch mode');
        process.exit(1);
      }

      // Batch mode: process all component directories
      const components = findComponentDirs(inputPath);

      if (opts.component) {
        // Filter to single component
        const filtered = components.filter((c) => path.basename(c) === opts.component);
        if (filtered.length === 0) {
          console.error(`Component '${opts.component}' not found in ${inputPath}`);
          process.exit(1);
        }
        await processComponents(filtered, outputPath, opts);
      } else {
        await processComponents(components, outputPath, opts);
      }
    } else {
      // Single component mode
      await processSingle(inputPath, outputPath, opts);
    }
  });

program.parse();

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

async function processSingle(
  inputPath: string,
  outputPath: string | undefined,
  opts: { dryRun?: boolean; verbose?: boolean },
): Promise<void> {
  try {
    const ir = parseComponent(inputPath);
    const transformed = transformAll(ir);
    const output = emitComponent(transformed);

    if (opts.dryRun || !outputPath) {
      console.log(output);
    } else {
      const dir = path.dirname(outputPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, output, 'utf-8');
      console.log(`✓ ${ir.name} → ${outputPath}`);
    }
  } catch (err) {
    console.error(`✗ Failed to process ${inputPath}:`, (err as Error).message);
    if (opts.verbose) console.error(err);
    process.exit(1);
  }
}

async function processComponents(
  componentDirs: string[],
  outputRoot: string,
  opts: { dryRun?: boolean; verbose?: boolean },
): Promise<void> {
  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ name: string; error: string }> = [];

  for (const componentDir of componentDirs) {
    const componentName = path.basename(componentDir);
    const outputFile = path.join(outputRoot, componentName, 'internal.ts');

    try {
      const ir = parseComponent(componentDir);
      const transformed = transformAll(ir);
      const output = emitComponent(transformed);

      if (opts.dryRun) {
        console.log(`\n=== ${ir.name} ===`);
        console.log(output);
      } else {
        const dir = path.dirname(outputFile);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(outputFile, output, 'utf-8');
        if (opts.verbose) {
          console.log(`✓ ${ir.name} → ${outputFile}`);
        }
      }
      succeeded++;
    } catch (err) {
      failed++;
      const errMsg = (err as Error).message;
      failures.push({ name: componentName, error: errMsg });
      if (opts.verbose) {
        console.error(`✗ ${componentName}: ${errMsg}`);
      }
    }
  }

  console.log(`\nResults: ${succeeded} succeeded, ${failed} failed out of ${componentDirs.length} total`);

  if (failures.length > 0) {
    console.log('\nFailed components:');
    for (const f of failures) {
      console.log(`  ✗ ${f.name}: ${f.error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Component directory discovery
// ---------------------------------------------------------------------------

function findComponentDirs(sourceRoot: string): string[] {
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  const dirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('__')) continue;

    const componentDir = path.join(sourceRoot, entry.name);
    // Must have an index.tsx or index.ts
    const hasIndex =
      fs.existsSync(path.join(componentDir, 'index.tsx')) ||
      fs.existsSync(path.join(componentDir, 'index.ts'));

    if (hasIndex) {
      dirs.push(componentDir);
    }
  }

  return dirs.sort();
}
