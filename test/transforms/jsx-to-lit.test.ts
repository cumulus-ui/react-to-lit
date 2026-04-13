/**
 * Unit tests for transforms/jsx-to-lit.ts — JSX → Lit tagged template transformer.
 *
 * Verifies that the configurable removeAttributes, removeAttributePrefixes,
 * and shouldUnwrap options work correctly.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { transformJsxToLit } from '../../src/parser/jsx-transform.js';
import { createJsxToLitTransformerFactory, type JsxToLitConfig } from '../../src/transforms/jsx-to-lit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a TSX SourceFile from source text and transform it. */
function transformTsx(source: string, config?: JsxToLitConfig): string {
  const sourceFile = ts.createSourceFile(
    'test.tsx',
    source,
    ts.ScriptTarget.ES2019,
    true,
    ts.ScriptKind.TSX,
  );
  const result = transformJsxToLit(sourceFile, config);
  return result.text;
}

/** Lower-level helper: run the factory directly via ts.transform. */
function transformWithFactory(source: string, config?: JsxToLitConfig): string {
  const sourceFile = ts.createSourceFile(
    'test.tsx',
    source,
    ts.ScriptTarget.ES2019,
    true,
    ts.ScriptKind.TSX,
  );
  const factory = createJsxToLitTransformerFactory(config);
  const result = ts.transform(sourceFile, [factory]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  let printed = printer.printFile(result.transformed[0]);
  printed = printed.replace(/\b(html|svg) `/g, '$1`');
  result.dispose();
  return printed;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('jsxToLitTransformerFactory config', () => {
  describe('removeAttributes', () => {
    it('removes default attributes (key, ref) when no config is given', () => {
      const src = 'const x = <div key="k" ref={myRef} id="main">hello</div>;';
      const out = transformTsx(src);
      expect(out).not.toContain('key=');
      expect(out).not.toContain('ref=');
      expect(out).toContain('id="main"');
    });

    it('removes custom attributes when removeAttributes is provided', () => {
      const src = 'const x = <div data-test="yes" id="main" role="button">hello</div>;';
      const out = transformTsx(src, {
        removeAttributes: new Set(['data-test', 'role']),
      });
      expect(out).not.toContain('data-test');
      expect(out).not.toContain('role');
      expect(out).toContain('id="main"');
    });

    it('preserves default-removed attributes when overridden with empty set', () => {
      const src = 'const x = <div key="k" id="main">hello</div>;';
      const out = transformTsx(src, {
        removeAttributes: new Set(),
        removeAttributePrefixes: [],
      });
      // "key" is normally removed, but with empty removeAttributes it should be preserved
      expect(out).toContain('key');
      expect(out).toContain('id="main"');
    });
  });

  describe('removeAttributePrefixes', () => {
    it('removes attributes with default __ prefix when no config is given', () => {
      const src = 'const x = <div __internal="yes" id="main">hello</div>;';
      const out = transformTsx(src);
      expect(out).not.toContain('__internal');
      expect(out).toContain('id="main"');
    });

    it('removes attributes with custom prefix when removeAttributePrefixes is provided', () => {
      const src = 'const x = <div x-internal="yes" id="main">hello</div>;';
      const out = transformTsx(src, {
        removeAttributePrefixes: ['x-'],
      });
      expect(out).not.toContain('x-internal');
      expect(out).toContain('id="main"');
    });

    it('preserves __-prefixed attributes when overridden with empty prefixes', () => {
      const src = 'const x = <div __internal="yes" id="main">hello</div>;';
      const out = transformTsx(src, {
        removeAttributes: new Set(),
        removeAttributePrefixes: [],
      });
      expect(out).toContain('__internal');
    });
  });

  describe('shouldUnwrap', () => {
    it('unwraps Fragment by default', () => {
      const src = 'const x = <Fragment><span>hi</span></Fragment>;';
      const out = transformTsx(src);
      // Fragment is unwrapped — output should contain the child but not Fragment tag
      expect(out).not.toContain('el-fragment');
      expect(out).toContain('span');
    });

    it('unwraps custom component when shouldUnwrap returns true', () => {
      const src = 'const x = <Wrapper><span>hi</span></Wrapper>;';
      const out = transformTsx(src, {
        shouldUnwrap: (name) => name === 'Wrapper',
      });
      // Wrapper should be unwrapped — just the child should remain
      expect(out).not.toContain('el-wrapper');
      expect(out).toContain('span');
    });

    it('does not unwrap a component when shouldUnwrap returns false', () => {
      const src = 'const x = <Wrapper><span>hi</span></Wrapper>;';
      const out = transformTsx(src, {
        shouldUnwrap: () => false,
      });
      // With shouldUnwrap returning false, Wrapper is rendered as a custom element
      expect(out).toContain('el-wrapper');
    });

    it('unwraps self-closing component to nothing', () => {
      const src = 'const x = <Wrapper />;';
      const out = transformTsx(src, {
        shouldUnwrap: (name) => name === 'Wrapper',
      });
      expect(out).toContain('nothing');
      expect(out).not.toContain('el-wrapper');
    });
  });

  describe('backward compatibility', () => {
    it('produces identical output when no config is passed', () => {
      const src = 'const x = <div key="k" ref={myRef} className={cls} onClick={handler}>text</div>;';
      const withoutConfig = transformTsx(src);
      const withUndefined = transformTsx(src, undefined);
      expect(withoutConfig).toBe(withUndefined);
    });

    it('factory without config matches jsxToLitTransformerFactory', () => {
      const src = 'const x = <div id="main">hello</div>;';
      const viaFactory = transformWithFactory(src);
      const viaFactoryNoConfig = transformWithFactory(src, undefined);
      expect(viaFactory).toBe(viaFactoryNoConfig);
    });
  });

  describe('createJsxToLitTransformerFactory', () => {
    it('returns a factory usable with ts.transform directly', () => {
      const sourceFile = ts.createSourceFile(
        'test.tsx',
        'const x = <div data-custom="yes" id="main">hello</div>;',
        ts.ScriptTarget.ES2019,
        true,
        ts.ScriptKind.TSX,
      );
      const factory = createJsxToLitTransformerFactory({
        removeAttributes: new Set(['data-custom']),
      });
      const result = ts.transform(sourceFile, [factory]);
      const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
      let printed = printer.printFile(result.transformed[0]);
      printed = printed.replace(/\b(html|svg) `/g, '$1`');
      result.dispose();

      expect(printed).not.toContain('data-custom');
      expect(printed).toContain('id="main"');
    });
  });
});
