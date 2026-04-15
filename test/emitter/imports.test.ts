/**
 * Unit tests for emitter/imports.ts — ImportCollector.
 */
import { describe, it, expect } from 'vitest';
import { ImportCollector, collectImports } from '../../src/emitter/imports.js';
import type { ComponentIR } from '../../src/ir/types.js';

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
// ImportCollector.emit()
// ---------------------------------------------------------------------------

describe('ImportCollector', () => {
  it('emits lit core imports', () => {
    const c = new ImportCollector();
    c.addLit('html');
    c.addLit('css');
    expect(c.emit()).toBe("import { css, html } from 'lit';");
  });

  it('emits decorator imports', () => {
    const c = new ImportCollector();
    c.addDecorator('property');
    c.addDecorator('state');
    expect(c.emit()).toBe("import { property, state } from 'lit/decorators.js';");
  });

  it('emits directive imports', () => {
    const c = new ImportCollector();
    c.addDirective('lit/directives/class-map.js', 'classMap');
    expect(c.emit()).toBe("import { classMap } from 'lit/directives/class-map.js';");
  });

  it('emits context imports', () => {
    const c = new ImportCollector();
    c.addContextImport('consume');
    expect(c.emit()).toBe("import { consume } from '@lit/context';");
  });

  it('emits named imports grouped by module', () => {
    const c = new ImportCollector();
    c.addNamed('./utils.js', 'foo');
    c.addNamed('./utils.js', 'bar');
    expect(c.emit()).toBe("import { bar, foo } from './utils';");
  });

  it('emits type-only imports', () => {
    const c = new ImportCollector();
    c.addType('./types.js', 'FooProps');
    expect(c.emit()).toBe("import type { FooProps } from './types';");
  });

  it('emits side-effect imports', () => {
    const c = new ImportCollector();
    c.addSideEffect('./register.js');
    expect(c.emit()).toBe("import './register';");
  });

  it('emits default imports', () => {
    const c = new ImportCollector();
    c.addDefault('./config.js', 'config');
    expect(c.emit()).toBe("import config from './config';");
  });

  it('deduplicates entries', () => {
    const c = new ImportCollector();
    c.addLit('html');
    c.addLit('html');
    c.addLit('css');
    expect(c.emit()).toBe("import { css, html } from 'lit';");
  });

  it('sorts entries alphabetically', () => {
    const c = new ImportCollector();
    c.addDecorator('state');
    c.addDecorator('property');
    c.addDecorator('query');
    expect(c.emit()).toBe("import { property, query, state } from 'lit/decorators.js';");
  });

  it('emits combined imports in correct order', () => {
    const c = new ImportCollector();
    // Add in random order
    c.addType('./interfaces.js', 'FooProps');
    c.addSideEffect('./register.js');
    c.addLit('html');
    c.addDecorator('property');
    c.addNamed('./base.js', 'CsBaseElement');
    c.addDirective('lit/directives/class-map.js', 'classMap');
    c.addDefault('./config.js', 'config');

    const lines = c.emit().split('\n');
    // Verify ordering: lit core → decorators → directives → named → default → type → side-effect
    expect(lines[0]).toContain("from 'lit'");
    expect(lines[1]).toContain("from 'lit/decorators.js'");
    expect(lines[2]).toContain("from 'lit/directives/class-map.js'");
    expect(lines[3]).toContain("from './base'");
    expect(lines[4]).toContain("import config from");
    expect(lines[5]).toContain("import type");
    expect(lines[6]).toContain("import './register'");
  });

  it('handles empty collector', () => {
    const c = new ImportCollector();
    expect(c.emit()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ImportCollector.filterUnused()
// ---------------------------------------------------------------------------

describe('ImportCollector.filterUnused', () => {
  it('removes named imports not referenced in body', () => {
    const c = new ImportCollector();
    c.addNamed('./style.js', 'getBadgeStyles');
    c.addNamed('./style.js', 'getButtonStyles');
    c.filterUnused('const x = getButtonStyles();');
    const output = c.emit();
    expect(output).toContain('getButtonStyles');
    expect(output).not.toContain('getBadgeStyles');
  });

  it('removes entire module when all named imports are unused', () => {
    const c = new ImportCollector();
    c.addNamed('./style.js', 'getBadgeStyles');
    c.filterUnused('no references here');
    expect(c.emit()).toBe('');
  });

  it('removes default imports not referenced in body', () => {
    const c = new ImportCollector();
    c.addDefault('./config.js', 'unusedConfig');
    c.filterUnused('const x = 1;');
    expect(c.emit()).toBe('');
  });

  it('preserves default imports that appear in body', () => {
    const c = new ImportCollector();
    c.addDefault('./config.js', 'myConfig');
    c.filterUnused('return myConfig.value;');
    expect(c.emit()).toContain('import myConfig from');
  });

  it('removes unused lit core imports', () => {
    const c = new ImportCollector();
    c.addLit('html');
    c.addLit('css');
    c.addLit('nothing');
    c.filterUnused('no lit references');
    expect(c.emit()).not.toContain('css');
    expect(c.emit()).not.toContain('html');
    expect(c.emit()).not.toContain('nothing');
  });

  it('keeps used lit core imports', () => {
    const c = new ImportCollector();
    c.addLit('html');
    c.addLit('css');
    c.addLit('nothing');
    c.filterUnused('return html`<div>${nothing}</div>`; static styles = css``;');
    expect(c.emit()).toContain('html');
    expect(c.emit()).toContain('css');
    expect(c.emit()).toContain('nothing');
  });

  it('never removes decorator imports', () => {
    const c = new ImportCollector();
    c.addDecorator('property');
    c.addDecorator('state');
    c.filterUnused('no decorator references');
    expect(c.emit()).toContain('property');
    expect(c.emit()).toContain('state');
  });

  it('removes unused directive imports', () => {
    const c = new ImportCollector();
    c.addDirective('lit/directives/class-map.js', 'classMap');
    c.filterUnused('body without it');
    expect(c.emit()).not.toContain('classMap');
  });

  it('keeps used directive imports', () => {
    const c = new ImportCollector();
    c.addDirective('lit/directives/class-map.js', 'classMap');
    c.filterUnused('class=${classMap({ active: true })}');
    expect(c.emit()).toContain('classMap');
  });

  it('never removes context imports', () => {
    const c = new ImportCollector();
    c.addContextImport('consume');
    c.filterUnused('no context references');
    expect(c.emit()).toContain('consume');
  });

  it('never removes type-only imports', () => {
    const c = new ImportCollector();
    c.addType('./interfaces.js', 'ButtonProps');
    c.filterUnused('no type references');
    expect(c.emit()).toContain('ButtonProps');
  });

  it('never removes side-effect imports', () => {
    const c = new ImportCollector();
    c.addSideEffect('./register.js');
    c.filterUnused('no references');
    expect(c.emit()).toContain("import './register'");
  });

  it('never removes preserved named imports', () => {
    const c = new ImportCollector();
    c.addNamed('./components.js', 'MyComponent');
    c.markPreserved('MyComponent');
    c.filterUnused('no MyComponent here');
    expect(c.emit()).toContain('MyComponent');
  });

  it('never removes preserved default imports', () => {
    const c = new ImportCollector();
    c.addDefault('./widget.js', 'Widget');
    c.markPreserved('Widget');
    c.filterUnused('no Widget here');
    expect(c.emit()).toContain('Widget');
  });

  it('uses word boundaries to avoid partial matches', () => {
    const c = new ImportCollector();
    c.addNamed('./utils.js', 'get');
    c.filterUnused('getButtonStyles(); target.value;');
    expect(c.emit()).not.toContain("from './utils.js'");
  });
});

// ---------------------------------------------------------------------------
// collectImports — IR import processing
// ---------------------------------------------------------------------------

describe('collectImports', () => {
  it('preserves named imports alongside default imports from the same module', () => {
    const ir = minimalIR({
      // getChartStatus is used in a handler body
      handlers: [{ name: 'h', body: 'const s = getChartStatus(data);', params: '' }],
      imports: [{
        moduleSpecifier: '../internal/components/chart-status',
        defaultImport: 'ChartStatusContainer',
        namedImports: ['getChartStatus'],
      }],
    });
    const collector = collectImports(ir);
    const output = collector.emit();
    expect(output).toContain('getChartStatus');
  });

  it('includes named imports that are referenced in code', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: 'return isRtl(el);', params: '' }],
      imports: [{
        moduleSpecifier: '@lib/utils',
        namedImports: ['isRtl', 'unusedFn'],
      }],
    });
    const collector = collectImports(ir);
    const output = collector.emit();
    expect(output).toContain('isRtl');
    expect(output).not.toContain('unusedFn');
  });

  it('drops default import when not referenced but keeps named imports', () => {
    const ir = minimalIR({
      handlers: [{ name: 'h', body: 'bar();', params: '' }],
      imports: [{
        moduleSpecifier: './mod',
        defaultImport: 'Unused',
        namedImports: ['bar'],
      }],
    });
    const collector = collectImports(ir);
    const output = collector.emit();
    expect(output).toContain('bar');
    expect(output).not.toContain('Unused');
  });
});
