/**
 * Unit tests for transforms/cleanup-core.ts — core generic patterns.
 */
import { describe, it, expect } from 'vitest';
import { applyCoreCleanup, applyPlugin, type CleanupPlugin } from '../../src/transforms/cleanup-core.js';
import { cloudscapeCleanupPlugin, createCloudscapeConfig } from '../../src/presets/cloudscape.js';
import { removeLibraryInternals } from '../../src/transforms/cleanup.js';
import type { ComponentIR } from '../../src/ir/types.js';

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

// ---------------------------------------------------------------------------
// Core cleanup with no plugin
// ---------------------------------------------------------------------------

describe('applyCoreCleanup', () => {
  describe('rest/spread cleanup (generic)', () => {
    it('replaces rest.xxx with undefined', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const id = rest.controlId;', params: '' }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.handlers[0].body).toContain('undefined');
      expect(result.handlers[0].body).not.toContain('rest.controlId');
    });

    it('removes {...rest} spread', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'return { disabled, {...rest} };', params: '' }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.handlers[0].body).not.toContain('rest');
    });

    it('removes const destructuring from rest', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          body: 'const { ariaLabelledby, controlId } = rest; return controlId;',
          params: '',
        }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.handlers[0].body).not.toContain('= rest');
    });

    it('cleans rest/spread in template expressions', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'input',
          attributes: [{
            name: '.aria-labelledby',
            value: { expression: 'rest.ariaLabelledby' },
            kind: 'property',
          }],
          children: [],
        },
      });
      const result = applyCoreCleanup(ir, new Set());
      const attr = result.template.attributes[0];
      const expr = typeof attr.value === 'object' ? attr.value.expression : attr.value;
      expect(expr).toBe('undefined');
    });
  });

  describe('__-prefixed variable cleanup (generic)', () => {
    it('strips __xxx && expr in handler bodies', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: '__focusable && doStuff();', params: '' }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.handlers[0].body).not.toContain('__focusable');
    });

    it('replaces bare __xxx with false in template classMap', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [{
            name: 'class',
            value: { expression: "classMap({ 'hidden': __hideLabel })" },
            kind: 'attribute',
          }],
          children: [],
        },
      });
      const result = applyCoreCleanup(ir, new Set());
      const expr = (result.template.attributes[0].value as { expression: string }).expression;
      expect(expr).toContain("'hidden': false");
    });

    it('removes __-prefixed key-value pairs from object literals', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          body: 'const obj = { visible: true, __internal: someCall(a, b), name: "test" };',
          params: '',
        }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.handlers[0].body).not.toContain('__internal');
      expect(result.handlers[0].body).toContain('visible: true');
      expect(result.handlers[0].body).toContain('name: "test"');
    });

    it('removes __-prefixed function parameters', () => {
      const ir = minimalIR({
        helpers: [{
          name: 'fn',
          source: 'function fn({ size, __darkHeader, visible }: Props) { return size; }',
        }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.helpers[0].source).not.toContain('__darkHeader');
      expect(result.helpers[0].source).toContain('size');
    });

    it('replaces bare __xxx in template interpolation with false', () => {
      const ir = minimalIR({
        helpers: [{
          name: 'renderContent',
          source: 'function renderContent() { return html`<el-body .closeAction=${__closeAnalyticsAction}></el-body>`; }',
        }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.helpers[0].source).not.toContain('__closeAnalyticsAction');
      expect(result.helpers[0].source).toContain('.closeAction=${false}');
    });
  });

  describe('createPortal unwrapping (generic)', () => {
    it('unwraps createPortal in handler body to its first argument', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          body: 'return createPortal(html`<div>${id}</div>`, document.body);',
          params: '',
        }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.handlers[0].body).not.toContain('createPortal');
      expect(result.handlers[0].body).toContain('html`<div>${id}</div>`');
    });
  });

  describe('dead-code simplification (generic)', () => {
    it('simplifies undefined ?? expr to expr', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const x = undefined ?? fallback;', params: '' }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.handlers[0].body).toBe('const x = fallback;');
    });

    it('simplifies undefined || expr to expr', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const x = undefined || fallback;', params: '' }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.handlers[0].body).toBe('const x = fallback;');
    });

    it('simplifies !undefined to true', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const x = !undefined;', params: '' }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.handlers[0].body).toBe('const x = true;');
    });
  });

  describe('skip props cleanup', () => {
    it('replaces skipProp references with undefined', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          body: 'const val = nativeButtonAttributes?.tabIndex;',
          params: '',
        }],
      });
      const result = applyCoreCleanup(ir, new Set(['nativeButtonAttributes']));
      expect(result.handlers[0].body).toContain('undefined');
    });
  });

  describe('prop filtering', () => {
    it('removes __-prefixed props', () => {
      const ir = minimalIR({
        props: [
          { name: '__internal', type: 'string', category: 'attribute' },
          { name: 'visible', type: 'boolean', category: 'attribute' },
        ],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.props.map(p => p.name)).toEqual(['visible']);
    });

    it('removes props in skipProps set', () => {
      const ir = minimalIR({
        props: [
          { name: 'nativeAttributes', type: 'object', category: 'property' },
          { name: 'visible', type: 'boolean', category: 'attribute' },
        ],
      });
      const result = applyCoreCleanup(ir, new Set(['nativeAttributes']));
      expect(result.props.map(p => p.name)).toEqual(['visible']);
    });
  });

  describe('template attribute filtering', () => {
    it('removes spread attributes', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [
            { name: '...props', value: { expression: 'props' }, kind: 'spread' },
            { name: 'title', value: 'hello', kind: 'attribute' },
          ],
          children: [],
        },
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.template.attributes).toHaveLength(1);
      expect(result.template.attributes[0].name).toBe('title');
    });

    it('removes .__-prefixed attributes', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [
            { name: '.__internal', value: { expression: 'true' }, kind: 'property' },
            { name: 'title', value: 'hello', kind: 'attribute' },
          ],
          children: [],
        },
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.template.attributes).toHaveLength(1);
      expect(result.template.attributes[0].name).toBe('title');
    });

    it('removes attributes whose value is purely a __xxx variable', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [
            { name: '.icon', value: { expression: '__rightIcon' }, kind: 'property' },
            { name: 'title', value: 'hello', kind: 'attribute' },
          ],
          children: [],
        },
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.template.attributes).toHaveLength(1);
      expect(result.template.attributes[0].name).toBe('title');
    });
  });

  describe('infra function filtering', () => {
    it('removes helpers matching infraFunctions', () => {
      const ir = minimalIR({
        helpers: [
          { name: 'applyDisplayName', source: 'function applyDisplayName() {}' },
          { name: 'renderContent', source: 'function renderContent() { return "ok"; }' },
        ],
      });
      const result = applyCoreCleanup(ir, new Set(), createCloudscapeConfig().cleanup);
      // infraFunctions filter removed — helpers pass through (emitter handles unused elimination)
      expect(result.helpers.map(h => h.name)).toEqual(['applyDisplayName', 'renderContent']);
    });
  });

  describe('effect dependency cleanup', () => {
    it('removes __internalRootRef from effect deps', () => {
      const ir = minimalIR({
        effects: [{ body: 'doSomething();', deps: ['value', '__internalRootRef'] }],
      });
      const result = applyCoreCleanup(ir, new Set());
      expect(result.effects[0].deps).toEqual(['value']);
    });
  });

  describe('core cleanup with custom config (no plugin)', () => {
    it('uses custom skipProps and removeAttributes (infraFunctions filter removed)', () => {
      const ir = minimalIR({
        props: [
          { name: 'myInternalProp', type: 'string', category: 'attribute' },
          { name: 'visible', type: 'boolean', category: 'attribute' },
        ],
        helpers: [
          { name: 'myInfra', source: 'function myInfra() {}' },
          { name: 'renderContent', source: 'function renderContent() { return "ok"; }' },
        ],
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [
            { name: 'data-custom', value: 'x', kind: 'attribute' },
            { name: 'title', value: 'hello', kind: 'attribute' },
          ],
          children: [],
        },
      });
      const result = applyCoreCleanup(ir, new Set(['myInternalProp']));
      expect(result.props.map(p => p.name)).toEqual(['visible']);
      expect(result.helpers.map(h => h.name)).toEqual(['myInfra', 'renderContent']);
      expect(result.template.attributes.map(a => a.name)).toEqual(['data-custom', 'title']);
    });
  });
});

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

