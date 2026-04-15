import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { emitController, deriveControllerName } from '../../src/emitter/controllers.js';
import { emitUtility } from '../../src/emitter/utilities.js';
import type { HookAnalysis } from '../../src/shared-pattern-analyzer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHookAnalysis(overrides: Partial<HookAnalysis> = {}): HookAnalysis {
  return {
    path: 'internal/hooks/use-controllable/index.ts',
    litShape: 'controller',
    hasState: true,
    hasLifecycle: true,
    hasRef: false,
    reason: 'has state and lifecycle — maps to ReactiveController',
    ...overrides,
  };
}

const SAMPLE_HOOK_SOURCE = `
import * as React from 'react';

interface PropertyDescription {
  componentName: string;
  controlledProp: string;
  changeHandler: string;
}

export function useControllable<ValueType>(
  controlledValue: ValueType,
  handler: ((...args: any[]) => unknown) | undefined,
  defaultValue: ValueType,
  { componentName, changeHandler, controlledProp }: PropertyDescription
) {
  const isControlled = React.useState(controlledValue !== undefined)[0];

  React.useEffect(() => {
    if (isControlled && handler === undefined) {
      console.warn('missing handler');
    }
  }, [handler, isControlled]);

  const [valueState, setValue] = React.useState(defaultValue);
  const [valueHasBeenSet, setValueHasBeenSet] = React.useState(false);

  const currentUncontrolledValue = valueHasBeenSet ? valueState : defaultValue;

  const setUncontrolledValue = React.useCallback(
    (newValue: React.SetStateAction<ValueType>) => {
      setValue(newValue);
      setValueHasBeenSet(true);
    },
    [setValue, setValueHasBeenSet]
  );

  if (isControlled) {
    return [controlledValue, () => void 0] as const;
  } else {
    return [currentUncontrolledValue, setUncontrolledValue] as const;
  }
}
`;

const SAMPLE_UTILITY_SOURCE = `
import React from 'react';

export type NonCancelableEventHandler<Detail = {}> = (event: CustomEvent<Detail>) => void;
export type CancelableEventHandler<Detail = {}> = (event: CustomEvent<Detail>) => void;

export function fireCancelableEvent<T>(
  handler: CancelableEventHandler<T> | undefined,
  detail: T,
  sourceEvent?: React.SyntheticEvent | Event
) {
  if (!handler) return false;
  const event = new CustomEvent('cancel', { detail, cancelable: true });
  handler(event);
  return event.defaultPrevented;
}

export function hasModifierKeys(event: React.MouseEvent | React.KeyboardEvent) {
  return event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
}
`;

// ---------------------------------------------------------------------------
// deriveControllerName
// ---------------------------------------------------------------------------

describe('deriveControllerName', () => {
  it('converts use-controllable/index.ts to ControllableController', () => {
    expect(deriveControllerName('internal/hooks/use-controllable/index.ts'))
      .toBe('ControllableController');
  });

  it('converts use-focus-visible.ts to FocusVisibleController', () => {
    expect(deriveControllerName('hooks/use-focus-visible.ts'))
      .toBe('FocusVisibleController');
  });

  it('handles useSomething.ts (no hyphen)', () => {
    expect(deriveControllerName('hooks/useSomething.ts'))
      .toBe('SomethingController');
  });

  it('handles bare hook file in src/', () => {
    expect(deriveControllerName('src/useMyHook.ts'))
      .toBe('MyHookController');
  });
});

// ---------------------------------------------------------------------------
// emitController
// ---------------------------------------------------------------------------

