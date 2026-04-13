/**
 * Unit tests for transforms/events.ts — event dispatch config overrides.
 */
import { describe, it, expect } from 'vitest';
import { transformEvents } from '../../src/transforms/events.js';
import type { ComponentIR } from '../../src/ir/types.js';
import type { EventsConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// No-config (backward compatibility)
// ---------------------------------------------------------------------------

describe('transformEvents (no config)', () => {
  it('rewrites fireNonCancelableEvent(propName, detail) to fireNonCancelableEvent(this, eventName, detail)', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'handleChange',
        body: "fireNonCancelableEvent(onChange, { value: 'x' })",
        params: '',
      }],
    });
    const result = transformEvents(ir);
    expect(result.handlers[0].body).toBe("fireNonCancelableEvent(this, 'change', { value: 'x' })");
  });

  it('rewrites fireCancelableEvent(propName, detail, event)', () => {
    const ir = minimalIR({
      props: [{ name: 'onFollow', type: 'Function', category: 'event', eventCancelable: true }],
      handlers: [{
        name: 'handleFollow',
        body: 'fireCancelableEvent(onFollow, { href }, event)',
        params: '',
      }],
    });
    const result = transformEvents(ir);
    expect(result.handlers[0].body).toBe("fireCancelableEvent(this, 'follow', { href }, event)");
  });

  it('rewrites fireKeyboardEvent to fireNonCancelableEvent', () => {
    const ir = minimalIR({
      props: [{ name: 'onKeyDown', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'handleKey',
        body: 'fireKeyboardEvent(onKeyDown, event)',
        params: '',
      }],
    });
    const result = transformEvents(ir);
    expect(result.handlers[0].body).toBe("fireNonCancelableEvent(this, 'keyDown', event)");
  });

  it('rewrites direct optional callback propName?.(detail)', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: 'onChange?.({ checked: true })',
        params: '',
      }],
    });
    const result = transformEvents(ir);
    expect(result.handlers[0].body).toBe("fireNonCancelableEvent(this, 'change', { checked: true })");
  });

  it('adds import for ../internal/events.js when needed', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: "fireNonCancelableEvent(onChange, { value: 1 })",
        params: '',
      }],
    });
    const result = transformEvents(ir);
    const evtImport = result.imports.find(i => i.moduleSpecifier === '../internal/events.js');
    expect(evtImport).toBeDefined();
    expect(evtImport!.namedImports).toContain('fireNonCancelableEvent');
  });

  it('returns IR unchanged when no event props exist', () => {
    const ir = minimalIR({
      props: [{ name: 'label', type: 'string', category: 'attribute' }],
    });
    const result = transformEvents(ir);
    expect(result.handlers).toEqual(ir.handlers);
    expect(result.template).toEqual(ir.template);
  });
});

// ---------------------------------------------------------------------------
// Config override — custom dispatch function names
// ---------------------------------------------------------------------------

