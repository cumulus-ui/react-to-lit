/**
 * Unit tests for transforms/components.ts — component registry and unwrap config.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveComponentReferences,
  cloudscapeComponentRegistry,
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

  it('custom unwrap list unwraps different components', () => {
    const customUnwrap = new Set(['MyWrapper', 'AnotherWrapper']);
    // Empty registry so we fall through to the unwrap check
    const registry: ComponentRegistry = {};

    const child = textNode('inner');
    const input = componentNode('MyWrapper', [child]);
    const { template } = resolveComponentReferences(input, registry, customUnwrap);

    // MyWrapper should be unwrapped to a fragment
    expect(template.kind).toBe('fragment');
    expect(template.children).toHaveLength(1);
    expect(template.children[0].expression).toBe('inner');
  });

  it('custom unwrap list does NOT unwrap components not in the set', () => {
    const customUnwrap = new Set(['OnlyThis']);
    const registry: ComponentRegistry = {};

    const input = componentNode('SomethingElse', [textNode('child')]);
    const { template } = resolveComponentReferences(input, registry, customUnwrap);

    // SomethingElse is NOT in the unwrap set and not a React builtin,
    // so it should be auto-derived to a custom element tag
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

  it('default registry (no args) uses cloudscapeComponentRegistry', () => {
    const child = textNode('inside');
    // CSSTransition is in the default UNWRAP_COMPONENTS for Cloudscape
    // Use the default registry (cloudscapeComponentRegistry) by not passing one
    const input = componentNode('CSSTransition', [child]);
    const { template } = resolveComponentReferences(input);

    // CSSTransition should be in the default registry as __UNWRAP__
    expect(template.kind).toBe('fragment');
    expect(template.children).toHaveLength(1);
  });

  it('cloudscapeComponentRegistry is exported and has entries', () => {
    expect(cloudscapeComponentRegistry).toBeDefined();
    expect(typeof cloudscapeComponentRegistry).toBe('object');
    // Should have AbstractSwitch (function-based) at minimum
    expect(cloudscapeComponentRegistry['AbstractSwitch']).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Nested children are recursed with config
  // ---------------------------------------------------------------------------

  it('custom unwrap config recurses into nested children', () => {
    const customUnwrap = new Set(['Outer', 'Inner']);
    const registry: ComponentRegistry = {};

    const input = componentNode('Outer', [
      componentNode('Inner', [textNode('deep')]),
    ]);
    const { template } = resolveComponentReferences(input, registry, customUnwrap);

    // Outer → fragment
    expect(template.kind).toBe('fragment');
    // Inner → also fragment
    expect(template.children[0].kind).toBe('fragment');
    // deep text
    expect(template.children[0].children[0].expression).toBe('deep');
  });
});
