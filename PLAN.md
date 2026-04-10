# Implementation Plan — `react-to-lit` Phases 1–3 (MVP)

## Decisions

- **Scope:** Phases 1–3 (Parser, Emitter, Transforms) — enough to generate simple through medium-complexity components
- **Input:** Parse `.tsx` source directly from the Cloudscape fork (added as git submodule)
- **Output:** `internal.ts` only — a single Lit component class file per React component
- **Input merging:** Parse both `index.tsx` (public wrapper) and `internal.tsx` (implementation), merge relevant bits into one output class
- **Base class:** Preserve source hierarchy. If React source extends a base component, the Lit output extends a corresponding Lit base
- **Custom hooks:** Configurable mapping — each React hook name maps to a Lit equivalent (controller, mixin, utility function). Adding a new hook means adding a mapping entry + the Lit implementation
- **Semantics preserved:** We're changing syntax, not semantics. Every custom hook gets a Lit equivalent that behaves the same way
- **Existing hand-written components:** Not treated as reference. The transpiler defines the canonical output

---

## Source Analysis Summary

The Cloudscape React source at `cloudscape-source/src/` contains ~95 component directories. Each component follows one of these patterns:

**Pattern A — Simple (no internal.tsx):** Badge. Single `index.tsx` with a function component.

**Pattern B — Wrapper + Internal:** Spinner, StatusIndicator. `index.tsx` is a thin wrapper calling `useBaseComponent` then delegating to `internal.tsx`.

**Pattern C — forwardRef + Internal:** Button, Checkbox, Input. `index.tsx` uses `React.forwardRef`, extracts default props, delegates to `internal.tsx` which is also wrapped in `forwardRef`.

Key patterns the parser will encounter:

| Pattern | Frequency | Example |
|---------|-----------|---------|
| `export default function Foo(props)` | ~30 | Badge |
| `React.forwardRef((...) => {...})` | ~122 | Button, Input |
| `useState(init)` | Moderate | Button (`showTooltip`) |
| `useRef(null)` | Very common | Every component with DOM refs |
| `useEffect(fn, deps)` | Very common | Checkbox (indeterminate), Button (funnel) |
| `useImperativeHandle(ref, fn)` | Moderate | Input |
| `useMemo(fn, deps)` | ~104 | Tables, charts |
| `useCallback(fn, deps)` | Common | Input utils |
| `useContext(ctx)` | ~26 contexts | FormField, Button, Modal |
| `clsx(styles.x, { [styles.y]: cond })` | Every component | Universal |
| `fireNonCancelableEvent(handler, detail)` | Very common | Checkbox, Input |
| `fireCancelableEvent(handler, detail, event)` | Common | Button (onClick, onFollow) |
| `useControllable(val, handler, def)` | Stateful components | Expandable, Tabs |
| `useForwardFocus(ref, controlRef)` | ~20 | Checkbox, Button |
| `AbstractSwitch` (shared component) | 4 | Checkbox, Toggle, Radio, Tiles |
| `WithNativeAttributes` wrapper | Every component | Root element wrapper |

---

## Phase 0: Project Scaffolding

### 0.1 — Repository setup

```
react-to-lit/
  package.json          — typescript, vitest, commander, prettier
  tsconfig.json         — ES2022, ESM, strict
  vitest.config.ts
  vendor/               — git submodule: cumulus-ui/cloudscape-source
  src/
    ir/                 — IR type definitions
    parser/             — React TSX → IR
    transforms/         — IR → IR (normalize, rewrite patterns)
    emitter/            — IR → Lit TypeScript source
    hooks/              — Hook mapping registry
    cli.ts              — CLI entry point
  test/
    fixtures/           — Extracted .tsx snippets for targeted tests
    parser/
    emitter/
    transforms/
    e2e/                — Full pipeline: .tsx → .ts, verify compilation
```

### 0.2 — Cloudscape source as submodule

```bash
git submodule add https://github.com/cumulus-ui/cloudscape-source vendor/cloudscape-source
```

The transpiler reads from `vendor/cloudscape-source/src/<component>/`.

### 0.3 — IR Type Definitions (`src/ir/types.ts`)

The IR captures component structure framework-agnostically:

