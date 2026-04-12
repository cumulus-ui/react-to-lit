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
import type { ComponentIR, ImportIR } from '../ir/types.js';
import { parseFile } from './program.js';
import { findComponent, type RawComponent } from './component.js';
import { extractProps, extractPropAliases } from './props.js';
import { extractHooks } from './hooks.js';
import { parseJSXFromBody } from './jsx.js';
import { extractHandlers, extractHelpers, extractFileConstants, extractFileTypeDeclarations, isHookCall, collectBindingNames, collectLocalVariables } from './utils.js';
import { createHookRegistry, type HookRegistry } from '../hooks/registry.js';
import { containsHtmlTemplate } from '../text-utils.js';
import { transformJsxToLit } from './jsx-transform.js';
import { toTagName } from '../naming.js';
import { INFRA_FUNCTIONS } from '../cloudscape-config.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParseOptions {
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

  // 2. Parse source files (as TSX — original with JSX syntax)
  const origIndexFile = parseFile(indexPath);
  let origInternalFile = internalPath ? parseFile(internalPath) : undefined;

  // 2b. If internal.tsx is a factory wrapper (createWidgetized*), fall back to implementation.tsx
  if (origInternalFile && isFactoryWrapper(origInternalFile)) {
    const implPath = resolveSourceFile(componentDir, 'implementation');
    if (implPath) {
      internalPath = implPath;
      origInternalFile = parseFile(implPath);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase A: Parse template from ORIGINAL TSX (before JSX-to-Lit).
  // This gives us a fully structured TemplateNodeIR with decomposed attributes,
  // conditions, and loops — rather than opaque html`` strings.
  // ---------------------------------------------------------------------------
  const origComponent = findComponent(origIndexFile, origInternalFile);
  const template = parseJSXFromBody(origComponent.body, origComponent.sourceFile);

  // ---------------------------------------------------------------------------
  // Phase B: Transform JSX → html`` for everything ELSE (handlers, helpers,
  // preamble variables), then re-parse so the rest of IR extraction works on
  // plain TS (no JSX syntax in hook bodies, etc.).
  // ---------------------------------------------------------------------------
  let indexFile = transformJsxToLit(origIndexFile);
  let internalFile = origInternalFile ? transformJsxToLit(origInternalFile) : undefined;

  // 3. Find component in the transformed TS files
  const component = findComponent(indexFile, internalFile);

  // 4. Extract props
  const sourceFile = component.sourceFile;
  const dirName = path.basename(componentDir);
  const props = extractProps(component, sourceFile, componentDir, declarationsDir, dirName);

  // 5. Extract hooks from the implementation body
  const hookResult = ts.isBlock(component.body)
    ? extractHooks(component.body, sourceFile, hookRegistry)
    : { state: [], effects: [], refs: [], computedValues: [], handlers: [], publicMethods: [], controllers: [], contexts: [], skipped: [], unknown: [], preservedVars: [] };

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
    } catch (e) {
      // findComponent throws when no component is found — that's expected for
      // index files that just re-export the internal component.
      // Log unexpected errors so we don't silently lose public methods.
      if (e instanceof Error && !e.message.includes('No component found')) {
        console.warn(`[react-to-lit] Warning: failed to parse index component for ${dirName}: ${e.message}`);
      }
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
    ? collectLocalVariables(component.body)
    : new Set<string>();

  // 7. Template was already parsed in Phase A from the original TSX

  // 8. Extract body preamble (code between hooks/handlers and return)
  //    JSX-containing variables become render helpers instead of preamble.
  const { preamble: bodyPreamble, renderHelpers } = ts.isBlock(component.body)
    ? extractBodyPreamble(component.body, sourceFile)
    : { preamble: [], renderHelpers: [] };

  // 9. Extract helper functions (file-level, outside the component)
  const implFile = internalFile ?? indexFile;
  const helpers = [...extractHelpers(implFile, component.name), ...renderHelpers];

  // 9b. Extract file-level constants
  const fileConstants = extractFileConstants(implFile, component.name);

  // 9c. Extract file-level type declarations
  const fileTypeDeclarations = extractFileTypeDeclarations(implFile, component.name);

  // 10. Derive component metadata
  const componentName = deriveComponentName(component.name, componentDir);
  const tagName = toTagName(componentName);

  // 11. Collect source files
  const sourceFiles: string[] = [path.basename(indexPath)];
  if (internalPath) sourceFiles.push(path.basename(internalPath));

  // 12. Detect style import
  const styleImport = resolveSourceFile(componentDir, 'styles.css')
    ? './styles.css.js'
    : undefined;

  // 13. Detect mixins (FormControlMixin)
  const mixins = detectMixins(implFile, props);

  return {
    name: componentName,
    tagName,
    typeParams: extractTypeParams(component),
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
    imports: extractSourceImports(sourceFile),
    styleImport,
    publicMethods: hookResult.publicMethods,
    helpers,
    fileConstants,
    fileTypeDeclarations,
    bodyPreamble,
    localVariables,
    skippedHookVars: hookResult.preservedVars,
    propAliases: extractPropAliases(component, sourceFile),
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

// ---------------------------------------------------------------------------
// Body preamble extraction
// ---------------------------------------------------------------------------

/**
 * Extract statements from the component body that are between hook calls
 * and the return statement. These are typically variable assignments,
 * object builds, and conditional logic.
 */
interface PreambleResult {
  preamble: string[];
  renderHelpers: import('../ir/types.js').HelperIR[];
}

function extractBodyPreamble(
  body: ts.Block,
  sourceFile: ts.SourceFile,
): PreambleResult {
  const preamble: string[] = [];
  const renderHelpers: import('../ir/types.js').HelperIR[] = [];
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
      if ([...INFRA_FUNCTIONS].some(fn => text.includes(fn))) continue;
      if (text.includes('useBaseComponent')) continue;
      // Skip dev-only validation blocks (contain hooks that violate rules-of-hooks)
      if (ts.isIfStatement(stmt) && text.includes('isDevelopment')) continue;

      // Check if this is a variable containing a template (html`...`)
      // These become render helper methods instead of bodyPreamble
      if (ts.isVariableStatement(stmt) && containsHtmlTemplate(text)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const initText = decl.initializer
              ? sourceFile.text.slice(decl.initializer.getStart(sourceFile), decl.initializer.getEnd())
              : '';
            if (containsHtmlTemplate(initText)) {
              // Convert to a render helper: const header = html`...` → function header() { return html`...`; }
              renderHelpers.push({
                name,
                source: `function ${name}() {\n  return ${initText};\n}`,
              });
              continue;
            }
          }
        }
        // If we got here, not all declarations were helpers — add remainder to preamble
        continue;
      }

      preamble.push(text);
    }
  }

  return { preamble, renderHelpers };
}

