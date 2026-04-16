import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  emitUtilities,
  emitToolkitShim,
  extractRelativeImports,
  hasJSX,
  transformUtility,
  resolveToSource,
} from '../src/emit-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let sourceRoot: string;
let outputRoot: string;

function setupDirs() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-util-test-'));
  sourceRoot = path.join(tmpDir, 'source');
  outputRoot = path.join(tmpDir, 'output');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
}

function cleanupDirs() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// extractRelativeImports
// ---------------------------------------------------------------------------

describe('extractRelativeImports', () => {
  it('extracts relative imports from file content', () => {
    const content = `
import { foo } from './foo.js';
import { bar } from '../internal/bar.js';
import { LitElement } from 'lit';
import type { Baz } from './baz.js';
`;
    const imports = extractRelativeImports(content);
    expect(imports).toContain('./foo.js');
    expect(imports).toContain('../internal/bar.js');
    expect(imports).toContain('./baz.js');
    expect(imports).not.toContain('lit');
  });

  it('deduplicates imports', () => {
    const content = `
import { a } from './shared.js';
import { b } from './shared.js';
`;
    const imports = extractRelativeImports(content);
    expect(imports.filter((i: string) => i === './shared.js')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// hasJSX
// ---------------------------------------------------------------------------

describe('hasJSX', () => {
  it('detects JSX component elements in .tsx files', () => {
    const content = `
export default function MyComponent() {
  return <Button variant="primary">Click</Button>;
}`;
    expect(hasJSX(content, 'comp.tsx')).toBe(true);
  });

  it('detects HTML elements returned in .tsx files', () => {
    const content = `
export default function MyComponent() {
  return (
    <div className="wrapper">hello</div>
  );
}`;
    expect(hasJSX(content, 'comp.tsx')).toBe(true);
  });

  it('detects React.createElement', () => {
    const content = `
export default function MyComponent() {
  return React.createElement('div', null, 'hello');
}`;
    expect(hasJSX(content, 'comp.ts')).toBe(true);
  });

  it('returns false for pure utility .ts files', () => {
    const content = `
export enum KeyCode {
  enter = 13,
  space = 32,
}
export const KEY_MAP = { enter: 13 };
`;
    expect(hasJSX(content, 'keycode.ts')).toBe(false);
  });

  it('returns false for .tsx files without JSX', () => {
    const content = `
export type ButtonProps = { label: string };
export function createConfig() { return {}; }
`;
    expect(hasJSX(content, 'utils.tsx')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveToSource
// ---------------------------------------------------------------------------

describe('resolveToSource', () => {
  beforeEach(() => setupDirs());
  afterEach(() => cleanupDirs());

  it('resolves .js target to .ts source file', () => {
    fs.mkdirSync(path.join(sourceRoot, 'internal'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'internal', 'keycode.ts'), 'export enum KeyCode {}');

    const absTarget = path.join(outputRoot, 'internal', 'keycode.js');
    const result = resolveToSource(absTarget, outputRoot, sourceRoot);
    expect(result).toBe(path.join(sourceRoot, 'internal', 'keycode.ts'));
  });

  it('resolves to index.ts for directory imports', () => {

    fs.mkdirSync(path.join(sourceRoot, 'internal', 'events'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'internal', 'events', 'index.ts'), 'export function fire() {}');

    const absTarget = path.join(outputRoot, 'internal', 'events.js');
    const result = resolveToSource(absTarget, outputRoot, sourceRoot);
    expect(result).toBe(path.join(sourceRoot, 'internal', 'events', 'index.ts'));
  });

  it('returns null when source not found', () => {

    const absTarget = path.join(outputRoot, 'internal', 'nonexistent.js');
    const result = resolveToSource(absTarget, outputRoot, sourceRoot);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transformUtility
// ---------------------------------------------------------------------------

describe('transformUtility', () => {
  beforeEach(() => setupDirs());
  afterEach(() => cleanupDirs());

  it('strips React imports', () => {

    const source = `import React from 'react';
import { useState } from 'react';

export function helper() { return 42; }
`;
    const result = transformUtility(
      source,
      path.join(sourceRoot, 'internal', 'helper.ts'),
      path.join(outputRoot, 'internal', 'helper.ts'),
      sourceRoot,
      outputRoot,
    );
    expect(result).not.toContain("from 'react'");
    expect(result).toContain('export function helper');
  });

  it('strips clsx imports', () => {

    const source = `import clsx from 'clsx';
export function combine() { return 'a'; }
`;
    const result = transformUtility(
      source,
      path.join(sourceRoot, 'internal', 'cls.ts'),
      path.join(outputRoot, 'internal', 'cls.ts'),
      sourceRoot,
      outputRoot,
    );
    expect(result).not.toContain("from 'clsx'");
  });

  it('strips CSS imports', () => {

    const source = `import styles from './styles.css.js';
export const x = 1;
`;
    const result = transformUtility(
      source,
      path.join(sourceRoot, 'internal', 'foo.ts'),
      path.join(outputRoot, 'internal', 'foo.ts'),
      sourceRoot,
      outputRoot,
    );
    expect(result).not.toContain('.css.js');
  });

  it('rewrites @cloudscape-design/component-toolkit imports to shim path', () => {

    const source = `import { warnOnce } from '@cloudscape-design/component-toolkit/internal';
export function warn() { warnOnce('x', 'y'); }
`;
    const result = transformUtility(
      source,
      path.join(sourceRoot, 'internal', 'warn.ts'),
      path.join(outputRoot, 'internal', 'warn.ts'),
      sourceRoot,
      outputRoot,
    );
    expect(result).not.toContain('@cloudscape-design/component-toolkit');
    expect(result).toContain('toolkit-shims.js');
  });

  it('replaces React.SyntheticEvent with Event', () => {

    const source = `export function handle(e: React.SyntheticEvent<HTMLElement>) {}`;
    const result = transformUtility(
      source,
      path.join(sourceRoot, 'internal', 'handler.ts'),
      path.join(outputRoot, 'internal', 'handler.ts'),
      sourceRoot,
      outputRoot,
    );
    expect(result).not.toContain('React.SyntheticEvent');
    expect(result).toContain('Event');
  });

  it('adds .js extension to relative imports', () => {

    fs.mkdirSync(path.join(sourceRoot, 'internal'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'internal', 'keycode.ts'), 'export enum K {}');

    const source = `import { KeyCode } from './keycode';
export const x = KeyCode;
`;
    const result = transformUtility(
      source,
      path.join(sourceRoot, 'internal', 'events.ts'),
      path.join(outputRoot, 'internal', 'events.ts'),
      sourceRoot,
      outputRoot,
    );
    expect(result).toContain("from './keycode.js'");
  });

  it('strips use client directive', () => {

    const source = `'use client';
export const x = 1;
`;
    const result = transformUtility(
      source,
      path.join(sourceRoot, 'internal', 'uc.ts'),
      path.join(outputRoot, 'internal', 'uc.ts'),
      sourceRoot,
      outputRoot,
    );
    expect(result).not.toContain('use client');
  });
});

// ---------------------------------------------------------------------------
// emitUtilities (integration with temp directory)
// ---------------------------------------------------------------------------

describe('emitUtilities', () => {
  beforeEach(() => setupDirs());
  afterEach(() => cleanupDirs());

  it('discovers and emits utility files from component imports', () => {


    // Create a source utility file
    fs.mkdirSync(path.join(sourceRoot, 'internal'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'internal', 'keycode.ts'),
      `export enum KeyCode { enter = 13, space = 32 }\n`,
    );

    // Create a generated component file that imports the utility
    fs.mkdirSync(path.join(outputRoot, 'badge'), { recursive: true });
    fs.writeFileSync(
      path.join(outputRoot, 'badge', 'index.ts'),
      `import { KeyCode } from '../internal/keycode.js';\nexport class Badge {}\n`,
    );

    const result = emitUtilities({ sourceRoot, outputRoot });

    expect(result.emitted).toBe(1);
    expect(result.emittedFiles).toContain(path.join('internal', 'keycode.ts'));

    const emittedContent = fs.readFileSync(
      path.join(outputRoot, 'internal', 'keycode.ts'),
      'utf-8',
    );
    expect(emittedContent).toContain('export enum KeyCode');
  });

  it('transforms React imports in emitted utilities', () => {


    fs.mkdirSync(path.join(sourceRoot, 'internal'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'internal', 'events.ts'),
      `import React from 'react';
export function fire(handler: React.MouseEvent) { handler; }
`,
    );

    fs.mkdirSync(path.join(outputRoot, 'button'), { recursive: true });
    fs.writeFileSync(
      path.join(outputRoot, 'button', 'index.ts'),
      `import { fire } from '../internal/events.js';\nexport class Button {}\n`,
    );

    emitUtilities({ sourceRoot, outputRoot });

    const emittedContent = fs.readFileSync(
      path.join(outputRoot, 'internal', 'events.ts'),
      'utf-8',
    );
    expect(emittedContent).not.toContain("from 'react'");
    expect(emittedContent).not.toContain('React.MouseEvent');
    expect(emittedContent).toContain('MouseEvent');
  });

  it('skips JSX component files', () => {


    fs.mkdirSync(path.join(sourceRoot, 'internal'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'internal', 'icon.tsx'),
      `import React from 'react';
export default function Icon() { return <svg><path d="M0 0"/></svg>; }
`,
    );

    fs.mkdirSync(path.join(outputRoot, 'alert'), { recursive: true });
    fs.writeFileSync(
      path.join(outputRoot, 'alert', 'index.ts'),
      `import Icon from '../internal/icon.js';\nexport class Alert {}\n`,
    );

    const result = emitUtilities({ sourceRoot, outputRoot });

    expect(result.emitted).toBe(0);
    expect(result.skippedFiles.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(outputRoot, 'internal', 'icon.ts'))).toBe(false);
  });

  it('recurses into emitted utility imports up to maxDepth', () => {


    // Depth 0: component imports utility_a
    // Depth 1: utility_a imports utility_b
    // Depth 2: utility_b imports utility_c (should be emitted, depth=2)
    // Depth 3: would stop
    fs.mkdirSync(path.join(sourceRoot, 'internal'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'internal', 'a.ts'),
      `import { b } from './b.js';\nexport const a = b;\n`,
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'internal', 'b.ts'),
      `import { c } from './c.js';\nexport const b = c;\n`,
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'internal', 'c.ts'),
      `export const c = 42;\n`,
    );

    fs.mkdirSync(path.join(outputRoot, 'comp'), { recursive: true });
    fs.writeFileSync(
      path.join(outputRoot, 'comp', 'index.ts'),
      `import { a } from '../internal/a.js';\nexport class Comp {}\n`,
    );

    const result = emitUtilities({ sourceRoot, outputRoot, maxDepth: 2 });

    // All three should be emitted: a (depth 1), b (depth 2 from a), c (depth 2 from a→b is depth 2)
    expect(result.emittedFiles).toContain(path.join('internal', 'a.ts'));
    expect(result.emittedFiles).toContain(path.join('internal', 'b.ts'));
    expect(result.emittedFiles).toContain(path.join('internal', 'c.ts'));
  });

  it('stops recursion beyond maxDepth', () => {


    fs.mkdirSync(path.join(sourceRoot, 'internal'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'internal', 'a.ts'), `import { b } from './b.js';\nexport const a = b;\n`);
    fs.writeFileSync(path.join(sourceRoot, 'internal', 'b.ts'), `import { c } from './c.js';\nexport const b = c;\n`);
    fs.writeFileSync(path.join(sourceRoot, 'internal', 'c.ts'), `import { d } from './d.js';\nexport const c = d;\n`);
    fs.writeFileSync(path.join(sourceRoot, 'internal', 'd.ts'), `export const d = 99;\n`);

    fs.mkdirSync(path.join(outputRoot, 'comp'), { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'comp', 'index.ts'), `import { a } from '../internal/a.js';\nexport class Comp {}\n`);

    const result = emitUtilities({ sourceRoot, outputRoot, maxDepth: 1 });

    expect(result.emittedFiles).toContain(path.join('internal', 'a.ts'));
    expect(result.emittedFiles).toContain(path.join('internal', 'b.ts'));
    // c is at depth 2 from a→b→c, but maxDepth=1 so b's imports are not followed
    expect(result.emittedFiles).not.toContain(path.join('internal', 'c.ts'));
  });

  it('does not emit duplicate files', () => {


    fs.mkdirSync(path.join(sourceRoot, 'internal'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'internal', 'shared.ts'), `export const x = 1;\n`);

    // Two components both import the same utility
    for (const name of ['badge', 'button']) {
      fs.mkdirSync(path.join(outputRoot, name), { recursive: true });
      fs.writeFileSync(
        path.join(outputRoot, name, 'index.ts'),
        `import { x } from '../internal/shared.js';\nexport class ${name} {}\n`,
      );
    }

    const result = emitUtilities({ sourceRoot, outputRoot });
    expect(result.emitted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// emitToolkitShim
// ---------------------------------------------------------------------------

describe('emitToolkitShim', () => {
  beforeEach(() => setupDirs());
  afterEach(() => cleanupDirs());

  it('emits placeholder shim when no source exists', () => {
    emitToolkitShim(outputRoot);

    const shimPath = path.join(outputRoot, 'internal', 'toolkit-shims.ts');
    expect(fs.existsSync(shimPath)).toBe(true);

    const content = fs.readFileSync(shimPath, 'utf-8');
    expect(content).toContain('warnOnce');
    expect(content).toContain('useUniqueId');
  });

  it('copies real shim when source exists', () => {

    const shimSource = path.join(sourceRoot, 'shim.ts');
    fs.writeFileSync(shimSource, 'export const REAL_SHIM = true;\n');

    emitToolkitShim(outputRoot, shimSource);

    const shimPath = path.join(outputRoot, 'internal', 'toolkit-shims.ts');
    const content = fs.readFileSync(shimPath, 'utf-8');
    expect(content).toContain('REAL_SHIM');
  });
});