describe('CleanupPlugin interface', () => {
  it('applyPlugin calls cleanBody on handler bodies', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: 'MARKER_BODY_TEXT', params: '' }],
    });
    const plugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('MARKER_BODY_TEXT', 'REPLACED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.handlers[0].body).toBe('REPLACED');
  });

  it('applyPlugin calls cleanBody on effect bodies', () => {
    const ir = minimalIR({
      effects: [{ body: 'MARKER_EFFECT', deps: [] }],
    });
    const plugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('MARKER_EFFECT', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.effects[0].body).toBe('CLEANED');
  });

  it('applyPlugin calls cleanBody on effect cleanup', () => {
    const ir = minimalIR({
      effects: [{ body: 'run();', deps: [], cleanup: 'MARKER_CLEANUP' }],
    });
    const plugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('MARKER_CLEANUP', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.effects[0].cleanup).toBe('CLEANED');
  });

  it('applyPlugin calls cleanBody on helper source', () => {
    const ir = minimalIR({
      helpers: [{ name: 'fn', source: 'MARKER_HELPER' }],
    });
    const plugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('MARKER_HELPER', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.helpers[0].source).toBe('CLEANED');
  });

  it('applyPlugin calls cleanBody on bodyPreamble', () => {
    const ir = minimalIR({
      bodyPreamble: ['MARKER_PREAMBLE'],
    });
    const plugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('MARKER_PREAMBLE', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.bodyPreamble[0]).toBe('CLEANED');
  });

  it('applyPlugin calls cleanBody on publicMethods', () => {
    const ir = minimalIR({
      publicMethods: [{ name: 'focus', params: '', body: 'MARKER_METHOD' }],
    });
    const plugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('MARKER_METHOD', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.publicMethods[0].body).toBe('CLEANED');
  });

  it('applyPlugin calls cleanBody on computedValues', () => {
    const ir = minimalIR({
      computedValues: [{ name: 'val', expression: 'MARKER_COMPUTED', deps: [] }],
    });
    const plugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('MARKER_COMPUTED', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.computedValues[0].expression).toBe('CLEANED');
  });

  it('applyPlugin calls cleanBody on fileTypeDeclarations', () => {
    const ir = minimalIR({
      fileTypeDeclarations: ['MARKER_TYPEDECL'],
    });
    const plugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('MARKER_TYPEDECL', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.fileTypeDeclarations[0]).toBe('CLEANED');
  });

  it('applyPlugin calls cleanBody on fileConstants', () => {
    const ir = minimalIR({
      fileConstants: ['MARKER_CONST'],
    });
    const plugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('MARKER_CONST', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.fileConstants[0]).toBe('CLEANED');
  });

  it('applyPlugin calls cleanAttribute on template attributes', () => {
    const ir = minimalIR({
      template: {
        kind: 'element',
        tag: 'div',
        attributes: [
          { name: 'data-remove', value: 'x', kind: 'attribute' },
          { name: 'title', value: 'hello', kind: 'attribute' },
        ],
        children: [],
      },
    });
    const plugin: CleanupPlugin = {
      cleanAttribute: (attr) => attr.name === 'data-remove' ? null : attr,
    };
    const result = applyPlugin(ir, plugin);
    expect(result.template.attributes).toHaveLength(1);
    expect(result.template.attributes[0].name).toBe('title');
  });

  it('applyPlugin calls cleanExpression on template expressions', () => {
    const ir = minimalIR({
      template: {
        kind: 'element',
        tag: 'div',
        attributes: [],
        children: [{
          kind: 'expression',
          attributes: [],
          children: [],
          expression: 'MARKER_EXPR',
        }],
      },
    });
    const plugin: CleanupPlugin = {
      cleanExpression: (expr) => expr.replace('MARKER_EXPR', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.template.children[0].expression).toBe('CLEANED');
  });

  it('applyPlugin calls cleanExpression on attribute expressions', () => {
    const ir = minimalIR({
      template: {
        kind: 'element',
        tag: 'div',
        attributes: [{
          name: '.foo',
          value: { expression: 'MARKER_ATTR_EXPR' },
          kind: 'property',
        }],
        children: [],
      },
    });
    const plugin: CleanupPlugin = {
      cleanExpression: (expr) => expr.replace('MARKER_ATTR_EXPR', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    const expr = (result.template.attributes[0].value as { expression: string }).expression;
    expect(expr).toBe('CLEANED');
  });

  it('applyPlugin calls cleanExpression on condition expressions', () => {
    const ir = minimalIR({
      template: {
        kind: 'element',
        tag: 'div',
        attributes: [],
        children: [{
          kind: 'element',
          tag: 'span',
          attributes: [],
          children: [],
          condition: {
            expression: 'MARKER_COND',
            kind: 'and',
          },
        }],
      },
    });
    const plugin: CleanupPlugin = {
      cleanExpression: (expr) => expr.replace('MARKER_COND', 'CLEANED'),
    };
    const result = applyPlugin(ir, plugin);
    expect(result.template.children[0].condition!.expression).toBe('CLEANED');
  });

  it('plugin with no methods is a no-op', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: 'unchanged', params: '' }],
    });
    const plugin: CleanupPlugin = {};
    const result = applyPlugin(ir, plugin);
    expect(result.handlers[0].body).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// Cloudscape plugin produces identical output to monolithic cleanup
