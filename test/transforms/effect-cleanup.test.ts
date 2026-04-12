/**
 * Unit tests for transforms/effect-cleanup.ts
 */
import { describe, it, expect } from 'vitest';
import { promoteEffectCleanupVars } from '../../src/transforms/effect-cleanup.js';
import type { ComponentIR } from '../../src/ir/types.js';

function minimalIR(overrides: Partial<ComponentIR> = {}): ComponentIR {
  return {
    name: 'Test',
    tagName: 'el-test',
    sourceFiles: [],
    mixins: [],
    props: [],
    state: [],
    effects: [],
    refs: [],
    handlers: [],
    template: { kind: 'fragment', attributes: [], children: [] },
    computedValues: [],
    controllers: [],
    contexts: [],
    imports: [],
    publicMethods: [],
    helpers: [],
    bodyPreamble: [],
    localVariables: new Set(),
    skippedHookVars: [],
    fileConstants: [],
    fileTypeDeclarations: [],
    forwardRef: false,
    ...overrides,
  };
}

describe('promoteEffectCleanupVars', () => {
  it('promotes const declared in effect body that is referenced in cleanup', () => {
    const ir = minimalIR({
      effects: [{
        body: '{ const clickListener = () => {}; window.addEventListener("click", clickListener); }',
        deps: ['open'],
        cleanup: 'window.removeEventListener("click", clickListener);',
      }],
      localVariables: new Set(['clickListener']),
    });
    const result = promoteEffectCleanupVars(ir);
    expect(result.skippedHookVars).toContain('clickListener');
    expect(result.effects[0].body).toContain('this._clickListener =');
    expect(result.effects[0].body).not.toMatch(/\bconst\s+clickListener\b/);
    expect(result.localVariables.has('clickListener')).toBe(false);
  });

  it('promotes multiple variables from the same effect', () => {
    const ir = minimalIR({
      effects: [{
        body: '{ const controller = new AbortController(); const signal = controller.signal; }',
        deps: 'empty',
        cleanup: 'controller.abort();',
      }],
      localVariables: new Set(['controller', 'signal']),
    });
    const result = promoteEffectCleanupVars(ir);
    expect(result.skippedHookVars).toContain('controller');
    // signal is not referenced in cleanup, should not be promoted
    expect(result.skippedHookVars).not.toContain('signal');
  });

  it('does not modify effects without cleanup', () => {
    const ir = minimalIR({
      effects: [{
        body: '{ const x = 1; doStuff(x); }',
        deps: 'empty',
      }],
    });
    const result = promoteEffectCleanupVars(ir);
    expect(result.effects[0].body).toBe('{ const x = 1; doStuff(x); }');
    expect(result.skippedHookVars).toHaveLength(0);
  });

  it('does not promote variables not referenced in cleanup', () => {
    const ir = minimalIR({
      effects: [{
        body: '{ const local = 1; const shared = 2; }',
        deps: ['dep'],
        cleanup: 'unregister(shared);',
      }],
      localVariables: new Set(['local', 'shared']),
    });
    const result = promoteEffectCleanupVars(ir);
    expect(result.skippedHookVars).toContain('shared');
    expect(result.skippedHookVars).not.toContain('local');
    expect(result.effects[0].body).toContain('const local = 1');
    expect(result.effects[0].body).toContain('this._shared = 2');
  });

  it('preserves existing skippedHookVars', () => {
    const ir = minimalIR({
      skippedHookVars: ['existing'],
      effects: [{
        body: '{ const listener = () => {}; }',
        deps: 'empty',
        cleanup: 'remove(listener);',
      }],
    });
    const result = promoteEffectCleanupVars(ir);
    expect(result.skippedHookVars).toContain('existing');
    expect(result.skippedHookVars).toContain('listener');
  });
});
