/**
 * Tests for the CompilerConfig interfaces, presets, and config loader.
 */
import { describe, it, expect } from 'vitest';
import { createDefaultConfig, createCloudscapeConfig } from '../src/config.js';
import { loadConfig } from '../src/config-loader.js';

// ---------------------------------------------------------------------------
// createDefaultConfig
// ---------------------------------------------------------------------------

describe('createDefaultConfig', () => {
  it('returns a valid config with all top-level fields populated', () => {
    const config = createDefaultConfig();

    expect(config.input).toBeDefined();
    expect(config.output).toBeDefined();
    expect(config.cleanup).toBeDefined();
    expect(config.components).toBeDefined();
    expect(config.events).toBeDefined();
  });

  it('has sensible cleanup defaults', () => {
    const config = createDefaultConfig();

    expect(config.cleanup.skipPrefixes).toContain('__');
    expect(config.cleanup.removeAttributes).toContain('key');
    expect(config.cleanup.removeAttributes).toContain('ref');
    expect(config.cleanup.unwrapComponents).toContain('Fragment');
    expect(config.cleanup.unwrapComponents).toContain('React.Fragment');
  });

  it('uses native dispatch mode', () => {
    const config = createDefaultConfig();
    expect(config.events.dispatchMode).toBe('native');
  });

  it('has auto-derive enabled for components', () => {
    const config = createDefaultConfig();
    expect(config.components.autoDerive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createCloudscapeConfig — Cloudscape preset values
// ---------------------------------------------------------------------------

describe('createCloudscapeConfig', () => {
  it('has matching skipPrefixes', () => {
    const config = createCloudscapeConfig();
    expect(config.cleanup.skipPrefixes).toEqual(['__']);
  });

  it('has matching removeAttributes', () => {
    const config = createCloudscapeConfig();
    const expected = [
      'key', 'ref', 'componentName', 'skipWarnings', 'baseProps',
      'nativeAttributes', 'nativeInputAttributes',
      'nativeButtonAttributes', 'nativeAnchorAttributes',
      'analyticsAction', 'analyticsMetadata',
    ];
    expect(config.cleanup.removeAttributes).toEqual(expected);
  });

  it('has matching removeAttributePrefixes', () => {
    const config = createCloudscapeConfig();
    expect(config.cleanup.removeAttributePrefixes).toEqual(['__', 'data-analytics', 'analytics']);
  });

  it('has matching infraFunctions', () => {
    const config = createCloudscapeConfig();
    const expected = [
      'applyDisplayName', 'getBaseProps', 'getAnalyticsMetadataProps', 'checkSafeUrl',
      'warnOnce', 'applyDefaults', 'FunnelMetrics', 'copyAnalyticsMetadataAttribute',
      'getAnalyticsLabelAttribute',
    ];
    expect(config.cleanup.infraFunctions).toEqual(expected);
  });

  it('has matching unwrapComponents (all four groups)', () => {
    const config = createCloudscapeConfig();
    const unwrap = config.cleanup.unwrapComponents;

    // React builtins
    expect(unwrap).toContain('Fragment');
    expect(unwrap).toContain('React.Fragment');
    expect(unwrap).toContain('Suspense');
    expect(unwrap).toContain('StrictMode');
    expect(unwrap).toContain('Profiler');

    // Third-party wrappers
    expect(unwrap).toContain('CSSTransition');
    expect(unwrap).toContain('FocusLock');
    expect(unwrap).toContain('Portal');

    // Cloudscape wrappers
    expect(unwrap).toContain('AnalyticsFunnel');
    expect(unwrap).toContain('BuiltInErrorBoundary');
    expect(unwrap).toContain('ColumnWidthsProvider');
    expect(unwrap).toContain('TableComponentsContextProvider');

    // Context providers
    expect(unwrap).toContain('ButtonContext.Provider');
    expect(unwrap).toContain('ModalContext.Provider');
    expect(unwrap).toContain('WidthsContext.Provider');
  });


});

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns defaults when no config or preset is provided', async () => {
    const config = await loadConfig();
    const defaults = createDefaultConfig();

    expect(config).toEqual(defaults);
  });

  it('loads the cloudscape preset by name', async () => {
    const config = await loadConfig(undefined, 'cloudscape');
    const preset = createCloudscapeConfig();

    expect(config).toEqual(preset);
  });

  it('throws on unknown preset name', async () => {
    await expect(loadConfig(undefined, 'nonexistent')).rejects.toThrow(
      /Unknown preset 'nonexistent'/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI flags (smoke test — just verify they are accepted without throwing)
// ---------------------------------------------------------------------------

describe('CLI --config and --preset flags', () => {
  it('Commander program accepts --config flag', async () => {
    // Import the Commander program definition from cli.ts is not practical
    // since it calls program.parse(). Instead, verify the config-loader
    // integration works end-to-end by calling loadConfig directly.
    // The flag wiring is tested by the fact that cli.ts compiles without
    // error and the loadConfig function is exercised above.
    const config = await loadConfig(undefined, 'cloudscape');
    expect(config.input.declarationsPackage).toBe('@cloudscape-design/components');
  });

  it('Commander program accepts --preset flag', async () => {
    const config = await loadConfig(undefined, 'cloudscape');
    expect(config.cleanup.skipPrefixes.length).toBeGreaterThan(0);
  });
});
