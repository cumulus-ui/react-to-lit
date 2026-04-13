# React-to-Lit: Session Handoff

## STOP — Read this ENTIRE document before making ANY changes

You are continuing work on a **general-purpose React-to-Lit conversion tool**. It converts React function components to Lit web components.

The test bed is Cloudscape Design System (91 components). **Every fix MUST be general-purpose.** If your fix mentions a component name, you're doing it wrong. If your fix only works for one component, you're doing it wrong. The tool must convert ANY React function component.

**Current state:**
- **91/91 components** generate valid Lit output (gate2 per-component: 0 errors)
- **792 tests** passing, TypeScript compiles clean
- **Shared tsc**: 14 errors across 10 components (down from 526 → 166 → 94 → 42 → 14)
- **81/91 components** fully error-free in shared compilation
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
- Run `npx vitest run` (must be 792+ passing).
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

1. **Parser** (`src/parser/`): Extracts component structure from TSX. Props from interfaces (including body-level destructuring for forwardRef), hooks from body, handlers, effects, template from JSX return. **Helper functions** in the same file get their hooks, handlers, and effect-referenced constants extracted and merged into the main IR. Index wrapper hooks (refs, preservedVars) are also merged for public method support.
2. **IR** (`src/ir/types.ts`): Intermediate representation — props, state, handlers, effects, template tree (with loop preamble support), computed values, controllers, helpers (with optional extracted hooks).
3. **Transforms** (`src/transforms/`): Pipeline of IR→IR transforms: cleanup, clsx→classMap, React types, events, effect cleanup promotion, identifiers. Template walker processes loop preamble through the expression visitor.
4. **Emitter** (`src/emitter/`): Produces Lit class from transformed IR. Preamble filter uses general-purpose patterns (any `use*()` hook call, bare function call statements as side-effects). Loop emission supports block-body arrows when preamble exists.

### Key files and what they do

