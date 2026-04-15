# Behavioral Dependency Preservation System

## TL;DR

> **Quick Summary**: Evolve react-to-lit from a per-component transpiler into a complete library generator that understands behavioral dependencies. The system analyzes a React library's shared patterns, classifies them as behavioral (preserve) or framework (eliminate), produces Lit-native equivalents for behavioral patterns, and generates a self-contained component library. Cloudscape is the proving ground; the architecture is generic.
>
> **Core Principle**: Preserve behavioral dependencies. Eliminate framework dependencies.
>
> **Deliverables**:
> - Property system: optional props, reflected HTMLElement handling, per-property `reflect: true`
> - Dependency analyzer: builds cross-library graph, classifies shared patterns
> - Pattern classifier: maps React patterns → Lit-native shapes (controller/utility/component/eliminate)
> - Shared infrastructure emitter: generates controllers, utilities, shared components
> - Context system: classifies and generates @lit/context equivalents for behavioral contexts
> - Convergence: measured gate2 progress toward 91/91 clean components
>
> **Estimated Effort**: XL
> **Parallel Execution**: YES — 5-8 tasks per wave
> **Critical Path**: Wave 0 baseline → Wave 1 property system → Wave 2 dependency analysis → Wave 3 shared generation → Wave 4 convergence

---

## Context

### Original Request
Build a comprehensive system that converts ANY React component library into a complete, self-contained Lit web component library — preserving behavioral dependencies, eliminating framework dependencies. Pre-1.0, can break things. Cloudscape is the example, not the target.

### Interview Summary
**Key Discussions**:
- Property system: `optional?: boolean` on PropIR fixes ~80 TS2564 errors. `reflect: true` for attribute-type props matches community convention. Skip unreferenced HTMLElement props (derived from `getHtmlElementProps()`, no hardcoded list).
- Base class: community does NOT override `createProperty`. Shoelace/Spectrum/Carbon/PatternFly all do reflect per-property. A generated base class would provide utility (events, registration), not property defaults.
- Shared patterns: React hooks map to Lit controllers. Utilities stay utilities. Sub-components stay components. React wrappers (forwardRef, getBaseProps, useBaseComponent root ref) are eliminated — web platform handles them.
- Architecture: two-phase generation. First analyze the React source for shared patterns. Then generate the Lit library with Lit-native equivalents for behavioral patterns.
- ../components is HAND-WRITTEN, NOT a reference. The generator's output must be self-contained.

**Research Findings**:
- Lit `reflect` defaults to `false`. Attribute→property sync is ON; property→attribute sync is OFF by default.
- Community: 50-65% of props use `reflect: true`. Boolean/visual-state props always reflect. Data/value props often don't.
- No direct React→Lit transpiler exists. react-to-lit is novel.
- Cloudscape: 100% function components. Shared hooks (`useBaseComponent`, `useControllable`). 27+ contexts (only 2 mapped). The index.tsx→internal.tsx pattern is React boilerplate (forwardRef + useBaseComponent).
- `getHtmlElementProps()` in standards.ts already queries TS DOM lib for HTMLElement properties.

### Metis Review
**Identified Gaps** (addressed):
- 0/91 analyze gate needs investigation → Wave 0 baseline establishes this
- Only 2/27+ contexts mapped → Wave 3 includes context classification
- Generic components (Table<T>) need a strategy → deferred to Wave 4 convergence
- RefObject-based contexts have no Lit equivalent → classified as "strip" unless proven behavioral
- Scope creep risk from "any React library" ambition → Cloudscape-first, generalize second

---

## Work Objectives

### Core Objective
Transform react-to-lit from a per-component transpiler into a library-aware generator that preserves behavioral dependencies as Lit-native equivalents and eliminates React framework artifacts.

### Concrete Deliverables
1. PropIR with `optional` and `reflect` fields, wired through parser → emitter
2. Emitter that skips unreferenced HTMLElement props and adds `reflect: true` for attribute-type props
3. Dependency analyzer that builds a cross-library import graph
4. Pattern classifier that categorizes shared imports as behavioral or framework
5. Shared infrastructure emitter that generates controllers, utilities, and shared components
6. Context classifier and @lit/context emitter for behavioral contexts
7. Measurable gate2 progress (baseline → target)

### Definition of Done
- [ ] `npx vitest run` — all existing tests pass (no regressions)
- [ ] `npm run gate2` — measurable improvement from baseline
- [ ] New features have unit tests
- [ ] Property system: optional props emit `?`, reflected HTMLElement props are skipped when unreferenced, attribute-type props have `reflect: true`
- [ ] Dependency analysis: shared patterns classified as behavioral/framework
- [ ] Shared infrastructure: at least controllers for mapped hooks are generated
- [ ] Context: behavioral contexts classified and mapped

### Must Have
- Optional prop support (TS2564 fix)
- Reflected HTMLElement prop handling (derived from `getHtmlElementProps()`)
- `reflect: true` for attribute-type `@property()` declarations
- Dependency graph builder
- Pattern classification engine (behavioral vs framework)
- Shared controller generation for at least `useControllable`-type hooks
- Context classification (27+ Cloudscape contexts into behavioral/framework/strip)

