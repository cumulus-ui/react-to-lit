import { describe, it, expect } from 'vitest';
import { cssTransition } from '../../src/plugins/css-transition.js';
import type { Plugin } from '../../src/plugins/index.js';

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe('cssTransition plugin interface', () => {
  it('returns a valid Plugin object', () => {
    const plugin: Plugin = cssTransition();
    expect(plugin.package).toBe('react-transition-group');
    expect(plugin.supportedVersions).toBe('>=4.0.0 <5.0.0');
    expect(plugin.imports).toEqual(['CSSTransition', 'TransitionGroup']);
    expect(typeof plugin.transform).toBe('function');
  });

  it('accepts a custom version range', () => {
    const plugin = cssTransition({ version: '>=3.0.0 <4.0.0' });
    expect(plugin.supportedVersions).toBe('>=3.0.0 <4.0.0');
  });
});

// ---------------------------------------------------------------------------
// Import removal
// ---------------------------------------------------------------------------

describe('cssTransition import removal', () => {
  const plugin = cssTransition();

  it('removes CSSTransition import from react-transition-group', () => {
    const code = [
      "import { LitElement, html } from 'lit';",
      "import { CSSTransition } from 'react-transition-group';",
      '',
      'export class MyComponent extends LitElement {}',
    ].join('\n');

    const result = plugin.transform(code, 'MyComponent');
    expect(result).not.toContain('react-transition-group');
    expect(result).toContain("import { LitElement, html } from 'lit';");
    expect(result).toContain('export class MyComponent extends LitElement {}');
  });

  it('removes TransitionGroup import', () => {
    const code = "import { TransitionGroup } from 'react-transition-group';\n\nconst x = 1;";
    const result = plugin.transform(code, 'Test');
    expect(result).not.toContain('react-transition-group');
    expect(result).toContain('const x = 1;');
  });

  it('removes multi-specifier imports', () => {
    const code = "import { CSSTransition, TransitionGroup } from 'react-transition-group';\n";
    const result = plugin.transform(code, 'Test');
    expect(result).not.toContain('react-transition-group');
  });

  it('handles double-quoted imports', () => {
    const code = 'import { CSSTransition } from "react-transition-group";\n';
    const result = plugin.transform(code, 'Test');
    expect(result).not.toContain('react-transition-group');
  });
});

// ---------------------------------------------------------------------------
// CSSTransition wrapper removal
// ---------------------------------------------------------------------------

describe('cssTransition wrapper removal', () => {
  const plugin = cssTransition();

  it('strips CSSTransition wrapper, keeps inner content', () => {
    const code = [
      "import { CSSTransition } from 'react-transition-group';",
      '',
      'const template = html`',
      '  <CSSTransition in=${expanded} timeout=${30} classNames=${{enter: styles["content-enter"]}}>',
      '    <div class="content">',
      '      <slot></slot>',
      '    </div>',
      '  </CSSTransition>',
      '`;',
    ].join('\n');

    const result = plugin.transform(code, 'ExpandableSection');
    expect(result).not.toContain('CSSTransition');
    expect(result).not.toContain('react-transition-group');
    expect(result).toContain('<div class="content">');
    expect(result).toContain('<slot></slot>');
  });

  it('strips TransitionGroup wrapper, keeps inner content', () => {
    const code = [
      "import { TransitionGroup } from 'react-transition-group';",
      '',
      'const template = html`',
      '  <TransitionGroup component=${null}>',
      '    <div>child</div>',
      '  </TransitionGroup>',
      '`;',
    ].join('\n');

    const result = plugin.transform(code, 'Flashbar');
    expect(result).not.toContain('TransitionGroup');
    expect(result).not.toContain('react-transition-group');
    expect(result).toContain('<div>child</div>');
  });

  it('strips Lit-style kebab-case tag names (el-csstransition)', () => {
    const code = [
      'const template = html`',
      '  <el-csstransition .in=${expanded}>',
      '    <div>content</div>',
      '  </el-csstransition>',
      '`;',
    ].join('\n');

    const result = plugin.transform(code, 'Test');
    expect(result).not.toContain('el-csstransition');
    expect(result).toContain('<div>content</div>');
  });

  it('strips el-transitiongroup kebab-case tags', () => {
    const code = '<el-transitiongroup .component=${null}><div>child</div></el-transitiongroup>';
    const result = plugin.transform(code, 'Test');
    expect(result).not.toContain('el-transitiongroup');
    expect(result).toContain('<div>child</div>');
  });
});

// ---------------------------------------------------------------------------
// Pass-through (no-op for unrelated code)
// ---------------------------------------------------------------------------

describe('cssTransition pass-through', () => {
  const plugin = cssTransition();

  it('leaves code without CSSTransition unchanged', () => {
    const code = [
      "import { LitElement, html } from 'lit';",
      '',
      'export class Button extends LitElement {',
      '  override render() {',
      '    return html`<button><slot></slot></button>`;',
      '  }',
      '}',
    ].join('\n');

    const result = plugin.transform(code, 'Button');
    expect(result).toBe(code);
  });
});
