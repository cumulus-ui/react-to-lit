/**
 * AST utility functions for the parser.
 */
import ts from 'typescript';
import { getNodeText } from './program.js';
import type { HandlerIR, HelperIR } from '../ir/types.js';
import { INFRA_FUNCTIONS } from '../cloudscape-config.js';
import { containsHtmlTemplate } from '../text-utils.js';
import { extractHooks } from './hooks.js';
import type { HookRegistry } from '../hooks/registry.js';

// ---------------------------------------------------------------------------
// Modifier helpers
// ---------------------------------------------------------------------------

/** Check whether a node carries a specific modifier keyword. */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some(m => m.kind === kind) === true;
}

/** Shorthand: node has the `export` keyword. */
export function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

/** Shorthand: node has the `default` keyword. */
export function isDefault(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

// ---------------------------------------------------------------------------
// Handler extraction (event handlers defined in the function body)
// ---------------------------------------------------------------------------

/**
 * Extract event handler functions defined in the component body.
 * Handles:
 * - const handleClick = (e: MouseEvent) => { ... }
 * - const handleClick = function(e: MouseEvent) { ... }
 * - function handleClick(e: MouseEvent) { ... }
 */
export function extractHandlers(
  body: ts.Block,
  sourceFile: ts.SourceFile,
): HandlerIR[] {
  const handlers: HandlerIR[] = [];

  for (const stmt of body.statements) {
    // const handleClick = (e) => { ... }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;

        const name = decl.name.text;
        // Skip hook calls — they're handled by hooks.ts
        if (isHookCall(decl.initializer)) continue;

        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          const fn = decl.initializer;
          // Skip if this looks like a JSX callback (too small, probably inline)
          if (isSignificantFunction(fn)) {
            handlers.push({
              name,
              params: fn.parameters.map((p) => getNodeText(p, sourceFile)).join(', '),
              body: ts.isBlock(fn.body)
                ? getNodeText(fn.body, sourceFile)
                : `{ return ${getNodeText(fn.body, sourceFile)}; }`,
              returnType: fn.type ? getNodeText(fn.type, sourceFile) : undefined,
            });
          }
        }
      }
    }

    // function handleClick(e) { ... }
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      handlers.push({
        name: stmt.name.text,
        params: stmt.parameters.map((p) => getNodeText(p, sourceFile)).join(', '),
        body: getNodeText(stmt.body, sourceFile),
        returnType: stmt.type ? getNodeText(stmt.type, sourceFile) : undefined,
      });
    }
  }

  return handlers;
}

// ---------------------------------------------------------------------------
// Helper function extraction (non-component functions in the same file)
// ---------------------------------------------------------------------------

/**
 * Extract top-level helper functions that are not the main component.
 * Includes both utility functions and render helpers (functions with html`` templates).
 * The JSX pre-transform has already converted JSX to html`` tagged templates before
 * this runs. Only functions with unconverted JSX (no html``) are still filtered out.
 */
export function extractHelpers(
  sourceFile: ts.SourceFile,
  componentFunctionName: string,
  hookRegistry?: HookRegistry,
): HelperIR[] {
  const helpers: HelperIR[] = [];

  for (const stmt of sourceFile.statements) {
    // Function declarations
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      if (name === componentFunctionName) continue;
      if (name === 'default') continue;
      if (isCloudscapeInfraFunction(name)) continue;
      if (isComponentImplementation(name, componentFunctionName)) continue;

      // Skip default exports (the main component is often export default function InternalXxx)
      if (isDefault(stmt)) continue;

      const source = getNodeText(stmt, sourceFile);
      // Allow all helpers through — JSX pre-transform has already converted JSX to html``
      // Any remaining React patterns will be cleaned up by post-processing
      if (containsJSX(source) && !containsHtmlTemplate(source)) continue;

      const helper: HelperIR = { name, source };
      if (hookRegistry && stmt.body) {
        extractHelperHooks(helper, stmt.body, sourceFile, hookRegistry);
      }
      helpers.push(helper);
    }

    // Variable declarations with function values
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        if (name === componentFunctionName) continue;
        if (isCloudscapeInfraFunction(name)) continue;
        if (isComponentImplementation(name, componentFunctionName)) continue;

        if (
          ts.isArrowFunction(decl.initializer) ||
          ts.isFunctionExpression(decl.initializer) ||
          ts.isObjectLiteralExpression(decl.initializer)
        ) {
          const source = getNodeText(stmt, sourceFile);
          // Allow all helpers through — JSX pre-transform has already converted JSX to html``
          // Any remaining React patterns will be cleaned up by post-processing
          if (containsJSX(source) && !containsHtmlTemplate(source)) continue;

          const helper: HelperIR = { name, source };
          if (hookRegistry) {
            const fn = decl.initializer;
            const body = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)
              ? fn.body : undefined;
            if (body && ts.isBlock(body)) {
              extractHelperHooks(helper, body, sourceFile, hookRegistry);
            }
          }
          helpers.push(helper);
        }
      }
    }
  }

  return helpers;
}

