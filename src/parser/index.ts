/**
 * Parser entry point.
 *
 * Orchestrates the full parsing pipeline:
 * 1. Load source files (index.tsx + internal.tsx)
 * 2. Find the component function (merge index + internal)
 * 3. Extract props from the interface/destructuring
 * 4. Extract hooks (state, effects, refs, etc.)
 * 5. Extract event handlers
 * 6. Parse JSX template
 * 7. Extract helper functions
 * 8. Produce ComponentIR
 */
import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import type { ComponentIR } from '../ir/types.js';
import { parseFile } from './program.js';
import { findComponent } from './component.js';
import { extractProps } from './props.js';
import { extractHooks } from './hooks.js';
import { parseJSXFromBody } from './jsx.js';
import { extractHandlers, extractHelpers } from './utils.js';
import type { HookRegistry } from '../hooks/registry.js';
import { createHookRegistry } from '../hooks/registry.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /** Custom element prefix, e.g. "cs" → "cs-badge" */
  prefix?: string;

  /** Custom hook registry overrides */
  hookMappings?: HookRegistry;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Parse a React component directory into a ComponentIR.
 *
 * @param componentDir - Absolute path to the component directory
 *   (e.g. /path/to/cloudscape-source/src/badge)
 * @param options - Parse options
 */
export function parseComponent(
  componentDir: string,
  options: ParseOptions = {},
): ComponentIR {
  const hookRegistry = createHookRegistry(options.hookMappings);
  const prefix = options.prefix ?? '';

  // 1. Locate source files
  const indexPath = resolveSourceFile(componentDir, 'index');
  const internalPath = resolveSourceFile(componentDir, 'internal');

  if (!indexPath) {
    throw new Error(`No index.tsx or index.ts found in ${componentDir}`);
  }

  // 2. Parse source files
  const indexFile = parseFile(indexPath);
  const internalFile = internalPath ? parseFile(internalPath) : undefined;

  // 3. Find and merge component function
  const component = findComponent(indexFile, internalFile);

  // 4. Extract props
  const sourceFile = component.sourceFile;
  const props = extractProps(component, sourceFile);

  // 5. Extract hooks
  const hookResult = ts.isBlock(component.body)
    ? extractHooks(component.body, sourceFile, hookRegistry)
    : { state: [], effects: [], refs: [], computedValues: [], handlers: [], publicMethods: [], controllers: [], contexts: [], skipped: [], unknown: [] };

  // 6. Extract standalone event handlers
  const handlers = ts.isBlock(component.body)
    ? extractHandlers(component.body, sourceFile)
    : [];

  // Merge handlers from useCallback with standalone handlers
  const allHandlers = [...hookResult.handlers, ...handlers];

  // 7. Parse JSX template
  const template = parseJSXFromBody(component.body, sourceFile);

  // 8. Extract helper functions (file-level, outside the component)
  const implFile = internalFile ?? indexFile;
  const helpers = extractHelpers(implFile, component.name);

  // 9. Derive component metadata
  const componentName = deriveComponentName(component.name, componentDir);
  const tagName = deriveTagName(componentName, prefix);

  // 10. Collect source files
  const sourceFiles: string[] = [path.basename(indexPath)];
  if (internalPath) sourceFiles.push(path.basename(internalPath));

  // 11. Detect style import
  const styleImport = resolveSourceFile(componentDir, 'styles.css')
    ? './styles.css.js'
    : undefined;

  return {
    name: componentName,
    tagName,
    sourceFiles,
    props,
    state: hookResult.state,
    effects: hookResult.effects,
    refs: hookResult.refs,
    handlers: allHandlers,
    template,
    computedValues: hookResult.computedValues,
    controllers: hookResult.controllers,
    mixins: [],
    contexts: hookResult.contexts,
    imports: [],
    styleImport,
    publicMethods: hookResult.publicMethods,
    helpers,
    forwardRef: component.forwardRef,
  };
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

function resolveSourceFile(dir: string, baseName: string): string | null {
  const extensions = ['.tsx', '.ts', '.jsx', '.js'];
  for (const ext of extensions) {
    const filePath = path.join(dir, baseName + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Name derivation
// ---------------------------------------------------------------------------

/**
 * Derive a clean component name from the function name and directory.
 * - "Badge" → "Badge"
 * - "InternalButton" → "Button"
 * - "StatusIndicator" → "StatusIndicator"
 */
function deriveComponentName(functionName: string, componentDir: string): string {
  // Strip "Internal" prefix if present
  let name = functionName.replace(/^Internal/, '');

  // If name is empty or "Unknown", derive from directory name
  if (!name || name === 'Unknown') {
    const dirName = path.basename(componentDir);
    // Convert kebab-case to PascalCase: "status-indicator" → "StatusIndicator"
    name = dirName
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }

  return name;
}

/**
 * Derive the custom element tag name.
 * - "Badge" + prefix "cs" → "cs-badge"
 * - "StatusIndicator" + prefix "cs" → "cs-status-indicator"
 */
function deriveTagName(componentName: string, prefix: string): string {
  // PascalCase to kebab-case
  const kebab = componentName
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();

  return prefix ? `${prefix}-${kebab}` : kebab;
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { parseFile } from './program.js';
export type { RawComponent } from './component.js';
export type { HookExtractionResult } from './hooks.js';