### Must NOT Have (Guardrails)
- NO hardcoded prop lists — everything derived from type system or DOM lib
- NO reference to ../components patterns — derive from React source + web standards
- NO CSS generation — separate concern, already solved elsewhere
- NO test generation for output — post-v1.0 concern
- NO SSR support — not needed yet
- NO plugin system for other libraries — premature generalization
- NO modification to the 4-phase pipeline architecture — enhance within it
- NO Cloudscape-specific logic in core — everything Cloudscape-specific goes in preset

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest, 1045 tests, 30 files)
- **Automated tests**: YES (TDD)
- **Framework**: vitest (already configured)
- **Each task follows**: RED (failing test) → GREEN (minimal impl) → REFACTOR

### QA Policy
Every task includes agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **IR/Parser changes**: `npx vitest run test/parser/` + `npx vitest run test/emitter/` + new test cases
- **Emitter changes**: `npx vitest run test/emitter/` + `npm run gate2 -- --component Badge`
- **Transform changes**: `npx vitest run test/transforms/` + batch regeneration check
- **Batch progress**: `npx tsx src/cli.ts -p @cloudscape-design/components -s vendor/cloudscape-source/src -o /tmp/r2l-all --preset cloudscape` + count clean components

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (Baseline — establish measurable starting point):
├── Task 1: Regenerate full batch, categorize all failures by type [deep]
├── Task 2: Quantify TS2564 errors from missing optional markers [quick]
└── Task 3: Quantify unreferenced HTMLElement prop declarations [quick]

Wave 1 (Property System — highest-impact mechanical fixes):
├── Task 4: Add optional?: boolean to PropIR + ClassifiedProp [quick]
├── Task 5: Detect optionality from TS type system in PackageAnalyzer [deep]
├── Task 6: Emit ? for optional props without defaults [quick]
├── Task 7: Skip unreferenced HTMLElement props in emitter (derived from getHtmlElementProps) [deep]
├── Task 8: Add reflect: true for attribute-type @property() declarations [quick]
└── Task 9: Property system tests [quick]

Wave 2 (Dependency Analysis — understand the library):
├── Task 10: Build cross-library import graph from React source [deep]
├── Task 11: Classify each shared import: behavioral vs framework [deep]
├── Task 12: Detect shared hooks and their usage patterns [deep]
├── Task 13: Detect shared sub-components and their embedding patterns [deep]
└── Task 14: Context classification: all contexts → behavioral/framework/strip [deep]

Wave 3 (Shared Infrastructure Generation — produce Lit-native equivalents):
├── Task 15: Shared controller emitter (behavioral hooks → Lit controllers) [deep]
├── Task 16: Shared utility emitter (behavioral utilities → utility modules) [deep]
├── Task 17: Shared component emitter (behavioral sub-components → Lit components) [deep]
├── Task 18: Context emitter (@lit/context definitions for behavioral contexts) [deep]
├── Task 19: Wire shared infrastructure imports into per-component output [deep]
└── Task 20: Shared infrastructure tests [unspecified-high]

Wave 4 (Convergence — measure and fix):
├── Task 21: Regenerate batch with property system + shared infrastructure [deep]
├── Task 22: Fix top failure category from batch results [deep]
├── Task 23: Fix second failure category from batch results [deep]
├── Task 24: Fix third failure category from batch results [deep]
└── Task 25: Gate2 measurement and remaining failure categorization [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1-3 | — | 4-9 | 0 |
| 4 | 1 | 5, 6 | 1 |
| 5 | 4 | 6 | 1 |
| 6 | 5 | 9 | 1 |
| 7 | 1 | 9 | 1 |
| 8 | 1 | 9 | 1 |
| 9 | 6, 7, 8 | 21 | 1 |
| 10 | 1 | 11, 12, 13 | 2 |
| 11 | 10 | 15, 16, 17 | 2 |
| 12 | 10 | 15 | 2 |
| 13 | 10 | 17 | 2 |
| 14 | 10 | 18 | 2 |
| 15-20 | 11-14 | 21 | 3 |
| 21-25 | 9, 20 | F1-F4 | 4 |

### Agent Dispatch Summary

- **Wave 0**: 3 tasks — T1 `deep`, T2-3 `quick`
- **Wave 1**: 6 tasks — T4 `quick`, T5 `deep`, T6 `quick`, T7 `deep`, T8 `quick`, T9 `quick`
- **Wave 2**: 5 tasks — all `deep`
- **Wave 3**: 6 tasks — T15-19 `deep`, T20 `unspecified-high`
- **Wave 4**: 5 tasks — all `deep`
- **FINAL**: 4 tasks — F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## TODOs

### Wave 0 — Baseline

- [x] 1. Regenerate full batch and categorize all failures by type

  **What to do**:
  - Run `npx tsx src/cli.ts -p @cloudscape-design/components -s vendor/cloudscape-source/src -o /tmp/r2l-all --preset cloudscape`
  - For each of the 91 output files, run `tsc --noEmit` and capture errors
  - Categorize every error by type: TS2564 (no initializer), TS6133 (unused variable), TS2552 (stale reference), TS2307 (missing module), other
  - Produce a JSON report: `{ errorType: string, count: number, components: string[] }[]`
  - Save report to `.sisyphus/evidence/task-1-baseline.json`

  **Must NOT do**:
  - Fix any errors — this is measurement only
  - Modify any source files

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with Tasks 2, 3)
  - **Blocks**: Tasks 4-9
  - **Blocked By**: None

  **References**:
  - `src/cli.ts` — CLI entry point, shows all flags
  - `src/presets/cloudscape.ts` — preset configuration

  **Acceptance Criteria**:
  - [ ] Batch output regenerated at /tmp/r2l-all/
  - [ ] JSON report exists at `.sisyphus/evidence/task-1-baseline.json`
  - [ ] Report categorizes errors across all 91 components by TS error code

  **QA Scenarios**:
  ```
  Scenario: Baseline measurement produces actionable data
    Tool: Bash
    Steps:
      1. Run CLI to generate all 91 components
      2. Run tsc --noEmit on each output file, capture stderr
      3. Parse error codes with regex TS\d{4}
      4. Aggregate into JSON report
    Expected Result: JSON with at least 3 error categories, total error count > 0
    Evidence: .sisyphus/evidence/task-1-baseline.json
  ```

  **Commit**: YES
  - Message: `chore: establish baseline — categorize batch failures`

