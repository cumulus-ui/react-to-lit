/**
 * Identifier rewriting transform.
 *
 * Rewrites React-style identifiers to Lit-style across ALL code:
 * handlers, effects, public methods, body preamble, helpers, AND templates.
 *
 * - props.foo → this.foo
 * - foo (destructured prop) → this.foo
 * - stateName (from useState) → this._stateName
 * - setStateName(val) → this._stateName = val
 * - refName.current → this._refName
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
  // Build the rewrite map
  const propNames = new Set(ir.props.map((p) => p.name));
  // Also include event props — they appear in handler bodies
  const eventPropNames = new Set(
    ir.props.filter((p) => p.category === 'event').map((p) => p.name),
  );
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

  const rewriter = (text: string) =>
    rewriteText(text, propNames, stateMap, setterMap, refMap);

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

  // Transform template expressions
  const template = rewriteTemplateIdentifiers(ir.template, rewriter);

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
// Template expression rewriting
// ---------------------------------------------------------------------------

function rewriteTemplateIdentifiers(
  node: TemplateNodeIR,
  rewriter: (text: string) => string,
): TemplateNodeIR {
  // Rewrite attribute expressions
  const attributes = node.attributes.map((attr) =>
    rewriteAttrIdentifiers(attr, rewriter),
  );

  // Rewrite expression nodes
  let expression = node.expression;
  if (expression) {
    expression = rewriter(expression);
  }

  // Rewrite condition expression
  let condition = node.condition;
  if (condition) {
    condition = {
      ...condition,
      expression: rewriter(condition.expression),
      alternate: condition.alternate
        ? rewriteTemplateIdentifiers(condition.alternate, rewriter)
        : undefined,
    };
  }

  // Rewrite loop expressions
  let loop = node.loop;
  if (loop) {
    loop = {
      ...loop,
      iterable: rewriter(loop.iterable),
    };
  }

  // Recurse into children
  const children = node.children.map((c) =>
    rewriteTemplateIdentifiers(c, rewriter),
  );

  return {
    ...node,
    attributes,
    children,
    expression,
    condition,
    loop,
  };
}

function rewriteAttrIdentifiers(
  attr: AttributeIR,
  rewriter: (text: string) => string,
): AttributeIR {
  if (typeof attr.value === 'string') return attr;
  return {
    ...attr,
    value: { expression: rewriter(attr.value.expression) },
  };
}

// ---------------------------------------------------------------------------
// Text rewriting
// ---------------------------------------------------------------------------

function rewriteText(
  text: string,
  propNames: Set<string>,
  stateMap: Map<string, string>,
  setterMap: Map<string, string>,
  refMap: Map<string, string>,
): string {
  let result = text;

  // Replace setter calls: setFoo(val) → this._foo = val
  for (const [setter, field] of setterMap) {
    const setterPattern = new RegExp(`\\b${escapeRegex(setter)}\\(([^)]+)\\)`, 'g');
    result = result.replace(setterPattern, `this.${field} = $1`);
  }

  // Replace ref.current → this._refName
  for (const [refName, field] of refMap) {
    const refCurrentPattern = new RegExp(`\\b${escapeRegex(refName)}\\.current\\b`, 'g');
    result = result.replace(refCurrentPattern, `this.${field}`);

    // Also handle bare ref name (not .current) when used as a value
    const refBarePattern = new RegExp(`(?<!\\.)\\b${escapeRegex(refName)}\\b(?!\\.current)(?!\\s*[:(=])`, 'g');
    result = result.replace(refBarePattern, `this.${field}`);
  }

  // Replace state variable references: stateName → this._stateName
  for (const [stateName, field] of stateMap) {
    const statePattern = new RegExp(`(?<!\\.)\\b${escapeRegex(stateName)}\\b(?!\\s*[:(])`, 'g');
    result = result.replace(statePattern, `this.${field}`);
  }

  // Replace props.foo → this.foo
  result = result.replace(/\bprops\.(\w+)/g, 'this.$1');

  // Replace destructured prop names: foo → this.foo
  // Only replace if it's a standalone identifier (not inside a word, not property access)
  for (const propName of propNames) {
    // Skip very short names and common variable names to avoid false positives
    if (propName.length <= 2) continue;
    if (COMMON_LOCALS.has(propName)) continue;

    // Require the identifier to NOT be preceded by a letter, digit, _, ., -, or '
    // and NOT followed by a letter, digit, _, ., :, (, = or '
    const propPattern = new RegExp(
      `(?<![\\w.\\-'"\`])${escapeRegex(propName)}(?![\\w.:'"\`(=])`,
      'g',
    );
    result = result.replace(propPattern, `this.${propName}`);
  }

  return result;
}

// Variable names that should NOT be rewritten to this.xxx
const COMMON_LOCALS = new Set([
  'e', 'i', 'j', 'k', 'n', 'x', 'y',
  'el', 'fn', 'cb', 'id',
  'key', 'ref', 'tag', 'val', 'err', 'evt', 'arg', 'idx', 'len',
  'item', 'node', 'list', 'data', 'prev', 'next', 'self', 'that',
  'true', 'false', 'null', 'undefined', 'void',
  'event', 'index', 'child', 'error', 'result', 'target',
  'width', 'height',
  'props', 'state', 'attrs',
  // Don't rewrite loop variables or common JS builtins
  'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'console', 'document', 'window', 'setTimeout', 'clearTimeout',
  'Promise', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
]);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