| File | Purpose | Traps to avoid |
|------|---------|---------------|
| `src/parser/utils.ts` | Helper extraction, handler extraction, `isHookCall` | `isHookCall` recursively matches property access on hooks (e.g., `useContext(X).prop`). `extractHelperHooks` extracts hooks, handlers (when effects exist), and effect-referenced constants from helper bodies. |
| `src/parser/hooks.ts` | Hook extraction from function bodies | Uses `isHookCall` as gatekeeper: direct calls get full structural extraction, wrapped calls (property access) get variable preservation. `processUseState` inlines preamble variables in state initializers. `processUseMemo` handles destructured returns via `collectPreservedVars`. |
| `src/parser/jsx.ts` | JSX → template IR, including `.map()` loops | `tryParseMapCall` preserves loop-body preamble (variable declarations before return). When a `.map()` callback returns a ternary, wraps in fragment so both branches are inside the loop. |
| `src/transforms/identifiers.ts` | Rewrites bare names to `this.xxx` / `this._xxx` | Don't flatten the scope analysis. The `buildMemberMap` + `isShadowedByNestedScope` + `topLevelLocals` trio is intentionally complex. |
| `src/transforms/cleanup.ts` | Strips Cloudscape infrastructure | Line-level regex only. No multi-line `[^}]*` patterns. |
| `src/transforms/cleanup-react-types.ts` | React → DOM type conversions | Applied via `mapIRText` to all text fields + template walker + prop types. |
| `src/emitter/properties.ts` | Emits `@property()`, `@state()`, controllers | Returns `{ code, deferred }` — the deferred inits MUST be passed to lifecycle. |
| `src/emitter/lifecycle.ts` | Emits lifecycle methods | Receives `deferredInits` and injects into `firstUpdated()`. Strips cleanup returns (both block and expression body). |
| `src/emitter/template.ts` | Emits `html\`` templates | `classMap` must NOT wrap expressions containing `html\``. Loop emission uses block-body arrow when `loop.preamble` exists. |
| `src/emitter/class.ts` | Assembles the full component | Orchestrates all emitters. Passes `allDeferred` to lifecycle. `stripReactHooks` was removed — hook stripping is now AST-level in the parser. Preamble filter uses general-purpose `use*()` pattern. |
| `src/template-walker.ts` | Structural recursion over template IR | Handles loop preamble through expression visitor. |
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
| Helper function hook extraction | `parse-components.test.ts` "helper hooks", cross-cutting "no hook calls" | `extractHelperHooks` runs `extractHooks` on each helper body, strips hook statements from source, merges results into main IR with deduplication. Replaces the old text-level `stripReactHooks` hack. |
| Body-level prop destructuring | `parse-components.test.ts` "body-destructured props" | `getDestructuredProps` scans body for `const { ... } = props` when first param is a plain identifier (forwardRef pattern). Shared `extractFromBindingPattern` avoids duplication. |
| Loop-body preamble preservation | `parse-components.test.ts` "loop-body locals" | `tryParseMapCall` captures variable declarations before the return as `loop.preamble`. Emitter produces block-body arrow. Template walker processes preamble through expression visitor. |
| Ternary-inside-map scoping | (verified via gate2) | When `.map()` callback returns a ternary, wraps in fragment so both branches have loop variable access. Previously the alternate branch was outside the loop. |
| Destructured useMemo returns | `parse-components.test.ts` "destructured useMemo" | `processUseMemo` falls through to `collectPreservedVars` for `ObjectBindingPattern` — destructured names get class fields. |
| Index wrapper hook merging | (verified via gate2) | `parseComponent` step 5b merges refs and preservedVars from index.tsx wrapper, not just publicMethods and contexts. Fixes useImperativeHandle bodies referencing wrapper-local hooks. |
| State init preamble inlining | `parse-components.test.ts` "state init inlining" | `processUseState` looks up preamble variables by name in the body via `findPreambleVarInitializer` and inlines their expression into the state initializer. |
| Hook call property access detection | (verified via gate2) | `isHookCall` recursively matches property access on hook calls (`useContext(X).prop`). `extractHooks` uses `isHookCall` as single gatekeeper: direct calls → structural extraction, wrapped calls → preserve variables. |
| Helper-body handler extraction | `parse-components.test.ts` "Modal helper-body handlers" | When a helper has extracted effects, `extractHelperHooks` also runs `extractHandlers` and merges results. `allHandlers` computed after helper merge to include helper-extracted handlers. |
| Helper-body effect-referenced constants | (verified via gate2) | Scans effect and handler bodies for referenced identifiers, then extracts matching non-hook, non-handler constant declarations as computed values. |
| Data arrays with JSX kept as preamble | (verified via gate2) | `isTemplateVariable` distinguishes direct templates/functions from `.map()` results. Data arrays containing JSX stay as preamble instead of becoming render helper methods. |
| General-purpose preamble filter | (verified via gate2) | Emitter filters standalone `use*()` calls and `const x = use*()` declarations. Bare function call expression statements (side-effects) skipped in parser. Replaced Cloudscape-specific `REACT_PATTERNS` and `stripReactHooks`. |
| Redundant Cloudscape hardcoding removed | (verified via gate2) | Removed inline `useBaseComponent`/`getBaseProps` strings from preamble filter — covered by `INFRA_FUNCTIONS` config and general bare-call filter. |

---

## Remaining 14 errors — categorized

### TS2304: Cannot find name (8 errors)