- [x] 2. Quantify TS2564 errors from missing optional markers

  **What to do**:
  - From baseline report (Task 1), extract all TS2564 errors
  - For each, identify the prop name and component
  - Cross-reference with the published .d.ts type: is the prop optional (has `?`)?
  - Produce count: how many TS2564 errors would be fixed by adding `optional?: boolean` to PropIR

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with Tasks 1, 3)
  - **Blocks**: Tasks 4-6
  - **Blocked By**: Task 1

  **Acceptance Criteria**:
  - [ ] Count of TS2564 errors that match optional props documented
  - [ ] Evidence file with per-component breakdown

  **QA Scenarios**:
  ```
  Scenario: TS2564 count quantified
    Tool: Bash
    Steps:
      1. Parse baseline JSON for TS2564 entries
      2. For each, check published type for questionToken
      3. Count matches
    Expected Result: Number > 50 (estimated ~80 based on prior analysis)
    Evidence: .sisyphus/evidence/task-2-ts2564-count.json
  ```

  **Commit**: NO (groups with Task 1)

- [x] 3. Quantify unreferenced HTMLElement prop declarations

  **What to do**:
  - For each generated output file, find all `@property()` declarations where the prop name is in `getHtmlElementProps()`
  - Check if `this.{propName}` appears anywhere in the component body/template
  - Count: how many HTMLElement props are declared but unreferenced
  - List the specific prop names (className, id, ariaLabel, etc.) and their frequency

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with Tasks 1, 2)
  - **Blocks**: Task 7
  - **Blocked By**: Task 1

  **Acceptance Criteria**:
  - [ ] Count of unreferenced HTMLElement prop declarations documented
  - [ ] Per-prop-name frequency (e.g., className: 85, id: 85, ariaLabel: 4)

  **QA Scenarios**:
  ```
  Scenario: HTMLElement prop audit
    Tool: Bash
    Steps:
      1. grep -r 'override.*:' /tmp/r2l-all/*/index.ts to find override props
      2. For each, grep for this.{propName} in the same file
      3. Count unreferenced
    Expected Result: className ~85, id ~85 unreferenced (from prior analysis)
    Evidence: .sisyphus/evidence/task-3-htmlelement-props.json
  ```

  **Commit**: NO (groups with Task 1)

---

### Wave 1 — Property System

- [x] 4. Add `optional?: boolean` to PropIR and ClassifiedProp

  **What to do**:
  - Add `optional?: boolean` field to `PropIR` interface in `src/ir/types.ts`
  - Add `optional: boolean` field to `ClassifiedProp` interface in `src/package-analyzer.ts`
  - No behavior changes — just the type definitions

  **Must NOT do**:
  - Change any behavior — this is types only

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: Tasks 5, 6
  - **Blocked By**: Task 1

  **References**:
  - `src/ir/types.ts:108-135` — PropIR interface, add field alongside `deprecated?: boolean`
  - `src/package-analyzer.ts:8-12` — ClassifiedProp interface, add field alongside `deprecated`

  **Acceptance Criteria**:
  - [ ] PropIR has `optional?: boolean` field
  - [ ] ClassifiedProp has `optional: boolean` field
  - [ ] `npx vitest run` — all 1045 tests still pass

  **QA Scenarios**:
  ```
  Scenario: Type definitions compile
    Tool: Bash
    Steps:
      1. npx tsc --noEmit
      2. npx vitest run
    Expected Result: Zero new errors, all tests pass
    Evidence: .sisyphus/evidence/task-4-types.txt
  ```

  **Commit**: YES
  - Message: `feat(ir): add optional field to PropIR and ClassifiedProp`

