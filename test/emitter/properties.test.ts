/**
 * Unit tests for emitter/properties.ts — property and state emission.
 */
import { describe, it, expect } from 'vitest';
import { emitState, emitProperties } from '../../src/emitter/properties.js';
import type { StateIR, PropIR } from '../../src/ir/types.js';

describe('emitState', () => {
  it('emits inline initializer when no this. reference', () => {
    const state: StateIR[] = [
      { name: 'count', setter: 'setCount', initialValue: '0', type: 'number' },
    ];
    const { code, deferred } = emitState(state);
    expect(code).toContain('private _count: number = 0;');
    expect(deferred).toHaveLength(0);
  });

  it('defers initialization when initialValue references this.', () => {
    const state: StateIR[] = [
      { name: 'isPersistentlyDismissed', setter: 'setIsPersistentlyDismissed',
        initialValue: '!!(this.persistenceConfig && this.persistenceConfig.uniqueKey)',
        type: 'boolean' },
    ];
    const { code, deferred } = emitState(state);
    // Should NOT have the this. reference in the field declaration
    expect(code).toContain('private _isPersistentlyDismissed: boolean = false;');
    // Should have deferred assignment
    expect(deferred).toHaveLength(1);
    expect(deferred[0].assignment).toContain('this._isPersistentlyDismissed = !!(this.persistenceConfig');
  });

  it('uses correct default for array types', () => {
    const state: StateIR[] = [
      { name: 'items', setter: 'setItems', initialValue: 'this.defaultItems', type: 'string[]' },
    ];
    const { code, deferred } = emitState(state);
    expect(code).toContain('= [];');
    expect(deferred).toHaveLength(1);
  });
});

describe('emitProperties', () => {
  it('emits inline default when no this. reference', () => {
    const props: PropIR[] = [
      { name: 'variant', type: 'string', category: 'attribute', default: "'default'" },
    ];
    const { code, deferred } = emitProperties(props);
    expect(code).toContain("= 'default'");
    expect(deferred).toHaveLength(0);
  });

  it('defers default when it references this.', () => {
    const props: PropIR[] = [
      { name: 'expandToViewport', type: 'boolean', category: 'attribute', default: 'false' },
      { name: 'loopFocus', type: 'boolean', category: 'attribute', default: 'this.expandToViewport' },
    ];
    const { code, deferred } = emitProperties(props);
    // loopFocus should NOT have inline default
    expect(code).not.toContain('loopFocus = this.expandToViewport');
    // Should have deferred using ??= to avoid overwriting explicit values
    expect(deferred).toHaveLength(1);
    expect(deferred[0].assignment).toContain('this.loopFocus ??= this.expandToViewport');
  });

  it('emits no deferred for event and slot props', () => {
    const props: PropIR[] = [
      { name: 'onChange', type: '() => void', category: 'event' },
      { name: 'children', type: 'any', category: 'slot' },
    ];
    const { code, deferred } = emitProperties(props);
    expect(deferred).toHaveLength(0);
  });

  it('emits @deprecated JSDoc before a deprecated attribute prop', () => {
    const props: PropIR[] = [
      { name: 'className', type: 'string', category: 'attribute', deprecated: true },
    ];
    const { code } = emitProperties(props);
    const lines = code.split('\n');
    const deprecatedIdx = lines.findIndex(l => l.includes('/** @deprecated */'));
    const propertyIdx = lines.findIndex(l => l.includes('@property('));
    expect(deprecatedIdx).toBeGreaterThanOrEqual(0);
    expect(propertyIdx).toBeGreaterThan(deprecatedIdx);
  });

  it('emits @deprecated JSDoc before a deprecated event callback', () => {
    const props: PropIR[] = [
      { name: 'onClick', type: '() => void', category: 'event', deprecated: true },
    ];
    const { code } = emitProperties(props);
    const lines = code.split('\n');
    const deprecatedIdx = lines.findIndex(l => l.includes('/** @deprecated */'));
    const callbackIdx = lines.findIndex(l => l.includes('onClick?'));
    expect(deprecatedIdx).toBeGreaterThanOrEqual(0);
    expect(callbackIdx).toBeGreaterThan(deprecatedIdx);
  });

  it('emits @deprecated JSDoc before a deprecated slot getter', () => {
    const props: PropIR[] = [
      { name: 'children', type: 'any', category: 'slot', deprecated: true },
    ];
    const { code } = emitProperties(props);
    const lines = code.split('\n');
    const deprecatedIdx = lines.findIndex(l => l.includes('/** @deprecated */'));
    const getterIdx = lines.findIndex(l => l.includes('_hasChildren'));
    expect(deprecatedIdx).toBeGreaterThanOrEqual(0);
    expect(getterIdx).toBeGreaterThan(deprecatedIdx);
  });

  it('does not emit @deprecated for non-deprecated props', () => {
    const props: PropIR[] = [
      { name: 'variant', type: 'string', category: 'attribute' },
      { name: 'onChange', type: '() => void', category: 'event' },
      { name: 'children', type: 'any', category: 'slot' },
    ];
    const { code } = emitProperties(props);
    expect(code).not.toContain('/** @deprecated */');
  });
});