| Category | Count | Components | Root cause |
|----------|-------|-----------|------------|
| Skipped prop refs | 4 | button (`nativeButtonAttributes`, `nativeAnchorAttributes`, `buttonProps` ×2) | Props in `SKIP_PROPS` are removed from the class but preamble variables still reference them. `buttonProps` declaration was filtered because it contained `useMergeRefs` in its initializer. `nativeButtonAttributes` and `nativeAnchorAttributes` are destructured from params but excluded as props. Fundamental React props-as-object mismatch — in Lit, native attributes are set directly on the host element. |
| Rest-spread / props object | 3 | input (`rest`), item-card (`nativeAttributes`), table (`props`) | `...rest` from prop destructuring and raw `props` object don't exist in Lit. `rest` is used to destructure form-field context props (`ariaLabelledby`, etc.) that ARE class fields but accessed via the non-existent `rest` intermediary. `props` in table is spread into a local object. `nativeAttributes` is a skipped prop passed to infrastructure `processAttributes()`. |
| Analytics infrastructure | 1 | modal (`analyticsComponentMetadata`) | Analytics variable partially stripped by cleanup — declaration removed but a stray reference in the helper method body persists. The `const metadataAttribute = ... ? getAnalyticsMetadataAttribute({ component: analyticsComponentMetadata }) : {}` gets mangled to `const metadataAttribute = analyticsComponentMetadata }` by incomplete analytics stripping. |

### TS2339: Property does not exist (1 error)

| Component | Error | Root cause |
|-----------|-------|------------|
| tag-editor | `.current` on `any[]` | Ref from index wrapper (`keyInputRefs = useRef<(T | null)[]>([])`) typed as `any[]` instead of preserving the ref wrapper. Ref extraction drops the `Ref<>` wrapper and the `.current` access pattern. |

### TS2345/TS2322/TS2556: Type mismatches (4 errors)

| Component | Error | Root cause |
|-----------|-------|------------|
| cards | analytics type mismatch | Partially-stripped analytics metadata literal doesn't match `GeneratedAnalyticsMetadataFragment` type. Analytics cleanup is incomplete for inline object literals passed as function arguments. |
| dropdown | spread argument (TS2556) | `this._setDropdownPosition(...calculatePosition(...))` — `calculatePosition` returns an array but TypeScript doesn't infer it as a tuple. Needs explicit tuple type assertion or the function return type needs to be narrowed. |
| dropdown | union narrowing (TS2322) | `this._fixedPosition = position` where `position: DropdownPosition \| InteriorDropdownPosition` assigned to field typed as `DropdownPosition`. Missing type narrowing guard. |
| top-navigation | `{}` not assignable to `string` (TS2345) | `fireCancelableEvent(this.identity.onFollow, {}, event)` — event transform didn't fire because first arg is a nested property access (`identity.onFollow`), not a direct prop name. The regex pattern `fireCancelableEvent(propName, ...)` only matches simple identifiers. |

### TS2304 (special case): JSX pre-transform edge case (1 error)

| Component | Error | Root cause |
|-----------|-------|------------|
| date-range-picker | `prevDateOnly` | Effect body with escaped backticks in a template literal (`\`dateOnly\``) gets mangled during JSX pre-transform, truncating the `if` condition from `prevDateOnly !== undefined && prevDateOnly !== dateOnly` to just `prevDateOnly !== undefined`. `stripFunctionCalls` works correctly (confirmed by test at `test/text-utils.test.ts` "exact date-range-picker warnOnce pattern") — the issue is upstream in how the JSX pre-transform handles non-JSX template literals containing escaped backticks. |

---

## Commands

```bash
# Run unit tests (fast, 792 tests)
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

1. **Skipped prop / rest-spread references** (~7 errors, button + input + item-card + table): The fundamental issue is that React's props-as-object pattern (`...rest`, `props`, `nativeAttributes`) has no direct Lit equivalent. Three sub-patterns:
   - **`...rest` destructuring → form-field context props**: `const { ariaLabelledby, ... } = rest` destructures props that ARE class fields. Could be handled by detecting rest-destructuring and mapping to `this`.
   - **Skipped prop refs in preamble**: `nativeButtonAttributes?.tabIndex` references a prop that was excluded by `SKIP_PROPS`. Preamble statements whose only non-trivial identifiers are skipped props should be filtered.
   - **`buttonProps` declaration filtered**: The object literal initializer contained `useMergeRefs(...)` which triggered the `use*()` preamble filter. The hook call is embedded in a larger expression — the filter should only remove standalone hook calls, not expressions that contain them.

2. **JSX pre-transform escaped backtick handling** (~1 error, date-range-picker): Non-JSX template literals with escaped backticks (`\`dateOnly\``) get mangled. Root cause is in the JSX-to-Lit pre-transform (`src/transforms/jsx-to-lit.ts` or related). The `stripFunctionCalls` utility works correctly (confirmed by test).

