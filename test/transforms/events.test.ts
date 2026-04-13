import { describe, it, expect } from 'vitest';
import { transformEvents } from '../../src/transforms/events.js';
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
    forwardRef: false,
    fileConstants: [],
    fileTypeDeclarations: [],
    ...overrides,
  };
}

describe('transformEvents', () => {
  describe('nested property access in fire*Event calls', () => {
    it('rewrites fireCancelableEvent(obj.onXxx, ...) to dispatch on this', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'onClick',
          params: 'event: MouseEvent',
          body: 'fireCancelableEvent(identity.onFollow, {}, event);',
        }],
      });
      const result = transformEvents(ir);
      expect(result.handlers[0].body).toBe(
        "fireCancelableEvent(this, 'follow', {}, event);",
      );
    });

    it('rewrites fireNonCancelableEvent(obj.onXxx, ...)', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'handleChange',
          params: '',
          body: 'fireNonCancelableEvent(config.onChange, { value });',
        }],
      });
      const result = transformEvents(ir);
      expect(result.handlers[0].body).toBe(
        "fireNonCancelableEvent(this, 'change', { value });",
      );
    });

    it('rewrites fireKeyboardEvent(obj.onXxx, ...) to fireNonCancelableEvent', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'handleKey',
          params: 'e: KeyboardEvent',
          body: 'fireKeyboardEvent(config.onKeyDown, e);',
        }],
      });
      const result = transformEvents(ir);
      expect(result.handlers[0].body).toBe(
        "fireNonCancelableEvent(this, 'keyDown', e);",
      );
    });

    it('handles deeply nested property access', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          params: '',
          body: 'fireCancelableEvent(a.b.onNavigate, detail, event);',
        }],
      });
      const result = transformEvents(ir);
      expect(result.handlers[0].body).toBe(
        "fireCancelableEvent(this, 'navigate', detail, event);",
      );
    });
  });

  describe('does not false-positive on already-rewritten calls', () => {
    it('leaves fire*Event(this, ...) untouched', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          params: '',
          body: "fireCancelableEvent(this, 'follow', {}, event);",
        }],
      });
      const result = transformEvents(ir);
      expect(result.handlers[0].body).toBe(
        "fireCancelableEvent(this, 'follow', {}, event);",
      );
    });
  });

  describe('per-prop matching still works alongside catch-all', () => {
    it('rewrites bare prop name and nested access in the same component', () => {
      const ir = minimalIR({
        props: [{ name: 'onChange', type: '(detail: any) => void', category: 'event' }],
        handlers: [
          {
            name: 'handleChange',
            params: '',
            body: 'fireNonCancelableEvent(onChange, { value });',
          },
          {
            name: 'handleFollow',
            params: 'event: MouseEvent',
            body: 'fireCancelableEvent(identity.onFollow, {}, event);',
          },
        ],
      });
      const result = transformEvents(ir);
      expect(result.handlers[0].body).toBe(
        "fireNonCancelableEvent(this, 'change', { value });",
      );
      expect(result.handlers[1].body).toBe(
        "fireCancelableEvent(this, 'follow', {}, event);",
      );
    });
  });
});
