/**
 * React type cleanup transform.
 *
 * Replaces React-specific type annotations and API references with their
 * web-standard equivalents across all IR string fields.
 *
 * This is a deterministic mapping — every React type has exactly one
 * correct web platform equivalent. No heuristics.
 *
 * Runs on: handlers, effects, helpers, bodyPreamble, publicMethods,
 *          computedValues, template expressions.
 */
import type { ComponentIR, TemplateNodeIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// React → Web Platform type mapping table
//
// Source: React's SyntheticEvent type hierarchy maps 1:1 to DOM events.
// React utility types map to TypeScript/DOM equivalents.
// ---------------------------------------------------------------------------

const REACT_TYPE_REPLACEMENTS: Array<[RegExp, string]> = [
  // Event types — React.XxxEvent<T> → XxxEvent (drop generic param)
  [/React\.MouseEvent(<[^>]*>)?/g, 'MouseEvent'],
  [/React\.KeyboardEvent(<[^>]*>)?/g, 'KeyboardEvent'],
  [/React\.FocusEvent(<[^>]*>)?/g, 'FocusEvent'],
  [/React\.ChangeEvent(<[^>]*>)?/g, 'Event'],
  [/React\.FormEvent(<[^>]*>)?/g, 'Event'],
  [/React\.SyntheticEvent(<[^>]*>)?/g, 'Event'],
  [/React\.DragEvent(<[^>]*>)?/g, 'DragEvent'],
  [/React\.ClipboardEvent(<[^>]*>)?/g, 'ClipboardEvent'],
  [/React\.PointerEvent(<[^>]*>)?/g, 'PointerEvent'],
  [/React\.TouchEvent(<[^>]*>)?/g, 'TouchEvent'],
  [/React\.WheelEvent(<[^>]*>)?/g, 'WheelEvent'],
  [/React\.AnimationEvent(<[^>]*>)?/g, 'AnimationEvent'],
  [/React\.TransitionEvent(<[^>]*>)?/g, 'TransitionEvent'],
  [/React\.CompositionEvent(<[^>]*>)?/g, 'CompositionEvent'],
  [/React\.UIEvent(<[^>]*>)?/g, 'UIEvent'],
  // Catch-all for any remaining React.XxxEvent
  [/React\.(\w+)Event/g, '$1Event'],

  // Ref types — no web equivalent, use any
  [/React\.Ref<[^>]*>/g, 'any'],
  [/React\.RefObject<[^>]*>/g, 'any'],
  [/React\.MutableRefObject<[^>]*>/g, 'any'],

  // Utility types
  [/React\.CSSProperties/g, 'Record<string, string>'],
  [/React\.ReactNode/g, 'unknown'],
  [/React\.ReactElement(<[^>]*>)?/g, 'unknown'],
  [/React\.\w+HTMLAttributes<[^>]*>/g, 'Record<string, unknown>'],

  // React API → bare names (in helper bodies that reference React.xxx)
  [/React\.useRef/g, 'useRef'],
  [/React\.useEffect/g, 'useEffect'],
  [/React\.useState/g, 'useState'],
  [/React\.useCallback/g, 'useCallback'],
  [/React\.useMemo/g, 'useMemo'],
  [/React\.useImperativeHandle/g, 'useImperativeHandle'],
  [/React\.Fragment/g, ''],
  [/React\.forwardRef\(/g, '('],
  [/React\.createElement/g, 'document.createElement'],
];

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

function replaceReactTypes(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REACT_TYPE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

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
