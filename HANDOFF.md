# React-to-Lit: Session Handoff

## STOP — Read this ENTIRE document before making ANY changes

You are continuing work on a **general-purpose React-to-Lit conversion tool**. It converts React function components to Lit web components.

The test bed is Cloudscape Design System (91 components). **Every fix MUST be general-purpose.** If your fix mentions a component name, you're doing it wrong. If your fix only works for one component, you're doing it wrong. The tool must convert ANY React function component.

**Current state:**
- **91/91 components** generate valid Lit output (gate2 per-component: 0 errors)
- **680 tests** passing, TypeScript compiles clean
- **Shared tsc**: 62 errors across 25 components (down from 526 → 166 → 94 → 62)
- **67/91 components** fully error-free in shared compilation
- All 7 original issues (#11-#18) are closed

---

## RULES — Violating these WILL cause regressions

Read each rule. Understand WHY it exists. The "why" is learned from painful debugging sessions.

### 1. No hacks. NONE.
- **No `as any` casts in generated output.** Narrow casts (`as Element`, `as HTMLInputElement`) are acceptable only for known DOM type gaps.
- **No hardcoded component names.** Don't check `if (name === 'PropertyFilter')`. Use patterns.
- **No `= false` default values for props.** This causes TS1240/TS2416 cascading errors in subclasses. Props without defaults must remain uninitialized.
- **No `!` definite assignment assertions.** These hide real issues.

### 2. The `__`-prefixed cleanup has THREE layers — understand all of them.
- **Code bodies** (`cleanInternalPrefixedRefs`): Conservative patterns — conditions, ternaries, logical operators. Does NOT replace bare `__xxx` with `false` in code bodies because that breaks type annotations, object keys, and function params.
- **Template expressions** (`cleanInternalPrefixedRefsInExpr`): Aggressive — replaces bare `__xxx → false`. Safe because template interpolations are value positions.
- **Render helper template literals** (`cleanTemplateInterpolations`): Scans `${...}` inside `html\`` in helper source text and applies the template-expression cleanup.
- **Why three layers?** Because `__`-prefixed props are stripped from declarations but their usage persists in three different text locations. A previous session tried a single blanket replacement and broke type annotations.

### 3. Regex cleanup is DANGEROUS. Prefer line-level patterns.
- **NEVER use `stripIfBlocks` on patterns that could match normal code.** A previous attempt to strip `if (...) { analyticsMetadata... }` ate the entire render method body because `[^}]*` consumed nested braces.
- **Always use `^\s*...\s*$/gm` (line-anchored, multiline) for cleanup patterns.** This limits damage to a single line.
- **After ANY regex cleanup change, check for TS1xxx syntax errors.** These mean you broke the output structure.

### 4. Identifier rewriting is scope-aware — don't break this.
- `src/transforms/identifiers.ts` uses ts-morph to walk the AST.
- **Top-level locals** (declared directly in the wrapper body) shadow class members globally.
- **Inner scope locals** (arrow function params, nested function params, for-of vars) only shadow within their own scope — checked per-identifier by `isShadowedByNestedScope`.
- A previous version used a flat `bodyLocals` set which caused `series.map(({ series }) => ...)` to fail — the inner destructured `series` parameter blocked rewriting of the outer `series` prop reference.

### 5. Deferred initialization is REQUIRED for `this.` in field initializers.
- In React, `useState(props.foo)` runs at first render when props are available.
- In Lit, class field initializers run at construction time, BEFORE props are set.
- `emitState`, `emitProperties`, and `emitControllers` return `{ code, deferred: DeferredInit[] }`.
- Deferred inits are injected into `firstUpdated()` by the lifecycle emitter.
- **If you add a new field type that can reference `this.`, you MUST check for deferred init.**

### 6. Test every fix. No exceptions.
- Add a unit test in `test/transforms/` or `test/emitter/` that covers the specific pattern.
- Run `npx vitest run` (must be 680+ passing).
- Run `npm run gate2` (must complete with no failures).
- Run the shared tsc command and verify error count went down, not up.
- **Check for TS1xxx syntax errors** — these mean your change broke the output.

### 7. Don't touch these.
- `vendor/cloudscape-source/` — the React source input. Read-only.
- Gate2's per-component approach — don't change it to shared compilation.
- The hook registry architecture — don't hardcode hook names outside the registry.

---

## Pipeline architecture

```
React TSX → Parser → IR → Transforms → Emitter → Lit TS
```

1. **Parser** (`src/parser/`): Extracts component structure from TSX. Props from interfaces, hooks from body, handlers, effects, template from JSX return.
2. **IR** (`src/ir/types.ts`): Intermediate representation — props, state, handlers, effects, template tree, computed values, controllers, helpers.
3. **Transforms** (`src/transforms/`): Pipeline of IR→IR transforms: cleanup, clsx→classMap, React types, events, effect cleanup promotion, identifiers.
4. **Emitter** (`src/emitter/`): Produces Lit class from transformed IR.

### Key files and what they do

| File | Purpose | Traps to avoid |
|------|---------|---------------|
| `src/transforms/identifiers.ts` | Rewrites bare names to `this.xxx` / `this._xxx` | Don't flatten the scope analysis. The `buildMemberMap` + `isShadowedByNestedScope` + `topLevelLocals` trio is intentionally complex. |
| `src/transforms/cleanup.ts` | Strips Cloudscape infrastructure | Line-level regex only. No multi-line `[^}]*` patterns. |
| `src/transforms/cleanup-react-types.ts` | React → DOM type conversions | Applied via `mapIRText` to all text fields + template walker + prop types. |
| `src/emitter/properties.ts` | Emits `@property()`, `@state()`, controllers | Returns `{ code, deferred }` — the deferred inits MUST be passed to lifecycle. |
| `src/emitter/lifecycle.ts` | Emits lifecycle methods | Receives `deferredInits` and injects into `firstUpdated()`. Strips cleanup returns (both block and expression body). |
| `src/emitter/template.ts` | Emits `html\`` templates | `classMap` must NOT wrap expressions containing `html\``. |
| `src/emitter/class.ts` | Assembles the full component | Orchestrates all emitters. Passes `allDeferred` to lifecycle. |
| `scripts/gate2-typecheck.ts` | Generates gate2 output + stubs | Auto-generates ambient type stubs. `SomeRequired` has a REAL definition (not `= any`). The stub append logic checks by exported NAME, not exact line. |

---

## What's been fixed — the full list

Each entry has a test reference. If you modify the related code, run that test to verify you didn't regress.

| Fix | Test file | Key insight |
|-----|-----------|-------------|
| Scope-aware identifier shadowing | `identifiers.test.ts` "scope-aware shadowing" | Inner arrow params only shadow their scope, not the whole body |
| Prop default value rewriting | `identifiers.test.ts` "prop default values" | `prop.default` goes through `astRewrite` in the identifiers transform |
| Const arrow render helper detection | `identifiers.test.ts` "const arrow render helper" | `const foo = (x) => html\`...\`` must be in the member map |
| Deferred state/prop/controller init | `properties.test.ts`, `lifecycle.test.ts` | `this.` references in initializers → defer to `firstUpdated()` |
| Expression-body cleanup return stripping | `lifecycle.test.ts` | `return () => expr;` must be stripped alongside `return () => { ... };` |
| `setTimeout` → `window.setTimeout` | `cleanup-react-types.test.ts` | Browser context returns `number`, not `NodeJS.Timeout` |
| `event.relatedTarget` → `as Element` | `cleanup-react-types.test.ts` | Only cast when used as function argument (closing paren follows) |
| `event.target.value`/`.files`/`.form` → cast | `cleanup-react-types.test.ts` | Also handles destructured `target.files` |
| `__`-prefixed in render helper templates | `cleanup.test.ts` "__-prefixed in render helper templates" | `cleanTemplateInterpolations` scans `${...}` inside `html\`` |
| Function call with sole `__` arg removed | `cleanup.test.ts` "removes function calls with sole __xxx argument" | `fireNonCancelableEvent(__onOpen)` → removed entirely |
| classMap not wrapping `html\`` expressions | (verified via gate2) | Check `expr.includes('html\`')` before wrapping |
| `__awsui__` cleanup | (verified via gate2) | `stripIfBlocks` for `node.__awsui__` + line-level assignment removal |
| Analytics metadata removal | (verified via gate2) | Line-level `const` and deep property assignment removal |
| Ambient type stubs with generic arity | (verified via gate2) | Scans type positions + `Name<` patterns + inner generic args |
| `SomeRequired` real type definition | (verified via gate2) | Stub append logic checks by NAME to avoid re-declaring |
| Type guard branded stubs | `parse-components.test.ts` "List" | Types in type guards (e.g., `t is TokenGroup`) get branded interface stubs instead of `= any` — prevents union narrowing to `never` |
| Render callback prop classification | `parse-components.test.ts` "List", `cleanup-react-types.test.ts` "prop type cleanup" | Function types `(args) => ReactNode` are properties, not slots. Prop types also get React type cleanup. |
| Expression wrapping for identifiers | `identifiers.test.ts` "expression wrapping" | `rewriteWithMorph` accepts `isExpression` flag so object literals with nested arrow semicolons are parsed correctly |
| Generic function stubs | (verified via gate2) | Functions called with type arguments (e.g., `foo<T>(...)`) get `declare function` stubs instead of `const: any` — supports nested angle brackets |
| Zero-param expression-body arrow extraction | `parse-components.test.ts` "Wizard" | `() => doSomething()` expression-body arrows with function-call bodies are now extracted as handlers. Previously fell into gap between `isHandlerDeclaration` (skipped from preamble) and `isSignificantFunction` (rejected from handlers). |
| Internal generated module import preservation | (verified via gate2) | `isComponentImportPath` no longer skips `/index.js` imports from `/generated/` utility modules (CSS custom properties, etc.) |

---

## Remaining 62 errors — categorized

### TS2304: Cannot find name (40 errors)

| Category | Count | Examples | Root cause | Correct fix |
|----------|-------|---------|------------|-------------|
| SCOPE vars | ~25 | `step`, `buttonProps`, `internalTags`, `itemContent`, `shouldAddDivider` | Variables from hook returns, `useMemo` bodies, loop callbacks, or local component body that weren't promoted to class scope | Complex: these include loop-body locals (`.map()` callback vars), composite props objects (gutted by cleanup), and vars from `implementation.tsx` (not scanned by parser). Each subcategory needs a different fix. |
| IMPORT/hook funcs | ~10 | `useModalContext`, `useContainerBreakpoints`, `formatDndStarted`, `i18n`, `funnelSubmit` | Hooks/functions from stripped modules where the return values are used, OR hook is in `implementation.tsx` which parser doesn't scan | Extend parser to scan `implementation.tsx` files; improve hook return preservation for unknown hooks |
| Remaining | ~5 | `rest`, `props`, `analyticsComponentMetadata`, `isRefresh` | Rest-spread from props not handled; raw props reference; helper using var from different component function in same file | Case-by-case: `rest` → rest-spread pattern; `props` → raw props ref; `isRefresh` → cross-function var in helper |

### TS2339: Property does not exist (7 errors)

- **4 are context issues**: error-boundary (`_errorBoundariesContext`), header (`_collectionLabelContext`). These are `useContext` calls the parser didn't convert to `@consume` fields.
- **3 are misc**: breadcrumb-group (`.href` on generic T, `.slice` on wrong type), button-dropdown (`.current` on HTMLElement — ref not fully converted), pie-chart (`.filter` on wrong type).

### TS2345: Argument type mismatch (4 errors)
- code-editor (2): `fireNonCancelableEvent(this.onValidate, ...)` — first arg should be `this` (EventTarget), not a callback prop. Partially converted event dispatch.
- cards: analytics type leftover
- top-navigation: `{}` not assignable to `string`

### Other (9 errors)
- TS2869 (2): unreachable `??` right operand (annotation-context)
- TS2554 (2): wrong arg count (annotation-context, input)
- TS2322 (2): type mismatch (breadcrumb-group, dropdown)
- TS2873 (1): always-falsy expression (slider)
- TS2729 (1): used before initialization (autosuggest)
- TS2694 (1): JSX namespace member (date-range-picker)
- TS2556 (1): spread argument (dropdown)
- TS2552 (1): similar name suggestion (breadcrumb-group)

---

## Commands

```bash
# Run unit tests (fast, 680 tests)
npx vitest run

# Run gate2 (generates all 91 components + type-checks each individually)
npm run gate2

# Shared tsc on gate2 output (the target: get this to 0)
npx tsc --noEmit --strict false --skipLibCheck --experimentalDecorators -p .gate2-output/tsconfig.json 2>&1 | grep "^\.gate2" | wc -l

# Error breakdown
npx tsc --noEmit --strict false --skipLibCheck --experimentalDecorators -p .gate2-output/tsconfig.json 2>&1 | grep "^\.gate2" | grep -oP 'TS\d+' | sort | uniq -c | sort -rn

# Error-free component count
all=$(ls .gate2-output/*/index.ts | wc -l); errored=$(npx tsc --noEmit --strict false --skipLibCheck --experimentalDecorators -p .gate2-output/tsconfig.json 2>&1 | grep "^\.gate2" | grep -oP '(\w+)/index\.ts' | sort -u | wc -l); echo "$((all - errored)) / $all"

# Check a specific component's output
cat .gate2-output/component-name/index.ts

# Components with fewest errors (easiest wins)
npx tsc --noEmit --strict false --skipLibCheck --experimentalDecorators -p .gate2-output/tsconfig.json 2>&1 | grep "^\.gate2" | grep -oP '(\w+)/index\.ts' | sort | uniq -c | sort -n | head -20
```

## Workflow: how to fix errors

1. **Categorize**: Run shared tsc, group by error code, find the pattern
2. **Find root cause**: Look at the `.gate2-output/component/index.ts` error line, then trace BACK to which parser/transform/emitter produced it
3. **Fix generically**: The fix should apply to ANY React component with this pattern
4. **Write a test FIRST** (or alongside): Unit test in `test/transforms/` or `test/emitter/`
5. **Verify**: `npx vitest run` → `npm run gate2` → shared tsc. Check TS1xxx = 0.
6. **Commit**: Small, focused commits with clear messages

## Highest-impact next steps (in priority order)

1. **Parser file resolution for `implementation.tsx`** (~10 errors): Many Cloudscape components split into `internal.tsx` (wrapper) + `implementation.tsx` (actual component). The parser only scans `index.tsx` and `internal.tsx`. Extending file resolution to also scan `implementation.tsx` would capture hooks like `useInternalI18n`, `useFunnel`, etc. that produce variables still referenced in the output.

2. **Loop-body local variable extraction** (~6 errors): Variables defined inside `.map()` callbacks (e.g., `shouldAddDivider`, `itemContent` in button-group, `step` in steps) are not captured by any extractor. These need either: (a) the template restructuring to inline the loop body, or (b) a mechanism to preserve loop-body locals when the loop is decomposed into template expressions.

3. **Rest-spread props pattern** (~3 errors): `const { a, b, ...rest } = props` produces a `rest` variable that's used for form-field context. The converter strips the destructuring but leaves `rest` references. Need a pattern to either inline the rest-spread or convert it to a computed getter.

4. **Event dispatch argument fixing** (~2 errors): `fireNonCancelableEvent(this._onFinish)` and `fireNonCancelableEvent({ relatedTarget })` have wrong arg counts. The event transform needs to handle the 1-arg pattern where the callback was the first arg (pre-conversion) and wasn't fully updated to the `(target, eventName, detail)` signature.

---

## Traps that caught previous sessions

| Trap | What happened | How to avoid |
|------|--------------|--------------|
| Flat bodyLocals set | All variable declarations in the body were added to one set, ignoring scope. Inner arrow params blocked outer member rewriting. | The `isShadowedByNestedScope` function now walks ancestors. Don't simplify it. |
| `[^}]*` in regex | Used in `stripIfBlocks` for analytics cleanup. Consumed nested braces and ate the entire render method. | Use line-anchored patterns (`^\s*...\s*$/gm`). |
| `= any` for utility types | `SomeRequired<T, K> = any` caused downstream `never` narrowing. | Preserve real type definitions in stubs. The stub append logic now checks by name. |
| Bare `__xxx → false` in code bodies | Replaced `__xxx` in type annotations like `type Foo = __Internal` → `type Foo = false`. | Three-layer cleanup: code bodies (conservative), template expressions (aggressive), render helper interpolations (aggressive). |
| `const` render helpers skipped | `const typeToIcon = (size) => ({ html\`...\` })` was skipped from member map because line 117 said "skip const declarations". | Now checks if the const is an arrow function with `html\``. |
| `prop.default` not rewritten | Prop default values like `loopFocus = expandToViewport` weren't going through the identifier rewriter. | Added `prop.default` rewriting in identifiers transform + `props` to the return value. |
| Cleanup return not stripped (expression body) | `return () => clearTimeout(ref);` wasn't matched by the block-body pattern `return () => { ... }`. | Added a second pass for expression-body arrows in `stripCleanupReturns`. |
| `type = any` in stubs breaks union narrowing | When two types in a union are both `= any`, TypeScript collapses the union to `any`. Type guards produce `never` in the else branch. | Auto-detect type guard patterns (`t is Foo`) and generate branded interface stubs with `__brand?: 'Name'` for structural distinction. |
| `interface` stubs break string types | Changing ALL stubs from `type = any` to `interface { [key: string]: any }` breaks types like `PaneStatus` that are compared with string literals. | Only change types detected in type guard unions. Keep `= any` as default for non-guard types. |
| Template preamble promotion causes cascading regressions | Extending `promotePreambleVars` to scan template expressions promotes variables that (a) have shorthand properties in object literals (breaks with `this.` prefix), (b) are multi-statement blocks (misidentified as expressions), (c) are reassigned later (getters are read-only). | Don't naively scan templates for promotion. The correct approach requires distinguishing render-only vars from cross-scope vars, and handling shorthand properties + block bodies in the identifier rewriter. |
| `isFunctionProp` bailed on ReactNode in return types | `(item: T) => { content: ReactNode }` was classified as a slot because `isFunctionProp` rejected any type containing ReactNode. | Now checks if the type STARTS with `(` — function signatures always start with `(`, while slot unions start with the type name. |
| Handler extraction gap: `isHandlerDeclaration` vs `isSignificantFunction` | `isHandlerDeclaration()` classified zero-param expression arrows as handler-like (skipped from preamble) but `isSignificantFunction()` rejected them (not extracted as handlers). Variable was lost. | `isSignificantFunction` now accepts expression-body arrows whose body is a function call or tagged template. |
| `/index.js` import filter too broad | `isComponentImportPath` skipped ALL `/index.js` imports including utility modules like `/internal/generated/custom-css-properties/index.js`. | Now checks for `/generated/` in the path and preserves those imports. |
