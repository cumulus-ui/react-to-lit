import { describe, it, expect } from 'vitest';
import { promotePreambleVars, type PreambleVar } from '../../src/parser/index.js';
import type { HandlerIR, HelperIR, EffectIR, PublicMethodIR, ComputedIR } from '../../src/ir/types.js';

function promote(
  preambleVars: PreambleVar[],
  bodyPreamble: string[],
  overrides: {
    handlers?: HandlerIR[];
    helpers?: HelperIR[];
    effects?: EffectIR[];
    publicMethods?: PublicMethodIR[];
    computedValues?: ComputedIR[];
  } = {},
) {
  return promotePreambleVars(
    preambleVars,
    bodyPreamble,
    overrides.handlers ?? [],
    overrides.helpers ?? [],
    overrides.effects ?? [],
    overrides.publicMethods ?? [],
    overrides.computedValues ?? [],
    new Set<string>(),
  );
}

describe('promotePreambleVars — preamble chain promotion', () => {
  it('promotes a→b→c chain when handler references a', () => {
    const preambleVars: PreambleVar[] = [
      { name: 'a', expression: 'b + 1' },
      { name: 'b', expression: 'c * 2' },
      { name: 'c', expression: 'this.x' },
    ];
    const bodyPreamble = [
      'const a = b + 1',
      'const b = c * 2',
      'const c = this.x',
    ];

    const result = promote(preambleVars, bodyPreamble, {
      handlers: [{ name: 'onClick', body: 'doStuff(a)', params: '' }],
    });

    const names = result.computedValues.map(cv => cv.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).toContain('c');
    expect(result.bodyPreamble).toHaveLength(0);
  });

  it('promotes a→b when helper references a', () => {
    const preambleVars: PreambleVar[] = [
      { name: 'isButton', expression: '!href' },
      { name: 'sharedProps', expression: '{ className: isButton ? "btn" : "link" }' },
    ];
    const bodyPreamble = [
      'const isButton = !href',
      'const sharedProps = { className: isButton ? "btn" : "link" }',
    ];

    const result = promote(preambleVars, bodyPreamble, {
      helpers: [{ name: 'renderContent', source: 'function renderContent() { return sharedProps.className; }' }],
    });

    const names = result.computedValues.map(cv => cv.name);
    expect(names).toContain('sharedProps');
    expect(names).toContain('isButton');
    expect(result.bodyPreamble).toHaveLength(0);
  });

  it('does not promote vars unrelated to the chain', () => {
    const preambleVars: PreambleVar[] = [
      { name: 'a', expression: 'b + 1' },
      { name: 'b', expression: '42' },
      { name: 'unrelated', expression: 'Math.random()' },
    ];
    const bodyPreamble = [
      'const a = b + 1',
      'const b = 42',
      'const unrelated = Math.random()',
    ];

    const result = promote(preambleVars, bodyPreamble, {
      handlers: [{ name: 'onClick', body: 'use(a)', params: '' }],
    });

    const names = result.computedValues.map(cv => cv.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).not.toContain('unrelated');
    expect(result.bodyPreamble).toEqual(['const unrelated = Math.random()']);
  });

  it('promotes via effect body reference', () => {
    const preambleVars: PreambleVar[] = [
      { name: 'x', expression: 'y + 1' },
      { name: 'y', expression: 'this.prop' },
    ];
    const bodyPreamble = ['const x = y + 1', 'const y = this.prop'];

    const result = promote(preambleVars, bodyPreamble, {
      effects: [{ body: 'console.log(x)', deps: ['x'] }],
    });

    const names = result.computedValues.map(cv => cv.name);
    expect(names).toContain('x');
    expect(names).toContain('y');
  });
});
