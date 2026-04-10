/**
 * Intermediate Representation (IR) for react-to-lit transpiler.
 *
 * The IR captures component structure in a framework-agnostic way,
 * decoupling parsing (React TSX → IR) from emission (IR → Lit TS).
 */

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

export interface ComponentIR {
  /** Component name, e.g. "Badge", "InternalButton" */
  name: string;

  /** Custom element tag name, e.g. "cs-badge" */
  tagName: string;

  /** Source files that were merged to produce this IR */
  sourceFiles: string[];

  /** Base class info (if extends a shared base) */
  baseClass?: BaseClassIR;

  /** Mixins to apply, e.g. ["FormControlMixin"] */
  mixins: string[];

  /** Reactive properties (from React props interface) */
  props: PropIR[];

  /** Internal reactive state (from useState) */
  state: StateIR[];

  /** Side effects (from useEffect / useLayoutEffect) */
  effects: EffectIR[];

  /** DOM and non-DOM refs (from useRef) */
  refs: RefIR[];

  /** Event handler methods */
  handlers: HandlerIR[];

  /** The component's render template (from JSX return) */
  template: TemplateNodeIR;

  /** Computed/memoized values (from useMemo) */
  computedValues: ComputedIR[];

  /** Reactive controllers (from custom hook mappings) */
  controllers: ControllerIR[];

  /** Lit context consumers/providers */
  contexts: ContextIR[];

  /** Additional imports to emit */
  imports: ImportIR[];

  /** Path to component styles module */
  styleImport?: string;

  /** Public methods on the class (from useImperativeHandle) */
  publicMethods: PublicMethodIR[];

  /** Helper functions defined in the same file but outside the component */
  helpers: HelperIR[];

