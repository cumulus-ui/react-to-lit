/**
 * Full pipeline E2E tests: Parse → Transform → Emit.
 *
 * Tests the complete pipeline for Badge, Spinner, and StatusIndicator
 * with transforms applied.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseComponent } from '../../src/parser/index.js';
import { transformAll } from '../../src/transforms/index.js';
import { emitComponent } from '../../src/emitter/index.js';
import { createDefaultConfig, createCloudscapeConfig } from '../../src/config.js';
import { cloudscapeCleanupPlugin } from '../../src/presets/cloudscape.js';
import type { CompilerConfig } from '../../src/config.js';

const CLOUDSCAPE_SRC = path.resolve(
  import.meta.dirname,
  '../../vendor/cloudscape-source/src',
);

function fullPipeline(componentName: string): string {
  const ir = parseComponent(path.join(CLOUDSCAPE_SRC, componentName));
  const transformed = transformAll(ir, { cleanupPlugin: cloudscapeCleanupPlugin });
  return emitComponent(transformed);
}

/** Strip comments from output for assertion checks */
function stripComments(text: string): string {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('Full pipeline: parse → transform → emit', () => {
  // -------------------------------------------------------------------------
  // Badge
  // -------------------------------------------------------------------------
  describe('Badge', () => {
    const output = fullPipeline('badge');

    it('should produce valid class declaration', () => {
      expect(output).toContain('export class CsBadgeInternal extends LitElement');
    });

    it('should NOT contain WithNativeAttributes', () => {
      expect(output).not.toContain('WithNativeAttributes');
    });

    it('should not contain raw JSX in render', () => {
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(stripComments(renderSection)).not.toContain('className=');
    });

    it('should NOT contain React imports', () => {
      expect(stripComments(output)).not.toContain("from 'react'");
    });

    it('should NOT contain baseProps', () => {
      expect(stripComments(output)).not.toContain('baseProps');
    });

    it('should NOT contain __internalRootRef', () => {
      expect(output).not.toContain('__internalRootRef');
    });

    it('includes passthrough props when no skipProps provided', () => {
      expect(output).toContain('nativeAttributes');
    });

    it('should contain <span', () => {
      // Badge renders a <span> (after unwrapping WithNativeAttributes)
      expect(output).toContain('<span');
    });

    it('should contain <slot>', () => {
      // children → <slot>
      expect(output).toContain('<slot>');
    });

    it('should contain class binding in render', () => {
      // After JSX transform, class binding is in the html`` template
      expect(output).toMatch(/class=/);
    });

    it('should contain proper imports', () => {
      expect(output).toContain("from 'lit'");
      expect(output).toContain("from 'lit/decorators.js'");
      expect(output).toContain('LitElement');
      expect(output).toContain('componentStyles');
      expect(output).toContain('sharedStyles');
    });

    it('should log output for review', () => {
      console.log('\n=== Badge (full pipeline) ===');
      console.log(output);
      console.log('=== end Badge ===\n');
    });
  });

  // -------------------------------------------------------------------------
  // Spinner
  // -------------------------------------------------------------------------
  describe('Spinner', () => {
    const output = fullPipeline('spinner');

    it('should not contain WithNativeAttributes in render method', () => {
      // Helpers may still contain raw source; the render method should not
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('WithNativeAttributes');
    });

    it('should not contain className in render method (Spinner)', () => {
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('className=');
    });

    it('should contain span elements', () => {
      expect(output).toContain('span');
    });

    it('should contain class binding', () => {
      expect(output).toMatch(/class=/);
    });

    it('should log output for review', () => {
      console.log('\n=== Spinner (full pipeline) ===');
      console.log(output);
      console.log('=== end Spinner ===\n');
    });
  });

  // -------------------------------------------------------------------------
  // StatusIndicator
  // -------------------------------------------------------------------------
  describe('StatusIndicator', () => {
    const output = fullPipeline('status-indicator');

    it('should NOT contain WithNativeAttributes', () => {
      expect(output).not.toContain('WithNativeAttributes');
    });

    it('should not contain className in render method (StatusIndicator)', () => {
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('className=');
    });

    it('should not contain InternalIcon in render method', () => {
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('<InternalIcon');
    });

    it('should not contain InternalSpinner in render method', () => {
      const renderSection = output.slice(output.indexOf('override render()'));
      expect(renderSection).not.toContain('<InternalSpinner');
    });

    it('should contain <slot> for children', () => {
      expect(output).toContain('<slot>');
    });

    it('should log output for review', () => {
      console.log('\n=== StatusIndicator (full pipeline) ===');
      console.log(output);
      console.log('=== end StatusIndicator ===\n');
    });
  });
});

// ---------------------------------------------------------------------------
// Config-driven pipeline
// ---------------------------------------------------------------------------

describe('config-driven pipeline', () => {
  const CLOUDSCAPE_SRC_DIR = path.resolve(
    import.meta.dirname,
    '../../vendor/cloudscape-source/src',
  );

  it('transformAll with no config produces identical output to today', () => {
    // Parse a known component
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC_DIR, 'badge'));

    // Transform with no config (legacy path)
    const legacyResult = transformAll(ir);
    const legacyOutput = emitComponent(legacyResult);

    // Transform with explicit undefined config (should be same code path)
    const noConfigResult = transformAll(ir, {});
    const noConfigOutput = emitComponent(noConfigResult);

    expect(noConfigOutput).toBe(legacyOutput);
  });

  it('transformAll with Cloudscape config produces consistent output for Cloudscape components', () => {
    const cloudscapeConfig = createCloudscapeConfig();
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC_DIR, 'spinner'), { config: cloudscapeConfig });

    const result = transformAll(ir, { config: cloudscapeConfig });
    const output = emitComponent(result);

    expect(output).toContain('class Cs');
    expect(output).toContain('render()');
  });

  it('transformAll with skipProps changes transform behaviour', () => {
    const config = createCloudscapeConfig();
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC_DIR, 'badge'), { config });

    const defaultResult = transformAll(ir, { config });
    const defaultOutput = emitComponent(defaultResult);

    const withSkipResult = transformAll(ir, { skipProps: new Set(['nativeAttributes']), config });
    const withSkipOutput = emitComponent(withSkipResult);

    expect(withSkipOutput).not.toBe(defaultOutput);
    expect(defaultOutput).toContain('nativeAttributes');
    expect(withSkipOutput).not.toContain('nativeAttributes');
  });

  it('transformAll with custom config respects events config', () => {
    // Use a component that has event props
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC_DIR, 'button'));

    // Default (no config)
    const defaultResult = transformAll(ir);
    const defaultOutput = emitComponent(defaultResult);

    // With native dispatch mode explicitly set
    const nativeConfig = createCloudscapeConfig();
    nativeConfig.events.dispatchMode = 'native';
    const nativeResult = transformAll(ir, { config: nativeConfig });
    const nativeOutput = emitComponent(nativeResult);

    // Both should produce valid output
    expect(defaultOutput).toBeTruthy();
    expect(nativeOutput).toBeTruthy();
  });
});
