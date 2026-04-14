/**
 * Integration tests for deprecated props filtering.
 *
 * Verifies that the keepProps logic (mirroring cli.ts) correctly excludes
 * props with @deprecated JSDoc tags unless includeDeprecatedProps is set.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PackageAnalyzer } from '../src/package-analyzer.js';
import { createDefaultConfig, discoverComponents } from '../src/config.js';
import type { CompilerConfig } from '../src/config.js';

const PACKAGE = '@cloudscape-design/components';

let alertPropsType: string;
let alertPropsFile: string;
let analyzer: PackageAnalyzer;

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

/**
 * Build a keepProps set mimicking the cli.ts logic (lines 44-49):
 * for each prop in the type, skip if deprecated and config says exclude.
 */
function buildKeepProps(config: CompilerConfig): Set<string> {
  const propsType = analyzer.getPropsType(alertPropsType, alertPropsFile);
  if (!propsType) throw new Error('Could not resolve Alert props type');

  const keepProps = new Set<string>();
  for (const prop of propsType.getProperties()) {
    if (!config.input?.includeDeprecatedProps) {
      const { deprecated } = analyzer.classifyProp(prop);
      if (deprecated) continue;
    }
    keepProps.add(prop.name);
  }
  return keepProps;
}

describe('deprecated props filtering (Alert)', () => {
  it('excludes deprecated props by default', () => {
    const config = createDefaultConfig();
    const keepProps = buildKeepProps(config);

    expect(keepProps.has('statusIconAriaLabel')).toBe(false);
    expect(keepProps.has('visible')).toBe(false);
    expect(keepProps.has('dismissAriaLabel')).toBe(false);
    expect(keepProps.has('buttonText')).toBe(false);
  });

  it('includes deprecated props when opted in', () => {
    const config = createDefaultConfig();
    config.input.includeDeprecatedProps = true;
    const keepProps = buildKeepProps(config);

    expect(keepProps.has('statusIconAriaLabel')).toBe(true);
    expect(keepProps.has('visible')).toBe(true);
    expect(keepProps.has('dismissAriaLabel')).toBe(true);
    expect(keepProps.has('buttonText')).toBe(true);
  });

  it('does not affect non-deprecated props', () => {
    const config = createDefaultConfig();
    const keepProps = buildKeepProps(config);

    expect(keepProps.has('type')).toBe(true);
    expect(keepProps.has('dismissible')).toBe(true);
    expect(keepProps.has('header')).toBe(true);
    expect(keepProps.has('action')).toBe(true);
    expect(keepProps.has('onDismiss')).toBe(true);
  });
});