- [x] 5. Detect optionality from TypeScript type system

  **What to do**:
  - In `PackageAnalyzer.classifyProp`, detect optional props using `memberSym.flags & ts.SymbolFlags.Optional` (same pattern already used in `generateDummyProps` line 206-208)
  - Set `optional: true` on the ClassifiedProp result
  - In CLI (`src/cli.ts`), stamp `optional` on PropIR from ClassifiedProp, same pattern as `deprecated` stamping (lines 116-119)

  **Must NOT do**:
  - Hardcode any prop names as optional
  - Change the emitter (that's Task 6)

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: Task 6
  - **Blocked By**: Task 4

  **References**:
  - `src/package-analyzer.ts:53-63` — `classifyProp` method, has `memberSym: ts.Symbol`
  - `src/package-analyzer.ts:206-208` — existing optionality detection in `generateDummyProps`
  - `src/cli.ts:116-119` — existing `deprecated` stamping pattern to follow

  **Acceptance Criteria**:
  - [ ] `classifyProp` sets `optional: true` when `memberSym.flags & ts.SymbolFlags.Optional`
  - [ ] CLI stamps `optional` on PropIR from ClassifiedProp
  - [ ] Test: a prop declared as `color?: string` in the published type → `optional: true` in ClassifiedProp

  **QA Scenarios**:
  ```
  Scenario: Optional detection works on Cloudscape Badge.color
    Tool: Bash
    Steps:
      1. Add a unit test in test/parser/ that classifies Badge's 'color' prop
      2. Assert classified.optional === true (Badge.color is declared as color?: string)
      3. npx vitest run test/parser/
    Expected Result: Test passes
    Evidence: .sisyphus/evidence/task-5-optional-detection.txt
  ```

  **Commit**: YES
  - Message: `feat(analyzer): detect optional props from TS type system`

- [x] 6. Emit `?` for optional props without defaults

  **What to do**:
  - In `emitProperties` (`src/emitter/properties.ts`), when emitting a property declaration:
    - If `prop.optional === true` AND `prop.default === undefined` → emit `propName?: Type;`
    - If `prop.optional === true` AND `prop.default !== undefined` → emit `propName: Type = default;` (default handles it)
    - If `prop.optional === false/undefined` → current behavior unchanged
  - This suppresses TS2564 for optional props

  **Must NOT do**:
  - Emit `!` (definite assignment assertion) — `?` is correct
  - Change behavior for props with defaults

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 7, 8)
  - **Parallel Group**: Wave 1 emission (with Tasks 7, 8)
  - **Blocks**: Task 9
  - **Blocked By**: Task 5

  **References**:
  - `src/emitter/properties.ts:88` — current property declaration line: `${override}${prop.name}${typeAnnotation}${defaultValue};`
  - `test/emitter/properties.test.ts` — existing property emission tests

  **Acceptance Criteria**:
  - [ ] `@property() color?: string;` emitted for optional prop without default
  - [ ] `@property() color: string = 'grey';` emitted for optional prop WITH default (unchanged)
  - [ ] `npx vitest run test/emitter/properties.test.ts` passes with new test cases

  **QA Scenarios**:
  ```
  Scenario: Optional prop emits question mark
    Tool: Bash
    Steps:
      1. Add test case to test/emitter/properties.test.ts with PropIR { name: 'color', type: 'string', optional: true, category: 'attribute', litType: 'String' }
      2. Assert output contains 'color?: string;'
      3. npx vitest run test/emitter/properties.test.ts
    Expected Result: Test passes
    Evidence: .sisyphus/evidence/task-6-optional-emit.txt

  Scenario: Optional prop with default still uses equals
    Tool: Bash
    Steps:
      1. Add test case with PropIR { name: 'color', type: 'string', optional: true, default: "'grey'", ... }
      2. Assert output contains "color: string = 'grey';" (no ?)
      3. npx vitest run test/emitter/properties.test.ts
    Expected Result: Test passes
    Evidence: .sisyphus/evidence/task-6-optional-with-default.txt
  ```

  **Commit**: YES
  - Message: `feat(emitter): emit optional markers for props without defaults`

- [x] 7. Skip unreferenced HTMLElement props in emitter

  **What to do**:
  - In `emitComponent` (`src/emitter/class.ts`), before emitting properties:
    - Get the set of HTMLElement property names via `getHtmlElementProps()` (from `src/standards.ts`)
    - For each prop in `ir.props`, if the prop name is in the HTMLElement set:
      - Scan the component's template, handlers, effects, computed values, and body preamble for `this.{propName}`
      - If NOT referenced anywhere → filter out (don't emit)
      - If referenced → keep (emit with `override`)
  - The reference scan follows existing patterns (unused slot getter filtering, unused import filtering)

  **Must NOT do**:
  - Hardcode any prop names (className, id, etc.) — derive from `getHtmlElementProps()`
  - Skip ALL HTMLElement props — only unreferenced ones
  - Change behavior for non-HTMLElement props

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 6, 8)
  - **Parallel Group**: Wave 1 emission (with Tasks 6, 8)
  - **Blocks**: Task 9
  - **Blocked By**: Task 1

  **References**:
  - `src/standards.ts` — `getHtmlElementProps()` queries TS DOM lib
  - `src/emitter/class.ts:122-129` — existing `filteredProps` pattern for unused slot getters
  - `src/emitter/class.ts:193-230` — existing unused preamble variable filter (reference scan pattern)

  **Acceptance Criteria**:
  - [ ] `className` and `id` NOT in output for Badge (unreferenced)
  - [ ] `title` IS in output for CollectionPreferences (referenced in template)
  - [ ] `getHtmlElementProps()` called, no hardcoded list

  **QA Scenarios**:
  ```
  Scenario: Unreferenced className is skipped
    Tool: Bash
    Steps:
      1. Regenerate Badge: npx tsx src/cli.ts ... --component badge
      2. grep 'className' /tmp/r2l-all/badge/index.ts
      3. Assert: no match (className was unreferenced, now skipped)
    Expected Result: grep returns no matches
    Evidence: .sisyphus/evidence/task-7-no-classname.txt

  Scenario: Referenced title is kept
    Tool: Bash
    Steps:
      1. Regenerate collection-preferences
      2. grep 'override title' output
      3. Assert: match exists (title IS referenced)
    Expected Result: grep returns match with override
    Evidence: .sisyphus/evidence/task-7-title-kept.txt
  ```

  **Commit**: YES
  - Message: `feat(emitter): skip unreferenced HTMLElement props (derived from DOM lib)`

