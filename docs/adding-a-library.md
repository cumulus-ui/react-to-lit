# Adding a New React Library

This guide walks through configuring react-to-lit for a React component library
other than Cloudscape. By the end you will have a working `react-to-lit.config.ts`
and know how to run the compiler against your components.

---

## Overview

react-to-lit is **library-agnostic**. The core pipeline (parse → IR → transform →
emit) works with any React function component. Library-specific behaviour is
controlled entirely through a `CompilerConfig` object that you pass via
`--config` or `--preset`.

The configuration is split into five sections:

| Section | Purpose |
|---------|---------|
| `input` | Where to find source files and published declarations |
| `output` | Naming conventions for the generated Lit classes and tags |
| `cleanup` | Props, attributes, and infrastructure functions to strip |
| `components` | Component-name → tag mapping and auto-derivation |
| `events` | How event callbacks are dispatched |

---

## Step 1 — Create a config file

Create a file called `react-to-lit.config.ts` (or `.js`) in your project root.
The file should export a `CompilerConfig` object as its default export, or a
factory function that returns one.

```typescript
// react-to-lit.config.ts
import type { CompilerConfig } from '@cumulus-ui/react-to-lit';

const config: CompilerConfig = {
  input: {
    declarationsPackage: '@my-org/my-components',
    skipDirectories: ['__tests__', 'utils', 'internal'],
  },

  output: {
    baseClass: { name: 'LitElement', import: 'lit' },
    classPrefix: 'Mui',
    classSuffix: '',
    tagPrefix: 'el-',
    importExtension: '.js',
  },

  cleanup: {
    skipProps: ['classes', 'sx', 'theme'],
    skipPrefixes: ['__', 'mui'],
    removeAttributes: ['key', 'ref', 'className'],
    removeAttributePrefixes: ['__', 'data-testid'],
    infraFunctions: ['useTheme', 'withStyles'],
    unwrapComponents: [
      'Fragment',
      'React.Fragment',
      'Suspense',
      'StrictMode',
      'ThemeProvider',
      'StylesProvider',
    ],
  },

  components: {
    registry: {
      ButtonBase: 'el-button-base',
      Ripple: '__UNWRAP__',
    },
    autoDerive: true,
  },

  events: {
    dispatchFunctions: {},
    dispatchMode: 'native',
  },
};

export default config;
```

