/**
 * React type cleanup transform.
 *
 * Replaces React-specific type annotations and API references with their
 * web-standard equivalents across all IR string fields.
 *
 * Rules are derived from standards, not hardcoded:
 * - React.XxxEvent → XxxEvent if it exists in DOM, otherwise Event
 * - React.useXxx → useXxx (drop namespace)
 * - React.Xxx<T> → small exceptions map for non-obvious mappings
 *
 * Runs on: handlers, effects, helpers, bodyPreamble, publicMethods,
 *          computedValues, template expressions.
 */
import type { ComponentIR, TemplateNodeIR } from '../ir/types.js';
import { getGlobalNames } from '../standards.js';

// ---------------------------------------------------------------------------
// Non-obvious mappings — only things that can't be derived from a rule.
// Everything else is handled by pattern rules below.
// ---------------------------------------------------------------------------

const REACT_EXCEPTIONS: Record<string, string> = {
  'React.CSSProperties': 'Record<string, string>',
  'React.Fragment': '',
  'React.createElement': 'document.createElement',
};

// ---------------------------------------------------------------------------
// Core replacement logic
// ---------------------------------------------------------------------------

function replaceReactTypes(text: string): string {
  if (!text.includes('React.')) return text;

  const domGlobals = getGlobalNames();
  let result = text;

  // 1. Apply explicit exceptions first
  for (const [from, to] of Object.entries(REACT_EXCEPTIONS)) {
    if (result.includes(from)) {
      result = result.replaceAll(from, to);
    }
  }

  // 2. React.forwardRef( → ( (strip wrapper)
  result = result.replace(/React\.forwardRef\(/g, '(');

  // 3. React.XxxEvent<T> → XxxEvent or Event (check DOM lib)
  result = result.replace(/React\.(\w+Event)(<[^>]*>)?/g, (_match, name: string) => {
    return domGlobals.has(name) ? name : 'Event';
  });

  // 4. React.ReactNode / React.ReactElement<T> → unknown
  result = result.replace(/React\.React\w+(<[^>]*>)?/g, 'unknown');

  // 5. React.Ref<T> / React.RefObject<T> / React.MutableRefObject<T> → any
  result = result.replace(/React\.(?:Mutable)?Ref(?:Object)?<[^>]*>/g, 'any');

  // 6. React.XxxHTMLAttributes<T> → Record<string, unknown>
  result = result.replace(/React\.\w+HTMLAttributes<[^>]*>/g, 'Record<string, unknown>');

  // 7. React.useXxx → useXxx (drop namespace)
  result = result.replace(/React\.(use\w+)/g, '$1');

  // 8. Catch-all: any remaining React.Xxx → strip React. prefix
  result = result.replace(/React\.(\w+)/g, (_match, name: string) => {
    return domGlobals.has(name) ? name : 'unknown';
  });

  return result;
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function cleanupReactTypes(ir: ComponentIR): ComponentIR {
  return {
    ...ir,
    handlers: ir.handlers.map(h => ({
      ...h,
      body: replaceReactTypes(h.body),
      returnType: h.returnType ? replaceReactTypes(h.returnType) : undefined,
    })),
    effects: ir.effects.map(e => ({
      ...e,
      body: replaceReactTypes(e.body),
      cleanup: e.cleanup ? replaceReactTypes(e.cleanup) : undefined,
    })),
    helpers: ir.helpers.map(h => ({
      ...h,
      source: replaceReactTypes(h.source),
    })),
    bodyPreamble: ir.bodyPreamble.map(replaceReactTypes),
    publicMethods: ir.publicMethods.map(m => ({
      ...m,
      body: replaceReactTypes(m.body),
      params: replaceReactTypes(m.params),
      returnType: m.returnType ? replaceReactTypes(m.returnType) : undefined,
    })),
    computedValues: ir.computedValues.map(c => ({
      ...c,
      expression: replaceReactTypes(c.expression),
      type: c.type ? replaceReactTypes(c.type) : undefined,
    })),
    template: replaceReactTypesInTemplate(ir.template),
  };
}

function replaceReactTypesInTemplate(node: TemplateNodeIR): TemplateNodeIR {
  const attributes = node.attributes.map(attr => {
    if (typeof attr.value === 'string') return attr;
    return { ...attr, value: { expression: replaceReactTypes(attr.value.expression) } };
  });

  let expression = node.expression;
  if (expression) expression = replaceReactTypes(expression);

  let condition = node.condition;
  if (condition) {
    condition = {
      ...condition,
      expression: replaceReactTypes(condition.expression),
      alternate: condition.alternate
        ? replaceReactTypesInTemplate(condition.alternate)
        : undefined,
    };
  }

  let loop = node.loop;
  if (loop) loop = { ...loop, iterable: replaceReactTypes(loop.iterable) };

  const children = node.children.map(replaceReactTypesInTemplate);

  return { ...node, attributes, children, expression, condition, loop };
}