- [x] 8. Add `reflect: true` for attribute-type @property() declarations

  **What to do**:
  - In `emitProperties` (`src/emitter/properties.ts`), when building the `@property()` decorator options:
    - If the prop has an attribute (`prop.attribute !== false`) → add `reflect: true` to the decorator options
    - If the prop is property-only (`prop.attribute === false`) → no reflect (no attribute to reflect to)
    - If the prop is `litType: Array` or `litType: Object` → no reflect (too expensive to serialize)
  - This matches community practice: all primitive attribute-type props reflect

  **Must NOT do**:
  - Add reflect for Array/Object props
  - Add reflect for property-only props (attribute: false)
  - Use a base class to set reflect globally

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 6, 7)
  - **Parallel Group**: Wave 1 emission (with Tasks 6, 7)
  - **Blocks**: Task 9
  - **Blocked By**: Task 1

  **References**:
  - `src/emitter/properties.ts:58-85` — decorator options building
  - Lit docs: `reflect: true` enables property→attribute sync

  **Acceptance Criteria**:
  - [ ] `@property({ type: String, reflect: true })` for string attribute props
  - [ ] `@property({ type: Boolean, reflect: true })` for boolean props
  - [ ] `@property({ attribute: false })` for object/function props (NO reflect)
  - [ ] `npx vitest run test/emitter/properties.test.ts` passes

  **QA Scenarios**:
  ```
  Scenario: String prop gets reflect: true
    Tool: Bash
    Steps:
      1. Add test with PropIR { name: 'variant', type: 'string', category: 'attribute', litType: 'String' }
      2. Assert output contains 'reflect: true'
      3. npx vitest run test/emitter/
    Expected Result: Test passes
    Evidence: .sisyphus/evidence/task-8-reflect.txt

  Scenario: Object prop does NOT get reflect
    Tool: Bash
    Steps:
      1. Add test with PropIR { name: 'items', type: 'Item[]', category: 'property', attribute: false, litType: 'Array' }
      2. Assert output does NOT contain 'reflect'
      3. npx vitest run test/emitter/
    Expected Result: Test passes
    Evidence: .sisyphus/evidence/task-8-no-reflect-object.txt
  ```

  **Commit**: YES
  - Message: `feat(emitter): add reflect: true for attribute-type properties`

- [x] 9. Property system integration test

  **What to do**:
  - Write an integration test that runs the FULL pipeline (parse → transform → emit) on a test component with:
    - An optional prop without default → emits `?`
    - An optional prop with default → emits `= default` (no `?`)
    - A className prop (HTMLElement, unreferenced) → skipped
    - An id prop (HTMLElement, unreferenced) → skipped
    - A string attribute prop → has `reflect: true`
    - A boolean attribute prop → has `reflect: true`
    - An object property-only prop → no `reflect`
  - Run full vitest suite to verify no regressions

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: Task 21
  - **Blocked By**: Tasks 6, 7, 8

  **Acceptance Criteria**:
  - [ ] Integration test passes covering all property system changes
  - [ ] `npx vitest run` — all tests pass (existing 1045 + new)

  **QA Scenarios**:
  ```
  Scenario: Full suite green
    Tool: Bash
    Steps:
      1. npx vitest run
    Expected Result: All tests pass, zero failures
    Evidence: .sisyphus/evidence/task-9-all-tests.txt
  ```

  **Commit**: YES
  - Message: `test: property system integration coverage`

---

### Wave 2 — Dependency Analysis

- [x] 10. Build cross-library import graph from React source

  **What to do**:
  - Create `src/dependency-graph.ts` — a module that takes a React source directory and produces a dependency graph
  - For each component directory, parse all `.tsx`/`.ts` files and extract import statements
  - Build a graph: `Map<string, Set<string>>` where key = importing module, value = set of imported modules
  - Classify each node: component (has JSX return), hook (starts with `use`), utility (pure function), context (uses `createContext`), type-only (only type imports)
  - Output: a serializable graph with node classifications

  **Must NOT do**:
  - Cloudscape-specific logic — this is a generic import analyzer
  - Execute any React code — static analysis only

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: Tasks 11, 12, 13, 14
  - **Blocked By**: Task 1

  **References**:
  - `src/parser/index.ts` — existing file parsing patterns
  - ts-morph `SourceFile.getImportDeclarations()` — import extraction API

  **Acceptance Criteria**:
  - [ ] Module `src/dependency-graph.ts` exists
  - [ ] Produces graph for Cloudscape source with 91+ component nodes
  - [ ] Each node classified as component/hook/utility/context/type-only
  - [ ] Unit test verifies graph structure for a known component (Button → InternalButton → fireCancelableEvent)

  **QA Scenarios**:
  ```
  Scenario: Graph captures Button's dependencies
    Tool: Bash
    Steps:
      1. Build graph for vendor/cloudscape-source/src
      2. Query: what does button/internal.tsx import?
      3. Assert: includes ../internal/events (fireCancelableEvent), ../icon/internal (Icon), ./interfaces (ButtonProps)
    Expected Result: All three dependencies present in graph
    Evidence: .sisyphus/evidence/task-10-graph.json
  ```

  **Commit**: YES
  - Message: `feat: build cross-library import dependency graph`