describe('config override', () => {
  const customConfig: EventsConfig = {
    dispatchFunctions: {
      emitEvent: { import: './my-events.js', cancelable: false },
      emitCancelable: { import: './my-events.js', cancelable: true },
    },
    dispatchMode: 'helper',
  };

  it('custom dispatch function names produce correct output', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: "emitEvent(onChange, { value: 1 })",
        params: '',
      }],
    });
    const result = transformEvents(ir, customConfig);
    expect(result.handlers[0].body).toBe("emitEvent(this, 'change', { value: 1 })");
  });

  it('custom cancelable dispatch preserves function name', () => {
    const ir = minimalIR({
      props: [{ name: 'onFollow', type: 'Function', category: 'event', eventCancelable: true }],
      handlers: [{
        name: 'h',
        body: 'emitCancelable(onFollow, { href }, event)',
        params: '',
      }],
    });
    const result = transformEvents(ir, customConfig);
    expect(result.handlers[0].body).toBe("emitCancelable(this, 'follow', { href }, event)");
  });

  it('uses custom import path from config', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: "emitEvent(onChange, { value: 1 })",
        params: '',
      }],
    });
    const result = transformEvents(ir, customConfig);
    const evtImport = result.imports.find(i => i.moduleSpecifier === './my-events.js');
    expect(evtImport).toBeDefined();
    expect(evtImport!.namedImports).toContain('emitEvent');
  });

  it('does not add ../internal/events.js import when custom config is used', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: "emitEvent(onChange, { value: 1 })",
        params: '',
      }],
    });
    const result = transformEvents(ir, customConfig);
    const legacyImport = result.imports.find(i => i.moduleSpecifier === '../internal/events.js');
    expect(legacyImport).toBeUndefined();
  });

  it('direct optional callback uses first non-cancelable function from config', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: 'onChange?.({ checked: true })',
        params: '',
      }],
    });
    const result = transformEvents(ir, customConfig);
    expect(result.handlers[0].body).toBe("emitEvent(this, 'change', { checked: true })");
  });

  it('omitting config preserves exact current behavior', () => {
    const ir = minimalIR({
      props: [
        { name: 'onChange', type: 'Function', category: 'event' },
        { name: 'onFollow', type: 'Function', category: 'event', eventCancelable: true },
      ],
      handlers: [
        { name: 'h1', body: "fireNonCancelableEvent(onChange, { value: 1 })", params: '' },
        { name: 'h2', body: 'fireCancelableEvent(onFollow, { href }, event)', params: '' },
        { name: 'h3', body: 'fireKeyboardEvent(onChange, event)', params: '' },
        { name: 'h4', body: 'onChange?.({ checked: true })', params: '' },
      ],
    });
    const result = transformEvents(ir);
    expect(result.handlers[0].body).toBe("fireNonCancelableEvent(this, 'change', { value: 1 })");
    expect(result.handlers[1].body).toBe("fireCancelableEvent(this, 'follow', { href }, event)");
    expect(result.handlers[2].body).toBe("fireNonCancelableEvent(this, 'change', event)");
    expect(result.handlers[3].body).toBe("fireNonCancelableEvent(this, 'change', { checked: true })");

    const evtImport = result.imports.find(i => i.moduleSpecifier === '../internal/events.js');
    expect(evtImport).toBeDefined();
    expect(evtImport!.namedImports).toContain('fireNonCancelableEvent');
    expect(evtImport!.namedImports).toContain('fireCancelableEvent');
  });
});

// ---------------------------------------------------------------------------
// Native dispatch mode
// ---------------------------------------------------------------------------

