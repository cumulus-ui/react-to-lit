import { describe, it, expect, beforeAll } from 'vitest';
import { PackageAnalyzer } from '../src/package-analyzer.js';
import { discoverComponents } from '../src/config.js';

const PACKAGE = '@cloudscape-design/components';

let analyzer: PackageAnalyzer;
let componentMap: Map<string, { propsType: string; propsFile: string }>;

beforeAll(() => {
  analyzer = new PackageAnalyzer(PACKAGE);
  const components = discoverComponents(PACKAGE);
  componentMap = new Map();
  for (const c of components) {
    if (c.propsType && c.propsFile) {
      componentMap.set(c.name, { propsType: c.propsType, propsFile: c.propsFile });
    }
  }
});

function getDummyProps(componentName: string): Record<string, unknown> {
  const meta = componentMap.get(componentName);
  if (!meta) throw new Error(`Component ${componentName} not found`);
  const propsType = analyzer.getPropsType(meta.propsType, meta.propsFile);
  if (!propsType) throw new Error(`Could not resolve props type for ${componentName}`);
  return analyzer.generateDummyProps(propsType);
}

describe('generateDummyProps', () => {
  it('returns empty object for Badge (all props optional)', () => {
    const dummy = getDummyProps('Badge');
    expect(dummy).toEqual({});
  });

  it('returns required array and callback for FileInput', () => {
    const dummy = getDummyProps('FileInput');
    expect(dummy.value).toEqual([]);
    expect(dummy.onChange).toBe('__NOOP_FN__');
  });

  it('returns nested required object for TopNavigation', () => {
    const dummy = getDummyProps('TopNavigation');
    expect(dummy.identity).toBeDefined();
    expect(typeof dummy.identity).toBe('object');
    const identity = dummy.identity as Record<string, unknown>;
    expect(identity.href).toBe('');
    expect(identity).not.toHaveProperty('title');
  });

  it('returns empty object when all props are optional', () => {
    const dummy = getDummyProps('Alert');
    expect(dummy).toEqual({});
  });

  it('generates string literal for union-of-literals required prop', () => {
    const dummy = getDummyProps('FileInput');
    expect(typeof dummy.value).not.toBe('undefined');
  });
});
