/**
 * JSX template parser.
 *
 * Parses the JSX return statement of a React function component
 * into a TemplateNodeIR tree.
 */
import ts from 'typescript';
import type {
  TemplateNodeIR,
  AttributeIR,
  DynamicValueIR,
  ConditionIR,
  LoopIR,
} from '../ir/types.js';
import { getNodeText } from './program.js';
import { getHtmlTagNames } from '../standards.js';
import { classifyBinding } from '../naming.js';
import { convertJsxExpression } from './jsx-transform.js';

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Find the return statement in a function body and parse its JSX.
 */
export function parseJSXFromBody(
  body: ts.Block | ts.Expression,
  sourceFile: ts.SourceFile,
): TemplateNodeIR {
  if (!ts.isBlock(body)) {
    // Arrow function with expression body: () => <div>...</div>
    return parseExpression(body, sourceFile);
  }

  // Try conditional early return pattern: if (cond) { return <A>; } ... return <B>;
  const conditional = findConditionalReturns(body, sourceFile);
  if (conditional) {
    const consequent = parseExpression(conditional.consequentExpr, sourceFile);
    const alternate = parseExpression(conditional.alternateExpr, sourceFile);
    return {
      ...consequent,
      condition: {
        expression: conditional.condition,
        kind: 'ternary',
        alternate,
      },
    };
  }

  // Fall back to single return
  const returnStmt = findReturnStatement(body);
  if (!returnStmt?.expression) {
    return { kind: 'fragment', attributes: [], children: [] };
  }

  return parseExpression(returnStmt.expression, sourceFile);
}

// ---------------------------------------------------------------------------
// Expression parser (handles JSX, conditionals, maps, etc.)
// ---------------------------------------------------------------------------

function parseExpression(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): TemplateNodeIR {
  // Strip parenthesized expressions: (expr)
  if (ts.isParenthesizedExpression(expr)) {
    return parseExpression(expr.expression, sourceFile);
  }

  // Handle html`` tagged template expressions (from JSX transformer)
  // These are already valid Lit templates — emit as raw expression
  if (ts.isTaggedTemplateExpression(expr)) {
    const tag = expr.tag;
    if (ts.isIdentifier(tag) && tag.text === 'html') {
      // The entire html`` expression becomes the template
      // We emit it as a raw expression that the emitter outputs directly
      return {
        kind: 'expression',
        attributes: [],
        children: [],
        expression: getNodeText(expr, sourceFile),
      };
    }
  }

  // JSX Element: <div>...</div>
  if (ts.isJsxElement(expr)) {
    return parseJsxElement(expr, sourceFile);
  }

  // JSX Self-closing: <br />
  if (ts.isJsxSelfClosingElement(expr)) {
    return parseJsxSelfClosing(expr, sourceFile);
  }

  // JSX Fragment: <>...</>
  if (ts.isJsxFragment(expr)) {
    return parseJsxFragment(expr, sourceFile);
  }

  // Conditional: cond && <X/> or cond ? <A/> : <B/>
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return parseAndCondition(expr, sourceFile);
  }

  if (ts.isConditionalExpression(expr)) {
    return parseTernary(expr, sourceFile);
  }

  // Template literal or string
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return {
      kind: 'text',
      attributes: [],
      children: [],
      expression: expr.text,
    };
  }

  // Any other expression (variable reference, function call, etc.)
  return {
    kind: 'expression',
    attributes: [],
    children: [],
    expression: getNodeText(expr, sourceFile),
  };
}

// ---------------------------------------------------------------------------
// JSX Element parsers
// ---------------------------------------------------------------------------

function parseJsxElement(
  element: ts.JsxElement,
  sourceFile: ts.SourceFile,
): TemplateNodeIR {
  const tag = getTagName(element.openingElement.tagName, sourceFile);
  const attributes = parseJsxAttributes(element.openingElement.attributes, sourceFile);
  const children = parseJsxChildren(element.children, sourceFile);

  return {
    kind: isHtmlTag(tag) ? 'element' : 'component',
    tag,
    attributes,
    children,
  };
}