```typescript
interface ComponentIR {
  name: string;                     // "Badge", "InternalButton"
  tagName: string;                  // "cs-badge" (derived from name + prefix config)
  sourceFiles: string[];            // ["index.tsx", "internal.tsx"]
  baseClass?: BaseClassIR;          // If extends a shared base
  props: PropIR[];
  state: StateIR[];
  effects: EffectIR[];
  refs: RefIR[];
  handlers: HandlerIR[];
  template: TemplateNodeIR;
  computedValues: ComputedIR[];
  controllers: ControllerIR[];      // From custom hook mappings
  mixins: string[];                 // e.g. ["FormControlMixin"]
  contexts: ContextIR[];
  imports: ImportIR[];
  styleImport?: string;
  publicMethods: PublicMethodIR[];  // From useImperativeHandle
}

interface PropIR {
  name: string;
  type: string;                     // TS type as string
  default?: string;                 // Default value expression
  category: 'attribute' | 'property' | 'slot' | 'event';
  eventDetail?: string;             // For event props: the detail type
  eventCancelable?: boolean;        // fireCancelableEvent vs fireNonCancelableEvent
  attribute?: string | false;       // HTML attribute name or false for property-only
  litType?: 'String' | 'Boolean' | 'Number' | 'Object' | 'Array';
}

interface StateIR {
  name: string;
  initialValue: string;
  setter: string;                   // "setFoo"
  type?: string;
}

interface EffectIR {
  body: string;                     // Source text of effect body
  deps: string[] | 'none' | 'empty'; // 'none'=every render, 'empty'=mount-only
  cleanup?: string;                 // Cleanup return body
}

interface RefIR {
  name: string;
  type?: string;
  initialValue: string;
  isDom: boolean;                   // useRef<HTMLElement> or similar
}

interface HandlerIR {
  name: string;
  params: string;
  body: string;
  returnType?: string;
}

interface TemplateNodeIR {
  kind: 'element' | 'component' | 'fragment' | 'text' | 'expression' | 'slot';
  tag?: string;
  attributes: AttributeIR[];
  children: TemplateNodeIR[];
  expression?: string;
  condition?: ConditionIR;          // Wrapping conditional
  loop?: LoopIR;                    // Wrapping .map()
}

interface AttributeIR {
  name: string;
  value: string | DynamicValueIR;
  kind: 'static' | 'property' | 'boolean' | 'event' | 'spread' | 'classMap' | 'styleMap';
}

interface ControllerIR {
  className: string;                // "ControllableController"
  importPath: string;
  constructorArgs: string;          // Source text of constructor arguments
  fieldName: string;                // "_expandedController"
}

interface ContextIR {
  fieldName: string;
  contextImport: string;
  type: string;
  role: 'consumer' | 'provider';
}

interface PublicMethodIR {
  name: string;
  params: string;
  body: string;
}
```

---

## Phase 1: Parser — React TSX → IR

### 1.1 — Source file loader

Use the TypeScript Compiler API (`ts.createProgram`) to parse `.tsx` files with full type information. This is necessary for:
- Resolving interface types across files (`interfaces.ts`, `base-checkbox.tsx`)
- Determining if a `useRef<T>` generic is a DOM element type
- Following imports to identify custom hooks

```typescript
// src/parser/program.ts
function createProgram(componentDir: string): ts.Program
function getSourceFile(program: ts.Program, file: string): ts.SourceFile
```

### 1.2 — Component function finder

Detect the component function across both files:

**From `index.tsx`:**
- `export default function Badge(props) { ... }` → extract defaults, note no internal.tsx
- `const Button = React.forwardRef((props, ref) => { ... })` → note forwardRef, extract defaults from destructuring
- If it delegates to `InternalFoo` → record defaults, continue to `internal.tsx`

**From `internal.tsx`:**
- `export default function InternalSpinner(props) { ... }` → the real implementation
- `const InternalButton = React.forwardRef((props, ref) => { ... })` → the real implementation

**Merge strategy:** Defaults come from `index.tsx` destructuring. Implementation body comes from `internal.tsx` (or `index.tsx` if no internal exists).

```typescript
// src/parser/component.ts
function findComponent(indexFile: ts.SourceFile, internalFile?: ts.SourceFile): RawComponent
```

### 1.3 — Props extraction

