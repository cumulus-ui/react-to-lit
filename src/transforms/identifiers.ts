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

  // Prop names for template-only rewriting
  const propNames = new Set(ir.props.map((p) => p.name));
  // Exclude state/ref names from prop rewriting (they have their own patterns)
  for (const s of ir.state) { propNames.delete(s.name); propNames.delete(s.setter); }
  for (const r of ir.refs) { propNames.delete(r.name); }

  // Transform handlers
  const handlers = ir.handlers.map((h) => ({
    ...h,
    body: rewriter(h.body),
  }));

  // Transform effects
  const effects = ir.effects.map((e) => ({
    ...e,
    body: rewriter(e.body),
    cleanup: e.cleanup ? rewriter(e.cleanup) : undefined,
  }));

  // Transform public methods
  const publicMethods = ir.publicMethods.map((m) => ({
    ...m,
    body: rewriter(m.body),
  }));

  // Transform body preamble
  const bodyPreamble = ir.bodyPreamble.map(rewriter);

  // Transform helpers
  const helpers = ir.helpers.map((h) => ({
    ...h,
    source: rewriter(h.source),
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
  for (const [setter, field] of setterMap) {
    result = result.replace(
      new RegExp(`\\b${esc(setter)}\\(([^)]+)\\)`, 'g'),
      `this.${field} = $1`,
    );
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
      new RegExp(`(?<![\\w.\\-{,])\\b${esc(propName)}\\b(?![\\w.:\\-('"\`=,}])`, 'g'),
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
  'props', 'state', 'style',
]);

function esc(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