3. **Event transform for nested property access** (~1 error, top-navigation): `fireCancelableEvent(identity.onFollow, {}, event)` — the event transform regex matches `fireCancelableEvent(propName, ...)` but not `fireCancelableEvent(obj.prop, ...)`. Needs to handle property access expressions as the first argument.

4. **Analytics cleanup completion** (~2 errors, modal + cards): Analytics infrastructure is partially stripped — imports removed, some patterns cleaned, but object literals and variable references in certain positions survive. The cleanup in `removeCloudscapeInternals` needs more thorough handling of `analyticsComponentMetadata` variable declarations and inline analytics literals.

5. **Ref type preservation for array refs** (~1 error, tag-editor): `useRef<(T | null)[]>([])` loses the `Ref<>` wrapper during extraction. The ref is typed as `any[]` instead of preserving `.current` access semantics. `processUseRef` should preserve the ref wrapper type when the initial value is an array.

6. **Dropdown type issues** (~2 errors): The spread argument (`...calculatePosition()`) needs a tuple type assertion. The union narrowing (`DropdownPosition | InteriorDropdownPosition`) needs a type guard. Both are TypeScript strictness issues in the generated output — not structural conversion problems.

### Cloudscape-specific tech debt (from audit)

These don't cause errors but should be addressed for generalization:

| Priority | Item | Files |
|----------|------|-------|
| P1 | `WithNativeAttributes` / `AbstractSwitch` hardcoded in transforms | `jsx-to-lit.ts`, `unwrap.ts`, `components.ts` |
| P1 | `CsBaseElement`, `Cs` class prefix, import paths hardcoded | `imports.ts`, `class.ts` |
| P2 | `fire*Event` names, `FORM_INTERFACES` hardcoded | `parser/index.ts`, `imports.ts` |
| P2 | `testUtilStyles`/`analyticsSelectors`/`baseProps.className` regex in cleanup | `cleanup.ts` |
| P3 | `Internal` prefix stripping, `isDevelopment` detection | `parser/index.ts`, `utils.ts` |

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
| Helper handler extraction too broad | Extracting handlers from ALL helpers pulled handlers that reference helper-local params (e.g., `PageButton`'s `handleClick` references `onClick`/`pageIndex` which are PageButton's own props). | Only extract handlers from helpers that have effects — those are the ones that need class-level promotion. Helpers without effects keep handlers as local scope. |
| Helper constant extraction too broad | Extracting ALL constant declarations from helper bodies broke the helper method body (stripped constants that the method still needed). | Only extract constants that are specifically referenced by effect or handler bodies. Scan bodies for identifiers, then match against local declarations. |
| `allHandlers` computed before helper merge | `const allHandlers = [...hookResult.handlers, ...handlers]` was computed at step 6, but helper-extracted handlers are merged at step 9a. Helper handlers were excluded from the final IR. | Compute `allHandlers` after all merging is complete (step 9c). |
| Preamble data arrays misclassified as render helpers | `const filterItems = data.map(d => ({ marker: html\`...\` }))` contains `html\`` in element properties. `extractBodyPreamble` converted it to a render helper method, changing its type from `Array<...>` to `() => any`. | `isTemplateVariable` distinguishes direct templates/functions from `.map()` results and other data expressions. |