function parseJsxSelfClosing(
  element: ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
): TemplateNodeIR {
  const tag = getTagName(element.tagName, sourceFile);
  const attributes = parseJsxAttributes(element.attributes, sourceFile);

  return {
    kind: isHtmlTag(tag) ? 'element' : 'component',
    tag,
    attributes,
    children: [],
  };
}

function parseJsxFragment(
  fragment: ts.JsxFragment,
  sourceFile: ts.SourceFile,
): TemplateNodeIR {
  const children = parseJsxChildren(fragment.children, sourceFile);
  return {
    kind: 'fragment',
    attributes: [],
    children,
  };
}

// ---------------------------------------------------------------------------
// Attribute parsing
// ---------------------------------------------------------------------------

function parseJsxAttributes(
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
): AttributeIR[] {
  const result: AttributeIR[] = [];

  for (const attr of attributes.properties) {
    if (ts.isJsxAttribute(attr)) {
      const parsed = parseJsxAttribute(attr, sourceFile);
      if (parsed) result.push(parsed);
    } else if (ts.isJsxSpreadAttribute(attr)) {
      result.push({
        name: '',
        value: { expression: getNodeText(attr.expression, sourceFile) },
        kind: 'spread',
      });
    }
  }

  return result;
}

function parseJsxAttribute(
  attr: ts.JsxAttribute,
  sourceFile: ts.SourceFile,
): AttributeIR | null {
  const name = ts.isIdentifier(attr.name) ? attr.name.text : getNodeText(attr.name, sourceFile);

  // Boolean attribute: <input disabled />
  if (!attr.initializer) {
    return { name, value: 'true', kind: 'boolean' };
  }

  // String literal: <div className="foo" />
  if (ts.isStringLiteral(attr.initializer)) {
    return { name, value: attr.initializer.text, kind: 'static' };
  }

  // Expression: <div className={expr} />
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    const expr = attr.initializer.expression;

    // If the expression contains JSX (e.g., content={<>...</>} or content={cond ? <X/> : null}),
    // convert JSX parts to html`` inline
    const exprText = containsJsxNode(expr)
      ? jsxExpressionToLitText(expr, sourceFile)
      : getNodeText(expr, sourceFile);

    // Detect className with clsx
    if (name === 'className') {
      return {
        name: 'className',
        value: { expression: exprText },
        kind: 'classMap',
      };
    }

    return {
      name,
      value: { expression: exprText },
      kind: classifyBinding(name),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Children parsing
// ---------------------------------------------------------------------------

function parseJsxChildren(
  children: ts.NodeArray<ts.JsxChild>,
  sourceFile: ts.SourceFile,
): TemplateNodeIR[] {
  const result: TemplateNodeIR[] = [];

  for (const child of children) {
    const parsed = parseJsxChild(child, sourceFile);
    if (parsed) result.push(parsed);
  }

  return result;
}

function parseJsxChild(
  child: ts.JsxChild,
  sourceFile: ts.SourceFile,
): TemplateNodeIR | null {
  // Text content
  if (ts.isJsxText(child)) {
    const text = child.text.trim();
    if (!text) return null; // Skip whitespace-only text
    return { kind: 'text', attributes: [], children: [], expression: text };
  }

  // Expression: {expr}
  if (ts.isJsxExpression(child)) {
    if (!child.expression) return null;
    return parseJsxChildExpression(child.expression, sourceFile);
  }

  // Nested element
  if (ts.isJsxElement(child)) {
    return parseJsxElement(child, sourceFile);
  }

  // Self-closing element
  if (ts.isJsxSelfClosingElement(child)) {
    return parseJsxSelfClosing(child, sourceFile);
  }

  // Fragment
  if (ts.isJsxFragment(child)) {
    return parseJsxFragment(child, sourceFile);
  }

  return null;
}

/**
 * Parse an expression inside JSX children: {expression}
 * Handles conditionals, maps, and plain expressions.
 */
function parseJsxChildExpression(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): TemplateNodeIR | null {
  // Strip parentheses
  if (ts.isParenthesizedExpression(expr)) {
    return parseJsxChildExpression(expr.expression, sourceFile);
  }

  // Conditional: {cond && <X />}
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return parseAndCondition(expr, sourceFile);
  }

  // Ternary: {cond ? <A /> : <B />}
  if (ts.isConditionalExpression(expr)) {
    return parseTernary(expr, sourceFile);
  }

  // Map: {items.map(item => <X />)}
  if (ts.isCallExpression(expr)) {
    const loop = tryParseMapCall(expr, sourceFile);
    if (loop) return loop;
  }

  // Plain expression: {someValue}
  // If the expression contains JSX, convert it inline to html``
  const rawText = getNodeText(expr, sourceFile);
  const exprText = containsJsxNode(expr)
    ? jsxExpressionToLitText(expr, sourceFile)
    : rawText;
  return {
    kind: 'expression',
    attributes: [],
    children: [],
    expression: exprText,
  };
}

// ---------------------------------------------------------------------------
// Conditional and loop parsing
// ---------------------------------------------------------------------------

/**
 * Parse an expression in a conditional branch.
 * Currently delegates to parseExpression; exists as a seam for future
 * enhancement to handle .map() calls containing JSX.
 */
function parseExpressionOrMap(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): TemplateNodeIR {
  return parseExpression(expr, sourceFile);
}

function parseAndCondition(
  expr: ts.BinaryExpression,
  sourceFile: ts.SourceFile,
): TemplateNodeIR {
  const conditionExpr = getNodeText(expr.left, sourceFile);
  const consequent = parseExpressionOrMap(expr.right, sourceFile);

  return {
    ...consequent,
    condition: {
      expression: conditionExpr,
      kind: 'and',
    },
  };
}

function parseTernary(
  expr: ts.ConditionalExpression,
  sourceFile: ts.SourceFile,
): TemplateNodeIR {
  const conditionExpr = getNodeText(expr.condition, sourceFile);
  const consequent = parseExpression(expr.whenTrue, sourceFile);
  const alternate = parseExpression(expr.whenFalse, sourceFile);

  return {
    ...consequent,
    condition: {
      expression: conditionExpr,
      kind: 'ternary',
      alternate,
    },
  };
}

function tryParseMapCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): TemplateNodeIR | null {
  // items.map(item => <X />)
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  if (call.expression.name.text !== 'map') return null;
  if (call.arguments.length < 1) return null;

  const callback = call.arguments[0];
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return null;

  const iterable = getNodeText(call.expression.expression, sourceFile);
  const params = callback.parameters;
  const variable = params.length > 0 && ts.isIdentifier(params[0].name)
    ? params[0].name.text
    : '_item';
  const index = params.length > 1 && ts.isIdentifier(params[1].name)
    ? params[1].name.text
    : undefined;

  // Parse the callback body as JSX
  let preamble: string[] | undefined;
  const body = ts.isBlock(callback.body)
    ? (() => {
        const block = callback.body as ts.Block;

        // Try conditional early return pattern inside map callback
        const conditional = findConditionalReturns(block, sourceFile);
        if (conditional) {
          const stmts: string[] = [];
          for (const stmt of block.statements) {
            if (ts.isReturnStatement(stmt) || ts.isIfStatement(stmt)) break;
            stmts.push(getNodeText(stmt, sourceFile));
          }
          if (stmts.length > 0) preamble = stmts;
          const consequent = parseExpression(conditional.consequentExpr, sourceFile);
          const alternate = parseExpression(conditional.alternateExpr, sourceFile);
          return {
            ...consequent,
            condition: {
              expression: conditional.condition,
              kind: 'ternary' as const,
              alternate,
            },
          } as TemplateNodeIR;
        }

        const ret = findReturnStatement(block);
        const stmts: string[] = [];
        for (const stmt of block.statements) {
          if (ts.isReturnStatement(stmt)) break;
          stmts.push(getNodeText(stmt, sourceFile));
        }
        if (stmts.length > 0) preamble = stmts;
        return ret?.expression ? parseExpression(ret.expression, sourceFile) : null;
      })()
    : parseExpression(callback.body, sourceFile);

  if (!body) return null;

  // When the loop body is a conditional (ternary inside .map), wrap it in a
  // fragment so the loop contains the entire conditional — both branches
  // have access to the loop variable.
  if (body.condition) {
    return {
      kind: 'fragment',
      tag: undefined,
      attributes: [],
      children: [body],
      loop: { iterable, variable, index, preamble },
    };
  }

  return {
    ...body,
    loop: { iterable, variable, index, preamble },
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getTagName(tagName: ts.JsxTagNameExpression, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(tagName)) return tagName.text;
  if (ts.isPropertyAccessExpression(tagName)) return getNodeText(tagName, sourceFile);
  return getNodeText(tagName, sourceFile);
}

function isHtmlTag(tag: string): boolean {
  return getHtmlTagNames().has(tag);
}

function findReturnStatement(block: ts.Block): ts.ReturnStatement | undefined {
  let lastReturn: ts.ReturnStatement | undefined;
  for (const stmt of block.statements) {
    if (ts.isReturnStatement(stmt)) {
      lastReturn = stmt;
    }
  }
  return lastReturn;
}

/**
 * Detect `if (cond) { return <A>; } ... return <B>;` and fold to ternary.
 * Only handles the 2-branch case (one if-return + one final return).
 */
function findConditionalReturns(block: ts.Block, sourceFile: ts.SourceFile): {
  condition: string;
  consequentExpr: ts.Expression;
  alternateExpr: ts.Expression;
} | null {
  let ifWithReturn: { condition: ts.Expression; returnExpr: ts.Expression } | undefined;
  let finalReturn: ts.ReturnStatement | undefined;
  let ifReturnCount = 0;

  for (const stmt of block.statements) {
    if (ts.isIfStatement(stmt)) {
      const ret = getReturnFromBlock(stmt.thenStatement);
      if (ret) {
        ifReturnCount++;
        if (ifReturnCount > 1) return null;
        if (stmt.elseStatement) return null;
        ifWithReturn = { condition: stmt.expression, returnExpr: ret };
      }
    } else if (ts.isReturnStatement(stmt) && stmt.expression) {
      finalReturn = stmt;
    }
  }

  if (!ifWithReturn || !finalReturn?.expression) return null;

  return {
    condition: getNodeText(ifWithReturn.condition, sourceFile),
    consequentExpr: ifWithReturn.returnExpr,
    alternateExpr: finalReturn.expression,
  };
}

function getReturnFromBlock(stmt: ts.Statement): ts.Expression | undefined {
  if (ts.isReturnStatement(stmt) && stmt.expression) {
    return stmt.expression;
  }
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) {
      if (ts.isReturnStatement(s) && s.expression) {
        return s.expression;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JSX-in-expression helpers
// ---------------------------------------------------------------------------

/** Check if a TS node is JSX syntax (element, fragment, or self-closing). */
function isJsxNode(node: ts.Node): boolean {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node) ||
    ts.isParenthesizedExpression(node) && isJsxNode(node.expression)
  );
}

/** Check if a TS node or any of its descendants contain JSX syntax. */
function containsJsxNode(node: ts.Node): boolean {
  if (isJsxNode(node)) return true;
  return ts.forEachChild(node, containsJsxNode) ?? false;
}

/**
 * Convert a JSX expression to a Lit html`` tagged template string.
 * Used when JSX appears inside attribute values or expression positions
 * rather than at the template root.
 */
function jsxExpressionToLitText(expr: ts.Expression, sourceFile: ts.SourceFile): string {
  return convertJsxExpression(getNodeText(expr, sourceFile));
}
