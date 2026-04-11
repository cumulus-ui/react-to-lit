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
import { transformJsxToLit } from './jsx-transform.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /** Custom element prefix, e.g. "cs" → "cs-badge" */
  prefix?: string;

  /** Custom hook registry overrides */
  hookMappings?: HookRegistry;

  /**
   * Path to published declaration files (e.g., node_modules/@cloudscape-design/components).
   * When provided, the parser reads .d.ts interfaces for complete prop type information
   * instead of relying solely on React source destructuring.
   */
  declarationsDir?: string;
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

  // Auto-detect declarationsDir from @cloudscape-design/components if not provided
  let declarationsDir = options.declarationsDir;
  if (!declarationsDir) {
    // Try to find @cloudscape-design/components in node_modules
    const candidates = [
      path.resolve('node_modules/@cloudscape-design/components'),
      path.resolve(import.meta.dirname, '../../node_modules/@cloudscape-design/components'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        declarationsDir = candidate;
        break;
      }
    }
  }

  // 1. Locate source files
  const indexPath = resolveSourceFile(componentDir, 'index');
  let internalPath = resolveSourceFile(componentDir, 'internal');

  if (!indexPath) {
    throw new Error(`No index.tsx or index.ts found in ${componentDir}`);
  }

  // 2. Parse source files
  let indexFile = parseFile(indexPath);
  let internalFile = internalPath ? parseFile(internalPath) : undefined;

  // 2b. If internal.tsx is a factory wrapper (createWidgetized*), fall back to implementation.tsx
  if (internalFile && isFactoryWrapper(internalFile)) {
    const implPath = resolveSourceFile(componentDir, 'implementation');
    if (implPath) {
      internalPath = implPath;
      internalFile = parseFile(implPath);
    }
  }

  // 2c. Transform JSX → html`` tagged templates BEFORE IR extraction
  // This handles JSX in ALL contexts: render return, handlers, helpers, ternaries, .map(), etc.
  indexFile = transformJsxToLit(indexFile);
  if (internalFile) {
    internalFile = transformJsxToLit(internalFile);
  }

  // 3. Find and merge component function
  const component = findComponent(indexFile, internalFile);

  // 4. Extract props
  const sourceFile = component.sourceFile;
  const dirName = path.basename(componentDir);
  const props = extractProps(component, sourceFile, componentDir, declarationsDir, dirName);

  // 5. Extract hooks from the implementation body
  const hookResult = ts.isBlock(component.body)
    ? extractHooks(component.body, sourceFile, hookRegistry)
    : { state: [], effects: [], refs: [], computedValues: [], handlers: [], publicMethods: [], controllers: [], contexts: [], skipped: [], unknown: [] };

  // 5b. Also extract hooks from the index.tsx wrapper (may have useImperativeHandle, etc.)
  if (component.hasInternal) {
    try {
      const indexComponent = findComponent(indexFile);
      if (ts.isBlock(indexComponent.body)) {
        const indexHooks = extractHooks(indexComponent.body, indexFile, hookRegistry);
        // Merge public methods from index.tsx (e.g., useImperativeHandle focus/select)
        hookResult.publicMethods.push(...indexHooks.publicMethods);
        // Merge contexts from index.tsx
        hookResult.contexts.push(...indexHooks.contexts);
      }
    } catch {
      // Index component might not have a parseable body (e.g., just delegates to internal)
    }
  }

  // 6. Extract standalone event handlers
  const handlers = ts.isBlock(component.body)
    ? extractHandlers(component.body, sourceFile)
    : [];

  // Merge handlers from useCallback with standalone handlers
  const allHandlers = [...hookResult.handlers, ...handlers];

  // 6b. Collect local variable names for scope-aware identifier rewriting
  const localVariables = ts.isBlock(component.body)
    ? collectLocalVars(component.body)
    : new Set<string>();

  // 7. Parse JSX template
  const template = parseJSXFromBody(component.body, sourceFile);

  // 8. Extract body preamble (code between hooks/handlers and return)
  const bodyPreamble = ts.isBlock(component.body)
    ? extractBodyPreamble(component.body, sourceFile)
    : [];

  // 9. Extract helper functions (file-level, outside the component)
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

  // 12. Detect mixins (FormControlMixin)
  const mixins = detectMixins(implFile, props);

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
    mixins,
    contexts: hookResult.contexts,
    imports: [],
    styleImport,
    publicMethods: hookResult.publicMethods,
    helpers,
    bodyPreamble,
    localVariables,
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
// Local variable collection
// ---------------------------------------------------------------------------