function isHookCallStatement(stmt: ts.Statement): boolean {
  // Variable declaration with hook call
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (decl.initializer && isHookCall(decl.initializer)) return true;
    }
  }
  // Expression statement with hook call
  if (ts.isExpressionStatement(stmt) && isHookCall(stmt.expression)) {
    return true;
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

// ---------------------------------------------------------------------------
// Source import extraction
// ---------------------------------------------------------------------------

/** Module specifiers to exclude — React, styling, and hook libraries handled elsewhere. */
const SKIP_IMPORT_MODULES = new Set([
  'react', 'react-dom', 'react-dom/client', 'clsx',
]);

/** Module specifier prefixes to exclude. */
const SKIP_IMPORT_PREFIXES = [
  '@cloudscape-design/component-toolkit',  // hooks → controllers, handled by registry
];

/** Named imports to exclude (handled by other parts of the pipeline). */
const SKIP_IMPORT_NAMES = new Set([
  'applyDisplayName', 'getBaseProps', 'useBaseComponent', 'InternalBaseComponentProps',
  'getAnalyticsMetadataProps', 'getAnalyticsMetadataAttribute', 'getAnalyticsLabelAttribute',
  'checkSafeUrl', 'warnOnce', 'FunnelMetrics',
  // Event dispatchers — hardcoded by the emitter
  'fireNonCancelableEvent', 'fireCancelableEvent', 'fireKeyboardEvent',
  // React wrapper components converted by the component transform
  'WithNativeAttributes',
]);

function extractSourceImports(sourceFile: ts.SourceFile): ImportIR[] {
  const imports: ImportIR[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;

    // Skip React, clsx, toolkit hooks
    if (SKIP_IMPORT_MODULES.has(specifier)) continue;
    if (SKIP_IMPORT_PREFIXES.some(p => specifier.startsWith(p))) continue;
    // Skip CSS module imports (handled by styleImport)
    if (specifier.endsWith('.css') || specifier.endsWith('.css.js')) continue;
    // Skip relative imports to React component files (index, internal) —
    // these become custom element imports handled by the component transform.
    // But keep imports to utility/shared modules (keycode, utils, etc.).
    if ((specifier.startsWith('.') || specifier.startsWith('/')) && isComponentImportPath(specifier)) continue;

    const clause = stmt.importClause;
    if (!clause) {
      // Side-effect import: import 'foo'
      imports.push({ moduleSpecifier: specifier, isSideEffect: true });
      continue;
    }

    const namedImports: string[] = [];
    const typeOnlyNames: string[] = [];
    let defaultImport: string | undefined;

    if (clause.name) {
      defaultImport = clause.name.text;
      if (SKIP_IMPORT_NAMES.has(defaultImport)) defaultImport = undefined;
    }
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const name = (el.propertyName ?? el.name).text;
          if (SKIP_IMPORT_NAMES.has(name)) continue;
          // Track individual type-only imports: import { type Foo } from '...'
          if (el.isTypeOnly) {
            typeOnlyNames.push(el.name.text);
          } else {
            namedImports.push(el.name.text);
          }
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        // import * as foo — keep as default
        defaultImport = clause.namedBindings.name.text;
      }
    }

    if (defaultImport || namedImports.length > 0) {
      const isTypeOnly = !!stmt.importClause?.isTypeOnly;
      imports.push({
        moduleSpecifier: specifier,
        ...(defaultImport ? { defaultImport } : {}),
        ...(namedImports.length > 0 ? { namedImports } : {}),
        ...(isTypeOnly ? { isTypeOnly } : {}),
      });
    }
    // Individual type-only named imports: import { type Foo } from '...'
    if (typeOnlyNames.length > 0) {
      imports.push({
        moduleSpecifier: specifier,
        namedImports: typeOnlyNames,
        isTypeOnly: true,
      });
    }
  }

  return imports;
}

