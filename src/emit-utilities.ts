/**
 * Utility emission phase — discovers, transforms, and emits utility modules
 * alongside generated component files.
 *
 * After component index.ts files are generated, this module scans their
 * imports, finds unresolved relative modules, traces them back to the
 * React vendor source, transforms them (strips React, rewrites
 * component-toolkit imports), and writes them to the output directory.
 */
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmitUtilitiesOptions {
  /** Absolute path to the React vendor source directory */
  sourceRoot: string;
  /** Absolute path to the output directory */
  outputRoot: string;
  /** Maximum recursion depth (default: 2) */
  maxDepth?: number;
  /** Log decisions */
  verbose?: boolean;
}

export interface EmitUtilitiesResult {
  /** Number of utility files emitted */
  emitted: number;
  /** Paths of emitted files (relative to outputRoot) */
  emittedFiles: string[];
  /** Paths of skipped files (JSX components) */
  skippedFiles: string[];
}

// ---------------------------------------------------------------------------
// Import patterns for stripping / rewriting
// ---------------------------------------------------------------------------

/** Packages to strip entirely */
const STRIP_PACKAGES = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'clsx',
]);

/** Package prefixes to rewrite to toolkit shims */
const TOOLKIT_PREFIXES = [
  '@cloudscape-design/component-toolkit/internal',
  '@cloudscape-design/component-toolkit/dom',
  '@cloudscape-design/component-toolkit',
];

/** React.* type replacements (ported from emitter/utilities.ts) */
const REACT_TYPE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/React\.SyntheticEvent(?:<[^>]*>)?/g, 'Event'],
  [/React\.MouseEvent(?:<[^>]*>)?/g, 'MouseEvent'],
  [/React\.KeyboardEvent(?:<[^>]*>)?/g, 'KeyboardEvent'],
  [/React\.FocusEvent(?:<[^>]*>)?/g, 'FocusEvent'],
  [/React\.ChangeEvent(?:<[^>]*>)?/g, 'Event'],
  [/React\.FormEvent(?:<[^>]*>)?/g, 'Event'],
  [/React\.DragEvent(?:<[^>]*>)?/g, 'DragEvent'],
  [/React\.TouchEvent(?:<[^>]*>)?/g, 'TouchEvent'],
  [/React\.ClipboardEvent(?:<[^>]*>)?/g, 'ClipboardEvent'],
  [/React\.SetStateAction<([^>]+)>/g, '$1'],
  [/React\.RefObject<([^>]+)>/g, '{ current: $1 | null }'],
  [/React\.MutableRefObject<([^>]+)>/g, '{ current: $1 }'],
  [/React\.(\w+)/g, '$1'],
];

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Scan all emitted component files for unresolved relative imports,
 * trace each to the vendor source, transform, and write to the output.
 */
export function emitUtilities(options: EmitUtilitiesOptions): EmitUtilitiesResult {
  const { sourceRoot, outputRoot, maxDepth = 5, verbose = false } = options;
  const emittedSet = new Set<string>(); // absolute output paths already emitted
  const skippedFiles: string[] = [];

  // Collect all existing .ts files in the output directory
  const existingOutputFiles = collectFiles(outputRoot, ['.ts']);

  // Process each existing output file's imports
  for (const outputFile of existingOutputFiles) {
    processImports(outputFile, sourceRoot, outputRoot, emittedSet, skippedFiles, 0, maxDepth, verbose);
  }

  const emittedFiles = [...emittedSet].map(f => path.relative(outputRoot, f));
  return { emitted: emittedSet.size, emittedFiles, skippedFiles };
}

// ---------------------------------------------------------------------------
// Import processing (recursive)
// ---------------------------------------------------------------------------

