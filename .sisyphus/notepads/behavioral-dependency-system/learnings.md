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

## SSR Smoke Test Learnings (2026-04-16)

### SSR Baseline: 58/92 pass (63%)

**Setup:**
- @lit-labs/ssr v3.3.1 installed in react-to-lit
- DOM shim must be imported BEFORE any Lit imports: `import '@lit-labs/ssr/lib/install-global-dom-shim.js'`
- `unsafeStatic` from `lit/static-html.js` enables dynamic tag names in SSR templates
- vitest.config.ts resolve aliases map @cloudscape-design/* etc to ../components/node_modules/

**Error Categories:**
- IMPORT_FAIL (7): Missing styles.js or internal sub-components (chart components, navigable-group, radio-button)
- RENDER_FAIL (27): TypeError (property on undefined), ReferenceError (undefined vars), RangeError (stack overflow in link)
  - Common patterns: `this._i18n is not a function` (5 components), `Cannot read properties of undefined` (9 components), `ReferenceError: X is not defined` (5 components)

**Key Observations:**
- Multiple Lit versions warning appears (components load their own Lit + test imports Lit)
- Simple presentational components pass; complex ones with i18n, context, or iterable props fail
- `cs-link` has infinite recursion (Maximum call stack size exceeded)

## Slot Getter → Method Migration

### What changed
- Named slot getters (`private get description()`) → methods (`private _hasDescriptionSlot()`)
- Children slot (`_hasChildren`) left as getter per design
- Identifier rewriter now has `isMethod` flag on MemberMapping for `()` call syntax
- class.ts filter updated to use `_has${capitalize(name)}Slot` for reference checking

### Key insight: 4 files needed coordinated changes
1. `properties.ts` — emission of the method declaration
2. `identifiers.ts` — member mapping + call syntax rewriting  
3. `class.ts` — unused member filter (regex name check)
4. `naming.d.ts` — export declaration for new `capitalize` utility

### SSR impact
- Zero `private get ... querySelector` in output after regeneration
- 56 slot methods across 21 components generated correctly
- SSR pass count didn't improve (57/92 vs 58/92) because slot getter crashes co-occurred with other issues in the same components
- Slider regression (-1) is pre-existing syntax error, unrelated

### Test strategy
- class.test.ts: test IR must use post-identifier-rewrite format (e.g., `this._hasHeaderSlot()`)
- properties.test.ts: no changes needed (tests `children` slot which stayed as getter)

## testUtilStyles stripping

- The `cloudscapeCleanupPlugin` was defined in `presets/cloudscape.ts` with `TEST_UTIL_STYLES_RE` but was NEVER wired into the `compile.ts` pipeline
- `compile.ts` passed `config` to `transformAll` but not `cleanupPlugin` — so only core cleanup ran, not the Cloudscape-specific cleanup
- This affected ALL Cloudscape-specific cleanup patterns (testUtilStyles, analyticsSelectors, baseProps.className, warnOnce, etc.)
- Fix: `config-loader.ts` now returns `LoadedConfig { config, cleanupPlugin? }`, and `compile.ts` passes the plugin through to `transformAll`
- Utility files (emitted by `emit-utilities.ts`) go through a different code path — `transformUtility()` does simple text transforms, not IR-level cleanup. Added testUtilStyles regex stripping there separately
- The `emitUtilities` function skips files that already exist in the output — so to re-generate a utility file, you must delete it first