describe('native dispatch mode', () => {
  const nativeConfig: EventsConfig = {
    dispatchFunctions: {
      fireNonCancelableEvent: { import: '../internal/events.js', cancelable: false },
      fireCancelableEvent: { import: '../internal/events.js', cancelable: true },
      fireKeyboardEvent: { import: '../internal/events.js', cancelable: false },
    },
    dispatchMode: 'native',
  };

  it('produces this.dispatchEvent(new CustomEvent(...)) for fireNonCancelableEvent', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: "fireNonCancelableEvent(onChange, { value: 'x' })",
        params: '',
      }],
    });
    const result = transformEvents(ir, nativeConfig);
    expect(result.handlers[0].body).toBe(
      "this.dispatchEvent(new CustomEvent('change', { detail: { value: 'x' }, bubbles: true, composed: true }))",
    );
  });

  it('produces cancelable CustomEvent for fireCancelableEvent', () => {
    const ir = minimalIR({
      props: [{ name: 'onFollow', type: 'Function', category: 'event', eventCancelable: true }],
      handlers: [{
        name: 'h',
        body: 'fireCancelableEvent(onFollow, { href })',
        params: '',
      }],
    });
    const result = transformEvents(ir, nativeConfig);
    expect(result.handlers[0].body).toBe(
      "this.dispatchEvent(new CustomEvent('follow', { detail: { href }, bubbles: true, composed: true, cancelable: true }))",
    );
  });

  it('handles fireKeyboardEvent in native mode', () => {
    const ir = minimalIR({
      props: [{ name: 'onKeyDown', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: 'fireKeyboardEvent(onKeyDown, event)',
        params: '',
      }],
    });
    const result = transformEvents(ir, nativeConfig);
    expect(result.handlers[0].body).toBe(
      "this.dispatchEvent(new CustomEvent('keyDown', { detail: event, bubbles: true, composed: true }))",
    );
  });

  it('handles direct optional callback in native mode', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: 'onChange?.({ checked: true })',
        params: '',
      }],
    });
    const result = transformEvents(ir, nativeConfig);
    expect(result.handlers[0].body).toBe(
      "this.dispatchEvent(new CustomEvent('change', { detail: { checked: true }, bubbles: true, composed: true }))",
    );
  });

  it('handles no-arg fire call in native mode', () => {
    const ir = minimalIR({
      props: [{ name: 'onDismiss', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: 'fireNonCancelableEvent(onDismiss)',
        params: '',
      }],
    });
    const result = transformEvents(ir, nativeConfig);
    expect(result.handlers[0].body).toBe(
      "this.dispatchEvent(new CustomEvent('dismiss', { detail: {}, bubbles: true, composed: true }))",
    );
  });

  it('does not add helper imports in native mode', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: "fireNonCancelableEvent(onChange, { value: 1 })",
        params: '',
      }],
    });
    const result = transformEvents(ir, nativeConfig);
    const evtImport = result.imports.find(i => i.moduleSpecifier === '../internal/events.js');
    expect(evtImport).toBeUndefined();
  });

  it('handles nested detail argument in native mode', () => {
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: 'fireNonCancelableEvent(onChange, { items: getItems(a, b) })',
        params: '',
      }],
    });
    const result = transformEvents(ir, nativeConfig);
    expect(result.handlers[0].body).toBe(
      "this.dispatchEvent(new CustomEvent('change', { detail: { items: getItems(a, b) }, bubbles: true, composed: true }))",
    );
  });

  it('native mode with custom dispatch function names', () => {
    const cfg: EventsConfig = {
      dispatchFunctions: {
        emitEvent: { import: './events.js', cancelable: false },
      },
      dispatchMode: 'native',
    };
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: "emitEvent(onChange, { value: 1 })",
        params: '',
      }],
    });
    const result = transformEvents(ir, cfg);
    expect(result.handlers[0].body).toBe(
      "this.dispatchEvent(new CustomEvent('change', { detail: { value: 1 }, bubbles: true, composed: true }))",
    );
    // No helper imports in native mode
    expect(result.imports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Config with empty dispatchFunctions (falls back to defaults)
// ---------------------------------------------------------------------------

describe('config with empty dispatchFunctions', () => {
  it('falls back to default function names when dispatchFunctions is empty', () => {
    const cfg: EventsConfig = {
      dispatchFunctions: {},
      dispatchMode: 'helper',
    };
    const ir = minimalIR({
      props: [{ name: 'onChange', type: 'Function', category: 'event' }],
      handlers: [{
        name: 'h',
        body: "fireNonCancelableEvent(onChange, { value: 1 })",
        params: '',
      }],
    });
    const result = transformEvents(ir, cfg);
    expect(result.handlers[0].body).toBe("fireNonCancelableEvent(this, 'change', { value: 1 })");
  });
});

// ---------------------------------------------------------------------------
// Multiple dispatch functions from different import paths
// ---------------------------------------------------------------------------

describe('multiple import paths', () => {
  it('groups imports by module specifier', () => {
    const cfg: EventsConfig = {
      dispatchFunctions: {
        emitChange: { import: './events-a.js', cancelable: false },
        emitCancel: { import: './events-b.js', cancelable: true },
      },
      dispatchMode: 'helper',
    };
    const ir = minimalIR({
      props: [
        { name: 'onChange', type: 'Function', category: 'event' },
        { name: 'onCancel', type: 'Function', category: 'event', eventCancelable: true },
      ],
      handlers: [
        { name: 'h1', body: 'emitChange(onChange, { val: 1 })', params: '' },
        { name: 'h2', body: 'emitCancel(onCancel, { reason })', params: '' },
      ],
    });
    const result = transformEvents(ir, cfg);
    expect(result.handlers[0].body).toBe("emitChange(this, 'change', { val: 1 })");
    expect(result.handlers[1].body).toBe("emitCancel(this, 'cancel', { reason })");

    const importA = result.imports.find(i => i.moduleSpecifier === './events-a.js');
    const importB = result.imports.find(i => i.moduleSpecifier === './events-b.js');
    expect(importA).toBeDefined();
    expect(importA!.namedImports).toEqual(['emitChange']);
    expect(importB).toBeDefined();
    expect(importB!.namedImports).toEqual(['emitCancel']);
  });
});
