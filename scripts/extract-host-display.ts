#!/usr/bin/env node
/**
 * Extract the computed `display` value of each component's host element
 * by rendering them in a real browser via Playwright.
 *
 * Usage:
 *   npx tsx scripts/extract-host-display.ts \
 *     --package @cloudscape-design/components \
 *     --source vendor/cloudscape-source/src
 */
import path from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { discoverComponents } from '../src/config.js';
import { PackageAnalyzer } from '../src/package-analyzer.js';
import { buildRenderManifest } from '../src/host-display.js';
import type { RenderManifest } from '../src/host-display.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { packageName: string; sourceDir: string; outputFile?: string } {
  const args = process.argv.slice(2);
  let packageName = '';
  let sourceDir = '';
  let outputFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--package':
      case '-p':
        packageName = args[++i];
        break;
      case '--source':
      case '-s':
        sourceDir = args[++i];
        break;
      case '--output':
      case '-o':
        outputFile = args[++i];
        break;
    }
  }

  if (!packageName || !sourceDir) {
    console.error('Usage: extract-host-display --package <name> --source <dir> [--output <file>]');
    process.exit(1);
  }

  return { packageName, sourceDir: path.resolve(sourceDir), outputFile };
}

// ---------------------------------------------------------------------------
// CSS file collection
// ---------------------------------------------------------------------------

function findCssFiles(pkgRoot: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.css') && !entry.endsWith('.css.js')) {
        results.push(full);
      }
    }
  }

  walk(pkgRoot);
  return results;
}

// ---------------------------------------------------------------------------
// Render script generation
// ---------------------------------------------------------------------------

function generateRenderScript(manifest: RenderManifest, packageName: string): string {
  const lines: string[] = [];
  const imports: string[] = [];
  const allNames = Object.keys(manifest);

  imports.push(`import React from 'react';`);
  imports.push(`import { createRoot } from 'react-dom/client';`);
  imports.push(`import { flushSync } from 'react-dom';`);

  for (const name of allNames) {
    imports.push(`import { ${name} } from '${packageName}';`);
  }

  lines.push(imports.join('\n'));
  lines.push('');

  lines.push(`
function reviveProps(obj) {
  if (obj === '__NOOP_FN__') return () => {};
  if (Array.isArray(obj)) return obj.map(reviveProps);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = reviveProps(v);
    }
    return out;
  }
  return obj;
}
`);

  lines.push(`const MANIFEST = ${JSON.stringify(manifest, null, 2)};`);
  lines.push('');

  lines.push('const COMPONENTS = {');
  for (const name of allNames) {
    lines.push(`  ${JSON.stringify(name)}: ${name},`);
  }
  lines.push('};');
  lines.push('');

  lines.push(`
async function main() {
  const results = {};

  for (const [name, entry] of Object.entries(MANIFEST)) {
    const Comp = COMPONENTS[name];
    if (!Comp) {
      results[name] = null;
      continue;
    }

    try {
      const wrapper = document.createElement('div');
      wrapper.id = 'render-target-' + name;
      document.getElementById('root').appendChild(wrapper);

      let renderError = null;
      const root = createRoot(wrapper, {
        onRecoverableError: () => {},
        onCaughtError: () => {},
        onUncaughtError: (err) => { renderError = err; },
      });

      const props = reviveProps(entry.props || {});
      const element = React.createElement(Comp, props);

      flushSync(() => { root.render(element); });
      await new Promise(r => setTimeout(r, 0));

      if (renderError) {
        results[name] = null;
        try { root.unmount(); } catch (e2) {}
        wrapper.remove();
        continue;
      }

      let target;
      if (entry.portal) {
        const bodyChildren = document.body.children;
        target = bodyChildren[bodyChildren.length - 1];
        if (target && target.id === 'root') target = null;
      } else {
        target = wrapper.firstElementChild;
      }

      if (target) {
        results[name] = window.getComputedStyle(target).display;
      } else {
        results[name] = null;
      }

      root.unmount();
      wrapper.remove();
    } catch (e) {
      results[name] = null;
    }
  }

  window.__results = results;
  window.__done = true;
}

main();
`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = performance.now();
  const { packageName, sourceDir, outputFile } = parseArgs();

  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  const pkgRoot = path.dirname(pkgJsonPath);

  console.error('Discovering components...');
  const components = discoverComponents(packageName);
  console.error(`Found ${components.length} components.`);

  console.error('Building render manifest...');
  const analyzer = new PackageAnalyzer(packageName);
  const manifest = buildRenderManifest(components, analyzer, sourceDir);
  console.error(`Manifest: ${Object.keys(manifest).length} entries.`);

  console.error('Generating render script...');
  const renderScript = generateRenderScript(manifest, packageName);
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const genScriptPath = path.join(projectRoot, 'scripts', '_generated-render.js');
  writeFileSync(genScriptPath, renderScript);

  console.error('Bundling with esbuild...');
  const esbuild = await import('esbuild');
  const tempBundlePath = path.join(projectRoot, 'scripts', '_bundle.js');

  await esbuild.build({
    entryPoints: [genScriptPath],
    bundle: true,
    format: 'esm',
    outfile: tempBundlePath,
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    target: 'es2022',
    logLevel: 'warning',
    plugins: [{
      name: 'css-module-stub',
      setup(build) {
        build.onLoad({ filter: /\.module\.css$/ }, () => ({
          contents: 'export default new Proxy({}, { get: (_, key) => key })',
          loader: 'js',
        }));
      },
    }],
  });

  console.error('Collecting CSS files...');
  const cssFiles = findCssFiles(pkgRoot);
  console.error(`Found ${cssFiles.length} CSS files.`);
  const cssContent = cssFiles.map(f => readFileSync(f, 'utf-8')).join('\n');

  console.error('Launching browser...');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on('console', () => {});
  page.on('pageerror', () => {});

  const bundleContent = readFileSync(tempBundlePath, 'utf-8');

  await page.setContent(
    `<!DOCTYPE html><html><head><style>${cssContent}</style></head><body><div id="root"></div></body></html>`,
  );

  await page.addScriptTag({ content: bundleContent, type: 'module' });

  console.error('Waiting for render completion...');
  await page.waitForFunction(() => (window as any).__done === true, null, { timeout: 60_000 });

  const browserResults: Record<string, string | null> = await page.evaluate(
    () => (window as any).__results,
  );

  await browser.close();

  const finalResults: Record<string, string | null> = {};
  for (const name of Object.keys(manifest)) {
    if (name in browserResults) {
      finalResults[name] = browserResults[name];
    } else {
      finalResults[name] = null;
    }
  }

  const json = JSON.stringify(finalResults, null, 2) + '\n';
  if (outputFile) {
    writeFileSync(outputFile, json);
  } else {
    process.stdout.write(json);
  }

  let resolved = 0;
  let nullCount = 0;
  for (const val of Object.values(finalResults)) {
    if (val !== null) resolved++;
    else nullCount++;
  }
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.error(`\n${resolved} resolved, ${nullCount} null — ${Object.keys(finalResults).length} total (${elapsed}s)`);

  try { unlinkSync(genScriptPath); } catch {}
  try { unlinkSync(tempBundlePath); } catch {}
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
