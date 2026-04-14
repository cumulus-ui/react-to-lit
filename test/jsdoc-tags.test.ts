import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PackageAnalyzer } from '../src/package-analyzer.js';

const PKG = '@cloudscape-design/components';

describe('ClassifiedProp jsDocTags', () => {
  const analyzer = new PackageAnalyzer(PKG);
  const propsFile = path.join(analyzer.pkgRoot, 'badge', 'interfaces.d.ts');

  it('Badge style prop has awsuiSystem tag', () => {
    const propsType = analyzer.getPropsType('BadgeProps', propsFile);
    expect(propsType).toBeDefined();
    const classified = analyzer.classifyAllProps(propsType!);
    const styleProp = classified.get('style');
    expect(styleProp).toBeDefined();
    expect(styleProp!.jsDocTags).toContain('awsuiSystem');
  });

  it('Badge color prop has no awsuiSystem tag', () => {
    const propsType = analyzer.getPropsType('BadgeProps', propsFile);
    expect(propsType).toBeDefined();
    const classified = analyzer.classifyAllProps(propsType!);
    const colorProp = classified.get('color');
    expect(colorProp).toBeDefined();
    expect(colorProp!.jsDocTags).not.toContain('awsuiSystem');
  });

  it('jsDocTags is always an array', () => {
    const propsType = analyzer.getPropsType('BadgeProps', propsFile);
    expect(propsType).toBeDefined();
    const classified = analyzer.classifyAllProps(propsType!);
    for (const [, prop] of classified) {
      expect(Array.isArray(prop.jsDocTags)).toBe(true);
    }
  });
});