Only the fields you specify are required — any omitted section is filled in from
the built-in defaults (see [Default values](#default-values) below).

---

## Step 2 — Identify infrastructure props to strip

Every React design system ships "plumbing" props that have no meaning in a Lit
web component. Audit your library for:

- **Styling infrastructure** — `className`, `classes`, `sx`, `style` (when
  handled by a CSS-in-JS runtime)
- **Internal flags** — anything prefixed with `__` or the library's internal prefix
- **Analytics / tracking** — props like `analyticsMetadata`
- **Native attribute pass-through** — props like `nativeAttributes` that spread
  onto a host element in React but are unnecessary in Lit

Add these to `cleanup.skipProps` (remove the prop entirely) or
`cleanup.removeAttributes` (strip from template expressions only).

```typescript
cleanup: {
  // These props won't appear on the generated Lit class at all
  skipProps: ['classes', 'sx', 'theme', 'TransitionComponent'],

  // Props whose names start with these prefixes are skipped
  skipPrefixes: ['__', 'mui'],

  // These attribute names are stripped from template html`` expressions
  removeAttributes: ['key', 'ref', 'className'],
  removeAttributePrefixes: ['__', 'data-testid'],

  // Function calls that are deleted from the component body
  infraFunctions: ['useTheme', 'withStyles', 'makeStyles'],

  // Wrapper components to unwrap (children are kept, wrapper tag is removed)
  unwrapComponents: [
    'Fragment', 'React.Fragment',
    'ThemeProvider', 'StylesProvider', 'CssBaseline',
  ],
},
```

### `skipProps` vs `removeAttributes`

- `skipProps` removes the prop from the class definition — it won't become a
  `@property()` on the Lit component.
- `removeAttributes` removes the attribute from template bindings (`.foo=${...}`)
  but doesn't affect the class property list.

Use `skipProps` for props that should never exist on the Lit component.
Use `removeAttributes` for attributes that appear in JSX but shouldn't be in
the Lit template output.

---

## Step 3 — Map sub-components (registry)

Most libraries have internal sub-components that are referenced inside a parent
component's render method. You need to tell the compiler what tag name each
sub-component maps to.

```typescript
components: {
  registry: {
    // Known sub-component → custom element tag
    ButtonBase: 'el-button-base',
    TouchRipple: 'el-touch-ripple',

    // Wrapper that should be unwrapped (children kept, tag removed)
    TransitionGroup: '__UNWRAP__',
  },
  autoDerive: true,
},
```

When `autoDerive` is `true`, any component **not** in the registry is
automatically converted from PascalCase to a kebab-case tag with the configured
`tagPrefix`. For example, `IconButton` becomes `<el-icon-button>`.

Set `autoDerive: false` if you want strict control — unknown components will
produce a compiler warning instead of guessing.

---

## Step 4 — Configure event dispatch

React callbacks like `onChange` and `onClick` need to become DOM events in Lit.
The compiler supports two modes:

### Native mode (default)

```typescript
events: {
  dispatchMode: 'native',
  dispatchFunctions: {},
},
```

Callbacks like `onChange(detail)` are emitted as:

```typescript
this.dispatchEvent(new CustomEvent('change', { detail, bubbles: true }));
```

### Helper mode

If your project uses a shared helper function for event dispatch:

```typescript
events: {
  dispatchMode: 'helper',
  dispatchFunctions: {
    fireNonCancelableEvent: {
      import: '@my-org/base/events',
      cancelable: false,
    },
    fireCancelableEvent: {
      import: '@my-org/base/events',
      cancelable: true,
    },
  },
},
```

In helper mode, the compiler preserves calls to your dispatch functions and adds
the appropriate import statement.

---

## Step 5 — Run the compiler

### Single component

```bash
npx react-to-lit \
  --config react-to-lit.config.ts \
  --input vendor/my-components/src/button \
  --output src/button/internal.ts
```

### Batch mode

```bash
npx react-to-lit \
  --config react-to-lit.config.ts \
  --input vendor/my-components/src \
  --output src \
  --batch
```

### Dry run (print to stdout, no file writes)

```bash
npx react-to-lit \
  --config react-to-lit.config.ts \
  --input vendor/my-components/src/button \
  --dry-run
```

### Using a built-in preset instead of a config file

```bash
npx react-to-lit --preset cloudscape --input vendor/src --output src --batch
```

---

## Step 6 — Handle common issues

### Sub-components not resolving

If the emitted template contains `<undefined>` or `<unknown-component>`, the
component name wasn't found in the registry and `autoDerive` couldn't produce a
valid tag. Fix by adding an explicit entry to `components.registry`.

### Rest/spread props

React patterns like `{...rest}` on a host element are not directly expressible
in Lit templates. The compiler strips rest-spread by default. If specific props
from the spread are needed, extract them explicitly in the React source or add
them to `cleanup.skipProps` to suppress warnings.

### React Context

`useContext(...)` calls are flagged during compilation. React Context has no
direct Lit equivalent out of the box. Options:

- **Lit context** (`@lit/context`) — requires manual wiring of providers/consumers.
- **Unwrap the provider** — add the Context `.Provider` component to
  `cleanup.unwrapComponents` so the wrapper is stripped and children are preserved.
- **Replace with properties** — pass the context value as a regular `@property()`.

### CSS-in-JS / styled components

react-to-lit does not convert CSS-in-JS. Strip the styling infrastructure via
`cleanup.infraFunctions` (e.g., `makeStyles`, `withStyles`) and
`cleanup.skipProps` (e.g., `classes`, `sx`). Provide styles separately through
Lit's `static styles` or an external stylesheet.

### Conditional / dynamic imports

Dynamic `import()` and `React.lazy()` are not supported. Ensure all component
imports are static before running the compiler.

---

## Worked example: Material UI Button → Lit

Suppose you want to convert the Material UI `Button` component. Here is a
complete configuration and workflow.

### Config

```typescript
// react-to-lit.config.ts
import type { CompilerConfig } from '@cumulus-ui/react-to-lit';

const config: CompilerConfig = {
  input: {
    declarationsPackage: '@mui/material',
    skipDirectories: ['__tests__', 'utils', 'styles', 'node_modules'],
  },

  output: {
    baseClass: { name: 'LitElement', import: 'lit' },
    classPrefix: 'Mui',
    classSuffix: '',
    tagPrefix: 'el-',
    importExtension: '.js',
  },

  cleanup: {
    skipProps: ['classes', 'sx', 'component', 'TransitionComponent'],
    skipPrefixes: ['__', 'mui'],
    removeAttributes: ['key', 'ref', 'className'],
    removeAttributePrefixes: ['__', 'data-testid', 'aria-'],
    infraFunctions: ['useTheme', 'useThemeProps', 'styled', 'shouldForwardProp'],
    unwrapComponents: [
      'Fragment', 'React.Fragment', 'Suspense', 'StrictMode',
      'ThemeProvider', 'StyledEngineProvider',
    ],
  },

  components: {
    registry: {
      ButtonBase: 'el-button-base',
      TouchRipple: 'el-touch-ripple',
      Ripple: '__UNWRAP__',
    },
    autoDerive: true,
  },

  events: {
    dispatchFunctions: {},
    dispatchMode: 'native',
  },
};

export default config;
```

### Compile

```bash
# Single component
npx react-to-lit \
  --config react-to-lit.config.ts \
  --input vendor/mui-source/packages/mui-material/src/Button \
  --output src/button/internal.ts

# Verify output
cat src/button/internal.ts
```

### Expected output shape

```typescript
import { html, LitElement } from 'lit';
import { property } from 'lit/decorators.js';

export class MuiButton extends LitElement {
  @property({ type: String }) variant: 'text' | 'outlined' | 'contained' = 'text';
  @property({ type: String }) color: string = 'primary';
  @property({ type: String }) size: 'small' | 'medium' | 'large' = 'medium';
  @property({ type: Boolean }) disabled = false;

  override render() {
    return html`
      <el-button-base
        .disabled=${this.disabled}
        @click=${this._handleClick}
      >
        <slot></slot>
      </el-button-base>
    `;
  }
}
```

The consumer then registers the element:

```typescript
import { MuiButton } from './button/internal.js';
customElements.define('mui-button', MuiButton);
```

---

## Configuration reference

### `CompilerConfig` (top-level)

| Field | Type | Description |
|-------|------|-------------|
| `input` | `InputConfig` | How source files are located and read |
| `output` | `OutputConfig` | Shape of generated Lit output |
| `cleanup` | `CleanupConfig` | Rules for stripping React artefacts |
| `components` | `ComponentsConfig` | Component name → tag mapping |
| `events` | `EventsConfig` | Event dispatch configuration |

### `InputConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `declarationsPackage` | `string?` | `undefined` | Package name for published `.d.ts` files (e.g., `'@mui/material'`). Used to resolve prop types from the full inheritance chain. |
| `skipDirectories` | `string[]` | `[]` | Directory names to skip during batch processing. |

### `OutputConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseClass` | `{ name: string; import: string }` | `{ name: 'LitElement', import: 'lit' }` | Base class for generated components. Change this to extend a custom base class. |
| `classPrefix` | `string` | `''` | Prefix added to generated class names (e.g., `'Cs'` → `CsButton`). |
| `classSuffix` | `string` | `''` | Suffix added to generated class names (e.g., `'Internal'` → `ButtonInternal`). |
| `tagPrefix` | `string` | `'el-'` | Prefix for custom element tags in templates (e.g., `'el-'` → `<el-button>`). |
| `importExtension` | `string` | `'.js'` | File extension appended to relative imports in generated code. |

### `CleanupConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `skipProps` | `string[]` | `[]` | Prop names to remove entirely from generated components. |
| `skipPrefixes` | `string[]` | `['__']` | Prop name prefixes indicating internal infrastructure (auto-skipped). |
| `removeAttributes` | `string[]` | `['key', 'ref']` | Template attributes to strip from `html\`\`` output. |
| `removeAttributePrefixes` | `string[]` | `['__']` | Attribute prefixes to strip from template output. |
| `infraFunctions` | `string[]` | `[]` | Infrastructure function names whose call statements are deleted from the component body. |
| `unwrapComponents` | `string[]` | `['Fragment', 'React.Fragment', 'Suspense', 'StrictMode', 'Profiler']` | Components to unwrap — their children are kept but the wrapper tag is removed. |

### `ComponentsConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `registry` | `Record<string, string \| '__UNWRAP__'>` | `{}` | Map of React component names to custom element tags. Use `'__UNWRAP__'` to strip the component and keep its children. |
| `autoDerive` | `boolean` | `true` | When `true`, unknown component names are auto-converted from PascalCase to kebab-case with `tagPrefix`. |

### `EventsConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dispatchFunctions` | `Record<string, { import: string; cancelable: boolean }>` | `{}` | Map of dispatch helper function names to their import path and cancelability. |
| `dispatchMode` | `'helper' \| 'native'` | `'native'` | `'native'` emits `this.dispatchEvent(new CustomEvent(...))`. `'helper'` preserves calls to functions listed in `dispatchFunctions`. |

---

## Default values

When no config file or preset is specified, the compiler uses sensible defaults:

- React built-in wrappers (`Fragment`, `Suspense`, etc.) are unwrapped
- `__`-prefixed props and attributes are skipped
- `key` and `ref` are removed from templates
- Components auto-derive kebab-case tags with `el-` prefix
- Events use native `this.dispatchEvent`
- Base class is `LitElement` from `lit`

You only need a config file when your library has infrastructure beyond what
the defaults handle.
