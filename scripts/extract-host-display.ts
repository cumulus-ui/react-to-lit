#!/usr/bin/env node
/**
 * Extract `:host { display: X }` for each component in a package.
 *
 * Usage:
 *   npx tsx scripts/extract-host-display.ts --package @cloudscape-design/components
 *   npx tsx scripts/extract-host-display.ts --package @cloudscape-design/components --output host-display.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import postcss from 'postcss';

const require = createRequire(import.meta.url);

/**
 * CSS inner display -> outer host display mapping:
 *   inline-block, inline-flex, inline-grid  ->  keep as-is
 *   inline / contents                       ->  keep as-is
 *   block, flex, grid, table, etc.          ->  block
 */
export function toHostDisplay(cssDisplay: string): string {
  if (cssDisplay.startsWith('inline-')) return cssDisplay;
  if (cssDisplay === 'inline') return 'inline';
  if (cssDisplay === 'contents') return 'contents';
  return 'block';
}

export function toPascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

export function parseClassMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /"(\w[^"]*)":\s*"(awsui_[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

/**
 * Find CSS `display` value for a root class via PostCSS.
 * Prefers the base rule (`.className:not(#\9)`) over compound/contextual selectors.
 * Skips `display: none` (conditional hidden state, not base layout).
 */
export function findDisplayForClass(
  cssText: string,
  rootClassName: string,
): string | null {
  const root = postcss.parse(cssText);
  const baseSelector = `.${rootClassName}:not(#\\9)`;

  let baseDisplay: string | null = null;
  let fallbackDisplay: string | null = null;

  root.walkRules((rule) => {
    if (!rule.selector.includes(rootClassName)) return;

    let display: string | null = null;
    rule.walkDecls('display', (decl) => {
      if (decl.value !== 'none') {
        display = decl.value;
      }
    });

    if (!display) return;

    for (const sel of rule.selectors) {
      if (sel.trim() === baseSelector) {
        if (!baseDisplay) baseDisplay = display;
        return;
      }
    }

    if (!fallbackDisplay) fallbackDisplay = display;
  });

  return baseDisplay ?? fallbackDisplay;
}

interface ComponentStyleFiles {
  dirName: string;
  classMapPath: string;
  scopedCssPath: string;
}

function findComponentStyleDirs(packageRoot: string): ComponentStyleFiles[] {
  const results: ComponentStyleFiles[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packageRoot, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('__') || entry.name.startsWith('.')) continue;

    const dirPath = path.join(packageRoot, entry.name);
    const classMapPath = path.join(dirPath, 'styles.css.js');
    const scopedCssPath = path.join(dirPath, 'styles.scoped.css');

    if (fs.existsSync(classMapPath) && fs.existsSync(scopedCssPath)) {
      results.push({ dirName: entry.name, classMapPath, scopedCssPath });
    }
  }

  return results.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

function extractHostDisplayMap(packageName: string): Record<string, string> {
  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  const packageRoot = path.dirname(pkgJsonPath);

  const componentDirs = findComponentStyleDirs(packageRoot);
  const result: Record<string, string> = {};

  for (const comp of componentDirs) {
    const classMapSource = fs.readFileSync(comp.classMapPath, 'utf-8');
    const classMap = parseClassMap(classMapSource);
    if (classMap.size === 0) continue;

    const cssText = fs.readFileSync(comp.scopedCssPath, 'utf-8');

    let display: string | null = null;

    if (classMap.has('root')) {
      display = findDisplayForClass(cssText, classMap.get('root')!);
      if (!display) {
        display = 'block';
      }
    } else {
      for (const className of classMap.values()) {
        display = findDisplayForClass(cssText, className);
        if (display) break;
      }
    }

    if (!display) continue;

    result[toPascalCase(comp.dirName)] = toHostDisplay(display);
  }

  return result;
}

function parseArgs(argv: string[]): { packageName: string; output?: string } {
  let packageName: string | undefined;
  let output: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--package' && i + 1 < argv.length) {
      packageName = argv[++i];
    } else if (argv[i] === '--output' && i + 1 < argv.length) {
      output = argv[++i];
    }
  }

  if (!packageName) {
    console.error('Usage: extract-host-display --package <name> [--output <file>]');
    process.exit(1);
  }

  return { packageName, output };
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('extract-host-display.ts') ||
    process.argv[1].endsWith('extract-host-display.js'));

if (isDirectRun) {
  const { packageName, output } = parseArgs(process.argv);
  const displayMap = extractHostDisplayMap(packageName);
  const json = JSON.stringify(displayMap, null, 2);

  if (output) {
    fs.writeFileSync(output, json + '\n', 'utf-8');
    console.error(`Wrote ${Object.keys(displayMap).length} entries to ${output}`);
  } else {
    console.log(json);
  }

  console.error(`Total: ${Object.keys(displayMap).length} components with display values`);
}