- [ ] 11. Classify shared imports as behavioral vs framework

  **What to do**:
  - Create `src/pattern-classifier.ts` — takes the dependency graph from Task 10 and classifies each shared module
  - Classification rules (GENERAL, not Cloudscape-specific):
    - **Framework** (eliminate): modules that exist because React requires them. Heuristics:
      - Uses `React.forwardRef`, `React.createRef`, `React.Children` — React wiring
      - Named `use-base-component`, `apply-display-name`, `get-base-props`, `external-props` — wrapper boilerplate
      - Only purpose is ref forwarding, prop spreading, or analytics metadata attachment
    - **Behavioral** (preserve): modules that implement component behavior. Heuristics:
      - Used by 2+ components AND contains state management, event dispatch, or DOM manipulation
      - Named patterns: `use-controllable`, `fire*event`, `use-unique-id`, `use-form-field`
      - Contains business logic that the component needs to function correctly
    - **Type-only** (import type): modules that only export TypeScript types/interfaces
  - The classifier should use heuristics, NOT hardcoded module names
  - Output: each shared module annotated with `behavioral | framework | type-only`

  **Must NOT do**:
  - Hardcode Cloudscape module names as behavioral/framework — use heuristics
  - Execute any code — static analysis only

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 12, 13, 14 if graph is ready)
  - **Blocks**: Tasks 15, 16, 17
  - **Blocked By**: Task 10

  **Acceptance Criteria**:
  - [ ] Module `src/pattern-classifier.ts` exists
  - [ ] Classifies Cloudscape's `useBaseComponent` as framework (purpose: ref + telemetry)
  - [ ] Classifies Cloudscape's `fireCancelableEvent` as behavioral (purpose: event dispatch)
  - [ ] Classifies Cloudscape's `useControllable` as behavioral (purpose: state management)
  - [ ] Uses heuristics, not hardcoded names

  **QA Scenarios**:
  ```
  Scenario: Framework vs behavioral classification
    Tool: Bash
    Steps:
      1. Run classifier on Cloudscape dependency graph
      2. Assert useBaseComponent → framework
      3. Assert fireCancelableEvent → behavioral
      4. Assert useControllable → behavioral
      5. Assert ButtonProps interface → type-only
    Expected Result: All 4 classifications correct
    Evidence: .sisyphus/evidence/task-11-classification.json
  ```

  **Commit**: YES
  - Message: `feat: classify shared patterns as behavioral vs framework`

- [ ] 12. Detect shared hooks and their Lit-native shape

  **What to do**:
  - From the dependency graph + classifier, for each behavioral hook:
    - Analyze its source: does it manage state? Does it use lifecycle (useEffect, useLayoutEffect)? Does it return refs?
    - Determine Lit-native shape:
      - State + lifecycle → Reactive controller
      - Pure computation → Utility function
      - Ref management → Eliminated (Lit handles refs via @query)
  - Output: a mapping `hookName → { shape: 'controller' | 'utility' | 'eliminate', sourceFile: string }`

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 11, 13, 14)
  - **Blocks**: Task 15
  - **Blocked By**: Task 10

  **Acceptance Criteria**:
  - [ ] Mapping produced for all behavioral hooks
  - [ ] `useControllable` → controller (has state + lifecycle)
  - [ ] `useUniqueId` → utility (pure computation)

  **Commit**: YES
  - Message: `feat: map behavioral hooks to Lit-native shapes`

- [ ] 13. Detect shared sub-components and embedding patterns

  **What to do**:
  - From the dependency graph, identify components imported and used by other components (not just their own index.tsx wrapper)
  - For each shared sub-component: how is it used? As a child in template? As a ref target? As a context provider?
  - Output: a mapping of which components embed which other components, and the embedding pattern

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 11, 12, 14)
  - **Blocks**: Task 17
  - **Blocked By**: Task 10

  **Acceptance Criteria**:
  - [ ] Sub-component embedding map produced
  - [ ] Icon, InternalButton, LiveRegion identified as shared sub-components
  - [ ] Embedding pattern classified (template child, ref target, context provider)

  **Commit**: YES
  - Message: `feat: detect shared sub-component embedding patterns`

- [ ] 14. Context classification: all contexts → behavioral/framework/strip

  **What to do**:
  - From the dependency graph, find all `React.createContext` calls in the source
  - For each context, analyze its value type and usage:
    - **Behavioral** (needs @lit/context): provides data that components need for rendering (form field state, theme, i18n)
    - **Framework** (strip): provides React-specific infrastructure (funnel analytics, sticky header tracking, error boundaries)
    - **Plugin** (strip): provides layout/container-specific wiring (split panel, app layout)
  - The classification should be based on the VALUE TYPE, not the context name:
    - Value is rendering data (strings, booleans, enums) → behavioral
    - Value is RefObjects, callbacks, or React-specific APIs → framework
    - Value is container-specific state → plugin (strip)
  - Output: each context annotated with its classification and the reason

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 11, 12, 13)
  - **Blocks**: Task 18
  - **Blocked By**: Task 10

  **Acceptance Criteria**:
  - [ ] All 27+ Cloudscape contexts classified
  - [ ] Classification based on value type, not name
  - [ ] FormFieldContext → behavioral (provides label, description, error state)
  - [ ] FunnelContext → framework (React-specific analytics)
  - [ ] Each classification has a documented reason

  **QA Scenarios**:
  ```
  Scenario: All contexts classified
    Tool: Bash
    Steps:
      1. Run context classifier on Cloudscape source
      2. Count total contexts found
      3. Assert each has a classification (behavioral/framework/strip)
      4. Assert zero unclassified
    Expected Result: 27+ contexts, zero unclassified
    Evidence: .sisyphus/evidence/task-14-contexts.json
  ```

  **Commit**: YES
  - Message: `feat: classify all React contexts as behavioral/framework/strip`

