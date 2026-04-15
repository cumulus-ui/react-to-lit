/**
 * Unit tests for emitter/class.ts — output config support.
 */
import { describe, it, expect } from 'vitest';
import { emitComponent } from '../../src/emitter/class.js';
import { collectImports } from '../../src/emitter/imports.js';
import type { ComponentIR } from '../../src/ir/types.js';
import type { OutputConfig } from '../../src/config.js';

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
    fileConstants: [],
    fileTypeDeclarations: [],
    forwardRef: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// emitComponent — output config
// ---------------------------------------------------------------------------

describe('emitComponent output config', () => {
  it('omitting config produces exact same output as today', () => {
    const ir = minimalIR();
    const withoutConfig = emitComponent(ir);
    const withEmptyConfig = emitComponent(ir, {});
    expect(withoutConfig).toBe(withEmptyConfig);
    // Verify class name is just ir.name
    expect(withoutConfig).toContain('export class Test extends LitElement');
  });

  it('class name is just ir.name with custom base class', () => {
    const ir = minimalIR({ name: 'Button' });
    const output = emitComponent(ir, { output: { baseClass: { name: 'CsBaseElement', import: '../internal/base-element.js' } } });
    expect(output).toContain('export class Button extends CsBaseElement');
  });

  it('class name is just ir.name for Badge', () => {
    const ir = minimalIR({ name: 'Badge' });
    const output = emitComponent(ir, { output: { baseClass: { name: 'CsBaseElement', import: '../internal/base-element.js' } } });
    expect(output).toContain('export class Badge extends CsBaseElement');
  });

  it('custom base class name and import path', () => {
    const ir = minimalIR({ name: 'Alert' });
    const config: OutputConfig = {
      baseClass: { name: 'MyBaseElement', import: '../base/my-element.js' },
    };
    const output = emitComponent(ir, { output: config });
    expect(output).toContain('extends MyBaseElement');
    expect(output).toContain("from '../base/my-element'");
    expect(output).not.toContain('LitElement');
    expect(output).not.toContain('../internal/base-element.js');
  });

  it('ir.baseClass takes precedence over output config', () => {
    const ir = minimalIR({
      name: 'Widget',
      baseClass: { name: 'SharedBase', importPath: '../shared/base.js' },
    });
    const config: OutputConfig = {
      baseClass: { name: 'ShouldNotAppear', import: '../should-not.js' },
    };
    const output = emitComponent(ir, { output: config });
    expect(output).toContain('extends SharedBase');
    expect(output).toContain("from '../shared/base'");
    expect(output).not.toContain('ShouldNotAppear');
  });

  it('mixin application uses configured base class', () => {
    const ir = minimalIR({
      name: 'Input',
      mixins: ['FormControlMixin'],
    });
    const config: OutputConfig = {
      baseClass: { name: 'MyBase', import: '../base.js' },
    };
    const output = emitComponent(ir, { output: config });
    expect(output).toContain('const Base = FormControlMixin(MyBase);');
    expect(output).toContain('extends Base');
  });

  it('plain class name with default config', () => {
    const ir = minimalIR({ name: 'Card' });
    const config: OutputConfig = {
      baseClass: { name: 'LitElement', import: 'lit' },
    };
    const output = emitComponent(ir, { output: config });
    expect(output).toContain('export class Card extends LitElement');
  });
});

// ---------------------------------------------------------------------------
// collectImports — output config
// ---------------------------------------------------------------------------

describe('collectImports output config', () => {
  it('uses default base element import without config', () => {
    const ir = minimalIR();
    const collector = collectImports(ir);
    const output = collector.emit();
    expect(output).toContain('LitElement');
    expect(output).toContain("from 'lit'");
  });

  it('uses custom base element import with config', () => {
    const ir = minimalIR();
    const config: OutputConfig = {
      baseClass: { name: 'MyBase', import: '@my-lib/base.js' },
    };
    const collector = collectImports(ir, config);
    const output = collector.emit();
    expect(output).toContain('MyBase');
    expect(output).toContain('@my-lib/base.js');
    expect(output).not.toContain('LitElement');
    expect(output).not.toContain('../internal/base-element.js');
  });

  it('ir.baseClass takes precedence over config in collectImports', () => {
    const ir = minimalIR({
      baseClass: { name: 'SharedBase', importPath: '../shared/base.js' },
    });
    const config: OutputConfig = {
      baseClass: { name: 'ShouldNotAppear', import: '../should-not.js' },
    };
    const collector = collectImports(ir, config);
    const output = collector.emit();
    expect(output).toContain('SharedBase');
    expect(output).toContain('../shared/base');
    expect(output).not.toContain('ShouldNotAppear');
  });
});

