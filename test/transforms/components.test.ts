/**
 * Unit tests for transforms/components.ts — component registry and unwrap config.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveComponentReferences,
  componentRegistry,
  type ComponentRegistry,
} from '../../src/transforms/components.js';
import type { TemplateNodeIR } from '../../src/ir/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal component node for testing. */
function componentNode(
  tag: string,
  children: TemplateNodeIR[] = [],
): TemplateNodeIR {
  return {
    kind: 'component',
    tag,
    attributes: [],
    children,
  };
}

/** Create a minimal text node. */
function textNode(text: string): TemplateNodeIR {
  return {
    kind: 'text',
    expression: text,
    attributes: [],
    children: [],
  };
}

// ---------------------------------------------------------------------------
// Custom registry tests
// ---------------------------------------------------------------------------

describe('resolveComponentReferences', () => {
  it('custom registry maps a component to a different tag name', () => {
    const registry: ComponentRegistry = {
      MyWidget: 'custom-widget',
    };

    const input = componentNode('MyWidget', [textNode('hello')]);
    const { template } = resolveComponentReferences(input, registry);

    expect(template.kind).toBe('element');
    expect(template.tag).toBe('custom-widget');
    expect(template.children).toHaveLength(1);
  });

  it('custom registry function-based entry replaces node', () => {
    const registry: ComponentRegistry = {
      Fancy: (node) => ({
        kind: 'element',
        tag: 'fancy-element',
        attributes: node.attributes,
        children: node.children,
      }),
    };

    const input = componentNode('Fancy', [textNode('content')]);
    const { template } = resolveComponentReferences(input, registry);

    expect(template.kind).toBe('element');
    expect(template.tag).toBe('fancy-element');
    expect(template.children).toHaveLength(1);
  });

  it('unwraps components not in knownComponents set', () => {
    const knownComponents = new Set(['KeepThis']);
    const registry: ComponentRegistry = {};

    const child = textNode('inner');
    const input = componentNode('MyWrapper', [child]);
    const { template } = resolveComponentReferences(input, registry, knownComponents);

    expect(template.kind).toBe('fragment');
    expect(template.children).toHaveLength(1);
    expect(template.children[0].expression).toBe('inner');
  });

  it('keeps components that are in knownComponents set', () => {
    const knownComponents = new Set(['SomethingElse']);
    const registry: ComponentRegistry = {};

    const input = componentNode('SomethingElse', [textNode('child')]);
    const { template } = resolveComponentReferences(input, registry, knownComponents);

    expect(template.kind).toBe('element');
    expect(template.tag).toBe('el-something-else');
  });

  // ---------------------------------------------------------------------------
  // React builtins always unwrap
  // ---------------------------------------------------------------------------

  it('React builtins (Fragment) are always unwrapped regardless of config', () => {
    const emptyUnwrap = new Set<string>();
    const registry: ComponentRegistry = {};

    const child = textNode('content');
    const input = componentNode('Fragment', [child]);
    const { template } = resolveComponentReferences(input, registry, emptyUnwrap);

    expect(template.kind).toBe('fragment');
    expect(template.children).toHaveLength(1);
  });

  it('React builtins (React.Fragment) are always unwrapped regardless of config', () => {
    const emptyUnwrap = new Set<string>();
    const registry: ComponentRegistry = {};

    const input = componentNode('React.Fragment', [textNode('x')]);
    const { template } = resolveComponentReferences(input, registry, emptyUnwrap);

    expect(template.kind).toBe('fragment');
  });

  it('React builtins (Suspense) are always unwrapped regardless of config', () => {
    const emptyUnwrap = new Set<string>();
    const registry: ComponentRegistry = {};

    const input = componentNode('Suspense', [textNode('loading')]);
    const { template } = resolveComponentReferences(input, registry, emptyUnwrap);

    expect(template.kind).toBe('fragment');
  });

  it('React builtins (StrictMode) are always unwrapped regardless of config', () => {
    const emptyUnwrap = new Set<string>();
    const registry: ComponentRegistry = {};

    const input = componentNode('StrictMode', [textNode('child')]);
    const { template } = resolveComponentReferences(input, registry, emptyUnwrap);

    expect(template.kind).toBe('fragment');
  });

  it('React builtins (Profiler) are always unwrapped regardless of config', () => {
    const emptyUnwrap = new Set<string>();
    const registry: ComponentRegistry = {};

    const input = componentNode('Profiler', [textNode('child')]);
    const { template } = resolveComponentReferences(input, registry, emptyUnwrap);

    expect(template.kind).toBe('fragment');
  });

  // ---------------------------------------------------------------------------
  // Context Provider/Consumer pattern always unwraps
  // ---------------------------------------------------------------------------

  it('.Provider pattern always unwraps regardless of config', () => {
    const emptyUnwrap = new Set<string>();
    const registry: ComponentRegistry = {};

    const input = componentNode('MyContext.Provider', [textNode('provided')]);
    const { template } = resolveComponentReferences(input, registry, emptyUnwrap);

    expect(template.kind).toBe('fragment');
  });

  it('.Consumer pattern always unwraps regardless of config', () => {
    const emptyUnwrap = new Set<string>();
    const registry: ComponentRegistry = {};

    const input = componentNode('ThemeContext.Consumer', [textNode('consumed')]);
    const { template } = resolveComponentReferences(input, registry, emptyUnwrap);

    expect(template.kind).toBe('fragment');
  });

  // ---------------------------------------------------------------------------
  // Default behavior (no config) preserves backward compat
  // ---------------------------------------------------------------------------

  it('without knownComponents, only React builtins are unwrapped', () => {
    const child = textNode('inside');
    const input = componentNode('CSSTransition', [child]);
    const { template } = resolveComponentReferences(input);

    expect(template.kind).toBe('element');
    expect(template.tag).toBe('el-csstransition');
  });

  it('componentRegistry is exported and has entries', () => {
    expect(componentRegistry).toBeDefined();
    expect(typeof componentRegistry).toBe('object');
    expect(componentRegistry['AbstractSwitch']).toBeDefined();
  });

  it('knownComponents recurses into nested children', () => {
    const knownComponents = new Set<string>();
    const registry: ComponentRegistry = {};

    const input = componentNode('Outer', [
      componentNode('Inner', [textNode('deep')]),
    ]);
    const { template } = resolveComponentReferences(input, registry, knownComponents);

    expect(template.kind).toBe('fragment');
    expect(template.children[0].kind).toBe('fragment');
    expect(template.children[0].children[0].expression).toBe('deep');
  });
});
