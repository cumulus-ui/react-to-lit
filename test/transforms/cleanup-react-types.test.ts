/**
 * Unit tests for transforms/cleanup-react-types.ts
 */
import { describe, it, expect } from 'vitest';
import { cleanupReactTypes } from '../../src/transforms/cleanup-react-types.js';
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

describe('cleanupReactTypes', () => {
  describe('setTimeout/setInterval → window. prefix', () => {
    it('rewrites setTimeout to window.setTimeout in handler body', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const id = setTimeout(() => {}, 100);', params: '' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).toContain('window.setTimeout');
      expect(result.handlers[0].body).not.toMatch(/(?<!window\.)setTimeout/);
    });

    it('rewrites clearTimeout to window.clearTimeout', () => {
      const ir = minimalIR({
        effects: [{ body: 'clearTimeout(this._timer);', deps: 'empty' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.effects[0].body).toContain('window.clearTimeout');
    });

    it('rewrites setInterval to window.setInterval', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const id = setInterval(tick, 1000);', params: '' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).toContain('window.setInterval');
    });

    it('rewrites clearInterval to window.clearInterval', () => {
      const ir = minimalIR({
        effects: [{ body: 'clearInterval(this._id);', deps: 'empty', cleanup: 'clearInterval(this._id);' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.effects[0].body).toContain('window.clearInterval');
      expect(result.effects[0].cleanup).toContain('window.clearInterval');
    });

    it('does not double-prefix window.setTimeout', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const id = window.setTimeout(() => {}, 100);', params: '' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).toContain('window.setTimeout');
      expect(result.handlers[0].body).not.toContain('window.window.setTimeout');
    });

    it('does not rewrite setTimeout when preceded by dot (method call)', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'obj.setTimeout(100);', params: '' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).toBe('obj.setTimeout(100);');
    });
  });

  describe('event.relatedTarget → cast to Element', () => {
    it('casts relatedTarget when used as function argument', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'if (!event.relatedTarget || isOutside(event.relatedTarget)) {}', params: 'event: FocusEvent' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).toContain('event.relatedTarget as Element)');
      // The negation check should NOT be cast
      expect(result.handlers[0].body).toContain('!event.relatedTarget');
    });

    it('does not cast relatedTarget in assignments', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const el = event.relatedTarget;', params: 'event: FocusEvent' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).not.toContain('as Element');
    });
  });

  describe('event.target property access → cast to HTMLInputElement', () => {
    it('casts event.target.value', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const v = event.target.value;', params: 'event: Event' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).toContain('(event.target as HTMLInputElement).value');
    });

    it('casts event.target.files', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const f = event.target.files;', params: 'event: Event' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).toContain('(event.target as HTMLInputElement).files');
    });

    it('casts destructured target.files', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const files = target.files ? Array.from(target.files) : [];', params: '{ target }: Event' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).toContain('(target as HTMLInputElement).files');
    });

    it('casts event.currentTarget.form', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'if (event.currentTarget.form) {}', params: 'event: KeyboardEvent' }],
      });
      const result = cleanupReactTypes(ir);
      expect(result.handlers[0].body).toContain('(event.currentTarget as HTMLInputElement).form');
    });
  });
});
