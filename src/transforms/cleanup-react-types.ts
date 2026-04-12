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
import { mapIRText } from '../ir/transform-helpers.js';
import { getGlobalNames } from '../standards.js';
import { walkTemplate } from '../template-walker.js';

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
  let result = text;

  // Bare React hooks in helper bodies → web equivalent
  // useRef<T>(value) → { current: value }
  if (result.includes('useRef')) {
    result = result.replace(/useRef<[^>]*>\(([^)]*)\)/g, '{ current: $1 }');
    result = result.replace(/useRef\(([^)]*)\)/g, '{ current: $1 }');
  }

  // useContext(XxxContext) → this._xxxContext
  // (the class needs a @consume field — handled by the hook parser for main body,
  //  this catches useContext in helper/render method bodies)
  if (result.includes('useContext')) {
    result = result.replace(
      /useContext\((\w+)\)/g,
      (_match, contextName: string) => {
        // XxxContext → _xxxContext, xxxContextType → _xxxContextType
        const fieldName = contextName.charAt(0).toLowerCase() + contextName.slice(1);
        return `this._${fieldName}`;
      },
    );
  }

  if (!result.includes('React.')) return result;

  const domGlobals = getGlobalNames();

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

  // 6. React.XxxHTMLAttributes<T> / React.HTMLAttributes<T> → Record<string, unknown>
  result = result.replace(/React\.\w*HTMLAttributes<[^>]*>/g, 'Record<string, unknown>');

  // 7. React.useXxx → useXxx (drop namespace)
  result = result.replace(/React\.(use\w+)/g, '$1');

  // 8. Catch-all: any remaining React.Xxx<T> or React.Xxx → strip React. prefix
  //    Must consume optional generic params to avoid producing invalid `unknown<T>`
  result = result.replace(/React\.(\w+)(?:<[^>]*>)?/g, (_match, name: string) => {
    return domGlobals.has(name) ? name : 'unknown';
  });

  return result;
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function cleanupReactTypes(ir: ComponentIR): ComponentIR {
  return {
    ...mapIRText(ir, replaceReactTypes, { params: true }),
    template: replaceReactTypesInTemplate(ir.template),
  };
}

function replaceReactTypesInTemplate(node: TemplateNodeIR): TemplateNodeIR {
  return walkTemplate(node, {
    attributeExpression: (expr) => replaceReactTypes(expr),
    expression: (expr) => replaceReactTypes(expr),
    conditionExpression: (expr) => replaceReactTypes(expr),
    loopIterable: (expr) => replaceReactTypes(expr),
  });
}