/**
 * Extract hooks from a helper function body and strip the hook call
 * statements from the helper's source text.
 *
 * Reuses `extractHooks` (the same logic that processes the main component)
 * and `isHookCall` (already used for handler extraction and preamble detection).
 */
function extractHelperHooks(
  helper: HelperIR,
  body: ts.Block,
  sourceFile: ts.SourceFile,
  hookRegistry: HookRegistry,
): void {
  const result = extractHooks(body, sourceFile, hookRegistry);

  // Nothing to do if the helper has no hooks
  const hasHooks =
    result.state.length > 0 ||
    result.effects.length > 0 ||
    result.refs.length > 0 ||
    result.computedValues.length > 0 ||
    result.handlers.length > 0 ||
    result.controllers.length > 0 ||
    result.contexts.length > 0 ||
    result.preservedVars.length > 0;
  if (!hasHooks) return;

  helper.hooks = result;

  // Strip hook call statements from the helper source text.
  // Collect ranges (relative to sourceFile) of statements that are hook calls,
  // then remove them from helper.source.
  const helperStart = sourceFile.text.indexOf(helper.source);
  if (helperStart === -1) return;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const stmt of body.statements) {
    let isHook = false;
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer && isHookCall(decl.initializer)) { isHook = true; break; }
      }
    }
    if (ts.isExpressionStatement(stmt) && isHookCall(stmt.expression)) {
      isHook = true;
    }
    if (isHook) {
      ranges.push({
        start: stmt.getStart(sourceFile) - helperStart,
        end: stmt.getEnd() - helperStart,
      });
    }
  }

  // Remove ranges in reverse order to preserve offsets
  let cleaned = helper.source;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { start, end } = ranges[i];
    // Also consume trailing newline/whitespace
    let trimEnd = end;
    while (trimEnd < cleaned.length && (cleaned[trimEnd] === '\n' || cleaned[trimEnd] === '\r')) {
      trimEnd++;
    }
    cleaned = cleaned.slice(0, start) + cleaned.slice(trimEnd);
  }
  helper.source = cleaned;
}

// ---------------------------------------------------------------------------
// File-level constant extraction
// ---------------------------------------------------------------------------

/**
 * Extract top-level constant/variable declarations that aren't functions,
 * classes, or the component itself. These are file-scope constants that
 * helpers and the component reference.
 */
export function extractFileConstants(
  sourceFile: ts.SourceFile,
  componentFunctionName: string,
): string[] {
  const constants: string[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;

    // Skip exported declarations (they're usually the component or re-exports)
    if (isExported(stmt)) continue;

    const decls = stmt.declarationList.declarations;
    let skip = false;

    for (const decl of decls) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;

      // Skip the component function
      if (name === componentFunctionName) { skip = true; break; }
      // Skip infrastructure
      if (isCloudscapeInfraFunction(name)) { skip = true; break; }
      if (isComponentImplementation(name, componentFunctionName)) { skip = true; break; }

      // Skip if the initializer is a function/arrow (already handled by extractHelpers)
      if (decl.initializer && (
        ts.isArrowFunction(decl.initializer) ||
        ts.isFunctionExpression(decl.initializer) ||
        ts.isObjectLiteralExpression(decl.initializer)
      )) { skip = true; break; }

      // Skip hook calls
      if (decl.initializer && isHookCall(decl.initializer)) { skip = true; break; }
    }

    if (skip) continue;

    const source = getNodeText(stmt, sourceFile);

    // Skip React imports/patterns
    if (source.includes('React.') || source.includes('createContext')) continue;
    // Skip CSS module imports (styles = require(...))
    if (source.includes('require(')) continue;

    constants.push(source);
  }

  return constants;
}

// ---------------------------------------------------------------------------
// File-level type declaration extraction
// ---------------------------------------------------------------------------

/**
 * Extract top-level type/interface declarations that aren't the main
 * component props interface. These are local types that helpers and
 * the component body reference.
 */