function collectLocalVars(body: ts.Block): Set<string> {
  const vars = new Set<string>();
  for (const stmt of body.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          vars.add(decl.name.text);
        } else if (ts.isObjectBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            if (ts.isIdentifier(el.name)) vars.add(el.name.text);
          }
        } else if (ts.isArrayBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) vars.add(el.name.text);
          }
        }
      }
    }
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Body preamble extraction
// ---------------------------------------------------------------------------

/**
 * Extract statements from the component body that are between hook calls
 * and the return statement. These are typically variable assignments,
 * object builds, and conditional logic.
 */
function extractBodyPreamble(
  body: ts.Block,
  sourceFile: ts.SourceFile,
): string[] {
  const preamble: string[] = [];
  let pastHooks = false;

  for (const stmt of body.statements) {
    // Skip return statements
    if (ts.isReturnStatement(stmt)) break;

    // Detect hook calls and handler declarations (already captured elsewhere)
    if (isHookCallStatement(stmt) || isHandlerDeclaration(stmt)) {
      pastHooks = true;
      continue;
    }

    // After hooks: capture the preamble code
    if (pastHooks) {
      const text = sourceFile.text.slice(stmt.getStart(sourceFile), stmt.getEnd());
      // Skip Cloudscape infrastructure
      if (text.includes('applyDisplayName') || text.includes('getBaseProps')) continue;
      if (text.includes('checkSafeUrl')) continue;
      if (text.includes('useBaseComponent')) continue;
      preamble.push(text);
    }
  }

  return preamble;
}

function isHookCallStatement(stmt: ts.Statement): boolean {
  // Variable declaration with hook call
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (decl.initializer && ts.isCallExpression(decl.initializer)) {
        const callee = decl.initializer.expression;
        if (ts.isIdentifier(callee) && callee.text.startsWith('use')) return true;
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'React') return true;
      }
    }
  }
  // Expression statement with hook call
  if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
    const callee = stmt.expression.expression;
    if (ts.isIdentifier(callee) && callee.text.startsWith('use')) return true;
  }
  return false;
}

function isHandlerDeclaration(stmt: ts.Statement): boolean {
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
        return true;
      }
      // Hook calls are also handler-like
      if (decl.initializer && ts.isCallExpression(decl.initializer)) {
        const callee = decl.initializer.expression;
        if (ts.isIdentifier(callee) && callee.text.startsWith('use')) return true;
      }
    }
  }
  if (ts.isFunctionDeclaration(stmt)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Factory wrapper detection
// ---------------------------------------------------------------------------

/**
 * Check if a source file is a factory wrapper (e.g., createWidgetized*).
 * These files typically just re-export from a factory and have no function body.
 */
function isFactoryWrapper(sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.text;
  return text.includes('createWidgetized') || text.includes('createLoadableComponent');
}

// ---------------------------------------------------------------------------
// Mixin detection
// ---------------------------------------------------------------------------

/** Interfaces that indicate form participation */
const FORM_INTERFACES = ['FormFieldControlProps', 'BaseCheckboxProps', 'BaseInputProps'];

/**
 * Detect mixins needed based on source file imports and prop analysis.
 */
function detectMixins(
  sourceFile: ts.SourceFile,
  props: import('../ir/types.js').PropIR[],
): string[] {
  const mixins: string[] = [];
  const sourceText = sourceFile.text;

  // Check if the source file references form-related interfaces/contexts
  const hasFormFieldContext = sourceText.includes('useFormFieldContext') ||
    sourceText.includes('FormFieldControlProps');

  const hasFormProps = props.some((p) =>
    p.name === 'name' || p.name === 'controlId',
  ) && props.some((p) => p.name === 'disabled');

  // Check for base interfaces that imply form participation
  const hasFormInterface = FORM_INTERFACES.some(name => sourceText.includes(name));

  if (hasFormFieldContext || (hasFormProps && hasFormInterface)) {
    mixins.push('FormControlMixin');
  }

  return mixins;
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { parseFile } from './program.js';
export type { RawComponent } from './component.js';
export type { HookExtractionResult } from './hooks.js';
