# Preamble Completeness — Fix Missing Body Variables

## TL;DR

> **Quick Summary**: Fix three compounding bugs that drop body-level variables from generated output. Order: safety nets first (transitive preamble filter, cross-reference promotion), then structural fix (conditional early return parsing). Plus fix recursive getter pattern (`_variant`, same bug as `_target`).
>
> **Deliverables**:
> - Transitive preamble filter in emitter (keeps variables referenced by kept variables)
> - Preamble cross-reference checking in promotion logic
> - Template parser handles `if (cond) return A; return B;` → ternary in Lit template
> - Recursive getter detection/fix (same pattern as _target)
> - SSR pass count improvement: 56 → target 62+ (6 ReferenceError failures resolved)
>
> **Estimated Effort**: Large
> **Parallel Execution**: NO — sequential B → C → A → D
> **Critical Path**: Fix B → Fix C → Fix A → Fix D → verify

---

## Context

### Root Cause (confirmed by codebase exploration)
1. **Template parser** (`jsx.ts:454`): `findReturnStatement` takes only the LAST top-level return. Components with `if (cond) return <A>; return <B>;` lose the conditional branch entirely.
2. **Emitter preamble filter** (`class.ts:250`): drops variables not in `renderRefCorpus`. Non-transitive — if var A (in template) uses var B (not in template), B is dropped.
3. **Promotion logic** (`index.ts:388`): doesn't check preamble-to-preamble references.
4. **Recursive getters**: computed values like `get _variant() { return this._variant; }` self-recurse (same bug as `_target`, different components).

### Affected Components
- **Early returns** (5): link, icon, progress-bar, app-layout, key-value-pairs
- **Missing preamble vars** (6+ SSR failures): persistenceConfig, referrerId, interior, delay, defaultOptions, isButton
- **Recursive getters**: link (_variant), possibly others

---

## Work Objectives

### Definition of Done
- [ ] Zero `ReferenceError: X is not defined` in SSR smoke test from missing preamble vars
- [ ] Zero `RangeError: Maximum call stack size exceeded` from recursive getters
- [ ] SSR pass count: 56 → 62+ (resolving preamble + getter failures)
- [ ] 56 currently passing SSR tests still pass (zero regressions)
- [ ] All non-SSR tests pass

### Must NOT Have
- NO changes to template rendering logic (`template.ts`) during Fixes B/C
- NO handling of 3+ branch cascading returns in Fix A (keep imperative for those)
- NO over-engineering — err on side of keeping too much (unused vars don't crash, missing vars do)

---

## Execution Strategy

```
Sequential: B → C → A → D → verify
Each fix: write failing test → implement → run SSR + unit tests → commit
```

---

## TODOs

- [x] 1. Fix B: Transitive preamble filter

  **What to do**:
  - In `src/emitter/class.ts` lines 249-255, after computing `usedPreamble`, add a transitive closure loop:
    - For each kept variable's statement text, check if it references other preamble variables
    - Add those to the kept set
    - Repeat until stable (max 10 iterations)
  - This is ~10 lines of code in the existing filter

  **Acceptance Criteria**:
  - [ ] Test: preamble with `const a = b + 1; const b = this.x;` where template uses `a` → both kept
  - [ ] SSR: ≥56 pass (no regressions, some ReferenceErrors may resolve)
  - [ ] `npx vitest run --exclude test/ssr/` passes

  **Commit**: `fix(emitter): transitive preamble filter — keep variables referenced by kept variables`

- [x] 2. Fix C: Preamble cross-reference promotion

  **What to do**:
  - In `src/parser/index.ts` line 388-398, extend the promotion loop to include preamble-to-preamble references
  - When a preamble variable is promoted (added to computedValues), its expression text should be added to `outsideTexts` for the next iteration
  - This catches chains like: handler uses `a`, `a` uses `b`, `b` uses `c` — all promoted

  **Acceptance Criteria**:
  - [ ] Test: preamble chain `a→b→c` where handler uses `a` → all three promoted
  - [ ] SSR: ≥56 pass
  - [ ] `npx vitest run --exclude test/ssr/` passes

  **Commit**: `fix(parser): promote preamble vars referenced by other promoted preamble vars`

- [x] 3. Fix A: Template parser handles conditional early returns

  **What to do**:
  - In `src/parser/jsx.ts`, replace `findReturnStatement` with a function that finds ALL return statements including those inside `if` blocks
  - For 2-branch pattern (`if (cond) return A; return B;`): produce a ternary condition in the template IR
  - For single-return components: produce identical output (regression guard)
  - Use existing `ConditionIR` with `kind: 'ternary'` and `alternate`

  **Acceptance Criteria**:
  - [ ] Link component output contains both button and anchor branches
  - [ ] Single-return components produce identical IR (test 3 components)
  - [ ] SSR: ≥56 pass
  - [ ] `npx vitest run --exclude test/ssr/` passes

  **Commit**: `feat(parser): handle conditional early returns — fold to ternary in template`

- [x] 4. Fix D: Recursive getter detection

  **What to do**:
  - In `src/transforms/identifiers.ts`, extend the fix from `_target` to handle ALL computed values that shadow props
  - The current fix restores prop mapping when rewriting computed expressions — verify it covers `_variant` and any other cases
  - Scan generated output for `get _X() { return this._X` patterns → all should be eliminated

  **Acceptance Criteria**:
  - [ ] Zero `get _X() { return this._X` self-reference patterns in output
  - [ ] Link `_variant` doesn't recurse
  - [ ] SSR: Link component passes (with all 4 fixes combined)
  - [ ] `npx vitest run --exclude test/ssr/` passes

  **Commit**: `fix(identifiers): prevent all computed getter self-recursion`

- [x] 5. Final verification

  **What to do**:
  - Regenerate all 91 components
  - Rebuild ../components
  - Run SSR smoke test
  - Count improvements: SSR pass count, stub count, remaining failures
  - Restart docs and verify index + badge + button pages

  **Acceptance Criteria**:
  - [ ] SSR: ≥62/92 pass (6+ new passes from preamble fixes)
  - [ ] Zero ReferenceError from missing preamble vars
  - [ ] Zero RangeError from recursive getters
  - [ ] Docs index page loads without `isButton` crash

  **Commit**: `chore: preamble completeness verified — N/92 SSR pass`

---

## Final Verification Wave

- [ ] F1. SSR smoke test — ≥62/92 pass, zero preamble-related crashes
- [ ] F2. Regression — 56 previously passing components still pass
- [ ] F3. All non-SSR tests pass
- [ ] F4. Docs pages load (index, badge, button)

---

## Success Criteria

### Verification Commands
```bash
npx vitest run --exclude test/ssr/     # all non-SSR tests pass
npx vitest run test/ssr/               # SSR: ≥62 pass, 0 preamble ReferenceErrors
grep -r "get _.*return this\._" ../components/src/*/index.ts  # zero recursive getters
```
