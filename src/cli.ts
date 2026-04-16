#!/usr/bin/env node
import { Command } from 'commander';
import { compile } from './compile.js';

const program = new Command();

program
  .name('react-to-lit')
  .description('Transpile React components to Lit web components')
  .version('0.1.0')
  .requiredOption('-p, --package <name>', 'npm package to discover components from (e.g. "@cloudscape-design/components")')
  .requiredOption('-s, --source <path>', 'Source directory containing component implementations')
  .option('-o, --output <path>', 'Output directory', './dist')
  .option('-c, --component <name>', 'Process a single component by name')
  .option('--dry-run', 'Print output to stdout instead of writing files')
  .option('--verbose', 'Log parsing decisions')
  .option('--preset <name>', 'Use a built-in preset (e.g. "cloudscape")')
  .option('--host-display <file>', 'Path to host display JSON map (from extract-host-display script)')
  .action(async (opts) => {
    const result = await compile({
      package: opts.package,
      source: opts.source,
      output: opts.output,
      preset: opts.preset,
      component: opts.component,
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      hostDisplay: opts.hostDisplay,
    });

    console.log(`\nResults: ${result.succeeded} succeeded, ${result.failed} failed out of ${result.total} total`);

    if (result.failures.length > 0) {
      console.log('\nFailed components:');
      for (const f of result.failures) {
        console.log(`  \u2717 ${f.name}: ${f.error}`);
      }
    }
  });

program.parse();
