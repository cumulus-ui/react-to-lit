/**
 * Unit tests for transforms/identifiers.ts — identifier rewriting.
 *
 * Tests rewriteIdentifiers (which internally uses rewriteWithMorph)
 * through the public API with minimal ComponentIR fixtures.
 */
import { describe, it, expect } from 'vitest';
import { rewriteIdentifiers } from '../../src/transforms/identifiers.js';
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

function expression(expr: string): TemplateNodeIR {
  return { kind: 'expression', attributes: [], children: [], expression: expr };
}

function prop(name: string, category: string = 'attribute') {
  return { name, type: 'string', category, defaultValue: undefined };
}

function stateDef(name: string, setter: string, initial: string = "''") {
  return { name, setter, initialValue: initial, type: 'string' };
}

function refDef(name: string, initial: string = 'null') {
  return { name, initialValue: initial, type: 'HTMLElement | null' };
}

// ---------------------------------------------------------------------------
// Basic prop rewriting
// ---------------------------------------------------------------------------

describe('rewriteIdentifiers', () => {
  describe('props → this.propName', () => {
    it('rewrites bare prop names in handler bodies', () => {
      const ir = minimalIR({
        props: [prop('disabled'), prop('value')],
        handlers: [{ name: 'handleClick', body: 'if (disabled) return value;', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('if (this.disabled) return this.value;');
    });

    it('does not rewrite prop after dot (property access)', () => {
      const ir = minimalIR({
        props: [prop('value')],
        handlers: [{ name: 'h', body: 'item.value + value', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('item.value + this.value');
    });

    it('does not rewrite prop in declaration position', () => {
      const ir = minimalIR({
        props: [prop('value')],
        handlers: [{ name: 'h', body: 'const value = 42; return value;', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      // local shadows the prop
      expect(result.handlers[0].body).toBe('const value = 42; return value;');
    });

    it('does not rewrite event props', () => {
      const ir = minimalIR({
        props: [prop('onChange', 'event')],
        handlers: [{ name: 'h', body: 'onChange()', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      // event props are not in member map
      expect(result.handlers[0].body).toBe('onChange()');
    });

    it('rewrites shorthand property to expanded form', () => {
      const ir = minimalIR({
        props: [prop('disabled')],
        handlers: [{ name: 'h', body: 'const obj = { disabled }', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('const obj = { disabled: this.disabled }');
    });
  });

  // ---------------------------------------------------------------------------
  // State rewriting
  // ---------------------------------------------------------------------------

  describe('state → this._stateName', () => {
    it('rewrites state name to this._name', () => {
      const ir = minimalIR({
        state: [stateDef('count', 'setCount', '0')],
        handlers: [{ name: 'h', body: 'return count + 1;', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('return this._count + 1;');
    });

    it('rewrites state initial values', () => {
      const ir = minimalIR({
        props: [prop('defaultValue')],
        state: [stateDef('value', 'setValue', 'defaultValue')],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.state[0].initialValue).toBe('this.defaultValue');
    });
  });

  // ---------------------------------------------------------------------------
  // Ref rewriting
  // ---------------------------------------------------------------------------

  describe('refs → this._refName', () => {
    it('rewrites ref.current to this._refName', () => {
      const ir = minimalIR({
        refs: [refDef('inputRef')],
        handlers: [{ name: 'h', body: 'inputRef.current.focus()', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('this._inputRef.focus()');
    });

    it('rewrites bare ref name', () => {
      const ir = minimalIR({
        refs: [refDef('containerRef')],
        handlers: [{ name: 'h', body: 'if (containerRef) doStuff()', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('if (this._containerRef) doStuff()');
    });
  });

  // ---------------------------------------------------------------------------
  // Template expression rewriting
  // ---------------------------------------------------------------------------

  describe('template expressions', () => {
    it('rewrites prop in attribute expression', () => {
      const ir = minimalIR({
        props: [prop('disabled')],
        template: element('div', [
          { name: 'disabled', value: { expression: 'disabled' }, kind: 'boolean' },
        ]),
      });
      const result = rewriteIdentifiers(ir);
      const attr = result.template.attributes[0];
      expect(typeof attr.value === 'object' && attr.value.expression).toBe('this.disabled');
    });

    it('rewrites prop in child expression node', () => {
      const ir = minimalIR({
        props: [prop('label')],
        template: element('div', [], [expression('label')]),
      });
      const result = rewriteIdentifiers(ir);
      expect(result.template.children[0].expression).toBe('this.label');
    });

    it('rewrites prop in condition expression', () => {
      const ir = minimalIR({
        props: [prop('visible')],
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [],
          children: [],
          condition: { expression: 'visible', kind: 'and' },
        },
      });
      const result = rewriteIdentifiers(ir);
      expect(result.template.condition!.expression).toBe('this.visible');
    });

    it('rewrites prop in loop iterable', () => {
      const ir = minimalIR({
        props: [prop('items')],
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [],
          children: [],
          loop: { iterable: 'items', variable: 'item' },
        },
      });
      const result = rewriteIdentifiers(ir);
      expect(result.template.loop!.iterable).toBe('this.items');
    });
  });

  // ---------------------------------------------------------------------------
  // Handler params are local
  // ---------------------------------------------------------------------------

  describe('handler params as locals', () => {
    it('does not rewrite handler params that shadow props', () => {
      const ir = minimalIR({
        props: [prop('value')],
        handlers: [{ name: 'h', body: 'console.log(value)', params: 'value' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('console.log(value)');
    });

    it('rewrites non-param props in handler with params', () => {
      const ir = minimalIR({
        props: [prop('value'), prop('disabled')],
        handlers: [{ name: 'h', body: 'if (disabled) return value;', params: 'value' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('if (this.disabled) return value;');
    });
  });

  // ---------------------------------------------------------------------------
  // Template literals with html``
  // ---------------------------------------------------------------------------

  describe('expressions containing html`` templates', () => {
    it('rewrites identifiers in html template interpolations', () => {
      const ir = minimalIR({
        props: [prop('items'), prop('label')],
        template: element('div', [], [
          expression('items.map(item => html`<span>${label}</span>`)'),
        ]),
      });
      const result = rewriteIdentifiers(ir);
      const expr = result.template.children[0].expression!;
      expect(expr).toContain('this.items');
      expect(expr).toContain('this.label');
    });

    it('does not insert spaces in Lit property bindings inside html``', () => {
      const ir = minimalIR({
        props: [prop('value'), prop('placeholder')],
        template: element('div', [], [
          expression('html`<el-input .value=${value} .placeholder=${placeholder}></el-input>`'),
        ]),
      });
      const result = rewriteIdentifiers(ir);
      const expr = result.template.children[0].expression!;
      // .value= should NOT become this .value= or this.value=
      // The .value is a Lit property binding name, not an identifier
      expect(expr).not.toMatch(/this\s*\.value=/);
      expect(expr).toContain('.value=${this.value}');
      expect(expr).toContain('.placeholder=${this.placeholder}');
    });

    it('does not garble Lit attribute bindings in nested html``', () => {
      const ir = minimalIR({
        props: [prop('items'), prop('disabled')],
        template: element('div', [], [
          expression('items.map(item => html`<el-button ?disabled=${disabled}>${item.label}</el-button>`)'),
        ]),
      });
      const result = rewriteIdentifiers(ir);
      const expr = result.template.children[0].expression!;
      expect(expr).toContain('this.items.map');
      expect(expr).toContain('?disabled=${this.disabled}');
      expect(expr).not.toContain('this ?disabled');
      expect(expr).not.toContain('this disabled');
    });

    it('does not rewrite identifiers in template literal string parts', () => {
      const ir = minimalIR({
        props: [prop('value')],
        template: element('div', [], [
          expression('html`<input value="${value}"/>`'),
        ]),
      });
      const result = rewriteIdentifiers(ir);
      const expr = result.template.children[0].expression!;
      // "value" as an HTML attribute name in string should not be rewritten
      // only ${value} in interpolation should be
      expect(expr).toContain('${this.value}');
    });

    it('handles .map() with html`` and multiple property bindings', () => {
      const ir = minimalIR({
        props: [prop('items'), prop('direction')],
        template: element('div', [], [
          expression('items.map((item, index) => html`<el-radio-button .value=${item.value} .description=${item.description} class=${direction}></el-radio-button>`)'),
        ]),
      });
      const result = rewriteIdentifiers(ir);
      const expr = result.template.children[0].expression!;
      expect(expr).toContain('this.items.map');
      expect(expr).toContain('.value=${item.value}');
      expect(expr).toContain('.description=${item.description}');
      expect(expr).toContain('class=${this.direction}');
      // No space injected before property bindings
      expect(expr).not.toMatch(/this\s+\.value/);
      expect(expr).not.toMatch(/this\s+\.description/);
    });

    it('handles html`` with event bindings', () => {
      const ir = minimalIR({
        props: [prop('items')],
        handlers: [{ name: 'handleClick', body: 'console.log("click")', params: '' }],
        template: element('div', [], [
          expression('items.map(item => html`<el-button @click=${handleClick}></el-button>`)'),
        ]),
      });
      const result = rewriteIdentifiers(ir);
      const expr = result.template.children[0].expression!;
      expect(expr).toContain('@click=${this._handleClick}');
    });
  });

  // ---------------------------------------------------------------------------
  // TypeScript generics — should not be treated as JSX
  // ---------------------------------------------------------------------------

  describe('TypeScript generics', () => {
    it('does not garble Partial<Type> in handler body', () => {
      const ir = minimalIR({
        props: [prop('value')],
        handlers: [{ name: 'h', body: 'const x: Partial<Props> = { value }', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toContain('Partial<Props>');
      expect(result.handlers[0].body).toContain('value: this.value');
    });

    it('does not garble Array<Item> in computed values', () => {
      const ir = minimalIR({
        props: [prop('items')],
        computedValues: [{ name: 'sorted', expression: 'items.sort() as Array<Item>', type: 'Item[]' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.computedValues[0].expression).toContain('Array<Item>');
      expect(result.computedValues[0].expression).toContain('this.items');
    });
  });

  // ---------------------------------------------------------------------------
  // Effect / lifecycle rewriting
  // ---------------------------------------------------------------------------

  describe('effects', () => {
    it('rewrites identifiers in effect body', () => {
      const ir = minimalIR({
        props: [prop('visible')],
        effects: [{ body: 'if (visible) show();', deps: ['visible'] }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.effects[0].body).toBe('if (this.visible) show();');
    });

    it('rewrites identifiers in effect cleanup', () => {
      const ir = minimalIR({
        props: [prop('visible')],
        effects: [{ body: 'setup()', cleanup: 'if (visible) teardown()', deps: [] }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.effects[0].cleanup).toBe('if (this.visible) teardown()');
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers and body preamble
  // ---------------------------------------------------------------------------

  describe('helpers and preamble', () => {
    it('rewrites identifiers in helper source', () => {
      const ir = minimalIR({
        props: [prop('items')],
        helpers: [{ name: 'getCount', source: 'function getCount() { return items.length; }' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.helpers[0].source).toContain('this.items.length');
    });

    it('rewrites identifiers in body preamble', () => {
      const ir = minimalIR({
        props: [prop('value')],
        bodyPreamble: ['const doubled = value * 2;'],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.bodyPreamble[0]).toBe('const doubled = this.value * 2;');
    });
  });

  // ---------------------------------------------------------------------------
  // The radio-group / tiles bug: JSX with spreads in template expressions
  // These tests document known issues — they will pass once the identifier
  // rewriter correctly handles JSX-to-Lit conversion order.
  // ---------------------------------------------------------------------------

  describe('JSX in template expression text (radio-group pattern)', () => {
    it.fails('does not produce "this .value" from JSX attribute values', () => {
      const ir = minimalIR({
        props: [prop('items'), prop('direction'), prop('value')],
        state: [stateDef('generatedName', 'setGeneratedName', "''")],
        refs: [refDef('radioButtonRef')],
        imports: [
          { moduleSpecifier: '../internal/components/radio-button', defaultImport: 'RadioButton' },
        ],
        template: element('div', [], [{
          kind: 'expression',
          attributes: [],
          children: [],
          condition: { expression: 'items', kind: 'and' },
          expression: `items.map((item, index) => (
            <RadioButton
              className="radio"
              checked={item.value === value}
              value={item.value}
              description={item.description}
              disabled={item.disabled}
              controlId={item.controlId}
              readOnly={readOnly}
              style={style}
            >
              {item.label}
            </RadioButton>
          ))`,
        }]),
      });
      const result = rewriteIdentifiers(ir);
      const expr = result.template.children[0].expression!;

      // Identifiers should be rewritten
      expect(expr).toContain('this.items');
      expect(expr).toContain('this.value');

      // No space before Lit property bindings
      expect(expr).not.toMatch(/this\s+\.value=/);
      expect(expr).not.toMatch(/this\s+\.controlId=/);
      expect(expr).not.toMatch(/this\s+\.readonly=/);
      expect(expr).not.toMatch(/this\s+\.style=/);

      // No orphaned statements from spreads
      expect(expr).not.toMatch(/;\s*\n\s*this\.\w+ =/);
    });

    it.fails('does not produce orphaned statements from JSX spread attributes', () => {
      const ir = minimalIR({
        props: [prop('items'), prop('disabled')],
        imports: [
          { moduleSpecifier: '../components/button', defaultImport: 'Button' },
        ],
        template: element('div', [], [{
          kind: 'expression',
          attributes: [],
          children: [],
          expression: `items.map(item => (
            <Button
              disabled={disabled}
              {...getMetadata({ pos: item.index })}
            >
              {item.label}
            </Button>
          ))`,
        }]),
      });
      const result = rewriteIdentifiers(ir);
      const expr = result.template.children[0].expression!;

      // Should not have getMetadata as an orphaned statement
      expect(expr).not.toContain('getMetadata(');
      // Should be a clean expression
      expect(expr).not.toMatch(/;\s*\n/);
    });

    it('handles JSX with children and spread in .map() callback', () => {
      const ir = minimalIR({
        props: [prop('items')],
        imports: [
          { moduleSpecifier: '../tile', defaultImport: 'Tile' },
        ],
        template: element('div', [], [{
          kind: 'expression',
          attributes: [],
          children: [],
          condition: { expression: 'items', kind: 'and' },
          expression: `items.map((item) => (
            <Tile
              item={item}
              selected={item.selected}
              {...(!item.disabled ? getAttrs({ action: 'select' }) : {})}
            />
          ))`,
        }]),
      });
      const result = rewriteIdentifiers(ir);
      const expr = result.template.children[0].expression!;

      expect(expr).toContain('this.items');
      // Should not have orphaned spread content
      expect(expr).not.toContain('getAttrs(');
      expect(expr).not.toMatch(/;\s*\n/);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('does not rewrite single-character identifiers', () => {
      const ir = minimalIR({
        props: [prop('x')],
        handlers: [{ name: 'h', body: 'return x + 1;', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      // single char names are skipped
      expect(result.handlers[0].body).toBe('return x + 1;');
    });

    it('does not rewrite global names', () => {
      const ir = minimalIR({
        props: [prop('undefined'), prop('console')],
        handlers: [{ name: 'h', body: 'if (undefined) console.log("hi")', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('if (undefined) console.log("hi")');
    });

    it('handles empty text', () => {
      const ir = minimalIR({
        props: [prop('value')],
        handlers: [{ name: 'h', body: '', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('');
    });

    it('handles text with no member references', () => {
      const ir = minimalIR({
        props: [prop('value')],
        handlers: [{ name: 'h', body: 'console.log("hello")', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toBe('console.log("hello")');
    });

    it('handles arrow functions with prop references', () => {
      const ir = minimalIR({
        props: [prop('onClick', 'event'), prop('disabled')],
        handlers: [{ name: 'h', body: '() => { if (disabled) return; }', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      expect(result.handlers[0].body).toContain('this.disabled');
    });

    it('does not rewrite object destructuring property names', () => {
      const ir = minimalIR({
        props: [prop('value')],
        handlers: [{ name: 'h', body: 'const { value } = getState(); return value;', params: '' }],
      });
      const result = rewriteIdentifiers(ir);
      // value is locally declared via destructuring, shadows the prop
      expect(result.handlers[0].body).toBe('const { value } = getState(); return value;');
    });
  });
});