// ---------------------------------------------------------------------------
// emitComponent — skipped hook variable filtering
// ---------------------------------------------------------------------------

describe('emitComponent skipped hook var filtering', () => {
  it('emits stubs only for hook vars referenced in IR text', () => {
    const ir = minimalIR({
      skippedHookVars: ['used', 'unused'],
      handlers: [{ name: 'handleClick', params: '', body: 'console.log(this._used);' }],
    });
    const output = emitComponent(ir);
    expect(output).toContain('private _used: any;');
    expect(output).not.toContain('private _unused: any;');
  });

  it('emits nothing when all hook vars are unused', () => {
    const ir = minimalIR({
      skippedHookVars: ['alpha', 'beta'],
    });
    const output = emitComponent(ir);
    expect(output).not.toContain('private _alpha: any;');
    expect(output).not.toContain('private _beta: any;');
  });

  it('emits nothing when skippedHookVars is empty', () => {
    const ir = minimalIR({ skippedHookVars: [] });
    const output = emitComponent(ir);
    expect(output).not.toMatch(/private _\w+: any;/);
  });

  it('uses word-boundary matching to avoid partial name collisions', () => {
    const ir = minimalIR({
      skippedHookVars: ['foo', 'fooBar'],
      handlers: [{ name: 'h', params: '', body: 'this._fooBar' }],
    });
    const output = emitComponent(ir);
    expect(output).not.toContain('private _foo: any;');
    expect(output).toContain('private _fooBar: any;');
  });

  it('detects references in effect bodies', () => {
    const ir = minimalIR({
      skippedHookVars: ['loadingButtonCount'],
      effects: [{ body: 'this._loadingButtonCount++', deps: [] }],
    });
    const output = emitComponent(ir);
    expect(output).toContain('private _loadingButtonCount: any;');
  });
});

// ---------------------------------------------------------------------------
// emitComponent — body preamble unused variable filtering
// ---------------------------------------------------------------------------

describe('emitComponent body preamble filtering', () => {
  it('keeps preamble variables referenced in template, removes unused ones', () => {
    const ir = minimalIR({
      bodyPreamble: [
        'const unused = getBaseProps(rest)',
        'const classes = { root: true }',
      ],
      template: {
        kind: 'element',
        tag: 'div',
        attributes: [{ name: 'class', value: { expression: 'classMap(classes)' }, kind: 'classMap' }],
        children: [],
      },
    });
    const output = emitComponent(ir);
    expect(output).toContain('const classes = { root: true }');
    expect(output).not.toContain('const unused = getBaseProps(rest)');
  });

  it('preserves destructured assignments (conservative — no simple variable name)', () => {
    const ir = minimalIR({
      bodyPreamble: ['const { a, b } = computeStuff()'],
      template: { kind: 'fragment', attributes: [], children: [] },
    });
    const output = emitComponent(ir);
    expect(output).toContain('const { a, b } = computeStuff()');
  });

  it('preserves side-effect statements (no variable assignment)', () => {
    const ir = minimalIR({
      bodyPreamble: ['if (x) warnOnce("deprecated")'],
      template: { kind: 'fragment', attributes: [], children: [] },
    });
    const output = emitComponent(ir);
    expect(output).toContain('if (x) warnOnce("deprecated")');
  });

  it('keeps preamble variables referenced in render helpers', () => {
    const ir = minimalIR({
      bodyPreamble: ['const helperData = buildData()'],
      helpers: [
        { name: 'renderContent', source: 'function renderContent() { return html`${helperData}`; }' },
      ],
      template: { kind: 'fragment', attributes: [], children: [] },
    });
    const output = emitComponent(ir);
    expect(output).toContain('const helperData = buildData()');
  });

  it('removes all preamble when none are referenced', () => {
    const ir = minimalIR({
      bodyPreamble: [
        'const baseProps = getBaseProps(rest)',
        'const iconProps = buildIconProps()',
      ],
      template: { kind: 'fragment', attributes: [], children: [] },
    });
    const output = emitComponent(ir);
    expect(output).not.toContain('const baseProps');
    expect(output).not.toContain('const iconProps');
  });

  it('uses word-boundary matching to avoid partial name collisions', () => {
    const ir = minimalIR({
      bodyPreamble: [
        'const item = getItem()',
        'const items = getItems()',
      ],
      template: {
        kind: 'expression',
        attributes: [],
        children: [],
        expression: 'html`${items.map(i => html`<li>${i}</li>`)}`',
      },
    });
    const output = emitComponent(ir);
    expect(output).toContain('const items = getItems()');
    expect(output).not.toContain('const item = getItem()');
  });
});