1. Find the props type from the function signature or forwardRef generic
2. Resolve the interface (may be in `interfaces.ts`, may extend `BaseComponentProps`, `FormFieldControlProps`, etc.)
3. Flatten inherited interfaces (but record which base interfaces were extended — this informs mixin selection)
4. Classify each prop:

| React type | PropIR.category | Notes |
|-----------|----------------|-------|
| `React.ReactNode` | `slot` | Becomes `<slot>` |
| `NonCancelableEventHandler<T>` | `event` | `cancelable: false` |
| `CancelableEventHandler<T>` | `event` | `cancelable: true` |
| `boolean` | `attribute` | `litType: 'Boolean'` |
| String union (`'a' \| 'b'`) | `attribute` | `litType: 'String'` |
| `string` | `attribute` | `litType: 'String'` |
| `number` | `attribute` | `litType: 'Number'` |
| Object/complex | `property` | `attribute: false` |
| `React.CSSProperties` | `property` | Map to `Record<string,string>` |

5. Extract defaults from the destructuring pattern in the function signature
6. **Skip these Cloudscape-internal props:** `nativeAttributes`, `nativeInputAttributes`, `nativeButtonAttributes`, `nativeAnchorAttributes`, `__internalRootRef`, `__injectAnalyticsComponentMetadata`, all `__`-prefixed props

```typescript
// src/parser/props.ts
function extractProps(component: RawComponent, program: ts.Program): PropIR[]
```

### 1.4 — Hook extraction

Walk the function body for hook calls. Each recognized hook produces an IR node:

| Hook | IR output | Notes |
|------|-----------|-------|
| `useState(init)` | `StateIR` | Extract name/setter from destructuring |
| `useRef(init)` | `RefIR` | Check generic type to determine `isDom` |
| `useEffect(fn, deps)` | `EffectIR` | Parse deps array, detect cleanup return |
| `useLayoutEffect(fn, deps)` | `EffectIR` | Flag as layout effect |
| `useMemo(fn, deps)` | `ComputedIR` | |
| `useCallback(fn, deps)` | `HandlerIR` | Inline where used in template |
| `useImperativeHandle(ref, fn)` | `PublicMethodIR[]` | Extract methods from factory |
| `useContext(ctx)` | `ContextIR` | Identify context by import |
| Custom hooks | Looked up in hook registry | See §1.6 |

```typescript
// src/parser/hooks.ts
function extractHooks(body: ts.Block, program: ts.Program): HookExtractionResult
```

### 1.5 — JSX template parsing

Walk the JSX return statement and build `TemplateNodeIR`:

- `<div className={...}>` → `{ kind: 'element', tag: 'div' }`
- `<InternalIcon name="foo" />` → `{ kind: 'component', tag: 'InternalIcon' }`
- `<>{...}</>` → `{ kind: 'fragment' }`
- `{children}` → `{ kind: 'slot' }` (if `children` is a `ReactNode` prop)
- `{cond && <Foo />}` → child node with `condition: { expr: 'cond', kind: 'and' }`
- `{cond ? <A /> : <B />}` → two child nodes with ternary condition
- `{items.map(i => <X />)}` → child node with `loop: { iterable: 'items', variable: 'i' }`
- `className={clsx(...)}` → parsed into `ClassMapIR` (see §3.1)

**Component resolution:** `<InternalIcon>` needs to map to `<cs-icon>`. This uses a component registry (config file) that maps React component names to custom element tag names.

```typescript
// src/parser/jsx.ts
function parseJSX(jsxElement: ts.JsxElement | ts.JsxFragment): TemplateNodeIR
```

### 1.6 — Hook mapping registry

A config-driven registry that maps custom hooks to their Lit equivalents:

