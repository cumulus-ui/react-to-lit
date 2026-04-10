# Remaining Issues — Prioritized Plan

## Current State

- **91/91 components** parse, transform, and emit (100% success rate)
- **166 tests** passing
- **39 clean components** (no output issues)
- **52 components** with output issues
- **62 components** with feature gaps vs hand-written versions

## Issue Categories

### HIGH Priority — Blocks Functional Output

#### 1. JSX Helper Inlining (45 components)

Local functions in the same file return JSX. The transpiler drops them with a TODO comment.

**Pattern:**
```tsx
// React source (same file as component)
function LeftIcon({ loading, iconName, ... }) {
  if (loading) return <InternalSpinner />;
  return <InternalIcon name={iconName} />;
}
```

**Current output:** `// TODO: transform helper 'LeftIcon' (contains JSX)`

**Fix:** Parse helper function JSX → emit as private methods returning `TemplateResult`:
```typescript
private _renderLeftIcon(): TemplateResult | typeof nothing {
  if (this.loading) return html`<cs-spinner></cs-spinner>`;
  return html`<cs-icon name=${this.iconName}></cs-icon>`;
}
```

**Approach:**
- In the parser, treat helper functions with JSX as additional components
- Parse their JSX body through the same JSX parser
- Emit them as private methods on the class
- In the template, replace `<LeftIcon {...props} />` with `${this._renderLeftIcon()}`

---

#### 2. Event Dispatch Rewrite (26 components)

Some `fireNonCancelableEvent` calls still reference the React callback prop variable instead of `this`.

**Pattern:** `fireNonCancelableEvent(onChange, { value })` should be `fireNonCancelableEvent(this, 'change', { value })`

**Fix:** The event transform (`src/transforms/events.ts`) only rewrites handlers. It needs to also scan:
- Template inline event expressions (`@click=${() => fireNonCancelableEvent(onChange, ...)}`)
- Effect bodies
- Helper function bodies

Also handle `fireCancelableEvent(onFollow, detail, event)` and `controlledOnXxx` prefixed handlers.

---

#### 3. Missing Lifecycle and Public API (25 components)

`useEffect`, `useImperativeHandle`, and `useRef` are parsed into the IR but the emitter doesn't always produce the corresponding Lit code because:
- Effects with event listener setup end up in handler bodies, not lifecycle
- `useImperativeHandle` public methods reference `ref.current` which needs rewriting
- Some effects are in the **index.tsx** wrapper, not internal.tsx, and get lost during merge

**Fix:**
- Ensure all EffectIR entries emit to lifecycle methods (connectedCallback/willUpdate/updated)
- Ensure all PublicMethodIR entries emit with correct `this.shadowRoot.querySelector()` patterns
- Process `useImperativeHandle` from both index.tsx and internal.tsx

---

#### 4. Unresolved React Component Tags in Templates (13 components)

Components like `<CSSTransition>`, `<BuiltInErrorBoundary>`, `<StickyHeaderContext.Provider>` have no Lit equivalent.

**Fix:** Extend the component registry with removal/replacement mappings:
- `CSSTransition` → unwrap (keep children, apply CSS transitions)
- `BuiltInErrorBoundary` → unwrap (no Lit equivalent)
- Context providers → `@provide` on the host class
- `InternalBox` → `<cs-box>`
- `ExpandableSectionContainer` → inline the template

---

#### 5. Render Props / AbstractSwitch (6 components)

Checkbox, Toggle, RadioButton, Tiles use `<AbstractSwitch nativeControl={(props) => <input .../>}>`. The render prop pattern can't be emitted as a Lit property.

**Fix:** The AbstractSwitch transform (planned in PLAN.md §3.8) needs implementation:
- Inline the AbstractSwitch template into the component
- Replace `nativeControl` render prop with the actual `<input>` element
- Replace `styledControl` with the actual SVG/icon element

---

### MEDIUM Priority — Cosmetic / Non-Critical

#### 6. Spread Attribute Comments (77 components)

`{...baseProps}` becomes `/* spread: baseProps */`. Most are internal plumbing.

**Fix:** For `baseProps`, drop entirely (handled by base class). For user-visible spreads, expand to explicit attributes or use `@open-wc/lit-helpers` `spreadProps` directive.

---

#### 7. ControllableController Malformed Init (9 components)

`useControllable(value, handler, default, { componentName })` → incorrect constructor call.

**Fix:** Parse `useControllable` args positionally, map to `ControllableController({ defaultValue })`.

---

#### 8. Raw clsx in Template Expressions (9 components)

Some `clsx()` calls survive because they're in attribute value expressions that don't go through the clsx transform (the transform only processes `classMap` kind attributes).

**Fix:** Extend the clsx transform to also process `property` and generic attribute values that contain `clsx()`.

---

### LOW Priority — Cleanup

#### 9. React Type Annotations (`KeyboardEvent<Element>`, etc.)

Strip React-specific generic params from event types.

#### 10. Duplicated `updated()` Bodies (6 components)

Deduplicate when multiple `useEffect` calls produce the same body.

---

## Recommended Attack Order

| Order | Issue | Impact | Components | Effort |
|-------|-------|--------|------------|--------|
| 1 | JSX helper inlining | Unblocks 45 components | 45 | High |
| 2 | Event dispatch rewrite | Fixes event system | 26 | Low |
| 3 | Missing lifecycle/API | Adds connectedCallback, focus() | 25 | Medium |
| 4 | Component tag resolution | Fixes template parsing | 13 | Low |
| 5 | AbstractSwitch inlining | Fixes checkbox/toggle | 6 | High |
| 6 | clsx in expressions | Fixes class bindings | 9 | Low |
| 7 | ControllableController | Fixes controller init | 9 | Low |
| 8 | Spread comments | Cosmetic cleanup | 77 | Medium |
| 9 | React types | Compile fix | few | Low |
| 10 | Deduplicated updated() | Cleanup | 6 | Low |

## Success Metric

Target: **80+ clean components** (from current 39), with all 91 producing valid TypeScript that compiles.