describe('emitController', () => {
  let tmpDir: string;

  function writeFixture(filename: string, content: string): string {
    const filePath = path.join(tmpDir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrl-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces output implementing ReactiveController', () => {
    writeFixture('internal/hooks/use-controllable/index.ts', SAMPLE_HOOK_SOURCE);
    const analysis = makeHookAnalysis();
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).toContain('implements ReactiveController');
    expect(output).toContain('ReactiveControllerHost');
    expect(output).toContain('host.addController(this)');
  });

  it('generates class name from hook path', () => {
    writeFixture('internal/hooks/use-controllable/index.ts', SAMPLE_HOOK_SOURCE);
    const analysis = makeHookAnalysis();
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).toContain('export class ControllableController');
  });

  it('extracts type parameters from hook function', () => {
    writeFixture('internal/hooks/use-controllable/index.ts', SAMPLE_HOOK_SOURCE);
    const analysis = makeHookAnalysis();
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).toContain('ControllableController<ValueType>');
  });

  it('generates state properties from useState calls', () => {
    writeFixture('internal/hooks/use-controllable/index.ts', SAMPLE_HOOK_SOURCE);
    const analysis = makeHookAnalysis();
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).toContain('private valueState');
    expect(output).toContain('private valueHasBeenSet');
  });

  it('generates lifecycle methods when hook has effects', () => {
    writeFixture('internal/hooks/use-controllable/index.ts', SAMPLE_HOOK_SOURCE);
    const analysis = makeHookAnalysis();
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).toContain('hostConnected()');
    expect(output).toContain('hostUpdated()');
  });

  it('generates state setters that call requestUpdate', () => {
    writeFixture('internal/hooks/use-controllable/index.ts', SAMPLE_HOOK_SOURCE);
    const analysis = makeHookAnalysis();
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).toContain('this.host.requestUpdate()');
  });

  it('generates options interface from hook params', () => {
    writeFixture('internal/hooks/use-controllable/index.ts', SAMPLE_HOOK_SOURCE);
    const analysis = makeHookAnalysis();
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).toContain('ControllableControllerOptions');
    expect(output).toContain('controlledValue');
  });

  it('preserves local interfaces from hook source', () => {
    writeFixture('internal/hooks/use-controllable/index.ts', SAMPLE_HOOK_SOURCE);
    const analysis = makeHookAnalysis();
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).toContain('interface PropertyDescription');
    expect(output).toContain('componentName: string');
  });

  it('does not contain React imports', () => {
    writeFixture('internal/hooks/use-controllable/index.ts', SAMPLE_HOOK_SOURCE);
    const analysis = makeHookAnalysis();
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).not.toContain("from 'react'");
    expect(output).not.toContain('import * as React');
  });

  it('emits minimal scaffold when source is unreadable', () => {
    const analysis = makeHookAnalysis({ path: 'nonexistent/hook.ts' });
    const output = emitController(analysis, 'nonexistent/hook.ts', tmpDir);

    expect(output).toContain('implements ReactiveController');
    expect(output).toContain('host.addController(this)');
  });

  it('includes hostDisconnected when effects have cleanup', () => {
    const hookWithCleanup = `
import * as React from 'react';
export function useTimer() {
  React.useEffect(() => {
    const id = setInterval(() => {}, 1000);
    return () => clearInterval(id);
  }, []);
}
`;
    writeFixture('hooks/use-timer.ts', hookWithCleanup);
    const analysis = makeHookAnalysis({
      path: 'hooks/use-timer.ts',
      hasState: false,
    });
    const output = emitController(analysis, analysis.path, tmpDir);

    expect(output).toContain('hostDisconnected()');
  });
});

// ---------------------------------------------------------------------------
// emitUtility
// ---------------------------------------------------------------------------

describe('emitUtility', () => {
  let tmpDir: string;

  function writeFixture(filename: string, content: string): string {
    const filePath = path.join(tmpDir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'util-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('strips React imports', () => {
    writeFixture('internal/events/index.ts', SAMPLE_UTILITY_SOURCE);
    const output = emitUtility('internal/events/index.ts', tmpDir);

    expect(output).not.toContain("import React from 'react'");
    expect(output).not.toContain("from 'react'");
  });

  it('replaces React.SyntheticEvent with Event', () => {
    writeFixture('internal/events/index.ts', SAMPLE_UTILITY_SOURCE);
    const output = emitUtility('internal/events/index.ts', tmpDir);

    expect(output).not.toContain('React.SyntheticEvent');
    expect(output).toContain('sourceEvent?: Event | Event');
  });

  it('replaces React.MouseEvent with MouseEvent', () => {
    writeFixture('internal/events/index.ts', SAMPLE_UTILITY_SOURCE);
    const output = emitUtility('internal/events/index.ts', tmpDir);

    expect(output).not.toContain('React.MouseEvent');
    expect(output).toContain('event: MouseEvent | KeyboardEvent');
  });

  it('preserves non-React exports', () => {
    writeFixture('internal/events/index.ts', SAMPLE_UTILITY_SOURCE);
    const output = emitUtility('internal/events/index.ts', tmpDir);

    expect(output).toContain('export type NonCancelableEventHandler');
    expect(output).toContain('export function fireCancelableEvent');
    expect(output).toContain('export function hasModifierKeys');
  });

  it('preserves CustomEvent usage (already web-standard)', () => {
    writeFixture('internal/events/index.ts', SAMPLE_UTILITY_SOURCE);
    const output = emitUtility('internal/events/index.ts', tmpDir);

    expect(output).toContain('new CustomEvent');
  });

  it('returns fallback for unreadable files', () => {
    const output = emitUtility('nonexistent/module.ts', tmpDir);

    expect(output).toContain('Could not read source');
    expect(output).toContain('export {}');
  });

  it('handles import * as React from react', () => {
    const source = `import * as React from 'react';\n\nexport const x = 1;\n`;
    writeFixture('util.ts', source);
    const output = emitUtility('util.ts', tmpDir);

    expect(output).not.toContain("from 'react'");
    expect(output).toContain('export const x = 1');
  });

  it('handles type-only React imports', () => {
    const source = `import type { FC } from 'react';\n\nexport const x = 1;\n`;
    writeFixture('util.ts', source);
    const output = emitUtility('util.ts', tmpDir);

    expect(output).not.toContain("from 'react'");
    expect(output).toContain('export const x = 1');
  });
});
