# Runtime-Clean Output — Dead Code Elimination + SSR Safety

## TL;DR

> **Quick Summary**: Fix the generator to produce runtime-clean output that works in SSR. Replace the 323 symbol stubs with proper dead-code elimination (trace stripped imports → remove all dependent code). Fix 87 slot getter conflicts that crash SSR. Strip test infrastructure (testUtilStyles). Convert undefined-symbols.ts from crutch to diagnostic.
>
> **Deliverables**:
> - Post-emission dead-code elimination pass (ts-morph, scope-aware)
> - Slot getter → method rename (`_hasXSlot()`)
> - testUtilStyles chain elimination
> - SSR smoke test harness
> - undefined-symbols.ts converted to diagnostic mode
> - Stub count: 323 → target ≤ 20
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: SSR smoke test → slot getters → dead-code elimination → diagnostic mode

---

## Context

### The Problem
Generated components crash at SSR runtime:
1. **323 value stubs** (`const X: any = {};`) — wrong shapes for function calls, property chains, conditional checks
2. **87 slot getters** across 33 components — `private get description()` conflicts with SSR `setProperty()`
3. **testUtilStyles** references — test infrastructure surviving cleanup, causing `undefined['class-name']` crashes
4. **Root cause**: cleanup strips imports but leaves ALL code that USED those imports. Stubs paper over the gaps.

### What Exists
- Cleanup pipeline: 7 IR transforms + 3 post-emission string passes
- `undefined-symbols.ts`: injects stubs for anything still undefined after cleanup
- `emit-utilities.ts`: copies vendor utilities with React/toolkit import rewriting
- SSR rendering via Astro + @lit-labs/ssr in ../docs
- ts-morph already used in emitter (imports.ts promoteToTypeImports)

### Metis Key Findings
- Actual slot getter count: 87 across 33 components (not 56/21)
- Zero SSR test infrastructure exists — can't verify fixes without building one
- All reference-checking is regex-based — no scope awareness
- testUtilStyles always imported with that exact name
- Dead-code elimination should use ts-morph (already available) for scope-aware analysis

---

## Work Objectives

### Core Objective
Eliminate runtime crashes by replacing stubs with proper dead-code elimination. The emitter should produce code that runs without ReferenceError or TypeError in both browser and SSR contexts.

### Definition of Done
- [ ] SSR smoke test: import all 91 components, render each → zero TypeError/ReferenceError
- [ ] Stub count: ≤ 20 value stubs (from 323)
- [ ] Zero `testUtilStyles` references in output
- [ ] Zero `private get` slot content getters in output
- [ ] `npm run build:esm` in ../components → 0 errors
- [ ] `npx vitest run` in react-to-lit → all tests pass

### Must Have
- SSR smoke test harness (verification prerequisite)
- Slot getter → method rename in emitter
- Dead-code elimination pass (ts-morph, scope-aware, traces from stripped imports)
- testUtilStyles chain elimination
- undefined-symbols.ts → diagnostic mode

