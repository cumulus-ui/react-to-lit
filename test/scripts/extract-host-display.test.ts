import { describe, it, expect } from 'vitest';
import {
  toHostDisplay,
  toPascalCase,
  parseClassMap,
  findDisplayForClass,
} from '../../scripts/extract-host-display.js';

describe('toHostDisplay', () => {
  it.each([
    ['block', 'block'],
    ['flex', 'block'],
    ['grid', 'block'],
    ['table', 'block'],
    ['inline-block', 'inline-block'],
    ['inline-flex', 'inline-flex'],
    ['inline-grid', 'inline-grid'],
    ['inline', 'inline'],
    ['contents', 'contents'],
  ])('%s -> %s', (input, expected) => {
    expect(toHostDisplay(input)).toBe(expected);
  });
});

describe('toPascalCase', () => {
  it.each([
    ['badge', 'Badge'],
    ['button-dropdown', 'ButtonDropdown'],
    ['status-indicator', 'StatusIndicator'],
    ['s3-resource-selector', 'S3ResourceSelector'],
  ])('%s -> %s', (input, expected) => {
    expect(toPascalCase(input)).toBe(expected);
  });
});

describe('parseClassMap', () => {
  it('extracts awsui class names from styles.css.js content', () => {
    const source = `
    export default {
  "root": "awsui_root_abc123",
  "badge": "awsui_badge_def456",
  "badge-color-grey": "awsui_badge-color-grey_ghi789"
};`;
    const map = parseClassMap(source);
    expect(map.get('root')).toBe('awsui_root_abc123');
    expect(map.get('badge')).toBe('awsui_badge_def456');
    expect(map.get('badge-color-grey')).toBe('awsui_badge-color-grey_ghi789');
    expect(map.size).toBe(3);
  });

  it('returns empty map for content with no matches', () => {
    expect(parseClassMap('export default {};')).toEqual(new Map());
  });
});

describe('findDisplayForClass', () => {
  it('extracts display from a base rule', () => {
    const css = `.awsui_root_xxx:not(#\\9) { display: flex; color: red; }`;
    expect(findDisplayForClass(css, 'awsui_root_xxx')).toBe('flex');
  });

  it('returns null when no display declaration exists', () => {
    const css = `.awsui_root_xxx:not(#\\9) { color: red; padding: 0; }`;
    expect(findDisplayForClass(css, 'awsui_root_xxx')).toBeNull();
  });

  it('prefers base rule over compound selector', () => {
    const css = `
      .awsui_root_xxx.awsui_variant_yyy:not(#\\9) { display: inline; }
      .awsui_root_xxx:not(#\\9) { display: flex; }
    `;
    expect(findDisplayForClass(css, 'awsui_root_xxx')).toBe('flex');
  });

  it('skips display: none', () => {
    const css = `
      .awsui_root_xxx:not(#\\9) { display: none; }
      .other .awsui_root_xxx:not(#\\9) { display: block; }
    `;
    expect(findDisplayForClass(css, 'awsui_root_xxx')).toBe('block');
  });

  it('returns null when only display: none exists', () => {
    const css = `.awsui_root_xxx:not(#\\9) { display: none; }`;
    expect(findDisplayForClass(css, 'awsui_root_xxx')).toBeNull();
  });

  it('falls back to compound selector when no base rule has display', () => {
    const css = `
      .awsui_root_xxx:not(#\\9) { color: red; }
      .parent .awsui_root_xxx:not(#\\9) { display: inline-block; }
    `;
    expect(findDisplayForClass(css, 'awsui_root_xxx')).toBe('inline-block');
  });
});