// ---------------------------------------------------------------------------

describe('Cloudscape plugin equivalence', () => {
  it('produces identical output for testUtilStyles stripping', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: "const cls = testUtilStyles['header'];", params: '' }],
    });
    const monolithic = removeLibraryInternals(ir, new Set(), cloudscapeCleanupPlugin);
    const split = applyPlugin(applyCoreCleanup(ir, new Set()), cloudscapeCleanupPlugin);
    expect(split.handlers[0].body).toBe(monolithic.handlers[0].body);
  });

  it('produces identical output for analyticsSelectors stripping', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: 'const s = analyticsSelectors.header;', params: '' }],
    });
    const monolithic = removeLibraryInternals(ir, new Set(), cloudscapeCleanupPlugin);
    const split = applyPlugin(applyCoreCleanup(ir, new Set()), cloudscapeCleanupPlugin);
    expect(split.handlers[0].body).toBe(monolithic.handlers[0].body);
  });

  it('produces identical output for baseProps removal', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: 'const baseProps = getBaseProps(rest);\n{...baseProps}', params: '' }],
    });
    const monolithic = removeLibraryInternals(ir, new Set(), cloudscapeCleanupPlugin);
    const split = applyPlugin(applyCoreCleanup(ir, new Set()), cloudscapeCleanupPlugin);
    expect(split.handlers[0].body).toBe(monolithic.handlers[0].body);
  });

  it('produces identical output for checkSafeUrl removal', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: "checkSafeUrl('Button', href);\nreturn href;", params: '' }],
    });
    const monolithic = removeLibraryInternals(ir, new Set(), cloudscapeCleanupPlugin);
    const split = applyPlugin(applyCoreCleanup(ir, new Set()), cloudscapeCleanupPlugin);
    expect(split.handlers[0].body).toBe(monolithic.handlers[0].body);
  });

  it('produces identical output for useBaseComponent removal', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: "const { __internalRootRef } = useBaseComponent('Button');", params: '' }],
    });
    const monolithic = removeLibraryInternals(ir, new Set(), cloudscapeCleanupPlugin);
    const split = applyPlugin(applyCoreCleanup(ir, new Set()), cloudscapeCleanupPlugin);
    expect(split.handlers[0].body).toBe(monolithic.handlers[0].body);
  });

  it('produces identical output for complex handler with multiple patterns', () => {
    const ir = minimalIR({
      props: [
        { name: '__internal', type: 'string', category: 'attribute' },
        { name: 'nativeAttributes', type: 'object', category: 'property' },
        { name: 'visible', type: 'boolean', category: 'attribute' },
      ],
      handlers: [{
        name: 'h',
        body: [
          'const baseProps = getBaseProps(rest);',
          "checkSafeUrl('Button', href);",
          "const cls = testUtilStyles['header'];",
          '__focusable && doStuff();',
          'const id = rest.controlId;',
        ].join('\n'),
        params: '',
      }],
      template: {
        kind: 'element',
        tag: 'div',
        attributes: [{
          name: 'class',
          value: { expression: "classMap({ 'hidden': __hideLabel, 'active': this.active })" },
          kind: 'attribute',
        }],
        children: [{
          kind: 'expression',
          attributes: [],
          children: [],
          expression: 'analyticsSelectors.header || defaultLabel',
        }],
      },
    });
    const monolithic = removeLibraryInternals(ir, new Set(), cloudscapeCleanupPlugin);
    const split = applyPlugin(applyCoreCleanup(ir, new Set()), cloudscapeCleanupPlugin);
    expect(split.props).toEqual(monolithic.props);
    expect(split.handlers[0].body).toBe(monolithic.handlers[0].body);
    // Check template attribute expression
    const monolithicExpr = (monolithic.template.attributes[0].value as { expression: string }).expression;
    const splitExpr = (split.template.attributes[0].value as { expression: string }).expression;
    expect(splitExpr).toBe(monolithicExpr);
    // Check template child expression
    expect(split.template.children[0].expression).toBe(monolithic.template.children[0].expression);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator behavior (removeLibraryInternals)
// ---------------------------------------------------------------------------

describe('removeLibraryInternals orchestrator', () => {
  it('with no plugin applies core only (no library-specific cleanup)', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: "const cls = testUtilStyles['header'];", params: '' }],
    });
    const result = removeLibraryInternals(ir, new Set());
    expect(result.handlers[0].body).toContain('testUtilStyles');
  });

  it('with explicit empty plugin applies core only (no Cloudscape)', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: "const cls = testUtilStyles['header'];", params: '' }],
    });
    const noopPlugin: CleanupPlugin = {};
    const result = removeLibraryInternals(ir, new Set(), noopPlugin);
    expect(result.handlers[0].body).toContain('testUtilStyles');
  });

  it('with config AND explicit plugin applies both', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: "const cls = testUtilStyles['header'];", params: '' }],
    });
    const result = removeLibraryInternals(ir, new Set(), cloudscapeCleanupPlugin);
    expect(result.handlers[0].body).not.toContain('testUtilStyles');
  });

  it('with custom plugin applies that plugin instead of Cloudscape', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: 'CUSTOM_MARKER text', params: '' }],
    });
    const customPlugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('CUSTOM_MARKER', 'REPLACED'),
    };
    const result = removeLibraryInternals(ir, new Set(), customPlugin);
    // Cloudscape plugin explicitly passed, so testUtilStyles IS removed
    expect(result.handlers[0].body).not.toContain('testUtilStyles');
  });

  it('with custom plugin applies that plugin instead of Cloudscape', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: 'CUSTOM_MARKER text', params: '' }],
    });
    const customPlugin: CleanupPlugin = {
      cleanBody: (text) => text.replace('CUSTOM_MARKER', 'REPLACED'),
    };
    const result = removeLibraryInternals(ir, new Set(), customPlugin);
    expect(result.handlers[0].body).toBe('REPLACED text');
  });
});
