import { describe, it, expect } from 'vitest';
import { eliminateDeadCode, collectStrippedSymbols } from '../../src/emitter/dead-code-elimination.js';

describe('collectStrippedSymbols', () => {
  it('detects analytics-prefixed symbols', () => {
    const code = 'const meta = analyticsAction; const analyticsMetadata = {};';
    const symbols = collectStrippedSymbols(code);
    expect(symbols).toContain('analyticsAction');
    expect(symbols).toContain('analyticsMetadata');
  });

  it('detects funnel-prefixed symbols', () => {
    const code = 'funnelKeyDown(); FUNNEL_KEY_PART_ERROR;';
    const symbols = collectStrippedSymbols(code);
    expect(symbols).toContain('funnelKeyDown');
    expect(symbols).toContain('FUNNEL_KEY_PART_ERROR');
  });

  it('detects Generated*Metadata patterns', () => {
    const code = 'type GeneratedAnalyticsMetadataButtonFragment = any;';
    const symbols = collectStrippedSymbols(code);
    expect(symbols).toContain('GeneratedAnalyticsMetadataButtonFragment');
  });

  it('detects stylePropertiesAndVariables', () => {
    const code = '.style=${stylePropertiesAndVariables}';
    const symbols = collectStrippedSymbols(code);
    expect(symbols).toContain('stylePropertiesAndVariables');
  });

  it('detects __awsui internal markers', () => {
    const code = '__awsuiMetadata = {}';
    const symbols = collectStrippedSymbols(code);
    expect(symbols).toContain('__awsuiMetadata');
  });

  it('does not flag normal symbols', () => {
    const code = 'const variant = "primary"; this.disabled = true;';
    const symbols = collectStrippedSymbols(code);
    expect(symbols).toHaveLength(0);
  });
});

describe('eliminateDeadCode', () => {
  it('returns code unchanged when no stripped symbols', () => {
    const code = 'const x = 1;\nconst y = x + 2;';
    expect(eliminateDeadCode(code, [])).toBe(code);
  });

  it('removes const declarations referencing dead symbols', () => {
    const code = [
      'const liveVar = 42;',
      'const deadVar = analyticsAction;',
      'console.log(liveVar);',
    ].join('\n');
    const result = eliminateDeadCode(code, ['analyticsAction']);
    expect(result).not.toContain('deadVar');
    expect(result).toContain('liveVar');
    expect(result).toContain('console.log');
  });

  it('transitively removes dependent declarations', () => {
    const code = [
      'const analyticsAction = getAction();',
      'const analyticsMetadata = { action: analyticsAction };',
      'const label = analyticsMetadata.label;',
      'const liveVar = 42;',
    ].join('\n');
    const result = eliminateDeadCode(code, ['analyticsAction']);
    expect(result).not.toContain('analyticsAction');
    expect(result).not.toContain('analyticsMetadata');
    expect(result).not.toContain('label');
    expect(result).toContain('liveVar');
  });

  it('removes object shorthand properties referencing dead symbols', () => {
    const code = [
      'const iconProps = {',
      '  loading: true,',
      '  analyticsAction,',
      '  variant: "primary",',
      '};',
      'const otherObj = {',
      '  a: 1,',
      '};',
    ].join('\n');
    const result = eliminateDeadCode(code, ['analyticsAction']);
    // The entire iconProps declaration is removed (it references dead code)
    expect(result).not.toContain('analyticsAction');
    expect(result).not.toContain('iconProps');
    // Other declarations survive
    expect(result).toContain('otherObj');
  });

  it('removes template attributes referencing dead symbols', () => {
    const code = '<div .style=${stylePropertiesAndVariables} class="foo">';
    const result = eliminateDeadCode(code, ['stylePropertiesAndVariables']);
    expect(result).not.toContain('stylePropertiesAndVariables');
    expect(result).toContain('class="foo"');
  });

  it('removes if blocks with dead condition', () => {
    const code = [
      'const x = 1;',
      'if (analyticsAction) {',
      '  doSomething();',
      '}',
      'console.log(x);',
    ].join('\n');
    const result = eliminateDeadCode(code, ['analyticsAction']);
    expect(result).not.toContain('analyticsAction');
    expect(result).not.toContain('doSomething');
    expect(result).toContain('console.log(x)');
  });

  it('does not remove live code', () => {
    const code = [
      "import { html } from 'lit';",
      'const hostStyles = css`:host { display: block; }`;',
      'export class Button extends LitElement {',
      '  @property({ type: String }) variant = "primary";',
      '  override render() {',
      '    return html`<button>${this.variant}</button>`;',
      '  }',
      '}',
    ].join('\n');
    const result = eliminateDeadCode(code, ['analyticsAction']);
    expect(result).toBe(code);
  });

  it('removes type/interface declarations referencing dead symbols', () => {
    const code = [
      'type AnalyticsMeta = { action: analyticsAction };',
      'const liveVar = 42;',
    ].join('\n');
    const result = eliminateDeadCode(code, ['analyticsAction']);
    expect(result).not.toContain('AnalyticsMeta');
    expect(result).toContain('liveVar');
  });

  it('preserves private class members not referencing dead symbols', () => {
    const code = [
      '  private _handler = () => {',
      '    this.doWork();',
      '  };',
    ].join('\n');
    const result = eliminateDeadCode(code, ['analyticsAction']);
    expect(result).toContain('_handler');
    expect(result).toContain('this.doWork()');
  });

  it('removes private class members that reference dead symbols', () => {
    const code = [
      '  private _analyticsHandler = () => {',
      '    reportAnalytics(analyticsAction);',
      '  };',
    ].join('\n');
    const result = eliminateDeadCode(code, ['analyticsAction']);
    expect(result).not.toContain('_analyticsHandler');
  });

  it('converges within max iterations', () => {
    const code = [
      'const a = deadSymbol;',
      'const b = a;',
      'const c = b;',
      'const d = c;',
      'const e = d;',
      'const live = 42;',
    ].join('\n');
    const result = eliminateDeadCode(code, ['deadSymbol']);
    expect(result).not.toContain('deadSymbol');
    expect(result).not.toContain('const a');
    expect(result).not.toContain('const b');
    expect(result).not.toContain('const c');
    expect(result).not.toContain('const d');
    expect(result).not.toContain('const e');
    expect(result).toContain('const live = 42;');
  });
});
