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

  // Bare XxxEvent<T> imported from 'react' — strip the generic param.
  // DOM event types (KeyboardEvent, MouseEvent, etc.) are not generic.
  result = result.replace(/\b(KeyboardEvent|MouseEvent|FocusEvent|ChangeEvent|FormEvent|ClipboardEvent|DragEvent|PointerEvent|TouchEvent|WheelEvent|AnimationEvent|TransitionEvent|UIEvent|CompositionEvent|InputEvent)<[^>]*>/g, '$1');

  // React-only event types without DOM equivalents → Event
  result = result.replace(/\b(ChangeEvent|FormEvent|SyntheticEvent)\b/g, 'Event');

  // React event properties → DOM equivalents
  result = result.replace(/\.nativeEvent\b/g, '');
  result = result.replace(/\.isDefaultPrevented\(\)/g, '.defaultPrevented');

  // event.relatedTarget is EventTarget|null in DOM, but React types it as Element.
  // Cast to Element when passed as a function argument: func(x.relatedTarget)
  result = result.replace(
    /(\w+\.relatedTarget)\s*\)/g,
    '$1 as Element)',
  );

  // event.target / event.currentTarget is EventTarget|null in DOM but React
  // types them as the specific HTML element. Cast when accessing HTML-specific
  // properties (value, files, form, checked, elements, etc.).
  result = result.replace(
    /(\w+)\.(target|currentTarget)\.(value|files|form|checked|elements|selectedIndex|src|textContent)\b/g,
    '($1.$2 as HTMLInputElement).$3',
  );
  // Also handle destructured target: ({ target }: Event) → still EventTarget
  // target.files, target.value etc.
  result = result.replace(
    /\btarget\.(value|files|form|checked|elements)\b/g,
    '(target as HTMLInputElement).$1',
  );

  // setTimeout/setInterval → window.setTimeout/window.setInterval
  // In React (Node types), setTimeout returns NodeJS.Timeout. In the browser
  // (which Lit components target), window.setTimeout returns number. Using
  // the explicit window. prefix avoids TS2322 type mismatch.
  result = result.replace(/(?<!\w\.)(?<!window\.)\bsetTimeout\b(?=\s*\()/g, 'window.setTimeout');
  result = result.replace(/(?<!\w\.)(?<!window\.)\bclearTimeout\b(?=\s*\()/g, 'window.clearTimeout');
  result = result.replace(/(?<!\w\.)(?<!window\.)\bsetInterval\b(?=\s*\()/g, 'window.setInterval');
  result = result.replace(/(?<!\w\.)(?<!window\.)\bclearInterval\b(?=\s*\()/g, 'window.clearInterval');

  // Component Props types with generic params — strip the generic.
  // React component props are often generic (CardsProps<T>) but Lit versions are not.
  result = result.replace(/\b(\w+Props)<[^>]+>/g, '$1');

  // Bare React handler/callback types imported from 'react' without namespace.
  // FocusEventHandler<T> → (e: FocusEvent) => void, etc.
  // Use negative lookbehind to avoid matching React.MouseEventHandler (handled later).
  result = result.replace(/(?<!React\.)(?<![\w.])(Focus|Mouse|Keyboard|Change|Form|Clipboard|Drag|Pointer|Touch|Wheel)EventHandler(?:<[^>]*>)?/g, '(e: $1Event) => void');
  // Bare EventHandler<T> (not part of a larger name)
  result = result.replace(/(?<![\w.])EventHandler(?:<[^>]*>)?/g, '(e: Event) => void');
  // ReactNode / ReactElement bare imports (not React.ReactNode — that's handled later)
  result = result.replace(/(?<![\w.])ReactNode\b/g, 'unknown');
  result = result.replace(/(?<![\w.])ReactElement(?:<[^>]*>)?/g, 'unknown');
  // JSX.Element → unknown (React-specific namespace type)
  result = result.replace(/\bJSX\.Element\b/g, 'unknown');

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

  // 2b. React.XxxEventHandler<T> → (e: XxxEvent) => void
  // Must run before the Event regex (step 3) which would partially match.
  result = result.replace(/React\.(\w+)EventHandler(<[^>]*>)?/g, (_match, prefix: string) => {
    return `(e: ${prefix}Event) => void`;
  });

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
    // Prop types may contain React.ReactNode etc. (e.g., render callback props
    // like `(item: T) => React.ReactNode`). Clean them up too.
    props: ir.props.map((p) => ({
      ...p,
      type: replaceReactTypes(p.type),
    })),
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
