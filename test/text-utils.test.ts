/**
 * Unit tests for text utilities (src/text-utils.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  findMatchingParen,
  findTopLevel,
  splitTopLevel,
  stripFunctionCalls,
  stripIfBlocks,
  unwrapFunctionCall,
} from '../src/text-utils.js';

// ---------------------------------------------------------------------------
// findMatchingParen
// ---------------------------------------------------------------------------

describe('findMatchingParen', () => {
  it('finds simple matching paren', () => {
    expect(findMatchingParen('foo(bar)', 3)).toBe(7);
  });

  it('handles nested parens', () => {
    expect(findMatchingParen('foo(bar(baz))', 3)).toBe(12);
  });

  it('skips single-quoted strings', () => {
    expect(findMatchingParen("foo('a)', b)", 3)).toBe(11);
  });

  it('skips double-quoted strings', () => {
    expect(findMatchingParen('foo("a)", b)', 3)).toBe(11);
  });

  it('skips template literals', () => {
    expect(findMatchingParen('foo(`a)`, b)', 3)).toBe(11);
  });

  it('skips template literals with interpolation', () => {
    expect(findMatchingParen('foo(`${x}`, b)', 3)).toBe(13);
  });

  it('returns -1 when no match', () => {
    expect(findMatchingParen('foo(bar', 3)).toBe(-1);
  });

  it('handles allBrackets mode', () => {
    expect(findMatchingParen('{a: [1]}', 0, { allBrackets: true })).toBe(7);
  });

  it('handles allBrackets with nested types', () => {
    expect(findMatchingParen('[a, {b: c}]', 0, { allBrackets: true })).toBe(10);
  });

  it('handles escaped chars in strings', () => {
    expect(findMatchingParen("foo('a\\')b', c)", 3)).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// findTopLevel
// ---------------------------------------------------------------------------

describe('findTopLevel', () => {
  it('finds char at top level', () => {
    expect(findTopLevel('a, b, c', ',')).toBe(1);
  });

  it('skips char inside parens', () => {
    expect(findTopLevel('fn(a, b), c', ',')).toBe(8);
  });

  it('skips char inside braces', () => {
    expect(findTopLevel('{a, b}, c', ',')).toBe(6);
  });

  it('skips char inside brackets', () => {
    expect(findTopLevel('[a, b], c', ',')).toBe(6);
  });

  it('skips char inside template literal', () => {
    expect(findTopLevel('`a,b`, c', ',')).toBe(5);
  });

  it('returns -1 when not found', () => {
    expect(findTopLevel('abc', ',')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// splitTopLevel
// ---------------------------------------------------------------------------

describe('splitTopLevel', () => {
  it('splits simple comma-separated values', () => {
    expect(splitTopLevel('a, b, c', ',')).toEqual(['a', ' b', ' c']);
  });

  it('preserves nested commas', () => {
    expect(splitTopLevel('fn(a, b), c', ',')).toEqual(['fn(a, b)', ' c']);
  });

  it('preserves braces', () => {
    expect(splitTopLevel('{a, b}, {c}', ',')).toEqual(['{a, b}', ' {c}']);
  });

  it('handles template literals with interpolation', () => {
    expect(splitTopLevel('`${x},y`, z', ',')).toEqual(['`${x},y`', ' z']);
  });

  it('returns single element for no-separator input', () => {
    expect(splitTopLevel('foobar', ',')).toEqual(['foobar']);
  });

  it('skips empty trailing parts', () => {
    expect(splitTopLevel('a, ', ',')).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// stripFunctionCalls
// ---------------------------------------------------------------------------

describe('stripFunctionCalls', () => {
  it('strips a simple function call', () => {
    expect(stripFunctionCalls('foo(); bar();', 'foo')).toBe(' bar();');
  });

  it('strips multiple occurrences', () => {
    const input = 'foo(1);\nfoo(2);\nbar();';
    expect(stripFunctionCalls(input, 'foo')).toBe('bar();');
  });

  it('handles nested parens in arguments', () => {
    expect(stripFunctionCalls('foo(a(b));\nbar();', 'foo')).toBe('bar();');
  });

  it('does not strip when function name is substring', () => {
    expect(stripFunctionCalls('fooBar(1);', 'foo')).toBe('fooBar(1);');
  });

  it('handles multi-line calls', () => {
    const input = 'foo(\n  a,\n  b\n);\nbar();';
    expect(stripFunctionCalls(input, 'foo')).toBe('bar();');
  });
});

// ---------------------------------------------------------------------------
// stripIfBlocks
// ---------------------------------------------------------------------------

describe('stripIfBlocks', () => {
  it('strips an if block matching a pattern', () => {
    const input = 'before;\nif (__debug) {\n  log();\n}\nafter;';
    expect(stripIfBlocks(input, /if\s*\(\s*__\w+\s*\)/)).toBe('before;\nafter;');
  });

  it('handles nested braces in the if body', () => {
    const input = 'if (__dev) {\n  if (true) { a(); }\n}\nok;';
    expect(stripIfBlocks(input, /if\s*\(\s*__\w+\s*\)/)).toBe('ok;');
  });

  it('does not strip non-matching if blocks', () => {
    const input = 'if (visible) { show(); }';
    expect(stripIfBlocks(input, /if\s*\(\s*__\w+\s*\)/)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// unwrapFunctionCall
// ---------------------------------------------------------------------------

describe('unwrapFunctionCall', () => {
  it('unwraps a simple two-argument call to its first argument', () => {
    expect(unwrapFunctionCall('createPortal(content, target)', 'createPortal'))
      .toBe('content');
  });

  it('unwraps when the first argument is a template literal', () => {
    const input = 'return createPortal(html`<div>${id}</div>`, document.body);';
    const result = unwrapFunctionCall(input, 'createPortal');
    expect(result).toBe('return html`<div>${id}</div>`;');
  });

  it('unwraps when the first argument contains nested function calls', () => {
    expect(unwrapFunctionCall('createPortal(render(a, b), target)', 'createPortal'))
      .toBe('render(a, b)');
  });

  it('returns the single argument when there is no comma', () => {
    expect(unwrapFunctionCall('createPortal(content)', 'createPortal'))
      .toBe('content');
  });

  it('does not modify text when the function is not present', () => {
    const input = 'doStuff(a, b)';
    expect(unwrapFunctionCall(input, 'createPortal')).toBe(input);
  });

  it('handles commas inside strings in the first argument', () => {
    expect(unwrapFunctionCall(`createPortal("a, b", target)`, 'createPortal'))
      .toBe('"a, b"');
  });

  it('handles commas inside template literals in the first argument', () => {
    const input = 'createPortal(html`<div a=${x}, b=${y}></div>`, document.body)';
    const result = unwrapFunctionCall(input, 'createPortal');
    expect(result).toBe('html`<div a=${x}, b=${y}></div>`');
  });
});
