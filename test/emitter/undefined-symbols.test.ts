import { describe, it, expect } from 'vitest';
import { stubUndefinedSymbols } from '../../src/emitter/undefined-symbols.js';

describe('stubUndefinedSymbols', () => {
  it('returns code unchanged when all symbols are defined', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      "import { property } from 'lit/decorators.js';",
      '',
      'const hostStyles = css`:host { display: block; }`;',
      '',
      'export class Test extends LitElement {',
      '  @property({ type: String }) variant = "default";',
      '  override render() {',
      '    return html`<div>${this.variant}</div>`;',
      '  }',
      '}',
    ].join('\n');

    expect(stubUndefinedSymbols(code)).toBe(code);
  });

  it('stubs an undefined value reference', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      '',
      'export class Button extends LitElement {',
      '  override render() {',
      '    const meta = analyticsAction;',
      '    return html`<button></button>`;',
      '  }',
      '}',
    ].join('\n');

    const result = stubUndefinedSymbols(code);
    expect(result).toContain('const analyticsAction: any = undefined;');
    // Value stub should be inside render(), not at module scope
    const stubIdx = result.indexOf('const analyticsAction');
    const renderIdx = result.indexOf('override render()');
    expect(stubIdx).toBeGreaterThan(renderIdx);
  });

  it('stubs an undefined type reference (uppercase, in type annotation)', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      '',
      'export class Button extends LitElement {',
      '  private meta: GeneratedAnalyticsMetadataButtonFragment;',
      '  override render() {',
      '    return html`<button></button>`;',
      '  }',
      '}',
    ].join('\n');

    const result = stubUndefinedSymbols(code);
    expect(result).toContain('type GeneratedAnalyticsMetadataButtonFragment = any;');
  });

  it('does not stub known globals', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      '',
      'export class Test extends LitElement {',
      '  override render() {',
      '    console.log(document.title);',
      '    const id = Math.random();',
      '    return html`<div>${id}</div>`;',
      '  }',
      '}',
    ].join('\n');

    const result = stubUndefinedSymbols(code);
    expect(result).not.toContain('const console');
    expect(result).not.toContain('const document');
    expect(result).not.toContain('const Math');
  });

  it('does not stub symbols defined via imports', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      "import { fireNonCancelableEvent } from '../internal/events.js';",
      '',
      'export class Test extends LitElement {',
      '  private handleClick() {',
      '    fireNonCancelableEvent(this, "click", {});',
      '  }',
      '  override render() {',
      '    return html`<div></div>`;',
      '  }',
      '}',
    ].join('\n');

    const result = stubUndefinedSymbols(code);
    expect(result).not.toContain('const fireNonCancelableEvent');
  });

  it('does not stub symbols defined as local variables', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      '',
      'const hostStyles = css`:host { display: block; }`;',
      'const myHelper = (x: number) => x * 2;',
      '',
      'export class Test extends LitElement {',
      '  override render() {',
      '    const result = myHelper(42);',
      '    return html`<div>${result}</div>`;',
      '  }',
      '}',
    ].join('\n');

    const result = stubUndefinedSymbols(code);
    expect(result).not.toContain('const myHelper: any');
    expect(result).not.toContain('const hostStyles: any');
  });

  it('stubs multiple undefined symbols, sorted alphabetically', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      '',
      'export class Test extends LitElement {',
      '  override render() {',
      '    const zz = zebra;',
      '    const aa = alpaca;',
      '    return html`<div></div>`;',
      '  }',
      '}',
    ].join('\n');

    const result = stubUndefinedSymbols(code);
    const alpacaIdx = result.indexOf('const alpaca');
    const zebraIdx = result.indexOf('const zebra');
    expect(alpacaIdx).toBeGreaterThan(-1);
    expect(zebraIdx).toBeGreaterThan(-1);
    expect(alpacaIdx).toBeLessThan(zebraIdx);
  });

  it('places stubs after imports block', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      "import { property } from 'lit/decorators.js';",
      '',
      'export class Test extends LitElement {',
      '  override render() {',
      '    return html`<div>${unknownVar}</div>`;',
      '  }',
      '}',
    ].join('\n');

    const result = stubUndefinedSymbols(code);
    const lastImportIdx = result.lastIndexOf('import ');
    const lastImportEnd = result.indexOf('\n', lastImportIdx);
    const stubIdx = result.indexOf('const unknownVar');
    expect(stubIdx).toBeGreaterThan(lastImportEnd);
  });

  it('handles type imports correctly', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      "import type { ButtonProps } from './interfaces.js';",
      '',
      'export class Button extends LitElement {',
      '  private props: ButtonProps;',
      '  override render() {',
      '    return html`<button></button>`;',
      '  }',
      '}',
    ].join('\n');

    const result = stubUndefinedSymbols(code);
    expect(result).not.toContain('type ButtonProps = any');
    expect(result).not.toContain('const ButtonProps');
  });

  it('does not create stubs for property access chains', () => {
    const code = [
      "import { html, css, LitElement } from 'lit';",
      '',
      'export class Test extends LitElement {',
      '  override render() {',
      '    return html`<div>${this.variant}</div>`;',
      '  }',
      '}',
    ].join('\n');

    const result = stubUndefinedSymbols(code);
    expect(result).not.toContain('const variant: any');
  });
});
