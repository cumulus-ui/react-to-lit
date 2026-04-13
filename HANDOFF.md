# React-to-Lit: Session Handoff

## CRITICAL CONTEXT — Read this first

You are continuing work on a **general-purpose React-to-Lit conversion tool**. It converts React function components to Lit web components. The current test bed is Cloudscape Design System (91 components), but all fixes MUST be general-purpose — no Cloudscape-specific hacks.

**Current state:**
- **91/91 components** generate valid Lit output (gate2 per-component: 0 errors)
- **639 tests** passing, TypeScript compiles clean
- **Shared tsc**: 166 errors across 40 components (down from 526)
- **51/91 components** fully error-free in shared compilation
- All 7 original issues (#11-#18) are closed

## Pipeline architecture

```
React TSX → Parser → IR → Transforms → Emitter → Lit TS
```

1. **Parser** (`src/parser/`): Extracts component structure from TSX. Props from interfaces, hooks from body, handlers, effects, template from JSX return.
2. **IR** (`src/ir/types.ts`): Intermediate representation — props, state, handlers, effects, template tree, computed values, controllers, helpers.
3. **Transforms** (`src/transforms/`): Pipeline of IR→IR transforms: cleanup, clsx→classMap, React types, events, effect cleanup promotion, identifiers.
4. **Emitter** (`src/emitter/`): Produces Lit class from transformed IR.

## Key design decisions (RESPECT THESE)

1. **No hacks.** No `as any` casts, no hardcoded component names, no fake default values. Every fix must be architecturally correct and general-purpose.
2. **Hook registry drives behavior.** `src/hooks/registry.ts` maps hook names to actions. Import filtering derives from the registry, not hardcoded name lists.
3. **INFRA_FUNCTIONS and UNWRAP_COMPONENTS** live in `src/cloudscape-config.ts` — that's the ONLY place for library-specific names.
4. **Identifier rewriting** uses ts-morph AST analysis in `src/transforms/identifiers.ts`. The member map is built from props, state, handlers, computed values, helpers, and skippedHookVars. The AST rewriter respects local variable scoping.
5. **Template IR is structured** — attributes, expressions, children are separate nodes walked by `walkTemplate`. Changes to template text go through walker callbacks, not string manipulation.
6. **`mapIRText`** in `src/ir/transform-helpers.ts` applies a function to ALL text fields in the IR. Used by cleanupReactTypes and other transforms. Covers: handlers, effects, helpers, preamble, publicMethods, computedValues, state, refs, controllers, fileTypeDeclarations, fileConstants.
7. **Import filtering at emit time** — the emitter's `collectImports` checks if each imported name appears in the output code (`allCode.includes(name)`). Named imports are NOT filtered at parse time (except emitter-generated names like `fire*Event`).

## What's been fixed (learnings to preserve)

- **Spread operator bug**: The AST rewriter's "preceded by `.`" safety check was skipping identifiers in `...spread` expressions. Fixed by detecting `...` (three dots) vs `.` (property access). **Test: `test/transforms/identifiers.test.ts` "spread operator"**
- **setState updater**: `setFoo(prev => val)` must become `this._foo = ((prev) => val)(this._foo)` (IIFE), not `this._foo = prev => val` (assigns function). **Test: `test/transforms/identifiers.test.ts` "setState updater functions"**
- **Preamble promotion**: Variables from the component body that are referenced by handlers/helpers/effects need to be promoted to computed getters. Runs iteratively (up to 5 rounds) to catch transitive refs. Handles both simple and destructured declarations.
- **Pre-hook preamble**: Statements BEFORE hook calls are also captured (e.g., `const { a, b } = setup(...)`). Skips statements referencing raw `props` (infrastructure).
- **Render helpers vs utility helpers**: Only helpers containing `html\`` templates get `this._` prefix (they become class methods). File-level utility functions keep bare names. Constant declarations (starting with `const/let/var`) are never added to the member map.
- **Effect cleanup promotion**: Variables declared in effect bodies and referenced in cleanup functions are promoted to class fields via `skippedHookVars`. The `const` declaration becomes `this._varName = expr`.
- **classMap double-wrap prevention**: Preamble `const className = classMap({...})` has classMap stripped (becomes plain object). The emitter adds classMap when rendering the class attribute. String literals and existing classMap calls skip wrapping.
- **`__`-prefixed cleanup**: Handled in both code bodies (`cleanInternalPrefixedRefs`) and template expressions (`cleanInternalPrefixedRefsInExpr`). Code bodies use conservative patterns; template expressions use aggressive `false` replacement. Object properties with `__` keys or values are removed with balanced paren matching.
- **Generic type stubs**: The gate2 stub generator detects generic arity by scanning output for `Name<T, U>` patterns and generates stubs with matching type parameters.

## Remaining 166 errors — categorized

### TS2304: Cannot find name (76 errors)
| Category | Count | Root cause | Correct fix |
|----------|-------|------------|-------------|
| SCOPE vars | 44 | Variables from `useMemo` callbacks, hook returns in helper components, complex closures | Deeper scope analysis — detect variables from `useMemo`/`useCallback` bodies and promote to computed values |
| TYPE refs | 21 | Types from stripped import modules | Preserve type-only imports; generate type stubs with correct generic arity |
| IMPORT funcs | 8 | Utility functions from modules that also have React components | Improve import path classification — don't strip utility function imports |
| INTERNAL __ | 3 | `__`-prefixed in render helper text (not template IR) | Apply `cleanExpressionText` to render helper template literals |

### TS2339: Property does not exist (40 errors)
- 20 are "on type `never`" — cascading from property-filter's incomplete type preservation. The `SomeRequired<T, K>` utility type resolves to `any` in stubs, causing downstream narrowing to `never`.
- Fix: Preserve the actual `SomeRequired` type definition (it's in `vendor/.../internal/types.ts`) as a real declaration in the stubs, not `type SomeRequired<T, T2> = any`.

### TS2729: Property used before initialization (15 errors)
- State initializers reference props at class construction time. In React, `useState(prop)` runs at first render (props available). In Lit, class field initializers run at construction (before props).
- Fix: Move state initializers that reference `this.propName` to `connectedCallback()` or `firstUpdated()`. This requires the emitter to detect prop references in state initial values and defer initialization.

### TS2345: Argument type mismatch (11 errors)
- classMap receiving wrong types in nested template expressions
- Fix: The template walker needs to recursively process nested `html\`` literals inside expression callbacks

### TS2663: Missing this. prefix (6 errors)  
- Props used in property initializers (`loopFocus = expandToViewport`)
- Fix: Property initializer expressions need to go through the identifier rewriter, or these should be computed getters instead of field declarations

### Other (18 errors)
- TS2322 (5): setState updater patterns in effects, type mismatches
- TS2349 (4): Boolean props called as functions (renderItem misclassification)
- TS2554 (2): Function props with wrong parameter types
- TS2347 (2), TS2869 (2), TS2873 (1), TS2694 (1), TS2556 (1)

## Commands

```bash
# Run unit tests (fast, 639 tests)
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
```

## Workflow: how to fix errors

1. **Categorize**: Run shared tsc, group by error code, find the pattern
2. **Find root cause**: Trace from the error in `.gate2-output/` back to the parser/transform/emitter that produced it
3. **Fix generically**: The fix should apply to ANY React component with this pattern, not just the specific Cloudscape component
4. **Test**: Add a unit test in `test/transforms/` or `test/parser/` that covers the pattern
5. **Verify**: Run `npx vitest run`, then `npm run gate2`, then shared tsc. Check for syntax errors (TS1xxx) and regressions
6. **Commit**: Small, focused commits with clear messages

## What NOT to do

- **No `as any` casts** — fix the transforms
- **No hardcoded component names** — use patterns and the hook registry
- **No `= false` default values for props** — causes TS1240/TS2416 cascading errors
- **No `!` definite assignment assertions** — these hide real issues
- **No blanket `__xxx → false` in code bodies** — breaks in type annotations, object keys, function params. Only safe in template expressions.
- **No SKIP_PROPS → undefined replacement** — creates `const undefined = ...` when the prop name is in a variable declaration
- Don't modify `vendor/cloudscape-source/` — it's the React source input
- Don't change gate2's per-component approach to shared compilation