// ---------------------------------------------------------------------------
// emitComponent — unused slot getter filtering
// ---------------------------------------------------------------------------

describe('emitComponent unused slot getter filtering', () => {
  it('removes children slot getter when _hasChildren is not referenced', () => {
    const ir = minimalIR({
      props: [
        { name: 'children', type: 'ReactNode', category: 'slot' },
      ],
      template: { kind: 'element', tag: 'div', attributes: [], children: [] },
    });
    const output = emitComponent(ir);
    expect(output).not.toContain('private get _hasChildren');
  });

  it('keeps children slot getter when _hasChildren IS referenced in handler', () => {
    const ir = minimalIR({
      props: [
        { name: 'children', type: 'ReactNode', category: 'slot' },
      ],
      handlers: [{ name: 'handleRender', params: '', body: 'if (this._hasChildren) { }' }],
      template: { kind: 'element', tag: 'div', attributes: [], children: [] },
    });
    const output = emitComponent(ir);
    expect(output).toContain('private get _hasChildren');
  });

  it('keeps named slot getter when referenced in template', () => {
    const ir = minimalIR({
      props: [
        { name: 'header', type: 'ReactNode', category: 'slot' },
      ],
      template: {
        kind: 'expression',
        attributes: [],
        children: [],
        expression: 'html`${this.header ? html`<div>${this.header}</div>` : nothing}`',
      },
    });
    const output = emitComponent(ir);
    expect(output).toContain('private get header');
  });

  it('removes named slot getter when not referenced', () => {
    const ir = minimalIR({
      props: [
        { name: 'header', type: 'ReactNode', category: 'slot' },
      ],
      template: { kind: 'element', tag: 'div', attributes: [], children: [] },
    });
    const output = emitComponent(ir);
    expect(output).not.toContain('private get header');
  });

  it('preserves non-slot props regardless of reference', () => {
    const ir = minimalIR({
      props: [
        { name: 'variant', type: 'string', category: 'attribute', litType: 'String' },
        { name: 'children', type: 'ReactNode', category: 'slot' },
      ],
      template: { kind: 'element', tag: 'div', attributes: [], children: [] },
    });
    const output = emitComponent(ir);
    expect(output).toContain('variant');
    expect(output).not.toContain('private get _hasChildren');
  });
});

// ---------------------------------------------------------------------------
// emitComponent — hostDisplay
// ---------------------------------------------------------------------------

describe('emitComponent hostDisplay', () => {
  it('defaults to display: block when hostDisplay is not set', () => {
    const output = emitComponent(minimalIR());
    expect(output).toContain('display: block');
  });

  it('uses hostDisplay value when provided', () => {
    const output = emitComponent(minimalIR({ hostDisplay: 'inline-block' }));
    expect(output).toContain('display: inline-block');
    expect(output).not.toContain('display: block');
  });

  it('supports display: contents', () => {
    const output = emitComponent(minimalIR({ hostDisplay: 'contents' }));
    expect(output).toContain('display: contents');
  });
});
