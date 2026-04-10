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
 * These are utility functions like `typeToIcon()` in status-indicator.
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
      // Skip internal Cloudscape helpers
      if (isCloudscapeInfraFunction(name)) continue;

      helpers.push({
        name,
        source: getNodeText(stmt, sourceFile),
      });
    }

    // Variable declarations with function values
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        if (name === componentFunctionName) continue;
        if (isCloudscapeInfraFunction(name)) continue;

        // Only include if the value is a function or object literal (like a map)
        if (
          ts.isArrowFunction(decl.initializer) ||
          ts.isFunctionExpression(decl.initializer) ||
          ts.isObjectLiteralExpression(decl.initializer)
        ) {
          helpers.push({
            name,
            source: getNodeText(stmt, sourceFile),
          });
        }
      }
    }
  }

  return helpers;
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
