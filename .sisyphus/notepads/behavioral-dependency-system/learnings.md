## Learnings

## Decisions

## Issues

## Problems

### Task 1 Baseline Findings (2026-04-15)

**Gate2 vs Raw type-checking:** Gate2 uses elaborate stubs (all imports → `any`) + `strict: false`, yielding 0 errors (except 2 slider syntax errors). Raw checking with `--strict` and lit resolved via node_modules yields 1969 errors across 33 unique error codes.

**Top 5 error categories (accounting for 85% of all errors):**
1. **TS2564** (846, 88 components): `@property()` props without initializers. Optional string/object props declared without `= undefined` or defaults.
2. **TS6133** (441, 73 components): Unused imports/variables. Code gen emits imports for internal utilities that aren't used in the generated output.
3. **TS2304** (259, 46 components): Cannot find name. References to symbols from unresolved internal modules (persistenceConfig, ScaleType, etc).
4. **TS7006** (121, 30 components): Implicit `any` parameters. Callback params in event handlers and utility functions lack type annotations.
5. **TS2339** (47, 8 components): Property doesn't exist. Accessing `__awsui__` or other non-standard properties on DOM elements.

**Key insight:** The gate2 stub infrastructure masks ALL real issues. The stubs make everything `any`, which hides type mismatches, unused variables, and missing imports. The 0-error gate2 result is misleading about code quality.

**Slider syntax error:** `slider/index.ts:150` has a malformed conditional: `if (this.step && this.value !== undefined) % this.step !== 0)` — mismatched parens in code generation.

**Only 1 clean component (no errors):** `radio-button` — the simplest possible component with minimal props/logic.

### Task 21 Post-Wave 1 Measurement (2026-04-15)

**Headline:** Baseline 1969 errors → Current 1817 errors (7.7% net reduction, -152 errors)

**Wave 1 target achieved:** TS2564 reduced 94.3% (846→48). The optional props (`?`), reflect, and HTMLElement-skip changes massively addressed the #1 error category. Remaining 48 TS2564 are genuinely required props (value, items, checked, columnDefinitions) that correctly need initializers.

**Regressions offset the gains:** Changes between Task 1 and Task 21 introduced new errors:
- **TS2307** exploded 9→448 (+439): Generator now emits imports for `./styles`, `./interfaces`, `../internal/*` modules not present in output. This is the NEW #1 error category.
- **TS4112** appeared (0→72): `override` modifier on classes tsc can't see extending another class — affects 17 form-control components.
- **TS2339** grew 47→95 (+48): `dispatchEvent`/`childElementCount` not recognized on classes after HTMLElement skip.
- **TS1240** grew 28→74 (+46): Property decorator signature resolution failures expanded.

**Top 3 remaining categories:**
1. **TS2307** (448, 90 components): Module resolution failures — ./styles, ./interfaces, ../internal/*
2. **TS6133** (442, 75 components): Unused imports/variables — essentially unchanged from baseline
3. **TS2304** (257, 46 components): Cannot find name — essentially unchanged from baseline

**Key insight:** The Wave 1 property system changes were surgically effective on their target (TS2564), but other codegen changes introduced a new dominant problem (TS2307 module resolution). The import generation pipeline needs attention — it's emitting references to files that don't exist in the output directory.

**radio-button regressed:** Was the only clean component in baseline (0 errors), now has 1 error (TS2307 for `./styles` import). Zero clean components remain.