export function extractFileTypeDeclarations(
  sourceFile: ts.SourceFile,
  componentFunctionName: string,
): string[] {
  const types: string[] = [];
  const componentName = componentFunctionName.replace(/^Internal/, '');

  for (const stmt of sourceFile.statements) {
    // type Foo = ...
    if (ts.isTypeAliasDeclaration(stmt)) {
      const name = stmt.name.text;
      // Skip the main props interface (already handled by the emitter)
      if (isMainPropsType(name, componentName)) continue;
      // Skip React-specific types
      if (name.includes('React') || name.includes('JSX')) continue;
      // Skip analytics metadata types
      if (name.includes('GeneratedAnalytics')) continue;
      // Skip exported types (they belong in interfaces.ts)
      if (isExported(stmt)) continue;

      types.push(getNodeText(stmt, sourceFile));
    }

    // interface Foo { ... }
    if (ts.isInterfaceDeclaration(stmt)) {
      const name = stmt.name.text;
      if (isMainPropsType(name, componentName)) continue;
      if (name.includes('React') || name.includes('JSX')) continue;
      if (name.includes('GeneratedAnalytics')) continue;
      if (isExported(stmt)) continue;

      types.push(getNodeText(stmt, sourceFile));
    }

    // enum Foo { ... }
    if (ts.isEnumDeclaration(stmt)) {
      const name = stmt.name.text;
      if (isExported(stmt)) continue;
      types.push(getNodeText(stmt, sourceFile));
    }
  }

  return types;
}

/**
 * Check if source text contains raw JSX syntax (not html`` templates or type generics).
 */
function containsJSX(source: string): boolean {
  // className= is a definitive JSX indicator
  if (/\bclassName\s*[={]/.test(source)) return true;
  // JSX closing tag: </Component>
  if (/<\/[A-Z][a-zA-Z]+>/.test(source)) return true;
  // JSX self-closing with attributes: <Component prop=
  if (/<[A-Z][a-zA-Z]+\s+\w+\s*=/.test(source)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function isHookCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (ts.isIdentifier(callee) && callee.text.startsWith('use')) return true;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'React' &&
    callee.name.text.startsWith('use')
  ) {
    return true;
  }
  return false;
}

function isSignificantFunction(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  // Consider a function "significant" (worth extracting as a handler) if it
  // has a block body with at least one statement
  if (ts.isBlock(fn.body)) {
    return fn.body.statements.length >= 1;
  }
  // Arrow with expression body — significant if it has params OR if the
  // body is a function call (e.g., `() => doSomething()`). Only trivial
  // expression bodies like `() => false` or `() => null` are skipped.
  if (fn.parameters.length > 0) return true;
  return ts.isCallExpression(fn.body) || ts.isTaggedTemplateExpression(fn.body);
}

function isCloudscapeInfraFunction(name: string): boolean {
  return INFRA_FUNCTIONS.has(name);
}

/**
 * Check if a function name looks like the main component implementation.
 * Matches patterns like:
 * - InternalXxx for component Xxx
 * - XxxImplementation for component Xxx
 */
function isComponentImplementation(name: string, componentName: string): boolean {
  if (name === `Internal${componentName}`) return true;
  if (name === `${componentName}Implementation`) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Local variable collection (for scope-aware identifier rewriting)
// ---------------------------------------------------------------------------

/**
 * Collect all locally declared variable names from a function body.
 * These should NOT be rewritten to this.xxx by the identifier transform.
 *
 * Collects:
 * - const/let/var declarations: const foo = ...
 * - Destructured bindings: const { a, b } = ..., const [x, y] = ...
 * - Function declarations: function foo() {}
 * - For-loop variables: for (const item of ...)
 * - Catch clause variables: catch (err)
 *
 * Does NOT collect:
 * - Function parameters (those are props — handled separately)
 * - Import bindings (those are at file scope)
 */
export function collectLocalVariables(body: ts.Block): Set<string> {
  const locals = new Set<string>();

  function walk(node: ts.Node): void {
    // Variable declarations
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, locals);
    }

    // Function declarations (named)
    if (ts.isFunctionDeclaration(node) && node.name) {
      locals.add(node.name.text);
      // Also collect parameters of inner functions
      for (const param of node.parameters) {
        collectBindingNames(param.name, locals);
      }
    }

    // Arrow functions and function expressions — collect their params
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      for (const param of node.parameters) {
        collectBindingNames(param.name, locals);
      }
    }

    // For-of / for-in initializer
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const decl of node.initializer.declarations) {
          collectBindingNames(decl.name, locals);
        }
      }
    }

    // Catch clause
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, locals);
    }

    ts.forEachChild(node, walk);
  }

  walk(body);
  return locals;
}

export function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
  } else if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      collectBindingNames(element.name, names);
    }
  } else if (ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        collectBindingNames(element.name, names);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Props type detection
// ---------------------------------------------------------------------------

/**
 * Check whether a type name is the main component props interface.
 *
 * The main props type follows predictable naming patterns:
 *   - `{Component}Props`           (e.g., ModalProps)
 *   - `Internal{Component}Props`   (e.g., InternalModalProps)
 *
 * Other types ending in `Props` (e.g., PortaledModalProps,
 * DropdownContainerProps) are local helper types that should be
 * preserved in the output.
 */
function isMainPropsType(typeName: string, componentName: string): boolean {
  return (
    typeName === `${componentName}Props` ||
    typeName === `Internal${componentName}Props`
  );
}