---

### Wave 3 — Shared Infrastructure Generation

- [ ] 15. Shared controller emitter: behavioral hooks → Lit controllers

  **What to do**:
  - Create `src/emitter/controllers.ts` — generates Lit reactive controller source from behavioral hooks
  - For each hook classified as `shape: 'controller'` in Task 12:
    - Analyze the hook's state variables (useState calls) → controller properties
    - Analyze the hook's effects (useEffect calls) → controller lifecycle (hostConnected, hostDisconnected, hostUpdated)
    - Analyze the hook's return value → controller's public API
    - Generate a TypeScript class extending `ReactiveController`
  - Output: one `.ts` file per generated controller
  - Wire into CLI: new flag `--emit-controllers` or automatic when shared hooks are detected

  **Must NOT do**:
  - Hardcode any controller implementations — derive from hook source
  - Generate controllers for hooks classified as 'utility' or 'eliminate'

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 16, 17, 18)
  - **Blocks**: Task 19, 20
  - **Blocked By**: Tasks 11, 12

  **References**:
  - `src/emitter/class.ts` — existing emitter patterns to follow
  - Lit docs on ReactiveController interface

  **Acceptance Criteria**:
  - [ ] `src/emitter/controllers.ts` exists
  - [ ] Generates at least one controller from a behavioral Cloudscape hook
  - [ ] Generated controller extends ReactiveController with correct interface
  - [ ] Unit test verifies generated controller compiles

  **Commit**: YES
  - Message: `feat(emitter): generate Lit controllers from behavioral hooks`

- [ ] 16. Shared utility emitter: behavioral utilities → utility modules

  **What to do**:
  - For each shared module classified as behavioral + utility (not hook, not component):
    - Copy the function signature and adapt React-specific APIs to web-standard APIs
    - `fireCancelableEvent(element, name, detail)` → standard `new CustomEvent()` + `dispatchEvent()`
    - `generateUniqueId(prefix)` → stays the same (no React dependency)
  - Output: utility module files
  - These are simpler than controllers — often 1:1 translation or just import forwarding

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 15, 17, 18)
  - **Blocks**: Task 19, 20
  - **Blocked By**: Task 11

  **Acceptance Criteria**:
  - [ ] Utility modules generated for behavioral utilities
  - [ ] Generated utilities have no React imports
  - [ ] `fireCancelableEvent` equivalent produces standard CustomEvents

  **Commit**: YES
  - Message: `feat(emitter): generate shared utility modules from behavioral utilities`

- [ ] 17. Shared component emitter: behavioral sub-components → Lit components

  **What to do**:
  - For shared sub-components identified in Task 13 (e.g., Icon, LiveRegion):
    - These are COMPONENTS — they need their own react-to-lit conversion
    - Run the existing per-component pipeline on them first (they're dependencies)
    - Ensure they're generated BEFORE the components that use them
  - This is primarily about ORDERING the generation pipeline, not new emitter code
  - The existing emitter already produces component files — just ensure sub-components are processed first

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 15, 16, 18)
  - **Blocks**: Task 19
  - **Blocked By**: Task 13

  **Acceptance Criteria**:
  - [ ] Sub-components generated before components that embed them
  - [ ] Generation order follows the dependency graph (leaves first)

  **Commit**: YES
  - Message: `feat: order component generation by dependency graph`

- [ ] 18. Context emitter: @lit/context definitions for behavioral contexts

  **What to do**:
  - For each context classified as behavioral in Task 14:
    - Generate a `@lit/context` context definition: `const myContext = createContext<MyType>('my-context')`
    - Generate the type for the context value (from the React context's type parameter)
  - For components that CONSUME behavioral contexts:
    - Add `@consume({ context: myContext, subscribe: true })` to the component's property
  - For components that PROVIDE behavioral contexts:
    - Add `@provide({ context: myContext })` to the component's property
  - Output: context definition files + per-component context wiring

  **Must NOT do**:
  - Generate context for framework/strip contexts
  - Hardcode context names or types

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 15, 16, 17)
  - **Blocks**: Task 19, 20
  - **Blocked By**: Task 14

  **Acceptance Criteria**:
  - [ ] Context definition files generated for behavioral contexts
  - [ ] Consumer components have `@consume` decorators
  - [ ] Provider components have `@provide` decorators
  - [ ] Framework/strip contexts produce NO output

  **Commit**: YES
  - Message: `feat(emitter): generate @lit/context definitions for behavioral contexts`

- [ ] 19. Wire shared infrastructure imports into per-component output

  **What to do**:
  - Modify the per-component emitter to import from generated shared infrastructure:
    - If component uses a behavioral hook → import the generated controller
    - If component calls a behavioral utility → import the generated utility module
    - If component embeds a shared sub-component → import the generated sub-component
    - If component consumes a behavioral context → import the context definition
  - The import paths should be relative and configurable via output config

  **Must NOT do**:
  - Import from ../components or any hand-written source
  - Hardcode import paths — derive from output directory structure

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: Task 20, 21
  - **Blocked By**: Tasks 15, 16, 17, 18

  **References**:
  - `src/emitter/imports.ts` — ImportCollector, the existing import management system

  **Acceptance Criteria**:
  - [ ] Generated components import from generated shared infrastructure
  - [ ] Import paths are relative and resolve correctly
  - [ ] No imports from hand-written sources

  **Commit**: YES
  - Message: `feat(emitter): wire shared infrastructure imports into component output`

