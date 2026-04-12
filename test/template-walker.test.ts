/**
 * Unit tests for template-walker.ts.
 */
import { describe, it, expect } from 'vitest';
import { walkTemplate, someInTemplate, templateHasExpression } from '../src/template-walker.js';
import type { TemplateNodeIR, AttributeIR } from '../src/ir/types.js';

// ---------------------------------------------------------------------------
// Helper: minimal node factories
// ---------------------------------------------------------------------------

function element(
  tag: string,
  attrs: AttributeIR[] = [],
  children: TemplateNodeIR[] = [],
): TemplateNodeIR {
  return { kind: 'element', tag, attributes: attrs, children };
}

function expression(expr: string): TemplateNodeIR {
  return { kind: 'expression', expression: expr, attributes: [], children: [] };
}

function text(content: string): TemplateNodeIR {
  return { kind: 'text', expression: content, attributes: [], children: [] };
}

function dynamicAttr(name: string, expr: string): AttributeIR {
  return { name, value: { expression: expr }, kind: 'property' };
}

function staticAttr(name: string, value: string): AttributeIR {
  return { name, value, kind: 'static' };
}

// ---------------------------------------------------------------------------
// walkTemplate
// ---------------------------------------------------------------------------

describe('walkTemplate', () => {
  it('transforms tags', () => {
    const tree = element('div', [], [element('span')]);
    const result = walkTemplate(tree, {
      tag: (tag) => tag === 'div' ? 'section' : tag,
    });
    expect(result.tag).toBe('section');
    expect(result.children[0].tag).toBe('span');
  });

  it('transforms attributes via attribute visitor', () => {
    const tree = element('div', [staticAttr('id', 'foo'), staticAttr('class', 'bar')]);
    const result = walkTemplate(tree, {
      attribute: (attr) => {
        if (attr.name === 'class') return null; // remove
        return undefined; // keep
      },
    });
    expect(result.attributes).toHaveLength(1);
    expect(result.attributes[0].name).toBe('id');
  });

  it('transforms dynamic attribute expressions', () => {
    const tree = element('div', [dynamicAttr('foo', 'x + y')]);
    const result = walkTemplate(tree, {
      attributeExpression: (expr) => expr.replace('x', 'this.x'),
    });
    expect((result.attributes[0].value as { expression: string }).expression).toBe('this.x + y');
  });

  it('transforms inline expressions', () => {
    const tree = element('div', [], [expression('count')]);
    const result = walkTemplate(tree, {
      expression: (expr) => `this.${expr}`,
    });
    expect(result.children[0].expression).toBe('this.count');
  });

  it('transforms condition expressions', () => {
    const node: TemplateNodeIR = {
      ...element('div'),
      condition: { expression: 'visible', kind: 'and' },
    };
    const result = walkTemplate(node, {
      conditionExpression: (expr) => `this.${expr}`,
    });
    expect(result.condition!.expression).toBe('this.visible');
  });

  it('recurses into condition.alternate', () => {
    const alternate = element('span');
    const node: TemplateNodeIR = {
      ...element('div'),
      condition: { expression: 'cond', kind: 'ternary', alternate },
    };
    const result = walkTemplate(node, {
      tag: (t) => t === 'span' ? 'em' : undefined,
    });
    expect(result.condition!.alternate!.tag).toBe('em');
  });

  it('transforms loop iterable', () => {
    const node: TemplateNodeIR = {
      ...element('li'),
      loop: { iterable: 'items', variable: 'item' },
    };
    const result = walkTemplate(node, {
      loopIterable: (expr) => `this.${expr}`,
    });
    expect(result.loop!.iterable).toBe('this.items');
  });

  it('applies node visitor after attributes/expressions', () => {
    const tree = element('Wrapper', [], [element('span')]);
    const result = walkTemplate(tree, {
      node: (n) => {
        if (n.tag === 'Wrapper') {
          return { kind: 'fragment', attributes: [], children: n.children };
        }
        return undefined;
      },
    });
    expect(result.kind).toBe('fragment');
    expect(result.children).toHaveLength(1);
    expect(result.children[0].tag).toBe('span');
  });

  it('recurses into deep children', () => {
    const tree = element('div', [], [
      element('ul', [], [
        element('li', [], [expression('item')]),
      ]),
    ]);
    const result = walkTemplate(tree, {
      expression: (expr) => `this.${expr}`,
    });
    expect(result.children[0].children[0].children[0].expression).toBe('this.item');
  });

  it('returns unchanged node when visitors return undefined', () => {
    const tree = element('div', [staticAttr('id', 'foo')], [text('hello')]);
    const result = walkTemplate(tree, {});
    expect(result.tag).toBe('div');
    expect(result.attributes[0].value).toBe('foo');
    expect(result.children[0].expression).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// someInTemplate
// ---------------------------------------------------------------------------

describe('someInTemplate', () => {
  it('returns true when a node matches', () => {
    const tree = element('div', [], [expression('count')]);
    expect(someInTemplate(tree, (n) => n.kind === 'expression')).toBe(true);
  });

  it('returns false when no node matches', () => {
    const tree = element('div', [], [text('hello')]);
    expect(someInTemplate(tree, (n) => n.kind === 'expression')).toBe(false);
  });

  it('checks condition.alternate', () => {
    const alt = expression('fallback');
    const tree: TemplateNodeIR = {
      ...element('div'),
      condition: { expression: 'cond', kind: 'ternary', alternate: alt },
    };
    expect(someInTemplate(tree, (n) => n.expression === 'fallback')).toBe(true);
  });

  it('matches root node', () => {
    const tree = element('custom-element');
    expect(someInTemplate(tree, (n) => n.tag === 'custom-element')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// templateHasExpression
// ---------------------------------------------------------------------------

describe('templateHasExpression', () => {
  it('finds text in attribute expressions', () => {
    const tree = element('div', [dynamicAttr('class', 'classMap({ root: true })')]);
    expect(templateHasExpression(tree, 'classMap(')).toBe(true);
  });

  it('finds text in inline expressions', () => {
    const tree = element('div', [], [expression('ifDefined(value)')]);
    expect(templateHasExpression(tree, 'ifDefined(')).toBe(true);
  });

  it('returns false when text is absent', () => {
    const tree = element('div', [staticAttr('class', 'root')]);
    expect(templateHasExpression(tree, 'classMap(')).toBe(false);
  });
});
