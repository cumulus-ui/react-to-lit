/**
 * Property system integration tests.
 *
 * Runs the FULL pipeline (parse → enrich with PackageAnalyzer → transform → emit)
 * on real Cloudscape components and verifies all three property system changes
 * work together:
 *
 * 1. `reflect: true` in @property decorators
 * 2. HTMLElement inherited props (className, id) are filtered out
 * 3. Optional props without defaults get `?` marker
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseComponent } from '../src/parser/index.js';
import { transformAll } from '../src/transforms/index.js';
import { emitComponent } from '../src/emitter/index.js';
import { discoverComponents } from '../src/config.js';
import { PackageAnalyzer } from '../src/package-analyzer.js';
import { cloudscapeCleanupPlugin } from '../src/presets/cloudscape.js';

const PACKAGE_NAME = '@cloudscape-design/components';
const CLOUDSCAPE_SRC = path.resolve(
  import.meta.dirname,
  '../vendor/cloudscape-source/src',
);

// ---------------------------------------------------------------------------
// Full CLI-equivalent pipeline
// ---------------------------------------------------------------------------

/**
 * Mirrors the CLI pipeline: parse → enrich props via PackageAnalyzer → transform → emit.
 * This is the same flow as `src/cli.ts` processComponents().
 */
function fullCliPipeline(componentName: string): string {
  const analyzer = new PackageAnalyzer(PACKAGE_NAME);
  const discovered = discoverComponents(PACKAGE_NAME);
  const entry = discovered.find(c => c.name === componentName);
  if (!entry) throw new Error(`Component '${componentName}' not found`);

  const knownComponents = new Set(discovered.map(c => c.name));
  const reactFrameworkAttributes = analyzer.getReactFrameworkAttributes();

  // Build keepProps + classifiedProps from PackageAnalyzer (same as CLI)
  const keepProps = new Set<string>();
  let classifiedProps = new Map<string, { classification: string; deprecated: boolean; optional: boolean; jsDocTags: string[] }>();

  if (entry.propsType && entry.propsFile) {
    const propsType = analyzer.getPropsType(entry.propsType, entry.propsFile);
    if (propsType) {
      for (const prop of propsType.getProperties()) {
        keepProps.add(prop.name);
      }
      classifiedProps = analyzer.classifyAllProps(propsType);
    }
  }

  const passthroughProps = new Set<string>();
  for (const [name, classified] of classifiedProps) {
    if (classified.classification === 'passthrough') passthroughProps.add(name);
  }

  // Parse
  const ir = parseComponent(
    path.join(CLOUDSCAPE_SRC, entry.dir.replace(/^\.\//, '')),
    { keepProps, knownComponents, reactFrameworkAttributes },
  );

  // Enrich props with optional/deprecated from PackageAnalyzer (same as CLI lines 116-119)
  for (const prop of ir.props) {
    const classified = classifiedProps.get(prop.name);
    if (classified?.deprecated) prop.deprecated = true;
    if (classified?.optional) prop.optional = true;
  }

  // Transform
  const transformed = transformAll(ir, {
    knownComponents,
    skipProps: passthroughProps,
    cleanupPlugin: cloudscapeCleanupPlugin,
  });

  // Emit
  return emitComponent(transformed);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property system integration: Badge', () => {
  const output = fullCliPipeline('Badge');

  it('should have reflect: true on @property decorators', () => {
    // Every @property decorator should include reflect: true
    const propertyDecorators = output.match(/@property\(\{[^}]+\}\)/g) ?? [];
    expect(propertyDecorators.length).toBeGreaterThan(0);
    for (const decorator of propertyDecorators) {
      expect(decorator).toContain('reflect: true');
    }
  });

  it('should have color prop with default value (no ? marker)', () => {
    // color has a default of 'grey', so it should NOT have ?
    expect(output).toMatch(/color[^?]*=\s*'grey'/);
    expect(output).not.toMatch(/color\?/);
  });

  it('should NOT contain className anywhere', () => {
    // HTMLElement inherited prop — must be filtered out
    const stripped = output.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toMatch(/\bclassName\b/);
  });

  it('should NOT contain override id', () => {
    // HTMLElement inherited prop — must be filtered out
    // "id" can appear in other contexts (e.g. #button), so check for property declaration
    expect(output).not.toMatch(/^\s+(?:override\s+)?id\s*[?:=]/m);
  });

  it('should produce a valid class extending LitElement', () => {
    expect(output).toContain('export class Badge extends LitElement');
  });

  it('should log output for manual review', () => {
    console.log('\n=== Badge (property system integration) ===');
    console.log(output);
    console.log('=== end Badge ===\n');
  });
});

describe('Property system integration: Button', () => {
  const output = fullCliPipeline('Button');

  it('should have reflect: true on @property decorators', () => {
    const propertyDecorators = output.match(/@property\(\{[^}]+\}\)/g) ?? [];
    expect(propertyDecorators.length).toBeGreaterThan(0);
    for (const decorator of propertyDecorators) {
      expect(decorator).toContain('reflect: true');
    }
  });

  it('should have href as optional without default (? marker)', () => {
    // href is optional in ButtonProps and has no default → should get ?
    expect(output).toMatch(/href\?\s*:\s*string/);
  });

  it('should have variant with default value (no ? marker)', () => {
    // variant has a default of 'normal' → should NOT have ?
    expect(output).toMatch(/variant[^?]*=\s*'normal'/);
    expect(output).not.toMatch(/variant\?/);
  });

  it('should NOT contain className anywhere', () => {
    const stripped = output.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toMatch(/\bclassName\b/);
  });

  it('should NOT contain override id as a property', () => {
    expect(output).not.toMatch(/^\s+(?:override\s+)?id\s*[?:=]/m);
  });

  it('should have disabled with default false (no ? marker)', () => {
    expect(output).toMatch(/disabled.*=\s*false/);
    expect(output).not.toMatch(/disabled\?/);
  });

  it('should produce a valid class extending LitElement', () => {
    expect(output).toContain('export class Button extends LitElement');
  });

  it('should log output for manual review', () => {
    console.log('\n=== Button (property system integration) ===');
    console.log(output);
    console.log('=== end Button ===\n');
  });
});
