# React-to-Lit: Session Handoff

## What this repo does

Converts Cloudscape React components to Lit web components. The pipeline: **parse TSX → extract IR → transform IR → emit Lit class**.

## Where we are

- **91/91 components** generate valid Lit output (gate2 per-component: 0 errors)
- **579 tests** passing, TypeScript compiles clean
- **Gate3**: 91/91 structure checks pass, 91/91 no raw JSX
- **Shared tsc**: 526 errors across 73 components from pre-existing transform gaps (see issues below)

## Architecture (key decisions made this session)

1. **Template parsed from original TSX** before JSX-to-Lit flattening (`src/parser/index.ts`). This gives all transforms structured IR nodes instead of opaque `html`` strings.

2. **JSX in expressions** (`.map()` callbacks, ternary branches) converted via `jsxExpressionToLitText` at parse time (`src/parser/jsx.ts`), or via `convertRemainingJsx` in the identifier rewriter (`src/transforms/identifiers.ts`).

3. **Identifier rewriting** uses ts-morph in `.ts` mode. Raw JSX in expressions is detected by `hasRawJsx()` and converted BEFORE `astRewrite` runs, to prevent garbling. The `convertRemainingJsx` wrapper handles the old path for backwards compat.

4. **Import preservation**: when JSX conversion removes a PascalCase component identifier, the import is marked with `preserve: true` on `ImportIR` so the emitter keeps it.

5. **Per-component type checking** in gate2 (`scripts/gate2-typecheck.ts`) prevents error cascade between unrelated components.

6. **Global names that are also props** (e.g., `name` = `window.name`) are rewritten to `this.name`. Event props are included in the member map and emitted as optional function declarations.

## Key files

- `src/parser/index.ts` — pipeline orchestration, template-from-original-TSX
- `src/parser/jsx.ts` — JSX parser, `jsxExpressionToLitText`, `containsJsxNode`
- `src/transforms/identifiers.ts` — `rewriteIdentifiers`, `rewriteWithMorph`, `hasRawJsx`, `convertRemainingJsx`, `buildMemberMap`
- `src/transforms/cleanup.ts` — Cloudscape-specific stripping (analytics, test utils, `__` internals)
- `src/emitter/imports.ts` — import collection, `preserve` flag handling
- `src/ir/types.ts` — `ImportIR.preserve` field
- `test/transforms/identifiers.test.ts` — 37 unit tests for the identifier rewriter

## Open issues (in priority order)

All tracked under #18: "Reduce per-component type errors from 652 to 0"

| Issue | Title | Errors | Approach |
|-------|-------|--------|----------|
| #12 | Hook return value bindings | ~30 | Track destructured hook returns in `parser/hooks.ts`, add to member map |
| #14 | Type import preservation | ~20 | Scan code bodies for type references, set `preserve: true` |
| #11 | testUtilStyles/analyticsSelectors in code bodies | 17 | Apply existing regexes to effects, computed, preamble |
| #17 | Utility function imports | ~14 | Fix gate2 stubs or strip internal utility calls |
| #13 | React API stripping (createPortal) | 6 | Add to cleanup strip list |
| #15 | __-prefixed internals in code bodies | 4 | Extend __ stripping to all IR text fields |
| #16 | Rest/spread variables | 4 | Strip rest patterns (Lit has no attribute spread) |

## How to work on an issue

```bash
# Run unit tests (fast)
npm test

# Run gate2 (generates all 91 components + type-checks each individually)
npm run gate2

# Run shared tsc on gate2 output (shows cascade — use to measure total progress)
cd .gate2-output && npx tsc --noEmit --project tsconfig.json 2>&1 | grep "error TS" | wc -l

# Check a specific component
cd .gate2-output && npx tsc --noEmit --strict false --skipLibCheck --experimentalDecorators \
  --useDefineForClassFields false --target ES2022 --module ES2022 --moduleResolution bundler \
  --lib ES2022,DOM,DOM.Iterable "component-name/index.ts" 2>&1

# Run gate3 (structural checks)
npm run gate3
```

## What NOT to do

- Don't modify the `vendor/cloudscape-source/` directory — it's the React source input
- Don't change gate2's per-component approach back to shared compilation
- Don't add `as any` casts to fix type errors — fix the transforms instead
- Don't fight `convertRemainingJsx` — it's load-bearing for expressions containing `Partial<Type>` generics. The `hasRawJsx` detection keeps it from running on already-converted expressions.