  /** Whether the original component used React.forwardRef */
  forwardRef: boolean;
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export interface BaseClassIR {
  name: string;
  importPath: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PropIR {
  /** Property name as it appears in the interface */
  name: string;

  /** TypeScript type as a source string */
  type: string;

  /** Default value expression (from destructuring) */
  default?: string;

  /** How this prop maps to Lit */
  category: 'attribute' | 'property' | 'slot' | 'event';

  /** For event props: the detail type parameter */
  eventDetail?: string;

  /** Whether the event is cancelable (fireCancelableEvent vs fireNonCancelableEvent) */
  eventCancelable?: boolean;

  /** HTML attribute name, or false for property-only */
  attribute?: string | false;

  /** Lit property type for the @property() decorator */
  litType?: 'String' | 'Boolean' | 'Number' | 'Object' | 'Array';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface StateIR {
  /** Variable name from destructuring, e.g. "checked" */
  name: string;

  /** Initial value expression */
  initialValue: string;

  /** Setter function name, e.g. "setChecked" */
  setter: string;

  /** TypeScript type (if explicitly provided) */
  type?: string;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export interface EffectIR {
  /** Effect body as source text */
  body: string;

  /**
   * Dependency specification:
   * - 'none': no deps array → runs after every render
   * - 'empty': empty deps [] → mount-only
   * - string[]: specific deps → runs when deps change
   */
  deps: string[] | 'none' | 'empty';

  /** Cleanup function body (from return statement) */
  cleanup?: string;

  /** Whether this was useLayoutEffect (runs synchronously after DOM update) */
  isLayout?: boolean;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export interface RefIR {
  /** Variable name, e.g. "buttonRef" */
  name: string;

  /** Generic type parameter, e.g. "HTMLInputElement" */
  type?: string;

  /** Initial value expression */
  initialValue: string;

  /** True if the ref targets a DOM element (useRef<HTMLElement>) */
  isDom: boolean;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface HandlerIR {
  /** Function name, e.g. "handleClick" */
  name: string;

  /** Parameter list as source text */
  params: string;

  /** Function body as source text */
  body: string;

  /** Return type annotation */
  returnType?: string;
}

// ---------------------------------------------------------------------------
// Template (JSX → TemplateNodeIR tree)
// ---------------------------------------------------------------------------

export interface TemplateNodeIR {
  kind: 'element' | 'component' | 'fragment' | 'text' | 'expression' | 'slot';

  /** HTML tag or React component name */
  tag?: string;

  /** Attributes / props on the element */
  attributes: AttributeIR[];

  /** Child nodes */
  children: TemplateNodeIR[];

  /** For 'expression' and 'text' nodes: the expression/text content */
  expression?: string;

  /** Wrapping condition (from {cond && <X/>} or {cond ? <A/> : <B/>}) */
  condition?: ConditionIR;

  /** Wrapping loop (from {items.map(i => <X/>)}) */
  loop?: LoopIR;
}

export interface AttributeIR {
  /** Attribute/prop name */
  name: string;

  /** Value (static string or dynamic expression) */
  value: string | DynamicValueIR;

  /** What kind of binding this is */
  kind: 'static' | 'property' | 'boolean' | 'event' | 'spread' | 'classMap' | 'styleMap';
}

export interface DynamicValueIR {
  /** The expression as source text */
  expression: string;
}

export interface ConditionIR {
  /** The condition expression */
  expression: string;

  /** 'and' for {cond && <X/>}, 'ternary' for {cond ? <A/> : <B/>} */
  kind: 'and' | 'ternary';

  /** For ternary: the alternate node (the "else" branch) */
  alternate?: TemplateNodeIR;
}

export interface LoopIR {
  /** The iterable expression, e.g. "items" */
  iterable: string;

  /** The loop variable name, e.g. "item" */
  variable: string;

  /** Index variable name if present, e.g. "index" */
  index?: string;
}

// ---------------------------------------------------------------------------
// Computed values (from useMemo)
// ---------------------------------------------------------------------------

export interface ComputedIR {
  /** Variable name */
  name: string;

  /** The computation expression */
  expression: string;

  /** Dependencies */
  deps: string[];

  /** TypeScript type */
  type?: string;
}

// ---------------------------------------------------------------------------
// Controllers (from custom hook mappings)
// ---------------------------------------------------------------------------

export interface ControllerIR {
  /** Controller class name, e.g. "ControllableController" */
  className: string;

  /** Import path for the controller */
  importPath: string;

  /** Constructor arguments as source text */
  constructorArgs: string;

  /** Field name on the class, e.g. "_expandedCtrl" */
  fieldName: string;
}

// ---------------------------------------------------------------------------
// Contexts (@lit/context)
// ---------------------------------------------------------------------------

export interface ContextIR {
  /** Field name on the class */
  fieldName: string;

  /** Import path for the context object */
  contextImport: string;

  /** The context identifier */
  contextName: string;

  /** TypeScript type of the context value */
  type: string;

  /** Whether this component provides or consumes the context */
  role: 'consumer' | 'provider';

  /** Default value expression (for consumers) */
  defaultValue?: string;
}

// ---------------------------------------------------------------------------
// Public methods (from useImperativeHandle)
// ---------------------------------------------------------------------------

export interface PublicMethodIR {
  /** Method name, e.g. "focus" */
  name: string;

  /** Parameter list as source text */
  params: string;

  /** Method body as source text */
  body: string;
}

// ---------------------------------------------------------------------------
// Helper functions (non-component functions in the same file)
// ---------------------------------------------------------------------------

export interface HelperIR {
  /** Function name */
  name: string;

  /** Full source text of the function */
  source: string;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export interface ImportIR {
  /** Module specifier */
  moduleSpecifier: string;

  /** Named imports */
  namedImports?: string[];

  /** Default import name */
  defaultImport?: string;

  /** Whether this is a type-only import */
  isTypeOnly?: boolean;

  /** Whether this is a side-effect import (import 'foo') */
  isSideEffect?: boolean;
}
