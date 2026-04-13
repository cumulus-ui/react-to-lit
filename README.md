# react-to-lit

A compiler that transforms React function components into Lit web component classes.

## Objectives

- **Framework-agnostic output.** The compiler produces pure Lit classes with neutral `el-` tag names. No `@customElement()` registration — the consumer decides tag names and registration.
- **Standards-driven.** Global names, DOM properties, boolean attributes, and HTML tag names come from the TypeScript compiler's DOM lib — not hardcoded lists.
- **Authoritative type data.** Component props are read from published `.d.ts` declaration files (with full inheritance chain resolution), not guessed from React source destructuring.
- **No post-processing.** All transforms happen at the IR level. The emitter is a pure printer — no regex patching of output text.
- **Deterministic.** Same input always produces same output. No heuristics that could produce different results across runs.

## Architecture

```
                       ┌──────────────────┐
                       │  CompilerConfig   │
                       │  (--config file,  │
                       │   --preset, or    │
                       │   defaults)       │
                       └────────┬─────────┘
                                │ drives all transforms
                                ▼
React source (.tsx)         Published declarations (.d.ts)
        │                              │
        ▼                              ▼
┌─────────────┐              ┌──────────────────┐
│   Parser    │◄─────────────│  .d.ts reader    │
│  (ts AST)   │  prop types  │  (ts-morph)      │
└──────┬──────┘              └──────────────────┘
       │
       ▼
┌─────────────┐
│     IR      │  ComponentIR: props, state, handlers,
│             │  effects, template tree, helpers
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────┐
│           Transform Pipeline            │
│                                         │
│  cleanup → react-types → unwrap →       │
│  components → slots → clsx → events →   │
│  identifiers                            │
└──────┬──────────────────────────────────┘
       │
       ▼
┌─────────────┐
│   Emitter   │  Pure printer: IR → Lit TypeScript
│             │  No regex, no text patching
└─────────────┘
```

### Key modules

| Module | Purpose |
|--------|---------|
| `src/standards.ts` | Queries TS compiler for web standards (globals, DOM props, boolean attrs, HTML tags) |
| `src/naming.ts` | Name conversions, event detection, `toTagName()`, `escapeRegex()` |
| `src/template-walker.ts` | Generic visitor for template IR trees |
| `src/cloudscape-config.ts` | Cloudscape-specific constants (isolated from core logic) |
| `src/transforms/cleanup-react-types.ts` | `React.XxxEvent` → DOM event (derived from DOM lib, not listed) |
| `src/transforms/identifiers.ts` | ts-morph scope-aware identifier rewriting (`foo` → `this.foo`) |

## Usage

### Generic usage

The compiler can target **any** React component library. Behaviour is controlled
via a `CompilerConfig` object provided through `--config` or `--preset`.

```bash
# With a custom config file (JS or TS module)
npx react-to-lit --config react-to-lit.config.ts \
  --input vendor/my-lib/src/button --output src/button/internal.ts

# With a built-in preset
npx react-to-lit --preset cloudscape \
  --input vendor/source/src --output src --batch

# Zero-config (sensible defaults — works for simple libraries)
npx react-to-lit --input vendor/source/src/badge --output src/badge/internal.ts
```

| Flag | Description |
|------|-------------|
| `-i, --input <path>` | Input directory (single component or source root) |
| `-o, --output <path>` | Output directory or file |
| `-b, --batch` | Batch mode: process all component directories under `--input` |
| `-c, --component <name>` | Process a single component from a batch input |
| `--config <path>` | Path to a config file (JS/TS module exporting a `CompilerConfig`) |
| `--preset <name>` | Use a built-in preset (e.g., `cloudscape`) |
| `--dry-run` | Print output to stdout instead of writing files |
| `--verbose` | Log parsing decisions |

For a full walkthrough on writing a config for a new library, see
[docs/adding-a-library.md](docs/adding-a-library.md).

### Cloudscape preset

The Cloudscape design system has a built-in preset that pre-configures all
cleanup rules, skip directories, class naming, and infrastructure function
stripping. Use it with `--preset cloudscape`:

```bash
# Single component
npx react-to-lit --preset cloudscape \
  --input vendor/source/src/badge --output src/badge/internal.ts

# Batch
npx react-to-lit --preset cloudscape \
  --input vendor/source/src --output src --batch

# Dry run
npx react-to-lit --preset cloudscape \
  --input vendor/source/src/badge --dry-run
```

The Cloudscape preset sets `classPrefix: 'Cs'`, `classSuffix: 'Internal'`,
strips Cloudscape-specific infrastructure functions (`applyDisplayName`,
`getBaseProps`, etc.), and unwraps framework wrappers like `AnalyticsFunnel`,
`FocusLock`, `CSSTransition`, and React Context providers.

## Quality gates

```bash
npm test          # 441 tests, esbuild 91/91, no-JSX 91/91
npm run gate2     # tsc type-check on generated output
npm run gate3     # structural validation (class, extends, render, imports, no React)
npm run analyze   # quality analysis (clean/broken/warning breakdown)
```

## How the consumer uses the output

The compiler produces pure classes with `el-` prefixed tags:

```typescript
// Generated by react-to-lit
export class CsAlertInternal extends CsBaseElement {
  @property({ type: String }) type = 'info';
  override render() {
    return html`<div>...
      <el-internal-icon .name=${this.iconName}></el-internal-icon>
    ...</div>`;
  }
}
```

The consumer (e.g., cumulus) remaps tags and registers elements:

```typescript
// Consumer's registration module
import { CsAlertInternal } from './alert/internal.js';
customElements.define('cs-alert', CsAlertInternal);
// Remap el-internal-icon → cs-icon in build step
```

## Adding support for a new library

react-to-lit is library-agnostic. To use it with a React component library
other than Cloudscape, create a `react-to-lit.config.ts` that describes your
library's naming conventions, infrastructure props, sub-component mappings, and
event dispatch pattern.

See **[docs/adding-a-library.md](docs/adding-a-library.md)** for a complete
step-by-step guide with worked examples and a full configuration reference.

## What's not in scope

- **Tag registration** — consumer's responsibility
- **Tag prefix choice** — consumer remaps `el-` → their prefix
- **CSS generation** — separate concern (styles pipeline)
- **Runtime framework** — this is a build-time compiler
- **Server-side rendering**
- **React context → Lit context** — partially handled (useContext flagged, not auto-converted)
