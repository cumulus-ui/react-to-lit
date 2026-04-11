/**
 * Identifier rewriting transform.
 *
 * Rewrites React-style identifiers to Lit-style:
 * - props.foo → this.foo
 * - stateName (from useState) → this._stateName
 * - setStateName(val) → this._stateName = val
 * - refName.current → this._refName
 *
 * In template attribute expressions ONLY, also rewrites destructured
 * prop names: color → this.color (safe because template attribute
 * values are always expressions, never object keys or declarations).
 */
import ts from 'typescript';
import type {
  ComponentIR,
  TemplateNodeIR,
  AttributeIR,
} from '../ir/types.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function rewriteIdentifiers(ir: ComponentIR): ComponentIR {
  const stateMap = new Map<string, string>();
  const setterMap = new Map<string, string>();
  const refMap = new Map<string, string>();

  for (const s of ir.state) {
    stateMap.set(s.name, `_${s.name}`);
    setterMap.set(s.setter, `_${s.name}`);
  }

  for (const r of ir.refs) {
    refMap.set(r.name, `_${r.name}`);
  }

  // Safe rewriter: state, setters, refs, props.xxx — no bare prop name rewriting
  const rewriter = (text: string) =>
    rewriteSafe(text, stateMap, setterMap, refMap);

  // Prop names for rewriting (template expressions + code bodies)
  const propNames = new Set(ir.props.map((p) => p.name));
  // Exclude state/ref names from prop rewriting (they have their own patterns)
  for (const s of ir.state) { propNames.delete(s.name); propNames.delete(s.setter); }
  for (const r of ir.refs) { propNames.delete(r.name); }

  // Body rewriter: safe rewriting + AST-based prop name rewriting
  const bodyRewriter = (text: string) => {
    const safe = rewriter(text);
    return rewritePropNamesInBody(safe, propNames, ir.localVariables);
  };

  // Transform handlers
  const handlers = ir.handlers.map((h) => ({
    ...h,
    body: bodyRewriter(h.body),
  }));

  // Transform effects
  const effects = ir.effects.map((e) => ({
    ...e,
    body: bodyRewriter(e.body),
    cleanup: e.cleanup ? bodyRewriter(e.cleanup) : undefined,
  }));

  // Transform public methods
  const publicMethods = ir.publicMethods.map((m) => ({
    ...m,
    body: bodyRewriter(m.body),
  }));

  // Transform body preamble
  const bodyPreamble = ir.bodyPreamble.map(bodyRewriter);

  // Transform helpers
  const helpers = ir.helpers.map((h) => ({
    ...h,
    source: bodyRewriter(h.source),
  }));

  // Transform template expressions (with prop name rewriting in attributes)
  const template = rewriteTemplateNode(ir.template, rewriter, propNames);

  return {
    ...ir,
    handlers,
    effects,
    publicMethods,
    bodyPreamble,
    helpers,
    template,
  };
}

// ---------------------------------------------------------------------------
// Safe text rewriting (state, setters, refs, props.xxx)
// ---------------------------------------------------------------------------

function rewriteSafe(
  text: string,
  stateMap: Map<string, string>,
  setterMap: Map<string, string>,
  refMap: Map<string, string>,
): string {
  let result = text;

  // setFoo(val) → this._foo = val
  // Uses balanced paren matching for callbacks with nested parens
  for (const [setter, field] of setterMap) {
    const pattern = new RegExp(`\\b${esc(setter)}\\(`, 'g');
    let match;
    while ((match = pattern.exec(result)) !== null) {
      const start = match.index;
      const argStart = start + match[0].length;
      const argEnd = findMatchingParen(result, argStart - 1);
      if (argEnd === -1) continue;
      const arg = result.slice(argStart, argEnd);
      result = result.slice(0, start) + `this.${field} = ${arg}` + result.slice(argEnd + 1);
      pattern.lastIndex = start + `this.${field} = ${arg}`.length;
    }
  }

  // fooRef.current → this._fooRef
  for (const [refName, field] of refMap) {
    result = result.replace(
      new RegExp(`\\b${esc(refName)}\\.current\\b`, 'g'),
      `this.${field}`,
    );
  }

  // NOTE: We do NOT rewrite bare state names (e.g. annotations → this._annotations)
  // in code bodies. This breaks destructuring targets, object shorthands, and
  // object key positions. State names are only rewritten in template expressions
  // (via rewritePropNames) where the context is known to be safe.

  // props.foo → this.foo
  result = result.replace(/\bprops\.(\w+)/g, 'this.$1');

  return result;
}

// ---------------------------------------------------------------------------
// Template tree rewriting
// ---------------------------------------------------------------------------

function rewriteTemplateNode(
  node: TemplateNodeIR,
  rewriter: (text: string) => string,
  propNames: Set<string>,
): TemplateNodeIR {
  // Rewrite attribute expressions (with prop name rewriting)
  const attributes = node.attributes.map((attr) => {
    if (typeof attr.value === 'string') return attr;
    let expr = rewriter(attr.value.expression);
    // In template attributes, safe to rewrite prop names
    expr = rewritePropNames(expr, propNames);
    return { ...attr, value: { expression: expr } };
  });

  // Rewrite expression nodes
  let expression = node.expression;
  if (expression) {
    expression = rewriter(expression);
    expression = rewritePropNames(expression, propNames);
  }

  // Rewrite condition
  let condition = node.condition;
  if (condition) {
    let condExpr = rewriter(condition.expression);
    condExpr = rewritePropNames(condExpr, propNames);
    condition = {
      ...condition,
      expression: condExpr,
      alternate: condition.alternate
        ? rewriteTemplateNode(condition.alternate, rewriter, propNames)
        : undefined,
    };
  }

  // Rewrite loop
  let loop = node.loop;
  if (loop) {
    let iterable = rewriter(loop.iterable);
    iterable = rewritePropNames(iterable, propNames);
    loop = { ...loop, iterable };
  }

  // Recurse into children
  const children = node.children.map((c) =>
    rewriteTemplateNode(c, rewriter, propNames),
  );

  return { ...node, attributes, children, expression, condition, loop };
}

