# Architecture

This document covers the internal architecture of react-to-lit, contributor
guidelines, and development commands.

For configuration and usage, see the [README](../README.md) and
[Adding a New Library](adding-a-library.md).

---

## Pipeline

```
React TSX --> Parser --> IR --> Transforms --> Emitter --> Lit TS
```

1. **Parser** (`src/parser/`): Extracts component structure from React TSX
   source. Props come from published `.d.ts` declarations (full inheritance
   chain), not from source destructuring. Hooks, handlers, effects, and the
   template tree are extracted from the function body. Helper functions in the
   same file have their hooks, handlers, and constants extracted and merged
   into the main IR.

2. **IR** (`src/ir/types.ts`): The intermediate representation. A
   `ComponentIR` contains props, state, handlers, effects, a template tree
   (with loop/condition support), computed values, controllers, helpers, and
   imports. All transforms operate on this structure.

3. **Transforms** (`src/transforms/`): A pipeline of IR-to-IR transforms run
   in order: cleanup, react-types, unwrap, components, slots, clsx, events,
   effect-cleanup, identifiers. Each transform returns a new IR -- no
   mutation. Library-specific behaviour is driven by `CompilerConfig`.

4. **Emitter** (`src/emitter/`): A pure printer that converts the transformed
   IR into a Lit TypeScript class. No regex patching, no text manipulation on
   the output. Sub-emitters handle imports, properties, lifecycle, handlers,
   and the `html` template.

---

## Key modules

| Module | Purpose |
|--------|---------|
| `src/config.ts` | `CompilerConfig` interface and default factory |
| `src/config-loader.ts` | Resolves config from `--config`, `--preset`, or defaults |
| `src/standards.ts` | Queries the TS compiler for web standards (globals, DOM props, boolean attrs, HTML tags) |
| `src/naming.ts` | Case conversion, event naming, `toTagName()` |
| `src/template-walker.ts` | Generic visitor for `TemplateNodeIR` trees |
| `src/hooks/registry.ts` | Hook-to-action mapping (skip, controller, mixin, context, etc.) |
| `src/ir/types.ts` | Full IR type definitions (18+ interfaces) |
| `src/ir/transform-helpers.ts` | `mapIRText` / `collectIRText` for applying transforms across all IR text fields |
| `src/parser/index.ts` | Parser orchestrator -- loads source, extracts structure, merges helpers |
| `src/parser/jsx.ts` | JSX-to-`TemplateNodeIR` tree (structured template parsing) |
| `src/parser/props.ts` | Prop extraction from `.d.ts` declarations + source destructuring |
| `src/transforms/identifiers.ts` | Scope-aware `foo` --> `this.foo` rewriting (ts-morph AST) |
| `src/transforms/clsx.ts` | `clsx()` --> Lit `classMap()` directive |
| `src/transforms/events.ts` | React callback props --> `CustomEvent` dispatch |
| `src/transforms/cleanup-core.ts` | Core cleanup: `__`-prefixed refs, analytics, infrastructure |
| `src/emitter/class.ts` | Main class assembler |
| `src/emitter/template.ts` | `html` template emission from `TemplateNodeIR` |
| `src/emitter/properties.ts` | `@property()`, `@state()`, controllers, refs |
| `src/emitter/lifecycle.ts` | `connectedCallback`, `firstUpdated`, `disconnectedCallback`, `updated` |

---

## Contributor guidelines

### General principles

- **Every fix must be general-purpose.** If your fix checks for a specific
  component name, it's wrong. The tool must convert any React function
  component from any library.
- **No hacks in generated output.** No `as any` casts (narrow casts like
  `as HTMLInputElement` are fine for known DOM gaps). No `!` definite
  assignment assertions. No `= false` default values for props (causes
  TS1240/TS2416 in subclasses).
- **Test every fix.** Add a unit test in `test/transforms/` or
  `test/emitter/`, run the full suite, run gate2.

### The `__`-prefixed cleanup has three layers

This is a common source of regressions. Understand all three before modifying
cleanup logic:

1. **Code bodies** (`cleanInternalPrefixedRefs`): Conservative patterns --
   conditions, ternaries, logical operators only. Does NOT replace bare
   `__xxx` with `false` because that breaks type annotations and object keys.
2. **Template expressions** (`cleanInternalPrefixedRefsInExpr`): Aggressive --
   replaces bare `__xxx` with `false`. Safe because template interpolations
   are always value positions.
3. **Render helper template literals** (`cleanTemplateInterpolations`): Scans
   `${...}` inside `` html` `` in helper source text and applies the
   template-expression cleanup.

### Identifier rewriting is scope-aware

`src/transforms/identifiers.ts` uses ts-morph AST walking with three
collaborating mechanisms:

- `buildMemberMap`: maps identifier names to their `this.` equivalents
- `isShadowedByNestedScope`: checks if a name is shadowed by an inner arrow
  function parameter, for-of variable, etc.
- `topLevelLocals`: variables declared directly in the function body that
  shadow class members globally

Inner scope locals only shadow within their own scope, not the whole body.
Do not flatten this to a single set -- that causes regressions where inner
destructured parameters block outer member rewriting.

### Deferred initialization

In React, `useState(props.foo)` runs at first render when props are available.
In Lit, class field initializers run at construction time, before props are
set. When a field initializer references `this.`, it must be deferred to
`firstUpdated()`.

The emitters for state, properties, controllers, and refs all return
`{ code, deferred: DeferredInit[] }`. The lifecycle emitter injects deferred
inits into `firstUpdated()`. If you add a new field type that can reference
`this.`, you must handle deferred initialization.

### Regex cleanup rules

- Use line-anchored patterns (`^\s*...\s*$/gm`) to limit damage to a single
  line.
- Never use `[^}]*` in patterns that could match normal code -- it will
  consume nested braces.
- After any regex cleanup change, check for TS1xxx syntax errors in the
  generated output.

---

## Commands

```bash
# Unit tests
npx vitest run

# Gate 2: generate all components + type-check each individually
npm run gate2

# Gate 3: structural validation (class, extends, render, imports, no React)
npm run gate3

# Quality analysis
npm run analyze

# Shared tsc on gate2 output (target: 0 errors)
npx tsc --noEmit --strict false --skipLibCheck \
  --experimentalDecorators -p .gate2-output/tsconfig.json 2>&1 \
  | grep "^\.gate2" | wc -l

# Error breakdown by code
npx tsc --noEmit --strict false --skipLibCheck \
  --experimentalDecorators -p .gate2-output/tsconfig.json 2>&1 \
  | grep "^\.gate2" | grep -oP 'TS\d+' | sort | uniq -c | sort -rn

# Error-free component count
all=$(ls .gate2-output/*/index.ts | wc -l); \
errored=$(npx tsc --noEmit --strict false --skipLibCheck \
  --experimentalDecorators -p .gate2-output/tsconfig.json 2>&1 \
  | grep "^\.gate2" | grep -oP '(\w+)/index\.ts' | sort -u | wc -l); \
echo "$((all - errored)) / $all"
```

## Workflow: fixing errors

1. **Categorize**: run shared tsc, group errors by code, find the pattern.
2. **Trace back**: look at the generated output error line, then identify
   which parser/transform/emitter produced it.
3. **Fix generically**: the fix should apply to any React component with the
   same pattern.
4. **Write a test**: unit test in `test/transforms/` or `test/emitter/`.
5. **Verify**: `npx vitest run` then `npm run gate2` then shared tsc. Confirm
   no TS1xxx syntax errors.
6. **Commit**: small, focused commits.
