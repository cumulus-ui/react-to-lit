/**
 * Unit tests for ir/transform-helpers.ts — mapIRText.
 */
import { describe, it, expect } from 'vitest';
import { mapIRText } from '../src/ir/transform-helpers.js';
import type { ComponentIR } from '../src/ir/types.js';

// ---------------------------------------------------------------------------
// Minimal IR factory
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

// ---------------------------------------------------------------------------
// mapIRText
// ---------------------------------------------------------------------------

describe('mapIRText', () => {
  const toUpper = (s: string) => s.toUpperCase();

  it('transforms handler bodies', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', params: 'e', body: 'click', returnType: 'void' }],
    });
    const result = mapIRText(ir, toUpper);
    expect(result.handlers[0].body).toBe('CLICK');
    // params and returnType untouched without options.params
    expect(result.handlers[0].params).toBe('e');
    expect(result.handlers[0].returnType).toBe('void');
  });

  it('transforms handler params and returnType with options.params', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', params: 'e: Event', body: 'x', returnType: 'void' }],
    });
    const result = mapIRText(ir, toUpper, { params: true });
    expect(result.handlers[0].params).toBe('E: EVENT');
    expect(result.handlers[0].returnType).toBe('VOID');
  });

  it('transforms effect body and cleanup', () => {
    const ir = minimalIR({
      effects: [{ body: 'setup', deps: 'empty', cleanup: 'teardown' }],
    });
    const result = mapIRText(ir, toUpper);
    expect(result.effects[0].body).toBe('SETUP');
    expect(result.effects[0].cleanup).toBe('TEARDOWN');
  });

  it('handles undefined cleanup', () => {
    const ir = minimalIR({
      effects: [{ body: 'x', deps: 'empty' }],
    });
    const result = mapIRText(ir, toUpper);
    expect(result.effects[0].cleanup).toBeUndefined();
  });

  it('transforms helper sources', () => {
    const ir = minimalIR({
      helpers: [{ name: 'fn', source: 'function fn() {}' }],
    });
    const result = mapIRText(ir, toUpper);
    expect(result.helpers[0].source).toBe('FUNCTION FN() {}');
  });

  it('transforms bodyPreamble', () => {
    const ir = minimalIR({ bodyPreamble: ['const x = 1'] });
    const result = mapIRText(ir, toUpper);
    expect(result.bodyPreamble[0]).toBe('CONST X = 1');
  });

  it('transforms publicMethod bodies', () => {
    const ir = minimalIR({
      publicMethods: [{ name: 'focus', params: '', body: 'this.el.focus()' }],
    });
    const result = mapIRText(ir, toUpper);
    expect(result.publicMethods[0].body).toBe('THIS.EL.FOCUS()');
  });

  it('transforms computedValue expressions', () => {
    const ir = minimalIR({
      computedValues: [{ name: 'v', expression: 'a + b', deps: [], type: 'number' }],
    });
    const result = mapIRText(ir, toUpper);
    expect(result.computedValues[0].expression).toBe('A + B');
  });

  it('transforms computedValue type with options.params', () => {
    const ir = minimalIR({
      computedValues: [{ name: 'v', expression: 'x', deps: [], type: 'React.CSSProperties' }],
    });
    const result = mapIRText(ir, toUpper, { params: true });
    expect(result.computedValues[0].type).toBe('REACT.CSSPROPERTIES');
  });

  it('transforms state initialValues', () => {
    const ir = minimalIR({
      state: [{ name: 's', initialValue: 'null', setter: 'setS' }],
    });
    const result = mapIRText(ir, toUpper);
    expect(result.state[0].initialValue).toBe('NULL');
  });

  it('transforms ref initialValues', () => {
    const ir = minimalIR({
      refs: [{ name: 'r', initialValue: 'null', isDom: false }],
    });
    const result = mapIRText(ir, toUpper);
    expect(result.refs[0].initialValue).toBe('NULL');
  });

  it('preserves non-text fields', () => {
    const ir = minimalIR({
      name: 'Foo',
      tagName: 'el-foo',
      props: [{ name: 'disabled', type: 'boolean', category: 'attribute' }],
    });
    const result = mapIRText(ir, toUpper);
    expect(result.name).toBe('Foo');
    expect(result.tagName).toBe('el-foo');
    expect(result.props[0].name).toBe('disabled');
  });
});
