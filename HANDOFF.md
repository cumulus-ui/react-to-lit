# React-to-Lit: Session Handoff

## STOP — Read this ENTIRE document before making ANY changes

You are continuing work on a **general-purpose React-to-Lit conversion tool**. It converts React function components to Lit web components.

The test bed is Cloudscape Design System (91 components). **Every fix MUST be general-purpose.** If your fix mentions a component name, you're doing it wrong. If your fix only works for one component, you're doing it wrong. The tool must convert ANY React function component.

**Current state:**
- **91/91 components** generate valid Lit output (gate2 per-component: 0 errors)
- **791 tests** passing, TypeScript compiles clean
- **Shared tsc**: 16 errors across 11 components (down from 526 → 166 → 94 → 42 → 16)
- **80/91 components** fully error-free in shared compilation
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
- Run `npx vitest run` (must be 682+ passing).
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
| Event prop alias matching | (verified via gate2) | Event transform includes `propAliases` (e.g., `onFinish: onFinishHandler`) and matches `props.propName` patterns in fire*Event calls |
| `fire*Event(__xxx, ...)` multi-arg cleanup | `cleanup.test.ts` | Strips entire `fire*Event` calls when first arg is `__`-prefixed (not just single-arg calls) |
| `fireNonCancelableEvent` import specificity | (verified via gate2) | Import emitter checks for `fireNonCancelableEvent` specifically, not just any events module import |
| Ref deferred initialization | (verified via gate2) | `emitRefs()` now returns `{ code, deferred }` and defers `this.`-referencing initializers to `firstUpdated()` |
| `JSX.Element` → `unknown` | (verified via gate2) | React-specific `JSX.Element` namespace type cleaned to `unknown` |
| Ref `.current` on subexpressions | (verified via gate2) | `(cond ? refA : refB).current` → `(cond ? refA : refB)` — `.current` stripped after `)` since inner refs are already unwrapped |
| `!undefined` → `true` simplification | (verified via gate2) | Cleanup artifacts from `__`-prefixed prop stripping simplified |
| `(expr !== undefined) ?? false` removal | (verified via gate2) | Redundant `?? false` after boolean comparison stripped via shared `cleanSimplifyUndefined` |
| `collectIRText` shared utility | (verified via gate2) | Replaces 3 duplicated `allCode` arrays + `codeBodyContains`/`templateToText`/`irContains` |
| Entry-file self-containment detection | `parse-components.test.ts` | When entry doesn't import from secondary file, entry IS the implementation — filename-agnostic |
| `findComponentInFile` strategy 5 generalized | (verified via gate2) | Uses `isSecondaryFile` parameter instead of hardcoded `'internal'`/`'implementation'` filenames |
| Preserved imports from `/context`, `/hooks`, `use-` paths | (verified via gate2) | Removed over-aggressive `isComponentImportPath` rules; emitter reference checking handles unused names |
| Import reference scanning includes types | (verified via gate2) | `collectIRText` includes ref types, state types, computed types, prop types |

---

## Remaining 16 errors — categorized

### TS2304: Cannot find name (10 errors)

| Category | Count | Components | Root cause |
|----------|-------|-----------|------------|
| Skipped prop refs | 4 | button (`nativeButtonAttributes`, `nativeAnchorAttributes`, `buttonProps` ×2) | Props in SKIP_PROPS are removed from the class but preamble variables still reference them. Fundamental React props-as-object mismatch. |
| Rest-spread / props object | 3 | input (`rest`), item-card (`nativeAttributes`), table (`props`) | `...rest` from prop destructuring and raw `props` object don't exist in Lit. Native attributes are set directly on the host element. |
| Helper-body constants | 1 | modal (`MODAL_READY_TIMEOUT`) | Plain `const` inside helper function body referenced by extracted effect. Handler extraction now works but non-function locals need similar treatment. |
| Analytics infrastructure | 1 | modal (`analyticsComponentMetadata`) | Analytics variable partially stripped by cleanup — declaration removed but stray reference and malformed expression remain. |
| JSX pre-transform edge case | 1 | date-range-picker (`prevDateOnly`) | Effect body with escaped backticks in template literal (`\`dateOnly\``) gets mangled during JSX pre-transform, truncating the condition expression. `stripFunctionCalls` works correctly (confirmed by test). |

### TS2339: Property does not exist (2 errors)

| Component | Error | Root cause |
|-----------|-------|------------|
| pie-chart | `.filter` on `() => any` | Preamble variable with JSX (`data.map(d => ({ marker: <Marker/> }))`) misclassified as render helper method instead of data array. |
| tag-editor | `.current` on `any[]` | Ref from index wrapper typed as `any[]` instead of `Ref<T[]>`. Ref extraction doesn't preserve array-of-refs pattern. |

### TS2345/TS2322/TS2556: Type mismatches (4 errors)

| Component | Error | Root cause |
|-----------|-------|------------|
| cards | analytics type mismatch | Partially-stripped analytics metadata literal doesn't match `GeneratedAnalyticsMetadataFragment` type. |
| dropdown | spread argument | `...calculatePosition(...)` return not tuple-typed. TypeScript strictness issue. |
| dropdown | union narrowing | `DropdownPosition \| InteriorDropdownPosition` not assignable to `DropdownPosition`. Missing type narrowing. |
| top-navigation | `{}` not assignable to `string` | `fireCancelableEvent(this.identity.onFollow, {}, event)` — event transform didn't fire because first arg is nested property access, not direct prop. |

---

## Commands

```bash
# Run unit tests (fast, 682 tests)
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

1. **Skipped prop references in preamble** (~7 errors, button + input + item-card + table): Props in `SKIP_PROPS` and `...rest` from destructuring are removed from the class but preamble variables still reference them. Preamble statements that reference undefined names should be filtered or the variables should be mapped to `this`.

2. **JSX pre-transform escaped backtick handling** (~1 error, date-range-picker): The JSX pre-transform mangles non-JSX template literals containing escaped backticks (`\`dateOnly\``), truncating effect bodies. `stripFunctionCalls` works correctly (confirmed by test) — issue is upstream in the pre-transform.

3. **Preamble variable with JSX misclassified as render helper** (~1 error, pie-chart): `const filterItems = data.map(d => ({ marker: <Marker/> }))` contains JSX but is a data array, not a render helper. `extractBodyPreamble` treats any variable with `html\`` as a render helper method, changing its type from array to function.

4. **Helper-body non-function locals** (~2 errors, modal): Plain `const` declarations and analytics preamble variables inside helper bodies need extraction when effects reference them, same as handler extraction.

5. **Event transform for nested property access** (~1 error, top-navigation): `fireCancelableEvent(identity.onFollow, {}, event)` — first arg is a property access, not a direct prop name. Event transform regex doesn't match.

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