```typescript
// src/hooks/registry.ts
interface HookMapping {
  // What to do when the parser encounters this hook
  action: 'skip' | 'controller' | 'mixin' | 'utility' | 'inline';

  // For 'controller': emit a ControllerIR
  controller?: { className: string; importPath: string; };

  // For 'mixin': add to ComponentIR.mixins
  mixin?: string;

  // For 'utility': inline the result as a plain call
  utility?: { functionName: string; importPath: string; };

  // For 'skip': silently drop (e.g. telemetry hooks)
  reason?: string;
}

const defaultRegistry: Record<string, HookMapping> = {
  // Cloudscape infrastructure — skip
  'useBaseComponent':                    { action: 'skip', reason: 'telemetry' },
  'useModalContextLoadingComponent':     { action: 'skip', reason: 'analytics' },
  'useModalContextLoadingButtonComponent': { action: 'skip', reason: 'analytics' },
  'usePerformanceMarks':                 { action: 'skip', reason: 'analytics' },
  'useSingleTabStopNavigation':          { action: 'skip', reason: 'toolkit internal' },
  'useInternalI18n':                     { action: 'skip', reason: 'i18n handled separately' },
  'useFunnel':                           { action: 'skip', reason: 'analytics' },
  'useFunnelStep':                       { action: 'skip', reason: 'analytics' },
  'useFunnelSubStep':                    { action: 'skip', reason: 'analytics' },

  // Mapped to Lit equivalents
  'useControllable': {
    action: 'controller',
    controller: {
      className: 'ControllableController',
      importPath: '../internal/controllers/controllable.js',
    },
  },
  'useForwardFocus': {
    action: 'skip',
    reason: 'handled by public method extraction from useImperativeHandle',
  },
  'useFormFieldContext': {
    action: 'inline',
    // Emitter uses @consume({ context: formFieldContext })
  },
  'useUniqueId': {
    action: 'utility',
    utility: {
      functionName: 'generateUniqueId',
      importPath: '../internal/hooks/use-unique-id.js',
    },
  },
  'useHiddenDescription': {
    action: 'skip',
    reason: 'handled differently in shadow DOM',
  },
  'useButtonContext': {
    action: 'inline',
    // @consume({ context: buttonContext })
  },
};
```

This is the extensibility point. For a non-Cloudscape React library, you provide your own hook registry.

### 1.7 — Test targets for Phase 1

| Component | What it tests |
|-----------|--------------|
| **Badge** | Simplest case: single file, no hooks, one prop, clsx, `WithNativeAttributes` unwrapping |
| **Spinner** | Two-file merge (index + internal), no hooks, multiple props, clsx with template literals |
| **StatusIndicator** | Two-file merge, component-in-component (`InternalIcon`, `InternalSpinner`), conditional rendering, helper function (`typeToIcon`) |

Each test: parse → inspect IR → assert correct props, template structure, no state/effects.

---

## Phase 2: Emitter — IR → Lit TypeScript

### 2.1 — Class structure

```typescript
// src/emitter/class.ts
function emitClass(ir: ComponentIR): string
```

Produces:

```typescript
// For Badge (simple, extends CsBaseElement):
export class CsBadgeInternal extends CsBaseElement {
  static override styles = [sharedStyles, componentStyles, hostStyles];
  // ...properties, methods, render()
}

// For Checkbox (FormControlMixin):
const Base = FormControlMixin(CsBaseElement);
export class CsCheckboxInternal extends Base {
  // ...
}
```