/**
 * Check if a relative import path points to a React component or
 * internal module that shouldn't be carried to the Lit output.
 *
 * Returns true to SKIP the import.
 */
function isComponentImportPath(specifier: string): boolean {
  // Exact patterns for component entry points
  if (specifier.endsWith('/index') || specifier.endsWith('/index.js')) return true;
  if (specifier.endsWith('/internal') || specifier.endsWith('/internal.js')) return true;
  // Test/mock patterns
  if (specifier.includes('__') || specifier.includes('.test')) return true;
  // Analytics metadata — generated code, not needed
  if (specifier.includes('analytics-metadata')) return true;
  // Analytics hooks — React-specific, handled by hook registry
  if (specifier.includes('analytics/hooks')) return true;
  // Context providers (already handled by transforms)
  if (specifier.includes('/context')) return true;
  // Hooks — handled by the hook registry
  if (specifier.includes('/hooks') || specifier.includes('use-')) return true;
  // Base component infrastructure
  if (specifier.includes('base-component') || specifier.includes('base-element')) return true;
  // i18n — needs separate Lit i18n strategy
  if (specifier.includes('/i18n')) return true;
  // ../component-name (bare parent-directory — resolved as /index by Node)
  // But not ./local-module (same-directory utility imports)
  if (specifier.startsWith('../')) {
    const segments = specifier.replace(/^\.\.\//, '').split('/');
    if (segments.length === 1 && !segments[0].includes('.')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Type parameter extraction
// ---------------------------------------------------------------------------

/**
 * Extract generic type parameters from the component function signature.
 * e.g., `function InternalAreaChart<T>({...}: AreaChartProps<T>)` → ['T']
 */
function extractTypeParams(component: RawComponent): string[] | undefined {
  if (component.parameters.length === 0) return undefined;
  const firstParam = component.parameters[0];
  if (!firstParam.type) return undefined;

  const typeArgs = getTypeArguments(firstParam.type);
  if (!typeArgs || typeArgs.length === 0) return undefined;

  const params: string[] = [];
  for (const arg of typeArgs) {
    if (ts.isTypeReferenceNode(arg) && ts.isIdentifier(arg.typeName)) {
      params.push(arg.typeName.text);
    }
  }
  return params.length > 0 ? params : undefined;
}

/** Extract type arguments from a type node (handles TypeReference and IntersectionType). */
function getTypeArguments(typeNode: ts.TypeNode): readonly ts.TypeNode[] | undefined {
  if (ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments) {
    return typeNode.typeArguments;
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    for (const member of typeNode.types) {
      if (ts.isTypeReferenceNode(member) && member.typeArguments) {
        return member.typeArguments;
      }
    }
  }
  return undefined;
}