function processImports(
  file: string,
  sourceRoot: string,
  outputRoot: string,
  emittedSet: Set<string>,
  skippedFiles: string[],
  depth: number,
  maxDepth: number,
  verbose: boolean,
): void {
  if (depth > maxDepth) return;

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return;
  }

  const relativeImports = extractRelativeImports(content);

  for (const specifier of relativeImports) {
    const fromDir = path.dirname(file);
    const absOutputTarget = path.resolve(fromDir, specifier);

    // Already exists in the output? Skip.
    if (fileExistsInOutput(absOutputTarget)) continue;

    // Determine the output path (strip .js → .ts)
    const outputFilePath = toOutputTsPath(absOutputTarget);

    // Already emitted? Skip.
    if (emittedSet.has(outputFilePath)) continue;

    // Trace to vendor source
    const sourceFile = resolveToSource(absOutputTarget, outputRoot, sourceRoot);
    if (!sourceFile) {
      if (verbose) {
        console.log(`  ⊘ Could not trace: ${specifier} (from ${path.relative(outputRoot, file)})`);
      }
      continue;
    }

    // Read source
    const sourceContent = fs.readFileSync(sourceFile, 'utf-8');

    // Check for JSX — skip React component files
    if (hasJSX(sourceContent, sourceFile)) {
      skippedFiles.push(path.relative(sourceRoot, sourceFile));
      if (verbose) {
        console.log(`  ⊘ Skipping JSX file: ${path.relative(sourceRoot, sourceFile)}`);
      }
      continue;
    }

    // Transform the source content
    const transformed = transformUtility(sourceContent, sourceFile, outputFilePath, sourceRoot, outputRoot);

    // Write to output
    fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
    fs.writeFileSync(outputFilePath, transformed, 'utf-8');
    emittedSet.add(outputFilePath);

    if (verbose) {
      console.log(`  ✓ Emitted utility: ${path.relative(outputRoot, outputFilePath)}`);
    }

    // Recurse into the newly emitted file
    processImports(outputFilePath, sourceRoot, outputRoot, emittedSet, skippedFiles, depth + 1, maxDepth, verbose);
  }
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/** Extract all relative import specifiers from file content. */
export function extractRelativeImports(content: string): string[] {
  const imports: string[] = [];
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return [...new Set(imports)];
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

/** Check if a target file already exists in the output directory. */
function fileExistsInOutput(absTarget: string): boolean {
  if (fs.existsSync(absTarget)) return true;

  const withoutJs = absTarget.replace(/\.js$/, '');
  if (fs.existsSync(withoutJs + '.ts')) return true;
  if (fs.existsSync(withoutJs + '.js')) return true;
  if (fs.existsSync(path.join(withoutJs, 'index.ts'))) return true;
  if (fs.existsSync(path.join(withoutJs, 'index.js'))) return true;

  return false;
}

/** Convert a .js output target path to its .ts form. */
function toOutputTsPath(absTarget: string): string {
  return absTarget.replace(/\.js$/, '') + '.ts';
}

/**
 * Trace an output target path back to its vendor source file.
 * Returns the absolute path to the source file, or null.
 */
export function resolveToSource(
  absOutputTarget: string,
  outputRoot: string,
  sourceRoot: string,
): string | null {
  const relFromOutput = path.relative(outputRoot, absOutputTarget);
  const withoutJs = relFromOutput.replace(/\.js$/, '');

  const candidates = [
    withoutJs + '.ts',
    withoutJs + '.tsx',
    path.join(withoutJs, 'index.ts'),
    path.join(withoutJs, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    const absCandidate = path.join(sourceRoot, candidate);
    if (fs.existsSync(absCandidate)) {
      return absCandidate;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// JSX detection
// ---------------------------------------------------------------------------

/** Returns true if the content looks like a React component (has JSX). */
export function hasJSX(content: string, filePath: string): boolean {
  // Strip comments for cleaner detection
  const stripped = content
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Check for React.createElement
  if (/React\.createElement\s*\(/.test(stripped)) return true;

  // Check for JSX elements (uppercase = components, lowercase = HTML tags)
  if (filePath.endsWith('.tsx')) {
    if (/<[A-Z][\w.]*[\s/>]/.test(stripped)) return true;
    // HTML elements in JSX context (look for return statements with JSX)
    if (/return\s*\(\s*<[a-z]/.test(stripped)) return true;
    if (/return\s+<[a-z]/.test(stripped)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Source transformation
// ---------------------------------------------------------------------------

/**
 * Transform a vendor React utility source into a web-standard module.
 *
 * - Strips React / react-dom / clsx imports
 * - Rewrites @cloudscape-design/component-toolkit imports to shim path
 * - Adds .js extensions to relative imports
 * - Replaces React.* type references with web-standard equivalents
 * - Strips 'use client' directives and CSS imports
 */
export function transformUtility(
  source: string,
  sourceFilePath: string,
  outputFilePath: string,
  sourceRoot: string,
  outputRoot: string,
): string {
  const sourceDir = path.dirname(sourceFilePath);
  let result = source;

  // 1. Process imports line by line
  result = result.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('import ') && !trimmed.startsWith('export ')) return line;

    // Check for side-effect imports: import 'foo';
    const sideEffectMatch = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
    if (sideEffectMatch && !trimmed.includes(' from ')) {
      const spec = sideEffectMatch[1];
      if (shouldStripImport(spec)) return '';
      return line;
    }

    // Extract module specifier from 'from' clause
    const specMatch = trimmed.match(/from\s+['"]([^'"]+)['"]/);
    if (!specMatch) return line;
    const specifier = specMatch[1];

    // Strip unwanted packages
    if (shouldStripImport(specifier)) return '';

    // Rewrite component-toolkit imports → local shim
    if (isToolkitImport(specifier)) {
      const shimPath = computeShimRelativePath(outputFilePath, outputRoot);
      return line.replace(/from\s+['"][^'"]+['"]/, `from '${shimPath}'`);
    }

    // Add .js extension to relative imports that lack one
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.css')) {
      const resolved = resolveJsExtension(specifier, sourceDir);
      return line.replace(/from\s+['"][^'"]+['"]/, `from '${resolved}'`);
    }

    return line;
  }).join('\n');

  // 2. Replace React.* type references with web-standard types
  for (const [pattern, replacement] of REACT_TYPE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }

  // 3. Strip 'use client' directive
  result = result.replace(/^['"]use client['"];?\s*\n?/m, '');

  // 4. Strip test utility style references (imports already stripped as .css.js)
  result = result.replace(/\btestUtilStyles(?:\[['"\w-]+\]|\.\w+)/g, "''");

  return result;
}

// ---------------------------------------------------------------------------
// Import classification helpers
// ---------------------------------------------------------------------------

function shouldStripImport(specifier: string): boolean {
  if (STRIP_PACKAGES.has(specifier)) return true;
  if (specifier.endsWith('.css.js') || specifier.endsWith('.scss') || specifier.endsWith('.css')) return true;
  return false;
}

function isToolkitImport(specifier: string): boolean {
  return TOOLKIT_PREFIXES.some(
    prefix => specifier === prefix || specifier.startsWith(prefix + '/'),
  );
}

/**
 * Resolve a relative import specifier to include .js extension,
 * handling directory imports (adding /index.js when needed).
 */
function resolveJsExtension(specifier: string, sourceDir: string): string {
  const absTarget = path.resolve(sourceDir, specifier);

  // Direct file?
  if (fs.existsSync(absTarget + '.ts') || fs.existsSync(absTarget + '.tsx')) {
    return specifier + '.js';
  }

  // Directory with index?
  if (fs.existsSync(path.join(absTarget, 'index.ts')) || fs.existsSync(path.join(absTarget, 'index.tsx'))) {
    return specifier + '/index.js';
  }

  // Fallback: just add .js
  return specifier + '.js';
}

// ---------------------------------------------------------------------------
// Shim path computation
// ---------------------------------------------------------------------------

/** Compute relative path from a file to outputRoot/internal/toolkit-shims.js */
function computeShimRelativePath(fromFile: string, outputRoot: string): string {
  const shimAbsPath = path.join(outputRoot, 'internal', 'toolkit-shims.js');
  const fromDir = path.dirname(fromFile);
  let rel = path.relative(fromDir, shimAbsPath);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

// ---------------------------------------------------------------------------
// Shim emission
// ---------------------------------------------------------------------------

/**
 * Emit a placeholder toolkit shim file to outputRoot/internal/toolkit-shims.ts.
 * This will be replaced by the real shims from src/shims/component-toolkit.ts
 * once that module is built.
 */
export function emitToolkitShim(outputRoot: string, shimSourcePath?: string): void {
  const shimOutputPath = path.join(outputRoot, 'internal', 'toolkit-shims.ts');

  // If the real shim source exists, copy it
  if (shimSourcePath && fs.existsSync(shimSourcePath)) {
    fs.mkdirSync(path.dirname(shimOutputPath), { recursive: true });
    fs.copyFileSync(shimSourcePath, shimOutputPath);
    return;
  }

  // Otherwise, emit a placeholder with common exports
  const placeholder = `/**
 * Component-toolkit shims — placeholder.
 *
 * Replace with real implementations from src/shims/component-toolkit.ts.
 * These stubs satisfy imports from utility modules that reference
 * @cloudscape-design/component-toolkit.
 */

// Stubs for @cloudscape-design/component-toolkit/internal
export function warnOnce(_component: string, _message: string): void {
  // no-op in Lit output
}

export function useUniqueId(prefix?: string): string {
  return (prefix ?? 'id') + '-' + Math.random().toString(36).slice(2, 9);
}

export function useMergeRefs(..._refs: unknown[]): unknown {
  return undefined;
}

export function useResizeObserver(): Record<string, unknown> {
  return {};
}

export function useSingleTabStopNavigation(): Record<string, unknown> {
  return {};
}

// Stubs for @cloudscape-design/component-toolkit/internal/analytics-metadata
export function getAnalyticsMetadataAttribute(): string {
  return '';
}

export interface GeneratedAnalyticsMetadataFragment {}
export interface LabelIdentifier {}
`;

  fs.mkdirSync(path.dirname(shimOutputPath), { recursive: true });
  fs.writeFileSync(shimOutputPath, placeholder, 'utf-8');
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collectFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];

  function walk(current: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}