The base class decision:
- Default: `CsBaseElement` (which extends `LitElement`)
- If `ComponentIR.mixins` includes `FormControlMixin`: apply mixin pattern
- If React source extends `AbstractSwitch`: no class inheritance (it's a shared component in React, shared CSS in Lit)

### 2.2 — Property declarations

```typescript
// src/emitter/properties.ts
function emitProperties(props: PropIR[], state: StateIR[]): string
```

For each `PropIR` with `category: 'attribute'`:
```typescript
@property({ type: String })
color: BadgeProps['color'] = 'grey';

@property({ type: Boolean, attribute: 'read-only' })
readOnly = false;

@property({ type: String, attribute: 'aria-label' })
override ariaLabel: string | null = null;
```

For each `StateIR`:
```typescript
@state()
private _showTooltip = false;
```

camelCase props get `attribute: 'kebab-case'` automatically. Props that collide with `HTMLElement` builtins (like `ariaLabel`) get `override`.

### 2.3 — Controller declarations

For each `ControllerIR`:
```typescript
private _expandedCtrl = new ControllableController(this, { defaultValue: false });
```

### 2.4 — Context declarations

For each `ContextIR`:
```typescript
// Consumer
@consume({ context: formFieldContext, subscribe: true })
private _formFieldCtx: FormFieldContext = defaultFormFieldContext;

// Provider
@provide({ context: formFieldContext })
_context: FormFieldContext = { ... };
```

### 2.5 — Lifecycle methods

```typescript
// src/emitter/lifecycle.ts
function emitLifecycle(effects: EffectIR[]): string
```

Group effects by kind and merge into lifecycle methods:

| EffectIR deps | Lit lifecycle | Notes |
|--------------|---------------|-------|
| `'empty'` (mount-only) | `connectedCallback()` | Also add event listeners here |
| `'none'` (every render) | `updated()` | Runs after every render |
| `['dep1', 'dep2']` | `willUpdate(changed)` | With `if (changed.has('dep1'))` guards |
| Has cleanup | `disconnectedCallback()` | Remove event listeners, clean up |

Multiple effects → merged into the same lifecycle method with separate blocks.

### 2.6 — Event handler methods

```typescript
// src/emitter/handlers.ts
function emitHandlers(handlers: HandlerIR[]): string
```

Arrow function handlers become class methods:
```typescript
private _onHostClick = (e: MouseEvent): void => {
  // ...rewritten body with this. references
};
```

### 2.7 — Template (render method)

```typescript
// src/emitter/template.ts
function emitTemplate(node: TemplateNodeIR): string
```

Recursive walk producing Lit `html` tagged template:

| IR node | Lit output |
|---------|------------|
| `{ kind: 'element', tag: 'div' }` | `<div ...>` |
| `{ kind: 'component', tag: 'InternalIcon' }` | `<cs-icon ...>` (via component registry) |
| `{ kind: 'slot' }` | `<slot></slot>` or `<slot name="...">` |
| `{ kind: 'text', expression: "'hello'" }` | `hello` |
| `{ kind: 'expression', expr }` | `${expr}` |
| Conditional `cond && node` | `` ${cond ? html`...` : nothing} `` |
| Ternary `cond ? a : b` | `` ${cond ? html`...` : html`...`} `` |
| Loop `items.map(...)` | `` ${items.map(i => html`...`)} `` |

Attribute emission:

| AttributeIR.kind | Lit syntax |
|-----------------|------------|
| `static` | `attr="value"` |
| `property` | `.prop=${expr}` |
| `boolean` | `?disabled=${expr}` |
| `event` | `@click=${this._handler}` |
| `classMap` | `class=${classMap({...})}` |

### 2.8 — Import collection

```typescript
// src/emitter/imports.ts
function emitImports(ir: ComponentIR): string
```

Collect imports during emission, deduplicate, sort:
- `lit`: `html`, `css`, `nothing`, `svg` (as needed)
- `lit/decorators.js`: `property`, `state`, `query`, `customElement`
- `lit/directives/class-map.js`: `classMap` (if used)
- `lit/directives/if-defined.js`: `ifDefined` (if used)
- `@lit/context`: `consume`, `provide` (if contexts used)
- Component styles: `./styles.js`
- Internal utilities: `fireNonCancelableEvent`, `generateUniqueId`, etc.
- Sibling components: `../icon/index.js` (for `<cs-icon>`)

### 2.9 — Output formatting

Run generated source through Prettier with TypeScript parser, 120 char line width, single quotes.

### 2.10 — Test targets for Phase 2

| Component | What it tests |
|-----------|--------------|
| **Badge** | Minimal output: one `@property`, `classMap`, `<slot>`, style imports |
| **Spinner** | Multiple props, multiple classMap entries, inner `<span>` elements |
| **StatusIndicator** | Conditional rendering (`loading` → `<cs-spinner>`, else `<cs-icon>`), component references |

Each test: construct IR manually → emit → verify output compiles with `tsc --noEmit`.

---

## Phase 3: Transforms — IR → IR Normalization

Transforms run on the IR between parsing and emission. They normalize React-specific patterns into framework-agnostic representations that the emitter can handle.

### 3.1 — clsx → classMap

```typescript
// src/transforms/clsx.ts
function transformClsx(node: TemplateNodeIR): TemplateNodeIR
```

Parse `clsx()` arguments and produce a `classMap` attribute:

```
// React input:
clsx(styles.root, styles[`size-${size}`], { [styles.disabled]: isNotInteractive })

// ClassMap output (stripping styles. indirection):
classMap({ 'root': true, [`size-${this.size}`]: true, 'disabled': this.isNotInteractive })
```

The `styles.xxx` indirection is dropped — Lit components use semantic class names directly. The key mapping is: `styles.root` → `'root'`, `styles['button-no-wrap']` → `'button-no-wrap'`, `` styles[`variant-${variant}`] `` → `` `variant-${this.variant}` ``.

### 3.2 — WithNativeAttributes unwrapping

```typescript
// src/transforms/unwrap.ts
function unwrapWithNativeAttributes(node: TemplateNodeIR): TemplateNodeIR
```

Cloudscape wraps every root element in `<WithNativeAttributes tag="span" ...>`. The transform:
1. Replaces the `WithNativeAttributes` node with an element node using the `tag` prop value
2. Merges `className`, `ref`, and other attributes onto the unwrapped element
3. Drops `componentName`, `nativeAttributes`, `skipWarnings` props

### 3.3 — Conditional & list rendering

```typescript
// src/transforms/conditionals.ts
function normalizeConditionals(node: TemplateNodeIR): TemplateNodeIR
```

Already captured during JSX parsing (§1.5), but this transform handles edge cases:
- Nested conditionals `{a && b && <Foo />}` → flatten
- `{x || <Fallback />}` → ternary
- Truthiness checks on non-boolean values

### 3.4 — Slot detection

```typescript
// src/transforms/slots.ts
function transformSlots(ir: ComponentIR): ComponentIR
```

For each `PropIR` with `category: 'slot'`:
- `{children}` in template → `<slot></slot>`
- `{description}` in template → `<slot name="description"></slot>` (for named slots)
- `{label}` rendered as text → keep as `@property` (it's a string, not a slot)

Decision between slot vs property: if the React type is `React.ReactNode` and it's rendered as a JSX child (not as an attribute value), it becomes a slot.

### 3.5 — Event callback → CustomEvent dispatch

```typescript
// src/transforms/events.ts
function transformEvents(ir: ComponentIR): ComponentIR
```

React pattern:
```tsx
fireNonCancelableEvent(onChange, { checked: true, indeterminate: false });
fireCancelableEvent(onFollow, { href, target }, event);
```

Lit equivalent:
```typescript
fireNonCancelableEvent(this, 'change', { checked: true, indeterminate: false });
```

The transform:
1. Finds all `fireNonCancelableEvent(handlerName, detail)` / `fireCancelableEvent(handlerName, detail, event)` calls
2. Replaces `handlerName` (a prop) with `this` (the element)
3. Derives event name from prop name: `onChange` → `'change'`, `onFollow` → `'follow'`
4. Removes the event prop from `ComponentIR.props`

### 3.6 — Identifier rewriting

```typescript
// src/transforms/identifiers.ts
function rewriteIdentifiers(ir: ComponentIR): ComponentIR
```

Throughout all source text in the IR (handler bodies, effect bodies, template expressions):

| React identifier | Lit identifier |
|-----------------|----------------|
| `props.foo` | `this.foo` |
| `foo` (destructured prop) | `this.foo` |
| `checked` (from useState) | `this._checked` |
| `setChecked(val)` | `this._checked = val` |
| `checkboxRef.current` | `this._checkboxRef` (or `this.shadowRoot.querySelector(...)`) |
| `ref.current` | `this._ref` |

### 3.7 — Component reference resolution

```typescript
// src/transforms/components.ts
function resolveComponentReferences(ir: ComponentIR, registry: ComponentRegistry): ComponentIR
```

When the template references `<InternalIcon name="foo" />`:
1. Look up `InternalIcon` in the component registry
2. Replace with `<cs-icon name="foo"></cs-icon>`
3. Add side-effect import: `import '../icon/index.js'`

The registry maps: `InternalIcon` → `cs-icon`, `InternalSpinner` → `cs-spinner`, `InternalButton` → `cs-button`, etc.

### 3.8 — AbstractSwitch transform

The React `AbstractSwitch` is a **shared React component** that Checkbox, Toggle, Radio render as their root. In Lit, this becomes **shared CSS + inline HTML structure**.

```typescript
// src/transforms/abstract-switch.ts
function transformAbstractSwitch(ir: ComponentIR): ComponentIR
```

When the template contains `<AbstractSwitch ...>`:
1. Inline the AbstractSwitch template directly into the component's template
2. Map AbstractSwitch props to the inlined structure:
   - `controlClassName` → additional class on the control `<span>`
   - `nativeControl` render prop → inline the rendered `<input>` element
   - `styledControl` → inline the styled element (SVG checkbox, toggle track, etc.)
   - `label` → label span
   - `description` → description span
3. Add `abstractSwitchStyles` to the component's style imports

### 3.9 — Cloudscape internals removal

```typescript
// src/transforms/cleanup.ts
function removeCloudscapeInternals(ir: ComponentIR): ComponentIR
```

Strip Cloudscape-specific infrastructure from the IR:
- `const baseProps = getBaseProps(rest)` → remove
- `{...baseProps}` spreads → remove
- `useBaseComponent(...)` → already skipped by hook registry
- `applyDisplayName(...)` → remove
- `__internalRootRef` prop → remove
- Analytics metadata (`getAnalyticsMetadataAttribute`, `DATA_ATTR_FUNNEL_VALUE`) → remove
- `checkSafeUrl(...)` → remove
- `useSingleTabStopNavigation` → remove (handled differently in web components)
- `InternalLiveRegion` for loading text → convert to `aria-live` region in template

### 3.10 — Test targets for Phase 3

| Component | What it tests |
|-----------|--------------|
| **Button** | forwardRef → public `focus()` method, click/follow events with `fireCancelableEvent`, conditional `<a>` vs `<button>`, clsx with many conditions, `WithNativeAttributes` unwrap, icon helper components, `useState` for tooltip, analytics removal |
| **Checkbox** | `AbstractSwitch` inlining, `useForwardFocus` → public method, `useFormFieldContext` → `@consume`, `fireNonCancelableEvent`, `useEffect` (every render) for indeterminate, `useRef` → DOM query, render props (`nativeControl`) |
| **Input** | `useImperativeHandle` → public `focus()`/`select()`, multiple event handlers, controlled value, `useFormFieldContext`, clear button rendering, search icon logic |

---

## Hook Mapping Implementation Order

For the MVP, these hooks need Lit equivalents:

| Priority | React hook | Lit equivalent | Status |
|----------|-----------|---------------|--------|
| 1 | `useFormFieldContext` | `@consume({ context: formFieldContext })` | Exists in components repo |
| 2 | `fireNonCancelableEvent` | `fireNonCancelableEvent(this, name, detail)` | Exists in components repo |
| 3 | `fireCancelableEvent` | `this.dispatchEvent(new CustomEvent(...))` | Emit inline |
| 4 | `useForwardFocus` | Public `focus()` method | Emit directly |
| 5 | `useUniqueId` | `generateUniqueId()` | Exists in components repo |
| 6 | `useControllable` | `ControllableController` | Exists in components repo |
| 7 | `useRef` (DOM) | `this.shadowRoot.querySelector()` | Emit directly |
| 8 | `useRef` (non-DOM) | Private class field | Emit directly |
| 9 | `useState` | `@state()` private field | Emit directly |
| 10 | `useEffect` | `connectedCallback`/`willUpdate`/`updated` | Emit directly |
| 11 | `useMemo` | Getter with cache or `willUpdate` pre-compute | Emit directly |
| 12 | `useImperativeHandle` | Public methods on class | Emit directly |

---

## CLI Interface

```bash
# Single component
npx react-to-lit \
  --input vendor/cloudscape-source/src/badge \
  --output src/badge/internal.ts \
  --prefix cs \
  --config react-to-lit.config.ts

# Batch
npx react-to-lit \
  --input vendor/cloudscape-source/src \
  --output src \
  --prefix cs \
  --config react-to-lit.config.ts

# Options
--prefix <str>        Custom element prefix (default: none)
--config <path>       Config file with hook mappings, component registry, skip patterns
--dry-run             Print output to stdout
--verbose             Log parsing decisions
--component <name>    Process a single component from a batch input
```

Config file (`react-to-lit.config.ts`):
```typescript
export default {
  prefix: 'cs',
  hookMappings: { /* custom hook registry overrides */ },
  componentRegistry: { /* React component name → custom element tag name */ },
  skipPatterns: ['__internalRootRef', '__inject*'],
  baseClass: {
    default: 'CsBaseElement',
    importPath: '../internal/base-element.js',
  },
  formMixin: {
    name: 'FormControlMixin',
    importPath: '../internal/mixins/form-control.js',
    triggerProps: ['name', 'value', 'disabled'],
  },
};
```

---

## Implementation Order

| # | File | Phase | Description |
|---|------|-------|-------------|
| 1 | `package.json`, `tsconfig.json`, `vitest.config.ts` | 0 | Project scaffolding |
| 2 | `src/ir/types.ts` | 0 | All IR type definitions |
| 3 | `src/hooks/registry.ts` | 0 | Hook mapping registry + Cloudscape defaults |
| 4 | `src/parser/program.ts` | 1 | TypeScript program/source file loader |
| 5 | `src/parser/component.ts` | 1 | Find component function, merge index+internal |
| 6 | `src/parser/props.ts` | 1 | Extract and classify props |
| 7 | `src/parser/hooks.ts` | 1 | Extract standard + custom hook calls |
| 8 | `src/parser/jsx.ts` | 1 | Parse JSX → TemplateNodeIR |
| 9 | `src/parser/index.ts` | 1 | Parser entry point, orchestrates 4–8 |
| 10 | `test/parser/*.test.ts` | 1 | Parser tests for Badge, Spinner, StatusIndicator |
| 11 | `src/emitter/imports.ts` | 2 | Import collection and deduplication |
| 12 | `src/emitter/properties.ts` | 2 | @property/@state declarations |
| 13 | `src/emitter/lifecycle.ts` | 2 | Lifecycle method generation |
| 14 | `src/emitter/handlers.ts` | 2 | Event handler methods |
| 15 | `src/emitter/template.ts` | 2 | html tagged template from TemplateNodeIR |
| 16 | `src/emitter/class.ts` | 2 | Class structure, decorators, styles |
| 17 | `src/emitter/index.ts` | 2 | Emitter entry point |
| 18 | `test/emitter/*.test.ts` | 2 | Emitter tests |
| 19 | `test/e2e/simple.test.ts` | 2 | E2E: Badge, Spinner, StatusIndicator |
| 20 | `src/transforms/clsx.ts` | 3 | clsx → classMap |
| 21 | `src/transforms/unwrap.ts` | 3 | WithNativeAttributes → plain element |
| 22 | `src/transforms/slots.ts` | 3 | ReactNode → slot |
| 23 | `src/transforms/events.ts` | 3 | Callback props → CustomEvent dispatch |
| 24 | `src/transforms/identifiers.ts` | 3 | Rewrite props/state/ref identifiers |
| 25 | `src/transforms/components.ts` | 3 | Component reference resolution |
| 26 | `src/transforms/abstract-switch.ts` | 3 | AbstractSwitch inlining |
| 27 | `src/transforms/cleanup.ts` | 3 | Remove Cloudscape internals |
| 28 | `src/transforms/index.ts` | 3 | Transform pipeline orchestrator |
| 29 | `test/transforms/*.test.ts` | 3 | Transform tests |
| 30 | `test/e2e/medium.test.ts` | 3 | E2E: Button, Checkbox, Input |
| 31 | `src/cli.ts` | 3 | CLI entry point |

---

## Risk Areas

1. **Render props** — Checkbox's `nativeControl` prop is a render prop (`(props) => <input ...props />`). The AbstractSwitch transform (§3.8) must inline this. Other components may use render props too.

2. **Helper components in same file** — StatusIndicator defines `InternalStatusIcon` in the same file. The parser needs to handle multiple component definitions, identifying the "main" one.

3. **Computed classNames with template literals** — `` styles[`variant-${variant}`] `` requires understanding that this maps to a CSS class name, not a dynamic property lookup. The clsx transform handles this by stripping the `styles.` prefix.

4. **Type information across files** — Props interfaces span multiple files (`CheckboxProps` extends `BaseCheckboxProps`). The TypeScript program API with a full `tsconfig.json` handles this, but the parser needs to resolve types transitively.

5. **Conditional root elements** — Button renders either `<a>` or `<button>` based on `href`. The emitter must handle conditional root elements in the render method.

6. **Style prop mapping** — Cloudscape's `style` prop (e.g., `BadgeProps.Style`, `ButtonProps.Style`) maps React inline styles to CSS custom properties. This is a Cloudscape-specific pattern that may need its own transform.
