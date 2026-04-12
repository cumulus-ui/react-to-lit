/**
 * Unit tests for transforms/clsx.ts — clsx → classMap conversion.
 */
import { describe, it, expect } from 'vitest';
import { transformClsx } from '../../src/transforms/clsx.js';
import type { ComponentIR, TemplateNodeIR, AttributeIR } from '../../src/ir/types.js';

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
    ...overrides,
  };
}

function element(
  tag: string,
  attrs: AttributeIR[] = [],
  children: TemplateNodeIR[] = [],
): TemplateNodeIR {
  return { kind: 'element', tag, attributes: attrs, children };
}

function dynamicAttr(name: string, expr: string, kind: AttributeIR['kind'] = 'property'): AttributeIR {
  return { name, value: { expression: expr }, kind };
}

// ---------------------------------------------------------------------------
// Template classMap conversion
// ---------------------------------------------------------------------------

describe('transformClsx — template attributes', () => {
  it('converts classMap attribute with clsx expression', () => {
    const ir = minimalIR({
      template: element('div', [
        dynamicAttr('className', "clsx(styles.root, styles['disabled'])", 'classMap'),
      ]),
    });
    const result = transformClsx(ir);
    const attr = result.template.attributes[0];
    expect(attr.kind).toBe('classMap');
    const expr = typeof attr.value === 'string' ? attr.value : attr.value.expression;
    expect(expr).toContain("'root': true");
    expect(expr).toContain("'disabled': true");
  });

  it('converts className attribute to class', () => {
    const ir = minimalIR({
      template: element('div', [
        { name: 'className', value: 'static-class', kind: 'static' },
      ]),
    });
    const result = transformClsx(ir);
    expect(result.template.attributes[0].name).toBe('class');
  });

  it('handles styles.xxx in classMap attributes', () => {
    const ir = minimalIR({
      template: element('div', [
        dynamicAttr('className', 'styles.root', 'classMap'),
      ]),
    });
    const result = transformClsx(ir);
    const attr = result.template.attributes[0];
    const expr = typeof attr.value === 'string' ? attr.value : attr.value.expression;
    expect(expr).toContain("'root': true");
  });
});

// ---------------------------------------------------------------------------
// Code body transformation
// ---------------------------------------------------------------------------

describe('transformClsx — code bodies', () => {
  it('replaces clsx() calls in handler bodies with classMap()', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', params: '', body: "const cls = clsx(styles.root, styles.active);" }],
    });
    const result = transformClsx(ir);
    expect(result.handlers[0].body).toContain('classMap(');
    expect(result.handlers[0].body).not.toContain('clsx(');
  });

  it('replaces styles.xxx references in handler bodies', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', params: '', body: "const cls = styles.root;" }],
    });
    const result = transformClsx(ir);
    expect(result.handlers[0].body).toContain("'root'");
    expect(result.handlers[0].body).not.toContain('styles.root');
  });

  it('replaces styles[`template-${x}`] with backtick strings', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', params: '', body: "const cls = styles[`size-${size}`];" }],
    });
    const result = transformClsx(ir);
    expect(result.handlers[0].body).toContain('`size-${size}`');
    expect(result.handlers[0].body).not.toContain('styles[');
  });

  it("replaces styles['quoted-key'] with plain strings", () => {
    const ir = minimalIR({
      helpers: [{ name: 'fn', source: "const x = styles['button-disabled'];" }],
    });
    const result = transformClsx(ir);
    expect(result.helpers[0].source).toContain("'button-disabled'");
    expect(result.helpers[0].source).not.toContain('styles[');
  });

  it('transforms effect bodies', () => {
    const ir = minimalIR({
      effects: [{ body: "el.className = clsx(styles.root);", deps: 'empty' }],
    });
    const result = transformClsx(ir);
    expect(result.effects[0].body).toContain('classMap(');
  });

  it('transforms bodyPreamble', () => {
    const ir = minimalIR({
      bodyPreamble: ["const cls = styles.root;"],
    });
    const result = transformClsx(ir);
    expect(result.bodyPreamble[0]).toContain("'root'");
  });

  it('transforms computedValues', () => {
    const ir = minimalIR({
      computedValues: [{ name: 'c', expression: 'styles.active', deps: [] }],
    });
    const result = transformClsx(ir);
    expect(result.computedValues[0].expression).toContain("'active'");
  });
});
