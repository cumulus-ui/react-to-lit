import { describe, it, expect, beforeAll } from 'vitest';
import { PackageAnalyzer } from '../src/package-analyzer.js';
import { discoverComponents } from '../src/config.js';

const PACKAGE = '@cloudscape-design/components';

let analyzer: PackageAnalyzer;
let alertPropsType: string;
let alertPropsFile: string;

beforeAll(() => {
  const components = discoverComponents(PACKAGE);
  const alert = components.find(c => c.name === 'Alert');
  if (!alert?.propsType || !alert?.propsFile) {
    throw new Error('Alert component not found or missing props metadata');
  }
  alertPropsType = alert.propsType;
  alertPropsFile = alert.propsFile;
  analyzer = new PackageAnalyzer(PACKAGE);
});

describe('optional prop detection', () => {
  it('marks optional props with optional: true', () => {
    const propsType = analyzer.getPropsType(alertPropsType, alertPropsFile);
    if (!propsType) throw new Error('Could not resolve Alert props type');

    const classified = analyzer.classifyAllProps(propsType);

    const dismissible = classified.get('dismissible');
    expect(dismissible).toBeDefined();
    expect(dismissible!.optional).toBe(true);
  });

  it('all Alert props are optional (interface uses ? on every member)', () => {
    const propsType = analyzer.getPropsType(alertPropsType, alertPropsFile);
    if (!propsType) throw new Error('Could not resolve Alert props type');

    const classified = analyzer.classifyAllProps(propsType);

    for (const [, info] of classified) {
      expect(info.optional).toBe(true);
    }
  });

  it('returns optional field for every classified prop', () => {
    const propsType = analyzer.getPropsType(alertPropsType, alertPropsFile);
    if (!propsType) throw new Error('Could not resolve Alert props type');

    const classified = analyzer.classifyAllProps(propsType);

    for (const [name, info] of classified) {
      expect(typeof info.optional).toBe('boolean');
    }
  });
});