// ---------------------------------------------------------------------------
// Prop name rewriting (template-only, conservative)
// ---------------------------------------------------------------------------

/**
 * Rewrite bare prop names to this.propName.
 * Only applied in template expressions where the context is known to be
 * an expression value (not an object key, declaration, or parameter).
 */
function rewritePropNames(text: string, propNames: Set<string>): string {
  let result = text;
  for (const propName of propNames) {
    if (propName.length <= 2) continue;
    if (EXCLUDE.has(propName)) continue;
    // Match standalone identifier, but NOT in:
    // - object shorthand { foo, bar } (followed by , or })
    // - object key { foo: val } (followed by :)
    // - function call foo() (followed by ()
    // - assignment foo = (followed by =)
    // - property access foo.bar (preceded/followed by .)
    // - destructuring const { foo } (preceded by { or ,)
    result = result.replace(
      new RegExp(`(?<![\\w.\\-{,])\\b${esc(propName)}\\b(?![\\w.:\\-('"\`=,}])(?!\\s*[,}])`, 'g'),
      `this.${propName}`,
    );
  }
  return result;
}

/** Names that must NEVER be rewritten */
const EXCLUDE = new Set([
  'true', 'false', 'null', 'undefined', 'void',
  'event', 'index', 'value', 'item', 'key', 'error', 'target', 'result',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'Map', 'Set', 'Promise', 'JSON', 'Error', 'RegExp', 'Symbol',
  'console', 'document', 'window',
  'html', 'css', 'nothing', 'svg', 'classMap', 'ifDefined',
  'props', 'state',
]);

function esc(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingParen(text: string, openPos: number): number {
  let depth = 0;
  let i = openPos;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// AST-based prop name rewriting for code bodies
// ---------------------------------------------------------------------------

function rewritePropNamesInBody(
  text: string,
  propNames: Set<string>,
  componentLocalVars: Set<string>,
): string {
  if (propNames.size === 0) return text;

  let hasAnyPropName = false;
  for (const name of propNames) {
    if (name.length > 2 && !EXCLUDE.has(name) && text.includes(name)) {
      hasAnyPropName = true;
      break;
    }
  }
  if (!hasAnyPropName) return text;

  const prefix = 'function __wrapper() {\n';
  const suffix = '\n}';
  const wrapped = prefix + text + suffix;

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      '__body.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
    );
  } catch {
    return text;
  }

  const bodyLocals = new Set<string>();
  collectDeclaredNames(sourceFile, bodyLocals);

  const allLocals = new Set([...componentLocalVars, ...bodyLocals]);

  const replacements: Array<{ start: number; end: number; name: string }> = [];

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (
        name.length > 2 &&
        propNames.has(name) &&
        !EXCLUDE.has(name) &&
        !allLocals.has(name) &&
        shouldRewriteIdentifier(node)
      ) {
        const startInWrapped = node.getStart(sourceFile!);
        const startInOriginal = startInWrapped - prefix.length;
        if (startInOriginal >= 0 && startInOriginal < text.length) {
          replacements.push({ start: startInOriginal, end: startInOriginal + name.length, name });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  replacements.sort((a, b) => b.start - a.start);
  let result = text;
  for (const { start, end, name } of replacements) {
    result = result.slice(0, start) + `this.${name}` + result.slice(end);
  }

  return result;
}

function shouldRewriteIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;

  // obj.propName or this.propName — don't rewrite the name after dot
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;

  // { propName: value }
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;

  // { propName } (shorthand)
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;

  // const { propName } = obj (binding target)
  if (ts.isBindingElement(parent) && parent.name === node) return false;

  // const { originalName: propName } (binding property key)
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;

  // const propName = ...
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;

  // (propName) => ... or function(propName)
  if (ts.isParameter(parent) && parent.name === node) return false;

  // function propName() or method propName()
  if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) ||
       ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)) &&
      parent.name === node) return false;

  // import { propName } / export { propName }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;

  // Type positions
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
  if (ts.isPropertySignature(parent) && parent.name === node) return false;
  if (ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) return false;

  // Labels
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;

  // Enum member name
  if (ts.isEnumMember(parent) && parent.name === node) return false;

  return true;
}

function collectDeclaredNames(node: ts.Node, names: Set<string>): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    names.add(node.name.text);
  }
  if (ts.isParameter(node)) {
    if (ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    } else if (ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        if (ts.isIdentifier(el.name)) names.add(el.name.text);
      }
    } else if (ts.isArrayBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) names.add(el.name.text);
      }
    }
  }
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
    names.add(node.name.text);
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    names.add(node.name.text);
  }
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
    for (const el of node.name.elements) {
      if (ts.isIdentifier(el.name)) names.add(el.name.text);
    }
  }
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)) {
    for (const el of node.name.elements) {
      if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) names.add(el.name.text);
    }
  }
  ts.forEachChild(node, (child) => collectDeclaredNames(child, names));
}
