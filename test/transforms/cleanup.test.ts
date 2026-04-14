/**
 * Unit tests for transforms/cleanup.ts — Cloudscape internals stripping.
 */
import { describe, it, expect } from 'vitest';
import { removeCloudscapeInternals, removeLibraryInternals } from '../../src/transforms/cleanup.js';
import { createCloudscapeConfig } from '../../src/presets/cloudscape.js';
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
// testUtilStyles / analyticsSelectors stripping
// ---------------------------------------------------------------------------

describe('removeCloudscapeInternals', () => {
  describe('testUtilStyles stripping', () => {
    it('strips bracket-access testUtilStyles in handler bodies', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: "const cls = testUtilStyles['header'];", params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).not.toContain('testUtilStyles');
    });

    it('strips dot-access testUtilStyles in handler bodies', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const cls = testUtilStyles.header;', params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).not.toContain('testUtilStyles');
    });

    it('strips dot-access testUtilStyles in effect bodies', () => {
      const ir = minimalIR({
        effects: [{ body: 'el.className = testUtilStyles.slider;', deps: [] }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.effects[0].body).not.toContain('testUtilStyles');
    });

    it('strips dot-access testUtilStyles in computed values', () => {
      const ir = minimalIR({
        computedValues: [{ name: 'cls', expression: 'testUtilStyles.footer', deps: [] }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.computedValues[0].expression).not.toContain('testUtilStyles');
    });

    it('strips dot-access testUtilStyles in body preamble', () => {
      const ir = minimalIR({
        bodyPreamble: ['const cls = testUtilStyles.content;'],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.bodyPreamble[0]).not.toContain('testUtilStyles');
    });

    it('strips dot-access testUtilStyles in helper source', () => {
      const ir = minimalIR({
        helpers: [{ name: 'fn', source: 'function fn() { return testUtilStyles.root; }' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.helpers[0].source).not.toContain('testUtilStyles');
    });
  });

  describe('analyticsSelectors stripping', () => {
    it('strips bracket-access analyticsSelectors in handler bodies', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: "const s = analyticsSelectors['container'];", params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).not.toContain('analyticsSelectors');
    });

    it('strips dot-access analyticsSelectors in handler bodies', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const s = analyticsSelectors.header;', params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).not.toContain('analyticsSelectors');
    });

    it('strips dot-access analyticsSelectors in effect bodies', () => {
      const ir = minimalIR({
        effects: [{ body: 'label = analyticsSelectors.container;', deps: [] }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.effects[0].body).not.toContain('analyticsSelectors');
    });
  });

  describe('createPortal unwrapping', () => {
    it('unwraps createPortal in handler body to its first argument', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          body: 'return createPortal(html`<div>${id}</div>`, document.body);',
          params: '',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).not.toContain('createPortal');
      expect(result.handlers[0].body).toContain('html`<div>${id}</div>`');
    });

    it('unwraps createPortal in helper source', () => {
      const ir = minimalIR({
        helpers: [{
          name: 'renderPortal',
          source: 'function renderPortal() { return createPortal(content, target); }',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.helpers[0].source).not.toContain('createPortal');
      expect(result.helpers[0].source).toContain('return content;');
    });
  });

  describe('rest/spread cleanup', () => {
    it('replaces rest.xxx with undefined in handler bodies', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const id = rest.controlId;', params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).toContain('undefined');
      expect(result.handlers[0].body).not.toContain('rest.controlId');
    });

    it('replaces rest.xxx with undefined in template expressions', () => {
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
      const result = removeCloudscapeInternals(ir, new Set());
      const attr = result.template.attributes[0];
      const expr = typeof attr.value === 'object' ? attr.value.expression : attr.value;
      expect(expr).toBe('undefined');
    });

    it('replaces restProps.xxx with undefined in template expressions', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [],
          children: [{
            kind: 'expression',
            attributes: [],
            children: [],
            expression: 'restProps.controlId || defaultId',
          }],
        },
      });
      const result = removeCloudscapeInternals(ir, new Set());
      // restProps.controlId → undefined, then undefined || defaultId → defaultId
      expect(result.template.children[0].expression).toBe('defaultId');
    });

    it('removes {...rest} spread from handler bodies', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'return { disabled, {...rest} };', params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
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
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).not.toContain('= rest');
    });
  });

  describe('__-prefixed variable cleanup', () => {
    it('strips __xxx && expr in handler bodies', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: '__focusable && doStuff();', params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).not.toContain('__focusable');
    });

    it('replaces __xxx && expr with false in template classMap', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [{
            name: 'class',
            value: { expression: "classMap({ 'no-wrap': __disableActionsWrapping })" },
            kind: 'attribute',
          }],
          children: [],
        },
      });
      const result = removeCloudscapeInternals(ir, new Set());
      const expr = (result.template.attributes[0].value as { expression: string }).expression;
      expect(expr).not.toContain('__disableActionsWrapping');
      expect(expr).toContain('false');
    });

    it('replaces __xxx && complexExpr with false in classMap without eating commas', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [{
            name: 'class',
            value: { expression: "classMap({ 'sticky': __stickyHeader && !this._isSticky, 'stuck': this._isStuck })" },
            kind: 'attribute',
          }],
          children: [],
        },
      });
      const result = removeCloudscapeInternals(ir, new Set());
      const expr = (result.template.attributes[0].value as { expression: string }).expression;
      expect(expr).not.toContain('__stickyHeader');
      expect(expr).toContain("'sticky': false");
      expect(expr).toContain("'stuck': this._isStuck");
    });

    it('preserves expr in !__xxx && expr template expressions', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [],
          children: [{
            kind: 'expression',
            attributes: [],
            children: [],
            expression: '!__hideLabel && this.info',
          }],
        },
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.template.children[0].expression).toBe('this.info');
    });

    it('replaces bare __xxx with false in template expressions', () => {
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
      const result = removeCloudscapeInternals(ir, new Set());
      const expr = (result.template.attributes[0].value as { expression: string }).expression;
      expect(expr).toContain("'hidden': false");
    });
  });

  describe('__-prefixed object property removal', () => {
    it('removes __-prefixed key-value pairs from object literals', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          body: 'const obj = { visible: true, __internal: someCall(a, b), name: "test" };',
          params: '',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
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
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.helpers[0].source).not.toContain('__darkHeader');
      expect(result.helpers[0].source).toContain('size');
    });
  });

  describe('dead-code simplification', () => {
    it('simplifies undefined ?? expr to expr', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const x = undefined ?? fallback;', params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).toBe('const x = fallback;');
    });

    it('simplifies undefined || expr to expr', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const x = undefined || fallback;', params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).toBe('const x = fallback;');
    });

    it('simplifies !undefined to true', () => {
      const ir = minimalIR({
        handlers: [{ name: 'h', body: 'const x = !undefined;', params: '' }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).toBe('const x = true;');
    });
  });

  // ---------------------------------------------------------------------------
  // __-prefixed cleanup in render helper template literals
  // ---------------------------------------------------------------------------

  describe('__-prefixed in render helper templates', () => {
    it('replaces bare __xxx in template interpolation with false', () => {
      const ir = minimalIR({
        helpers: [{
          name: 'renderContent',
          source: 'function renderContent() { return html`<el-body .closeAction=${__closeAnalyticsAction}></el-body>`; }',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.helpers[0].source).not.toContain('__closeAnalyticsAction');
      expect(result.helpers[0].source).toContain('.closeAction=${false}');
    });

    it('replaces __xxx && expr in template interpolation', () => {
      const ir = minimalIR({
        helpers: [{
          name: 'renderTrigger',
          source: 'function renderTrigger() { return html`<el-trigger .inFilter=${__inFilteringToken && true}></el-trigger>`; }',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.helpers[0].source).not.toContain('__inFilteringToken');
    });

    it('removes function calls with sole __xxx argument', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'onTriggerClick',
          body: '        fireNonCancelableEvent(__onOpen);\n        this._visible = true;',
          params: '',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).not.toContain('fireNonCancelableEvent');
      expect(result.handlers[0].body).toContain('this._visible = true');
    });

    it('removes fire*Event calls with __xxx as first of multiple arguments', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'onBlur',
          body: '            fireNonCancelableEvent(__onBlurWithDetail, { relatedTarget: e.relatedTarget });',
          params: 'e: FocusEvent',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set());
      expect(result.handlers[0].body).not.toContain('fireNonCancelableEvent');
    });
  });

  // ---------------------------------------------------------------------------
  // SKIP_PROPS reference cleanup (#20)
  // ---------------------------------------------------------------------------

  describe('skipProps usage site cleanup', () => {
    it('replaces nativeButtonAttributes?.tabIndex with undefined', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'render',
          body: 'const explicitTabIndex = nativeButtonAttributes?.tabIndex ?? nativeAnchorAttributes?.tabIndex;',
          params: '',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set(['nativeButtonAttributes', 'nativeAnchorAttributes']));
      expect(result.handlers[0].body).not.toContain('nativeButtonAttributes');
      expect(result.handlers[0].body).not.toContain('nativeAnchorAttributes');
    });

    it('replaces bare nativeAttributes passed as function argument', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          body: "mergeProps(baseConfig, nativeAttributes, 'Card');",
          params: '',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set(['nativeAttributes']));
      expect(result.handlers[0].body).not.toContain('nativeAttributes');
      expect(result.handlers[0].body).toContain('undefined');
    });

    it('preserves local variable declarations named nativeAttributes', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          body: "const nativeAttributes: Record<string, unknown> = {};\nnativeAttributes['aria-invalid'] = true;",
          params: '',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set(['nativeAttributes']));
      expect(result.handlers[0].body).toContain('const nativeAttributes');
    });

    it('replaces nativeAttributes.xxx in template expressions', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [],
          children: [{
            kind: 'expression',
            attributes: [],
            children: [],
            expression: 'nativeAttributes?.tabIndex',
          }],
        },
      });
      const result = removeCloudscapeInternals(ir, new Set(['nativeAttributes']));
      expect(result.template.children[0].expression).not.toContain('nativeAttributes');
    });

    it('replaces analyticsMetadata in handler bodies', () => {
      const ir = minimalIR({
        handlers: [{
          name: 'h',
          body: 'const meta = analyticsMetadata;',
          params: '',
        }],
      });
      const result = removeCloudscapeInternals(ir, new Set(['analyticsMetadata']));
      expect(result.handlers[0].body).not.toContain('analyticsMetadata');
    });
  });

  describe('config override', () => {
    it('custom skipProps list correctly filters different prop names', () => {
      const ir = minimalIR({
        props: [
          { name: 'myInternalProp', type: 'string', category: 'attribute' },
          { name: 'visible', type: 'boolean', category: 'attribute' },
        ],
      });
      const result = removeLibraryInternals(ir, new Set(['myInternalProp']));
      expect(result.props.map(p => p.name)).toEqual(['visible']);
    });

    it('custom removeAttributes — still uses module defaults', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [
            { name: 'key', value: 'x', kind: 'attribute' },
            { name: 'title', value: 'hello', kind: 'attribute' },
          ],
          children: [],
        },
      });
      const result = removeLibraryInternals(ir, new Set());
      expect(result.template.attributes.map(a => a.name)).toEqual(['title']);
    });

    it('custom infraFunctions — still uses module defaults', () => {
      const ir = minimalIR({
        helpers: [
          { name: 'applyDisplayName', source: 'function applyDisplayName() {}' },
          { name: 'renderContent', source: 'function renderContent() { return "ok"; }' },
        ],
      });
      const result = removeLibraryInternals(ir, new Set(), undefined, createCloudscapeConfig().cleanup);
      expect(result.helpers.map(h => h.name)).toEqual(['renderContent']);
    });

    it('custom removeAttributePrefixes — still uses module defaults', () => {
      const ir = minimalIR({
        template: {
          kind: 'element',
          tag: 'div',
          attributes: [
            { name: 'data-analytics-funnel-key', value: 'a', kind: 'attribute' },
            { name: 'title', value: 'hello', kind: 'attribute' },
          ],
          children: [],
        },
      });
      const result = removeLibraryInternals(ir, new Set(), undefined, createCloudscapeConfig().cleanup);
      expect(result.template.attributes.map(a => a.name)).toEqual(['title']);
    });

    it('omitting config preserves exact current behavior', () => {
      const ir = minimalIR({
        props: [
          { name: '__internal', type: 'string', category: 'attribute' },
          { name: 'visible', type: 'boolean', category: 'attribute' },
        ],
        handlers: [{ name: 'h', body: "const cls = testUtilStyles['header'];", params: '' }],
      });
      const withDefault = removeCloudscapeInternals(ir, new Set());
      const withoutConfig = removeLibraryInternals(ir, new Set());
      expect(withDefault.props).toEqual(withoutConfig.props);
      expect(withDefault.handlers).toEqual(withoutConfig.handlers);
    });

    it('removeCloudscapeInternals is an alias for removeLibraryInternals', () => {
      expect(removeCloudscapeInternals).toBe(removeLibraryInternals);
    });
  });
});
