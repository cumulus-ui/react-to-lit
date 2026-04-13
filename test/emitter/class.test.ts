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
    // Verify default class name pattern
    expect(withoutConfig).toContain('export class CsTestInternal extends CsBaseElement');
  });

  it('custom class prefix produces My${name}Internal instead of Cs${name}Internal', () => {
    const ir = minimalIR({ name: 'Button' });
    const output = emitComponent(ir, { output: { classPrefix: 'My', classSuffix: 'Internal', tagPrefix: 'el-', importExtension: '.js', baseClass: { name: 'CsBaseElement', import: '../internal/base-element.js' } } });
    expect(output).toContain('export class MyButtonInternal extends CsBaseElement');
    expect(output).not.toContain('CsButtonInternal');
  });

  it('custom class suffix', () => {
    const ir = minimalIR({ name: 'Badge' });
    const output = emitComponent(ir, { output: { classPrefix: 'Cs', classSuffix: 'Base', tagPrefix: 'el-', importExtension: '.js', baseClass: { name: 'CsBaseElement', import: '../internal/base-element.js' } } });
    expect(output).toContain('export class CsBadgeBase extends CsBaseElement');
    expect(output).not.toContain('CsBadgeInternal');
  });

  it('custom base class name and import path', () => {
    const ir = minimalIR({ name: 'Alert' });
    const config: OutputConfig = {
      classPrefix: 'Cs',
      classSuffix: 'Internal',
      tagPrefix: 'el-',
      importExtension: '.js',
      baseClass: { name: 'MyBaseElement', import: '../base/my-element.js' },
    };
    const output = emitComponent(ir, { output: config });
    expect(output).toContain('extends MyBaseElement');
    expect(output).toContain("from '../base/my-element.js'");
    expect(output).not.toContain('CsBaseElement');
    expect(output).not.toContain('../internal/base-element.js');
  });

  it('ir.baseClass takes precedence over output config', () => {
    const ir = minimalIR({
      name: 'Widget',
      baseClass: { name: 'SharedBase', importPath: '../shared/base.js' },
    });
    const config: OutputConfig = {
      classPrefix: 'Cs',
      classSuffix: 'Internal',
      tagPrefix: 'el-',
      importExtension: '.js',
      baseClass: { name: 'ShouldNotAppear', import: '../should-not.js' },
    };
    const output = emitComponent(ir, { output: config });
    expect(output).toContain('extends SharedBase');
    expect(output).toContain("from '../shared/base.js'");
    expect(output).not.toContain('ShouldNotAppear');
  });

  it('mixin application uses configured base class', () => {
    const ir = minimalIR({
      name: 'Input',
      mixins: ['FormControlMixin'],
    });
    const config: OutputConfig = {
      classPrefix: 'Cs',
      classSuffix: 'Internal',
      tagPrefix: 'el-',
      importExtension: '.js',
      baseClass: { name: 'MyBase', import: '../base.js' },
    };
    const output = emitComponent(ir, { output: config });
    expect(output).toContain('const Base = FormControlMixin(MyBase);');
    expect(output).toContain('extends Base');
  });

  it('empty prefix and suffix produce plain class name', () => {
    const ir = minimalIR({ name: 'Card' });
    const config: OutputConfig = {
      classPrefix: '',
      classSuffix: '',
      tagPrefix: 'el-',
      importExtension: '.js',
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
    expect(output).toContain('CsBaseElement');
    expect(output).toContain('../internal/base-element.js');
  });

  it('uses custom base element import with config', () => {
    const ir = minimalIR();
    const config: OutputConfig = {
      classPrefix: 'Cs',
      classSuffix: 'Internal',
      tagPrefix: 'el-',
      importExtension: '.js',
      baseClass: { name: 'MyBase', import: '@my-lib/base.js' },
    };
    const collector = collectImports(ir, config);
    const output = collector.emit();
    expect(output).toContain('MyBase');
    expect(output).toContain('@my-lib/base.js');
    expect(output).not.toContain('CsBaseElement');
    expect(output).not.toContain('../internal/base-element.js');
  });

  it('ir.baseClass takes precedence over config in collectImports', () => {
    const ir = minimalIR({
      baseClass: { name: 'SharedBase', importPath: '../shared/base.js' },
    });
    const config: OutputConfig = {
      classPrefix: 'Cs',
      classSuffix: 'Internal',
      tagPrefix: 'el-',
      importExtension: '.js',
      baseClass: { name: 'ShouldNotAppear', import: '../should-not.js' },
    };
    const collector = collectImports(ir, config);
    const output = collector.emit();
    expect(output).toContain('SharedBase');
    expect(output).toContain('../shared/base.js');
    expect(output).not.toContain('ShouldNotAppear');
  });
});
