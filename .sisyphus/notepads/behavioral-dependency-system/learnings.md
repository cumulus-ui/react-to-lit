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

**Only 1 clean component (no errors):** `error-boundary` — the simplest possible component with minimal props/logic.
