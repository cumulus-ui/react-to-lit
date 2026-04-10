/**
 * Identifier rewriting transform.
 *
 * Rewrites React-style identifiers in handler bodies, effect bodies,
 * and template expressions to Lit-style:
 *
 * - props.foo → this.foo
 * - foo (destructured prop) → this.foo
 * - stateName (from useState) → this._stateName
 * - setStateName(val) → this._stateName = val
 * - refName.current → this._refName
 */
import type { ComponentIR, HandlerIR, EffectIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function rewriteIdentifiers(ir: ComponentIR): ComponentIR {
  // Build the rewrite map
  const propNames = new Set(ir.props.map((p) => p.name));
  const stateMap = new Map<string, string>(); // name → _name
  const setterMap = new Map<string, string>(); // setX → _x
  const refMap = new Map<string, string>(); // refName → _refName

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

  return {
    ...ir,
    handlers,
    effects,
    publicMethods,
    bodyPreamble,
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
    // Simple setter: setFoo(value)
    const setterPattern = new RegExp(`\\b${escapeRegex(setter)}\\(([^)]+)\\)`, 'g');
    result = result.replace(setterPattern, `this.${field} = $1`);
  }

  // Replace ref.current → this._refName
  for (const [refName, field] of refMap) {
    const refCurrentPattern = new RegExp(`\\b${escapeRegex(refName)}\\.current\\b`, 'g');
    result = result.replace(refCurrentPattern, `this.${field}`);
  }

  // Replace state variable references: stateName → this._stateName
  for (const [stateName, field] of stateMap) {
    const statePattern = new RegExp(`(?<!\\.)\\b${escapeRegex(stateName)}\\b(?!\\s*[:(])`, 'g');
    result = result.replace(statePattern, `this.${field}`);
  }

  // Replace props.foo → this.foo
  result = result.replace(/\bprops\.(\w+)/g, 'this.$1');

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
