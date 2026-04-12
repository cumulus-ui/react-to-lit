/**
 * Unit tests for naming utilities (src/naming.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  camelToKebab,
  pascalToKebab,
  kebabToPascal,
  isEventProp,
  toLitEventName,
  toCustomEventName,
  reactAttrToHtml,
  toTagName,
  escapeRegex,
} from '../src/naming.js';

// ---------------------------------------------------------------------------
// camelToKebab
// ---------------------------------------------------------------------------

describe('camelToKebab', () => {
  it('converts simple camelCase', () => {
    expect(camelToKebab('readOnly')).toBe('read-only');
  });

  it('converts multi-word camelCase', () => {
    expect(camelToKebab('ariaLabel')).toBe('aria-label');
  });

  it('leaves lowercase unchanged', () => {
    expect(camelToKebab('disabled')).toBe('disabled');
  });

  it('handles consecutive capitals correctly', () => {
    expect(camelToKebab('tabIndex')).toBe('tab-index');
  });

  it('handles numbers adjacent to capitals', () => {
    expect(camelToKebab('v2Theme')).toBe('v2-theme');
  });
});

// ---------------------------------------------------------------------------
// pascalToKebab
// ---------------------------------------------------------------------------

describe('pascalToKebab', () => {
  it('converts PascalCase to kebab', () => {
    expect(pascalToKebab('ButtonDropdown')).toBe('button-dropdown');
  });

  it('converts InternalIcon', () => {
    expect(pascalToKebab('InternalIcon')).toBe('internal-icon');
  });

  it('converts single word', () => {
    expect(pascalToKebab('Badge')).toBe('badge');
  });

  it('handles multi-word PascalCase', () => {
    expect(pascalToKebab('TabHeaderBar')).toBe('tab-header-bar');
  });
});

// ---------------------------------------------------------------------------
// kebabToPascal
// ---------------------------------------------------------------------------

describe('kebabToPascal', () => {
  it('converts kebab-case to PascalCase', () => {
    expect(kebabToPascal('button-dropdown')).toBe('ButtonDropdown');
  });

  it('converts single word', () => {
    expect(kebabToPascal('badge')).toBe('Badge');
  });

  it('handles multi-segment', () => {
    expect(kebabToPascal('tab-header-bar')).toBe('TabHeaderBar');
  });
});

// ---------------------------------------------------------------------------
// isEventProp
// ---------------------------------------------------------------------------

describe('isEventProp', () => {
  it('recognizes onXxx pattern', () => {
    expect(isEventProp('onClick')).toBe(true);
    expect(isEventProp('onChange')).toBe(true);
    expect(isEventProp('onKeyDown')).toBe(true);
  });

  it('rejects non-event props', () => {
    expect(isEventProp('disabled')).toBe(false);
    expect(isEventProp('once')).toBe(false);
    expect(isEventProp('ongoing')).toBe(false);
    expect(isEventProp('on')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toLitEventName
// ---------------------------------------------------------------------------

describe('toLitEventName', () => {
  it('converts React event to Lit event name', () => {
    expect(toLitEventName('onKeyDown')).toBe('keydown');
    expect(toLitEventName('onClick')).toBe('click');
    expect(toLitEventName('onChange')).toBe('change');
  });
});

// ---------------------------------------------------------------------------
// toCustomEventName
// ---------------------------------------------------------------------------

describe('toCustomEventName', () => {
  it('converts React event to CustomEvent name', () => {
    expect(toCustomEventName('onKeyDown')).toBe('keyDown');
    expect(toCustomEventName('onClick')).toBe('click');
    expect(toCustomEventName('onChange')).toBe('change');
  });
});

// ---------------------------------------------------------------------------
// reactAttrToHtml
// ---------------------------------------------------------------------------

describe('reactAttrToHtml', () => {
  it('converts known React attrs to HTML', () => {
    expect(reactAttrToHtml('className')).toBe('class');
    expect(reactAttrToHtml('htmlFor')).toBe('for');
    expect(reactAttrToHtml('tabIndex')).toBe('tabindex');
    expect(reactAttrToHtml('autoFocus')).toBe('autofocus');
    expect(reactAttrToHtml('readOnly')).toBe('readonly');
  });

  it('passes unknown attrs through unchanged', () => {
    expect(reactAttrToHtml('disabled')).toBe('disabled');
    expect(reactAttrToHtml('aria-label')).toBe('aria-label');
    expect(reactAttrToHtml('custom')).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// toTagName
// ---------------------------------------------------------------------------

describe('toTagName', () => {
  it('derives custom element tag names', () => {
    expect(toTagName('Button')).toBe('el-button');
    expect(toTagName('InternalButton')).toBe('el-internal-button');
    expect(toTagName('StatusIndicator')).toBe('el-status-indicator');
    expect(toTagName('TabHeaderBar')).toBe('el-tab-header-bar');
  });
});

// ---------------------------------------------------------------------------
// escapeRegex
// ---------------------------------------------------------------------------

describe('escapeRegex', () => {
  it('escapes regex special chars', () => {
    expect(escapeRegex('foo.bar')).toBe('foo\\.bar');
    expect(escapeRegex('foo(bar)')).toBe('foo\\(bar\\)');
    expect(escapeRegex('a+b*c?d')).toBe('a\\+b\\*c\\?d');
    expect(escapeRegex('$100')).toBe('\\$100');
  });

  it('leaves plain strings unchanged', () => {
    expect(escapeRegex('foobar')).toBe('foobar');
  });
});