- [ ] 20. Shared infrastructure tests

  **What to do**:
  - Unit tests for dependency graph builder (Task 10)
  - Unit tests for pattern classifier (Task 11)
  - Unit tests for hook shape detection (Task 12)
  - Unit tests for context classification (Task 14)
  - Integration test: end-to-end pipeline produces component + shared infrastructure with correct imports

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: Task 21
  - **Blocked By**: Tasks 15-19

  **Acceptance Criteria**:
  - [ ] `npx vitest run` — all tests pass
  - [ ] New test files cover: graph, classifier, hook mapping, context classification
  - [ ] Integration test proves end-to-end pipeline works

  **Commit**: YES
  - Message: `test: shared infrastructure generation coverage`

---

### Wave 4 — Convergence

- [ ] 21. Regenerate batch with property system + shared infrastructure

  **What to do**:
  - Run the full pipeline with all Wave 1 + Wave 3 changes
  - Compare failure counts to Wave 0 baseline
  - Categorize remaining failures by type
  - Produce a delta report: what improved, what's new, what's unchanged

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: Tasks 22, 23, 24, 25
  - **Blocked By**: Tasks 9, 20

  **Acceptance Criteria**:
  - [ ] Batch regenerated with all changes
  - [ ] Delta report: baseline N errors → current M errors
  - [ ] Remaining failures categorized

  **Commit**: YES
  - Message: `chore: regenerate batch — N/91 clean (up from baseline)`

- [ ] 22-24. Fix top 3 failure categories from batch results

  **What to do** (for each):
  - From Task 21's categorized failures, pick the failure category affecting the most components
  - Write a failing test reproducing the failure on a minimal component
  - Fix the relevant transform/emitter/parser
  - Verify the fix improves the batch count

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (sequential — each fix may change the failure landscape)
  - **Blocked By**: Task 21

  **Acceptance Criteria**:
  - [ ] Each fix improves the batch clean count
  - [ ] Each fix has a unit test
  - [ ] No regressions

  **Commit**: YES (one per fix)
  - Message: `fix(transform): resolve [category] — improves N components`

- [ ] 25. Gate2 measurement and roadmap for remaining work

  **What to do**:
  - Run final gate2 measurement
  - Document: where we are (N/91), what's left, what the next wave should target
  - This is the exit point for THIS plan — future waves continue the convergence

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Acceptance Criteria**:
  - [ ] Final gate2 count documented
  - [ ] Remaining failures categorized with effort estimates
  - [ ] Clear roadmap for next planning cycle

  **Commit**: YES
  - Message: `docs: gate2 progress — N/91 clean, roadmap for remaining`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + linter + `npx vitest run`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code. Check for hardcoded Cloudscape references in core pipeline (only allowed in preset).
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Regenerate full batch output. Run gate2 on ALL 91 components. Count clean vs failing. Compare to Wave 0 baseline. Test property system on 3 representative components (Badge=simple, Button=medium, Table=complex).
  Output: `Baseline [N/91] → Current [N/91] | Property system [3/3 correct] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read spec, read diff. Verify no Cloudscape-specific logic in core pipeline. Verify no ../components references. Verify no hardcoded prop/attribute lists. Verify all derivation uses type system or DOM lib.
  Output: `Tasks [N/N compliant] | Core purity [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

- Wave 0: `chore: establish baseline — regenerate batch, categorize N failure types`
- Wave 1: `feat(ir): add optional field to PropIR` → `feat(emitter): emit optional markers` → `feat(emitter): skip unreferenced HTMLElement props` → `feat(emitter): add reflect: true for attribute-type props` → `test: property system coverage`
- Wave 2: `feat: build cross-library dependency graph` → `feat: classify shared patterns as behavioral/framework` → `feat: classify 27+ Cloudscape contexts`
- Wave 3: `feat(emitter): generate shared controllers from behavioral hooks` → `feat(emitter): generate shared utilities` → `feat(emitter): wire shared imports into component output`
- Wave 4: `fix: [failure category] — improves N components` (repeat per category)

---

## Success Criteria

### Verification Commands
```bash
npx vitest run                    # Expected: all tests pass (existing + new)
npm run gate2                     # Expected: measurable improvement from baseline
npm run gate2 -- --component Badge  # Expected: clean output with optional + reflect
```

### Final Checklist
- [ ] All existing 1045 tests still pass
- [ ] PropIR has `optional` and `reflect` fields
- [ ] Optional props emit `?` (TS2564 fix verified on Badge, Button)
- [ ] Unreferenced HTMLElement props are skipped (className, id not in output)
- [ ] Attribute-type @property() has `reflect: true`
- [ ] Dependency graph builder exists and produces graph for Cloudscape
- [ ] Pattern classifier categorizes shared imports
- [ ] At least one shared controller is generated from a behavioral hook
- [ ] All 27+ Cloudscape contexts classified
- [ ] Gate2 pass count improved from baseline
- [ ] Zero hardcoded prop/attribute lists in core pipeline
- [ ] Zero ../components references in codebase
- [ ] Zero Cloudscape-specific logic outside of preset
