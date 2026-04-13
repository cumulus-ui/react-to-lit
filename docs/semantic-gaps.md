# React → Lit: Semantic Gaps

When converting React function components to Lit elements, the compiler produces
structurally correct output — but the two frameworks have fundamentally different
runtime models. This document catalogues known semantic differences that consumers
should be aware of when working with generated output.

---

## 1. Reactivity Model

**React** re-runs the entire function body on every render. Any JavaScript
expression can appear in a dependency array and React evaluates it each time:

```jsx
useEffect(() => { ... }, [config?.nested?.value])
```

**Lit** tracks *declared reactive properties* — `@property()` and `@state()`
decorators. The `changed` map in lifecycle methods is keyed by property name,
not arbitrary expressions:

```typescript
override willUpdate(changed: PropertyValues): void {
  if (changed.has('config')) { ... }  // ✅ works
  if (changed.has('config?.nested?.value')) { ... }  // ❌ always false
}
```

### What the compiler does

Effect dependency expressions are flattened to their root identifier:

| React dep expression | Lit `changed.has()` key |
|----------------------|------------------------|
| `config?.nested?.value` | `config` |
| `model.handlers.onKeyDown` | `model` |
| `items` | `items` |

When multiple deps flatten to the same root, they are deduplicated.

### What consumers must know

Deep property mutations (e.g. `this.config.nested.value = 'new'`) will **not**
trigger Lit reactivity. Lit compares property references, not deep values.
Consumers must follow immutable update patterns:

```typescript
// ❌ mutation — Lit won't detect this
this.config.nested.value = 'new';

// ✅ immutable replacement — Lit detects the new reference
this.config = { ...this.config, nested: { ...this.config.nested, value: 'new' } };
```

---

## 2. Attribute Binding Types

**React** treats all JSX attributes as props — the reconciler decides whether to
set a DOM property or an HTML attribute at runtime.

**Lit** requires the developer (or compiler) to choose the binding type explicitly
in the template:

| Lit syntax | Meaning | Example |
|------------|---------|---------|
| `attr="val"` | Static attribute | `id="main"` |
| `attr=${expr}` | Dynamic attribute | `aria-label=${this.label}` |
| `.prop=${expr}` | Property binding | `.value=${this.val}` |
| `?attr=${bool}` | Boolean attribute | `?disabled=${this.off}` |
| `@event=${fn}` | Event listener | `@click=${this.onClick}` |

### What the compiler does

- `aria-*`, `role`, `data-*` → attribute binding (no `.` prefix)
- `value`, `checked`, `indeterminate`, `selectedIndex` → property binding (`.` prefix)
- Boolean HTML attributes (from the DOM spec) → boolean binding (`?` prefix)
- `onXxx` handlers → event binding (`@xxx`)
- Everything else → property binding (`.` prefix)

### What consumers must know

If a generated component sets a custom attribute that should be an HTML attribute
(not a property), review the output and adjust the binding type if needed.

---

## 3. `className` → `class` with `classMap`

**React** uses `className` as a string prop. Libraries like `clsx()` compose
class names into strings.

**Lit** uses the `class` attribute with `classMap()` for conditional classes:

```typescript
// React
<div className={clsx(styles.root, isActive && styles.active)} />

// Lit (generated)
<div class=${classMap({ 'root': true, 'active': this.isActive })}>
```

### What consumers must know

The `clsx()` → `classMap()` conversion handles common patterns but may fail
on dynamic CSS module lookups or complex expressions. Review `classMap()` calls
in the output for correctness.

---

## 4. Event Handler Naming

**React** uses camelCase synthetic events: `onClick`, `onFocus`, `onChange`.

**Lit** uses native DOM event names with `@` prefix: `@click`, `@focus`, `@change`.

### What the compiler does

Strips the `on` prefix and lowercases: `onClick` → `@click`,
`onSelectionChange` → `@selectionchange`.

### What consumers must know

Custom event names (e.g. `onDismiss`, `onFollow`) may not map to real DOM events.
The compiler emits them as `@dismiss`, `@follow` — the component must dispatch
matching `CustomEvent`s for these to work.

---

## 5. Children → Slots

**React** passes children as props: `{children}`, `{props.header}`.

**Lit** uses the Shadow DOM `<slot>` mechanism:

```typescript
// React
<div>{header}</div>
<div>{children}</div>

// Lit (generated)
<div><slot name="header"></slot></div>
<div><slot></slot></div>
```

### What consumers must know

Named slots require the consumer to use `slot="header"` attributes on child
elements. This is a fundamental API difference — React wrapper components
may need adapter logic.

---

## 6. Refs → `@query` Decorators

**React** uses `useRef()` + `ref={myRef}` to get DOM element references.

**Lit** uses the `@query` decorator:

```typescript
// React
const inputRef = useRef<HTMLInputElement>(null);
<input ref={inputRef} />
inputRef.current.focus();

// Lit (generated)
@query('input') _inputRef!: HTMLInputElement;
this._inputRef.focus();
```

### What consumers must know

`@query` selects by CSS selector within the shadow root. If multiple matching
elements exist, only the first is returned. Complex ref patterns (callback refs,
forwarded refs) may require manual adjustment.

### Residual `.current` access (known limitation)

The compiler correctly strips `.current` from direct `useRef()` declarations.
However, `.current` survives in cases where ref objects are:

- **Passed as props**: `triggerRef: React.RefObject<HTMLElement>` — the prop
  type carries the `.current` wrapper, but the Lit component receives the
  element directly.
- **Returned from custom hooks**: `const { loadingButtonCount } = useFunnel()`
  — the hook returns a ref-like object the compiler doesn't understand.
- **Nested in context objects**: `tableComponentContext?.paginationRef?.current`
  — the context provides React ref wrappers around values.

These require manual review. The consuming code needs to decide whether to:
1. Pass the unwrapped value directly (no `.current` wrapper)
2. Define a Lit-native equivalent type for the context/prop

---

## 7. Effect Timing

| React | Lit equivalent | Notes |
|-------|---------------|-------|
| `useEffect(() => {}, [])` | `connectedCallback()` | Runs on mount |
| `useEffect(() => {}, [deps])` | `willUpdate(changed)` | Runs before render when deps change |
| `useEffect(() => {})` | `updated()` | Runs after every render |
| `useLayoutEffect(() => {}, [])` | `firstUpdated()` | Runs once after first render |
| Effect cleanup return | `disconnectedCallback()` | Runs on unmount |

### What consumers must know

`willUpdate` runs **before** rendering (synchronous), while React's `useEffect`
runs **after** painting (asynchronous). Side effects that depend on the rendered
DOM being visible may behave differently.
