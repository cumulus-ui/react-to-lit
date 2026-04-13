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
import { extractHandlers, extractHelpers, extractFileConstants, extractFileTypeDeclarations, isHookCall, collectBindingNames, collectLocalVariables, isInfraFunction } from './utils.js';
import { createHookRegistry, type HookRegistry } from '../hooks/registry.js';
import { containsHtmlTemplate } from '../text-utils.js';
import { transformJsxToLit } from './jsx-transform.js';
import { toTagName, escapeRegex } from '../naming.js';
import { INFRA_FUNCTIONS, UNWRAP_COMPONENTS } from '../cloudscape-config.js';
import type { CompilerConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParseOptions {
  skipProps?: Set<string>;
  hookMappings?: HookRegistry;
  declarationsDir?: string;
  config?: CompilerConfig;
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
  const props = extractProps(component, sourceFile, options.skipProps ?? new Set(), componentDir, declarationsDir, dirName);

  // 5. Extract hooks from the implementation body
  const hookResult = ts.isBlock(component.body)
    ? extractHooks(component.body, sourceFile, hookRegistry, options.config?.cleanup)
    : { state: [], effects: [], refs: [], computedValues: [], handlers: [], publicMethods: [], controllers: [], contexts: [], skipped: [], unknown: [], preservedVars: [] };

  // 5b. Also extract hooks from the index.tsx wrapper (may have useImperativeHandle, etc.)
  // Public methods (focus, select) from useImperativeHandle reference hooks
  // in the index wrapper body (useRef, useMemo, custom hooks). We need to
  // merge those too, or the public methods will have dangling variable refs.
  if (component.hasInternal) {
    try {
      const indexComponent = findComponent(indexFile);
      if (ts.isBlock(indexComponent.body)) {
        const indexHooks = extractHooks(indexComponent.body, indexFile, hookRegistry, options.config?.cleanup);
        hookResult.publicMethods.push(...indexHooks.publicMethods);
        hookResult.contexts.push(...indexHooks.contexts);
        // Merge refs and preserved vars that publicMethods may reference
        const existingRefNames = new Set(hookResult.refs.map(r => r.name));
        for (const r of indexHooks.refs) {
          if (!existingRefNames.has(r.name)) hookResult.refs.push(r);
        }
        const existingPreserved = new Set(hookResult.preservedVars);
        for (const v of indexHooks.preservedVars) {
          if (!existingPreserved.has(v)) hookResult.preservedVars.push(v);
        }
      }
    } catch (e) {
      if (e instanceof Error && !e.message.includes('No component found')) {
        console.warn(`[react-to-lit] Warning: failed to parse index component for ${dirName}: ${e.message}`);
      }
    }
  }

  // 6. Extract standalone event handlers
  const handlers = ts.isBlock(component.body)
    ? extractHandlers(component.body, sourceFile)
    : [];

  // 6b. Collect local variable names for scope-aware identifier rewriting
  const localVariables = ts.isBlock(component.body)
    ? collectLocalVariables(component.body)
    : new Set<string>();

  // 7. Template was already parsed in Phase A from the original TSX

  // 8. Extract body preamble (code between hooks/handlers and return)
  //    JSX-containing variables become render helpers instead of preamble.
  const configInfraFunctions = options.config?.cleanup.infraFunctions
    ? new Set(options.config.cleanup.infraFunctions)
    : undefined;
  const { preamble: bodyPreamble, renderHelpers, preambleVars } = ts.isBlock(component.body)
    ? extractBodyPreamble(component.body, sourceFile, configInfraFunctions)
    : { preamble: [], renderHelpers: [], preambleVars: [] as PreambleVar[] };

  // 9. Extract helper functions (file-level, outside the component)
  const implFile = internalFile ?? indexFile;
  const helpers = [...extractHelpers(implFile, component.name, hookRegistry, configInfraFunctions), ...renderHelpers];

  // 9a. Merge hooks extracted from helper function bodies into the main IR.
  // Helpers that are component-like functions (have hooks) get their hooks
  // extracted by extractHelpers. We merge them here so the identifier
  // rewriter and emitter see them as class-level fields.
  // Deduplicate by name to avoid TS2300 when both main component and
  // a helper declare the same hook variable (e.g., both call useVisualRefresh).
  const existingStateNames = new Set(hookResult.state.map(s => s.name));
  const existingRefNames = new Set(hookResult.refs.map(r => r.name));
  const existingComputedNames = new Set(hookResult.computedValues.map(c => c.name));
  const existingHandlerNames = new Set(hookResult.handlers.map(h => h.name));
  const existingPreservedVars = new Set(hookResult.preservedVars);
  for (const helper of helpers) {
    if (!helper.hooks) continue;
    for (const s of helper.hooks.state) {
      if (!existingStateNames.has(s.name)) { hookResult.state.push(s); existingStateNames.add(s.name); }
    }
    hookResult.effects.push(...helper.hooks.effects);
    for (const r of helper.hooks.refs) {
      if (!existingRefNames.has(r.name)) { hookResult.refs.push(r); existingRefNames.add(r.name); }
    }
    for (const c of helper.hooks.computedValues) {
      if (!existingComputedNames.has(c.name)) { hookResult.computedValues.push(c); existingComputedNames.add(c.name); }
    }
    for (const h of helper.hooks.handlers) {
      if (!existingHandlerNames.has(h.name)) { hookResult.handlers.push(h); existingHandlerNames.add(h.name); }
    }
    hookResult.controllers.push(...helper.hooks.controllers);
    hookResult.contexts.push(...helper.hooks.contexts);
    for (const v of helper.hooks.preservedVars) {
      if (!existingPreservedVars.has(v)) { hookResult.preservedVars.push(v); existingPreservedVars.add(v); }
    }
  }

  // 9c. Merge all handlers: useCallback + standalone + helper-extracted
  const allHandlers = [...hookResult.handlers, ...handlers];

  // 9d. Promote preamble variables that are referenced by handlers, helpers,
  //     or effects to computed values — they need class-level scope since
  //     handlers/helpers become separate class methods.
  //     Run iteratively: promoted computed values may reference other preamble
  //     variables that then also need promotion.
  let currentPreambleVars = preambleVars;
  let currentBodyPreamble = bodyPreamble;
  let allPromotedComputedValues: import('../ir/types.js').ComputedIR[] = [];
  const allComputedValues = [...hookResult.computedValues];

  for (let round = 0; round < 5; round++) {
    const promotedVars = promotePreambleVars(
      currentPreambleVars,
      currentBodyPreamble,
      allHandlers,
      helpers,
      hookResult.effects,
      hookResult.publicMethods,
      allComputedValues,
      localVariables,
    );
    if (promotedVars.computedValues.length === 0) break;
    allPromotedComputedValues = [...allPromotedComputedValues, ...promotedVars.computedValues];
    allComputedValues.push(...promotedVars.computedValues);
    currentBodyPreamble = promotedVars.bodyPreamble;
    // Remove promoted vars from preambleVars for next round
    const promotedNames = new Set(promotedVars.computedValues.map(c => c.name));
    currentPreambleVars = currentPreambleVars.filter(pv => !promotedNames.has(pv.name));
  }

  // 9b. Extract file-level constants
  const fileConstants = extractFileConstants(implFile, component.name, configInfraFunctions);

  // 9c. Extract file-level type declarations
  const fileTypeDeclarations = extractFileTypeDeclarations(implFile, component.name, options.config?.components?.stripPrefixes);

  // 10. Derive component metadata
  const componentName = deriveComponentName(component.name, componentDir, options.config?.components?.stripPrefixes);
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
    computedValues: [...hookResult.computedValues, ...allPromotedComputedValues],
    controllers: hookResult.controllers,
    mixins,
    contexts: hookResult.contexts,
    imports: extractSourceImports(sourceFile, buildSkipImportNames(hookRegistry, options.config)),
    styleImport,
    publicMethods: hookResult.publicMethods,
    helpers,
    fileConstants,
    fileTypeDeclarations,
    bodyPreamble: currentBodyPreamble,
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
function deriveComponentName(functionName: string, componentDir: string, stripPrefixes?: string[]): string {
  let name = functionName;
  for (const prefix of stripPrefixes ?? []) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }

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
// Preamble variable promotion
// ---------------------------------------------------------------------------

/**
 * Detect preamble variables that are referenced by handlers, helpers,
 * effects, public methods, or other computed values, and promote them
 * to ComputedIR entries so they become class-level getters accessible
 * from all methods.
 *
 * In React, the component function body is a single flat scope — local
 * variables are visible to all closures.  In the Lit class, handlers and
 * helpers become separate methods, so variables scoped to render() are
 * not accessible.  Promoting them to computed getters restores the
 * original scoping semantics.
 */
function promotePreambleVars(
  preambleVars: PreambleVar[],
  bodyPreamble: string[],
  handlers: import('../ir/types.js').HandlerIR[],
  helpers: import('../ir/types.js').HelperIR[],
  effects: import('../ir/types.js').EffectIR[],
  publicMethods: import('../ir/types.js').PublicMethodIR[],
  computedValues: import('../ir/types.js').ComputedIR[],
  localVariables: Set<string>,
): {
  bodyPreamble: string[];
  computedValues: import('../ir/types.js').ComputedIR[];
} {
  if (preambleVars.length === 0) {
    return { bodyPreamble, computedValues: [] };
  }

  // Collect all text from code bodies that live outside render()
  const outsideTexts: string[] = [];
  for (const h of handlers) outsideTexts.push(h.body);
  for (const h of helpers) outsideTexts.push(h.source);
  for (const e of effects) {
    outsideTexts.push(e.body);
    if (e.cleanup) outsideTexts.push(e.cleanup);
  }
  for (const m of publicMethods) outsideTexts.push(m.body);
  for (const c of computedValues) outsideTexts.push(c.expression);

  const outsideText = outsideTexts.join('\n');

  // Find preamble variables referenced in outside-render code
  const promotedNames = new Set<string>();
  for (const pv of preambleVars) {
    // Use word-boundary check to avoid partial matches
    const pattern = new RegExp(`\\b${escapeRegex(pv.name)}\\b`);
    if (pattern.test(outsideText)) {
      promotedNames.add(pv.name);
    }
  }

  if (promotedNames.size === 0) {
    return { bodyPreamble, computedValues: [] };
  }

  // Build promoted ComputedIR entries and filter bodyPreamble
  const promoted: import('../ir/types.js').ComputedIR[] = [];
  const filteredPreamble: string[] = [];

  // Track which preamble statements to keep vs remove
  const promotedVarNames = new Set<string>();
  for (const pv of preambleVars) {
    if (promotedNames.has(pv.name)) {
      promoted.push({
        name: pv.name,
        expression: pv.expression,
        deps: [],
      });
      promotedVarNames.add(pv.name);
      // Remove from localVariables so the identifier rewriter will add this. prefix
      localVariables.delete(pv.name);
    }
  }

  // Filter out preamble statements that declare promoted variables.
  // A statement may declare multiple variables; remove it only if ALL
  // its declarations were promoted.
  for (const stmt of bodyPreamble) {
    // Check if this statement declares promoted variables.
    // Simple: const name = ...
    const simpleDeclMatch = stmt.match(/^(?:const|let|var)\s+(\w+)\s*=/);
    if (simpleDeclMatch && promotedVarNames.has(simpleDeclMatch[1])) {
      continue; // skip — promoted
    }
    // Destructured: const { a, b, c } = ... or const [a, b] = ...
    const destructMatch = stmt.match(/^(?:const|let|var)\s+[\[{]([^=]+)[\]}]\s*=/);
    if (destructMatch) {
      const bindingNames = destructMatch[1]
        .split(',')
        .map(s => s.replace(/\s*:.*$/, '').trim()) // strip `: alias` and whitespace
        .filter(Boolean);
      if (bindingNames.length > 0 && bindingNames.every(n => promotedVarNames.has(n))) {
        continue; // skip — all bindings promoted
      }
    }
    filteredPreamble.push(stmt);
  }

  return { bodyPreamble: filteredPreamble, computedValues: promoted };
}

// ---------------------------------------------------------------------------
// Body preamble extraction
// ---------------------------------------------------------------------------

/**
 * A preamble variable declaration: `const name = expression`.
 * Used to promote cross-referenced variables to class-level computed values.
 */
interface PreambleVar {
  name: string;
  expression: string;
}

/**
 * Extract statements from the component body that are between hook calls
 * and the return statement. These are typically variable assignments,
 * object builds, and conditional logic.
 */
interface PreambleResult {
  preamble: string[];
  renderHelpers: import('../ir/types.js').HelperIR[];
  /** Simple `const name = expression` declarations from the preamble */
  preambleVars: PreambleVar[];
}

function extractBodyPreamble(
  body: ts.Block,
  sourceFile: ts.SourceFile,
  infraFunctions?: Set<string>,
): PreambleResult {
  const preamble: string[] = [];
  const renderHelpers: import('../ir/types.js').HelperIR[] = [];
  const preambleVars: PreambleVar[] = [];

  // Determine if the component body contains any hooks or handler declarations.
  // If not, the entire body between the first statement and the return is preamble.
  const hasHooksOrHandlers = body.statements.some(
    (stmt) => isHookCallStatement(stmt) || isHandlerDeclaration(stmt),
  );
  let pastHooks = !hasHooksOrHandlers;

  for (const stmt of body.statements) {
    // Skip return statements
    if (ts.isReturnStatement(stmt)) break;

    // Detect hook calls and handler declarations (already captured elsewhere)
    if (isHookCallStatement(stmt) || isHandlerDeclaration(stmt)) {
      pastHooks = true;
      continue;
    }

    // Capture preamble code: both pre-hook setup statements and
    // post-hook computations. In React all these are in the same
    // flat function scope.
    // Skip pre-hook statements that destructure the raw props parameter
    // (those are infrastructure, not user logic).
    if (!pastHooks) {
      const text = sourceFile.text.slice(stmt.getStart(sourceFile), stmt.getEnd());
      if (text.includes('props')) continue;
    }
    {
      const text = sourceFile.text.slice(stmt.getStart(sourceFile), stmt.getEnd());
      // Skip infrastructure functions
      if ([...(infraFunctions ?? INFRA_FUNCTIONS)].some(fn => text.includes(fn))) continue;
      // Skip dev-only validation blocks (contain hooks that violate rules-of-hooks)
      if (ts.isIfStatement(stmt) && text.includes('isDevelopment')) continue;

      // Skip bare function call expression statements.
      // In a React component body, bare calls (not assignments, not declarations)
      // are side-effects: validation, registration, analytics, etc.
      // They don't produce values the template needs, and the called function
      // is often not available in the Lit output.
      if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) continue;

      // Check if this is a variable containing a template (html`...`)
      // These become render helper methods instead of bodyPreamble —
      // BUT only if the variable is directly a template or a function
      // returning a template. Array expressions (.map results) that
      // happen to contain templates in element properties are data,
      // not render functions.
      if (ts.isVariableStatement(stmt) && containsHtmlTemplate(text)) {
        let allHandledAsHelpers = true;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const name = decl.name.text;
            const initText = sourceFile.text.slice(decl.initializer.getStart(sourceFile), decl.initializer.getEnd());
            if (containsHtmlTemplate(initText) && isTemplateVariable(decl.initializer)) {
              // Convert to a render helper: const header = html`...` → function header() { return html`...`; }
              renderHelpers.push({
                name,
                source: `function ${name}() {\n  return ${initText};\n}`,
              });
              continue;
            }
          }
          allHandledAsHelpers = false;
        }
        if (allHandledAsHelpers) continue;
        // Fall through to add as preamble if not all decls were helpers
      }

      preamble.push(text);

      // Track simple variable declarations for potential promotion
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer) {
            const expr = sourceFile.text.slice(
              decl.initializer.getStart(sourceFile),
              decl.initializer.getEnd(),
            );
            if (ts.isIdentifier(decl.name)) {
              preambleVars.push({ name: decl.name.text, expression: expr });
            } else if (ts.isObjectBindingPattern(decl.name)) {
              // const { a, b } = expr → each binding becomes a preambleVar
              for (const el of decl.name.elements) {
                if (ts.isIdentifier(el.name)) {
                  const propName = el.propertyName && ts.isIdentifier(el.propertyName)
                    ? el.propertyName.text
                    : el.name.text;
                  preambleVars.push({
                    name: el.name.text,
                    expression: `(${expr}).${propName}`,
                  });
                }
              }
            } else if (ts.isArrayBindingPattern(decl.name)) {
              // const [a, b] = expr → each binding becomes a preambleVar
              for (let i = 0; i < decl.name.elements.length; i++) {
                const el = decl.name.elements[i];
                if (!ts.isOmittedExpression(el) && ts.isIdentifier(el.name)) {
                  preambleVars.push({
                    name: el.name.text,
                    expression: `(${expr})[${i}]`,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return { preamble, renderHelpers, preambleVars };
}

/**
 * Check if a variable initializer is directly a template or a function
 * producing a template. Returns false for array/method-call expressions
 * that happen to contain templates in element properties — those are
 * data, not render functions.
 */
function isTemplateVariable(init: ts.Expression): boolean {
  // Direct template: html`...` or just `...`
  if (ts.isTaggedTemplateExpression(init) || ts.isTemplateExpression(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
    return true;
  }
  // Arrow function or function expression — likely a render helper
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return true;
  }
  // Conditional: cond ? html`a` : html`b`
  if (ts.isConditionalExpression(init)) {
    return true;
  }
  // Parenthesized: (html`...`)
  if (ts.isParenthesizedExpression(init)) {
    return isTemplateVariable(init.expression);
  }
  // Everything else (method calls, array literals, object literals) is data
  return false;
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

/**
 * Build the set of import names to skip, derived from:
 * - The hook registry (all registered hooks are handled by the hook pipeline)
 * - Infrastructure functions (handled by the cleanup pipeline)
 * - The emitter's own generated names (to avoid duplicates)
 * - Wrapper components that are unwrapped by the template transform
 *
 * This keeps the parser general-purpose — no hardcoded library-specific names.
 */
function buildSkipImportNames(hookRegistry: HookRegistry, config?: CompilerConfig): Set<string> {
  const names = new Set<string>();

  // All registered hooks are handled by the hook extraction pipeline
  for (const hookName of Object.keys(hookRegistry)) {
    names.add(hookName);
  }

  // Infrastructure functions stripped by cleanup transforms
  const infraFns = config?.cleanup.infraFunctions
    ? new Set(config.cleanup.infraFunctions)
    : INFRA_FUNCTIONS;
  for (const fn of infraFns) {
    names.add(fn);
  }

  // Event dispatch function names the emitter generates its own imports for
  if (config?.events.dispatchFunctions) {
    for (const fnName of Object.keys(config.events.dispatchFunctions)) {
      names.add(fnName);
    }
  } else {
    names.add('fireNonCancelableEvent');
    names.add('fireCancelableEvent');
    names.add('fireKeyboardEvent');
  }

  // Wrapper components unwrapped by the template transform
  const unwrapSet = config?.cleanup.unwrapComponents
    ? new Set(config.cleanup.unwrapComponents)
    : UNWRAP_COMPONENTS;
  for (const name of unwrapSet) {
    names.add(name);
  }

  return names;
}

function extractSourceImports(sourceFile: ts.SourceFile, skipNames: Set<string>): ImportIR[] {
  const imports: ImportIR[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;

    // Skip React, clsx
    if (SKIP_IMPORT_MODULES.has(specifier)) continue;
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
      if (skipNames.has(defaultImport)) defaultImport = undefined;
    }
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const name = (el.propertyName ?? el.name).text;
          // Named imports are preserved — the emitter filters unused
          // ones by reference checking and handles deduplication.
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
  // Only skip `/index` imports that look like component entry points,
  // NOT utility modules under /internal/generated/ etc.
  if (specifier.endsWith('/index') || specifier.endsWith('/index.js')) {
    // Keep imports from generated utility modules (CSS custom properties, etc.)
    if (specifier.includes('/generated/')) return false;
    return true;
  }
  if (specifier.endsWith('/internal') || specifier.endsWith('/internal.js')) return true;
  // Test/mock patterns
  if (specifier.includes('__') || specifier.includes('.test')) return true;
  // Analytics metadata — generated code, not needed
  if (specifier.includes('analytics-metadata')) return true;
  // Analytics hooks — React-specific, handled by hook registry
  if (specifier.includes('analytics/hooks')) return true;
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
