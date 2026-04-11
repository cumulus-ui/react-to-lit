/**
 * AST utility functions for the parser.
 */
import ts from 'typescript';
import { getNodeText } from './program.js';
import type { HandlerIR, HelperIR } from '../ir/types.js';

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
      const isDefaultExport = stmt.modifiers?.some(
        m => m.kind === ts.SyntaxKind.DefaultKeyword,
      );
      if (isDefaultExport) continue;

      const source = getNodeText(stmt, sourceFile);
      // Allow all helpers through — JSX pre-transform has already converted JSX to html``
      // Any remaining React patterns will be cleaned up by post-processing
      if (containsJSX(source) && !source.includes('html`') && !source.includes('html `')) continue;

      helpers.push({ name, source });
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
          if (containsJSX(source) && !source.includes('html`') && !source.includes('html `')) continue;

          helpers.push({ name, source });
        }
      }
    }
  }

  return helpers;
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

function isHookCall(expr: ts.Expression): boolean {
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
  // Arrow with expression body — usually inline, but include if it has params
  return fn.parameters.length > 0;
}

function isCloudscapeInfraFunction(name: string): boolean {
  const infraFunctions = new Set([
    'applyDisplayName',
    'getBaseProps',
    'getAnalyticsMetadataProps',
    'checkSafeUrl',
  ]);
  return infraFunctions.has(name);
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

function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
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
