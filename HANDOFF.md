# React-to-Lit: Session Handoff

## STOP — Read this ENTIRE document before making ANY changes

You are continuing work on a **general-purpose React-to-Lit conversion tool**. It converts React function components to Lit web components.

The test bed is Cloudscape Design System (91 components). **Every fix MUST be general-purpose.** If your fix mentions a component name, you're doing it wrong. If your fix only works for one component, you're doing it wrong. The tool must convert ANY React function component.

**Current state:**
- **91/91 components** generate valid Lit output (gate2 per-component: 0 errors)
- **674 tests** passing, TypeScript compiles clean
- **Shared tsc**: 94 errors across 26 components (down from 526 → 166 → 94)
- **65/91 components** fully error-free in shared compilation
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
- Run `npx vitest run` (must be 674+ passing).
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
| `src/transforms/cleanup-react-types.ts` | React → DOM type conversions | Applied via `mapIRText` to all text fields + template walker. |
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

---

## Remaining 94 errors — categorized

### TS2304: Cannot find name (47 errors)

| Category | Count | Examples | Root cause | Correct fix |
|----------|-------|---------|------------|-------------|
| SCOPE vars | ~35 | `i18n`, `step`, `onPreviousClick`, `buttonProps`, `customCssProps`, `pieData`, `internalTags` | Variables from hook returns, `useMemo` bodies, or local component body that weren't promoted to class scope | **Deeper preamble promotion** — detect variables referenced in template expressions (not just handlers/helpers/effects). The promotion iterates up to 5 rounds but only checks handler/helper/effect bodies, missing template references. |
| IMPORT funcs | ~7 | `useModalContext`, `useContainerBreakpoints`, `formatDndStarted` | Hooks/functions from stripped modules where the return values are used | Better hook return parsing — detect that the variables produced by these hooks need to be preserved |
| Remaining | ~5 | `rest`, `props`, `analyticsComponentMetadata`, `fireNonCancelableEvent` | Cleanup gaps, partial event conversion | Case-by-case: `rest` → rest-spread cleanup missed a path; `props` → raw props ref not rewritten; `analyticsComponentMetadata` → multi-line const not fully stripped |

### TS2339: Property does not exist (27 errors)

- **20 are "on type `never`"** — ALL in property-filter. The `SomeRequired<T, K>` type is now correct, but `InternalToken = any` and `InternalTokenGroup = any` in stubs cause type guards (`'tokens' in x`) to narrow to `never`.
  - **Fix**: Give `InternalToken` and `InternalTokenGroup` discriminant properties in their stub interfaces: `interface InternalToken { propertyKey?: string; operator?: string; value?: string; }` and `interface InternalTokenGroup { operation: string; tokens: InternalToken[]; }`.
  - This is a gate2 stub fix in `scripts/gate2-typecheck.ts`, NOT a transform fix.
- **4 are context issues**: error-boundary (`_errorBoundariesContext`), header (`_collectionLabelContext`). These are `useContext` calls the parser didn't convert to `@consume` fields.
- **3 are misc**: breadcrumb-group, tabs stub types.

### TS2349: This expression is not callable (4 errors)
- ALL in list component. `renderItem` was misclassified as a `slot` (the slot getter returns boolean) but the code calls it as `this.renderItem(item)`.
- **Fix**: Improve prop category detection in the parser — props with function types (`(item: T) => { ... }`) or named `renderXxx` should be `property`, not `slot`.

### TS2345: Argument type mismatch (4 errors)
- code-editor (2): `fireNonCancelableEvent(this.onValidate, ...)` — first arg should be `this` (EventTarget), not a callback prop. Partially converted event dispatch.
- cards: analytics type leftover
- top-navigation: `{}` not assignable to `string`

### Other (12 errors)
- TS2869 (2), TS2554 (2), TS2347 (2), TS2873 (1), TS2729 (1), TS2694 (1), TS2556 (1), TS2552 (1), TS2322 (1)

---

## Commands

```bash
# Run unit tests (fast, 674 tests)
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

1. **Property-filter stub quality** (~20 errors, one file change): Give `InternalToken` and `InternalTokenGroup` actual shapes in `scripts/gate2-typecheck.ts`. This is the single highest-bang fix available.

2. **Preamble promotion for template-referenced vars** (~15 errors): Extend the preamble promotion in `src/parser/` to scan template expression text for bare variable names, not just handler/helper/effect bodies.

3. **`renderItem` prop misclassification** (4 errors): In the parser's prop categorization, props with function types or `renderXxx` naming pattern should be `property`, not `slot`.

4. **Import preservation for used types** (~5 errors): When a type-only import name appears in the final output code, preserve the import. Currently the emitter strips imports from infrastructure modules even when the type is still referenced.

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
