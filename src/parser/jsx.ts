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
import { getBooleanAttributes } from '../standards.js';

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

  // Find the return statement(s)
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
    const exprText = getNodeText(expr, sourceFile);

    // Detect className with clsx
    if (name === 'className') {
      return {
        name: 'className',
        value: { expression: exprText },
        kind: 'classMap',
      };
    }

    // Detect event handlers: onClick, onFocus, etc.
    if (isEventAttributeName(name)) {
      return {
        name,
        value: { expression: exprText },
        kind: 'event',
      };
    }

    // Detect boolean bindings: ?disabled=${expr}
    if (isBooleanAttributeName(name)) {
      return {
        name,
        value: { expression: exprText },
        kind: 'boolean',
      };
    }

    // Property bindings: .value=${expr}
    if (isPropertyBinding(name)) {
      return {
        name,
        value: { expression: exprText },
        kind: 'property',
      };
    }

    // Default: dynamic attribute
    return {
      name,
      value: { expression: exprText },
      kind: 'property',
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
  return {
    kind: 'expression',
    attributes: [],
    children: [],
    expression: getNodeText(expr, sourceFile),
  };
}

// ---------------------------------------------------------------------------
// Conditional and loop parsing
// ---------------------------------------------------------------------------

function parseAndCondition(
  expr: ts.BinaryExpression,
  sourceFile: ts.SourceFile,
): TemplateNodeIR {
  const conditionExpr = getNodeText(expr.left, sourceFile);
  const consequent = parseExpression(expr.right, sourceFile);

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
  const body = ts.isBlock(callback.body)
    ? (() => {
        const ret = findReturnStatement(callback.body as ts.Block);
        return ret?.expression ? parseExpression(ret.expression, sourceFile) : null;
      })()
    : parseExpression(callback.body, sourceFile);

  if (!body) return null;

  return {
    ...body,
    loop: { iterable, variable, index },
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
  // HTML tags start with lowercase
  return /^[a-z]/.test(tag);
}

function isEventAttributeName(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

function isBooleanAttributeName(name: string): boolean {
  return getBooleanAttributes().has(name);
}

function isPropertyBinding(name: string): boolean {
  // Properties that should use .prop= binding instead of attr=
  const propertyBindings = new Set([
    'value', 'checked', 'indeterminate', 'selectedIndex',
  ]);
  return propertyBindings.has(name);
}

function findReturnStatement(block: ts.Block): ts.ReturnStatement | undefined {
  // Find the last return statement (there might be early returns)
  let lastReturn: ts.ReturnStatement | undefined;
  for (const stmt of block.statements) {
    if (ts.isReturnStatement(stmt)) {
      lastReturn = stmt;
    }
  }
  return lastReturn;
}