### Must NOT Have (Guardrails)
- NO full data-flow analyzer — only "trace from stripped import → transitively dead bindings"
- NO modification of the 7-stage IR transform pipeline — the dead code pass is a NEW post-emission step
- NO SSR visual regression testing — just smoke test (import + render doesn't throw)
- NO fixing other metrics categories (#32-#38, #40-#41)
- NO removing undefined-symbols.ts until stubs are at target — convert to diagnostic first

---

## Verification Strategy

> **Primary gate**: SSR smoke test — zero crashes when rendering all 91 components

### QA Policy
- Before each task: `npx vitest run` + `npm run build:esm` (../components) to establish baseline
- After each task: same + SSR smoke test to measure improvement
- Track: stub count 323 → ? → ... → ≤ 20

---

## Execution Strategy

```
Wave 1 (Foundation + quick wins):
├── Task 1: SSR smoke test harness [deep]
├── Task 2: Fix slot getters → _hasXSlot() methods [deep]
└── Task 3: Strip testUtilStyles chains [deep]

Wave 2 (Core — dead code elimination):
├── Task 4: Post-emission dead-code elimination pass [deep]
└── Task 5: Wire into emitter + verify stub reduction [deep]

Wave 3 (Cleanup):
├── Task 6: Convert undefined-symbols.ts to diagnostic mode [deep]
└── Task 7: Final SSR verification + stub count audit [deep]

Wave FINAL:
├── F1: SSR smoke test — zero crashes
├── F2: Stub count ≤ 20
├── F3: Zero testUtilStyles, zero slot getters
└── F4: All existing tests pass
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 2, 3, 4 | 1 |
| 2 | — | 7 | 1 |
| 3 | — | 5 | 1 |
| 4 | 1 | 5 | 2 |
| 5 | 3, 4 | 6, 7 | 2 |
| 6 | 5 | 7 | 3 |
| 7 | all | F1-F4 | 3 |

---

## TODOs

### Wave 1 — Foundation + Quick Wins

- [x] 1. SSR smoke test harness

  **What to do**:
  - Create `test/ssr/smoke.test.ts` in react-to-lit
  - Use `@lit-labs/ssr` to render each of the 91 components in a Node environment
  - For each component: import it, create an instance, call `render()` in SSR context
  - Record: which components pass (no error), which throw (and what error)
  - Establish baseline: N/91 pass SSR rendering
  - This is the verification harness for all subsequent fixes

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Acceptance Criteria**:
  - [ ] `test/ssr/smoke.test.ts` exists
  - [ ] Runs against generated output in ../components
  - [ ] Reports pass/fail per component
  - [ ] Baseline count documented

  **Commit**: `test(ssr): add SSR smoke test — baseline N/91 pass`

- [x] 2. Fix slot getters → _hasXSlot() methods

  **What to do**:
  - In `src/emitter/properties.ts`, change slot content getters from:
    `private get description() { return !!this.querySelector?.('[slot="description"]'); }`
    to:
    `private _hasDescriptionSlot() { return !!this.querySelector?.('[slot="description"]'); }`
  - The naming pattern: `_has{PascalName}Slot()` — a method, not a getter. SSR can't conflict with methods.
  - Update all template references: `this.description` → `this._hasDescriptionSlot()` in the emitter output
  - This affects how the emitter generates slot checks AND how the identifier rewriter handles slot references

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Acceptance Criteria**:
  - [ ] Zero `private get` slot getters in generated output
  - [ ] All 87 slot checks are now `_has*Slot()` methods
  - [ ] Template references updated to use method calls
  - [ ] `npx vitest run` passes
  - [ ] SSR smoke test shows improvement

  **Commit**: `fix(emitter): slot content checks use methods not getters — SSR-safe`

- [x] 3. Strip testUtilStyles chains

  **What to do**:
  - In the Cloudscape preset or cleanup transform, strip:
    1. The `testUtilStyles` import itself (may already be stripped)
    2. ALL usages: `testUtilStyles['class-name']` in class= attributes and classMap objects
    3. Any variables derived from testUtilStyles
  - In the emitter, add testUtilStyles to the framework import stripping (alongside analytics)
  - After stripping usages, the cleanup cascade should eliminate the now-unused variables

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Acceptance Criteria**:
  - [ ] Zero `testUtilStyles` references in generated output
  - [ ] No stubs for testUtilStyles or derived symbols
  - [ ] `npx vitest run` passes

  **Commit**: `fix(cleanup): strip testUtilStyles chains — test infrastructure eliminated`

---

### Wave 2 — Core Dead-Code Elimination

- [x] 4. Post-emission dead-code elimination pass

  **What to do**:
  - Create `src/emitter/dead-code-elimination.ts`
  - Input: the emitted component code string + list of symbols from stripped imports
  - Algorithm:
    1. Parse the emitted code with ts-morph
    2. For each stripped symbol:
       a. Find all declarations that reference it (const x = strippedSymbol, const { a } = strippedCall())
       b. Mark those declarations as dead
       c. Find all references to newly-dead declarations
       d. Mark code that uses dead declarations as dead
       e. Repeat until stable (max 10 iterations)
    3. Remove all dead declarations and their usages
    4. Return the cleaned code
  - The stripped symbols list comes from: imports that were removed by cleanup (analytics, framework hooks, testUtilStyles)
  - Use ts-morph's scope-aware API — not regex — to correctly handle shadowing, closures, etc.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Acceptance Criteria**:
  - [ ] `src/emitter/dead-code-elimination.ts` exists
  - [ ] Handles: simple references, object literals with dead properties, conditional blocks using dead symbols, destructured assignments from dead calls
  - [ ] Does NOT remove code whose source is a NON-stripped import
  - [ ] Unit tests: stripped symbol → dependent code removed; live symbol → code preserved
  - [ ] `npx vitest run` passes

  **Commit**: `feat(emitter): scope-aware dead-code elimination from stripped imports`

- [x] 5. Wire into emitter + verify stub reduction

  **What to do**:
  - Integrate dead-code elimination into the emitter pipeline (in class.ts, between strip passes and stubUndefinedSymbols)
  - The stripped imports list needs to be threaded from the cleanup phase into the emitter
  - After integration: regenerate all 91 components, rebuild, count stubs
  - Target: 323 stubs → ≤ 50

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Acceptance Criteria**:
  - [ ] Dead-code elimination wired into emitter pipeline
  - [ ] Stub count ≤ 50 (from 323)
  - [ ] No over-elimination (wanted symbols survive)
  - [ ] `npm run build:esm` in ../components → 0 errors
  - [ ] SSR smoke test shows improvement

  **Commit**: `feat(emitter): wire dead-code elimination — stubs 323→N`

---

### Wave 3 — Cleanup

- [x] 6. Convert undefined-symbols.ts to diagnostic mode

  **What to do**:
  - Change `stubUndefinedSymbols()` to report what it WOULD stub instead of stubbing
  - In diagnostic mode: each would-be stub becomes a warning logged during compilation
  - Keep the actual stubbing as a fallback (controlled by config flag) for any remaining gaps
  - This surfaces exactly which symbols the dead-code elimination missed

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Acceptance Criteria**:
  - [ ] Diagnostic mode reports per-component stub counts
  - [ ] Remaining stubs documented with their source import chain
  - [ ] Config flag to switch between stub/diagnostic/error modes

  **Commit**: `feat(emitter): undefined-symbols diagnostic mode — surfaces remaining gaps`

- [x] 7. Final SSR verification + stub count audit

  **What to do**:
  - Regenerate all 91 components with full pipeline
  - Rebuild ../components
  - Run SSR smoke test — target: zero crashes
  - Run stub count audit — target: ≤ 20
  - Document remaining stubs with reasons

  **Acceptance Criteria**:
  - [ ] SSR smoke test: zero TypeError/ReferenceError
  - [ ] Stub count ≤ 20
  - [ ] Remaining stubs documented

  **Commit**: `chore: final SSR verification — N/91 pass, M stubs remaining`

---

## Final Verification Wave

- [ ] F1. **SSR smoke test** — zero crashes when rendering all 91 components
- [ ] F2. **Stub count** — ≤ 20 value stubs (from 323)
- [ ] F3. **Cleanliness** — zero testUtilStyles, zero slot getters in output
- [ ] F4. **Regression** — all existing react-to-lit tests pass, esbuild 0 errors

---

## Commit Strategy

- Wave 1: `test(ssr): smoke test baseline` → `fix(emitter): slot getters → methods` → `fix(cleanup): strip testUtilStyles`
- Wave 2: `feat(emitter): dead-code elimination` → `feat(emitter): wire + verify stub reduction`
- Wave 3: `feat(emitter): diagnostic mode` → `chore: final verification`

---

## Success Criteria

### Verification Commands
```bash
# react-to-lit tests
cd /Users/piwit/GIT/@cumulus-ui/react-to-lit && npx vitest run

# Components build
cd /Users/piwit/GIT/@cumulus-ui/components && npx tsx src/build.ts && npm run build:esm

# SSR smoke test
cd /Users/piwit/GIT/@cumulus-ui/react-to-lit && npx vitest run test/ssr/

# Stub count
grep -rc "any = {};" /Users/piwit/GIT/@cumulus-ui/components/src/*/index.ts | awk -F: '{sum+=$2} END {print sum}'
```

### Final Checklist
- [ ] SSR smoke test: zero crashes
- [ ] Stub count ≤ 20
- [ ] Zero testUtilStyles references
- [ ] Zero private get slot getters
- [ ] All react-to-lit tests pass
- [ ] esbuild 0 errors
