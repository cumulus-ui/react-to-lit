/**
 * Tests for parser config override support (#23).
 *
 * Verifies that parser functions accept optional config parameters
 * and use config values instead of hardcoded defaults when provided.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseComponent } from '../../src/parser/index.js';
import { isInfraFunction } from '../../src/parser/utils.js';
import { createCloudscapeConfig } from '../../src/presets/cloudscape.js';
import { createDefaultConfig } from '../../src/config.js';

const CLOUDSCAPE_SRC = path.resolve(
  import.meta.dirname,
  '../../vendor/cloudscape-source/src',
);

// ---------------------------------------------------------------------------
// isInfraFunction — accepts optional infraFunctions set
// ---------------------------------------------------------------------------

describe('isInfraFunction', () => {
  it('uses generic defaults (empty) when no set provided', () => {
    // With generic defaults, no function is infra unless explicitly configured
    expect(isInfraFunction('applyDisplayName')).toBe(false);
    expect(isInfraFunction('notAFunction')).toBe(false);
  });

  it('uses provided set when given', () => {
    const custom = new Set(['myInfraFn', 'anotherFn']);
    expect(isInfraFunction('myInfraFn', custom)).toBe(true);
    expect(isInfraFunction('anotherFn', custom)).toBe(true);
    // applyDisplayName is NOT in the custom set
    expect(isInfraFunction('applyDisplayName', custom)).toBe(false);
  });

  it('empty set means nothing is infra', () => {
    const empty = new Set<string>();
    expect(isInfraFunction('applyDisplayName', empty)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractProps — config.cleanup overrides skipProps/skipPrefixes
// ---------------------------------------------------------------------------

describe('extractProps with keepProps', () => {
  it('keeps only props in the provided set', () => {
    const keepProps = new Set(['children']);
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'), { keepProps });
    const colorProp = ir.props.find((p) => p.name === 'color');
    expect(colorProp).toBeUndefined();
  });

  it('preserves all props when keepProps is not provided', () => {
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'));
    const colorProp = ir.props.find((p) => p.name === 'color');
    expect(colorProp).toBeDefined();
  });

  it('keeps only specified props', () => {
    const keepProps = new Set(['color']);
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'), { keepProps });
    expect(ir.props.map(p => p.name)).toEqual(['color']);
  });
});

// ---------------------------------------------------------------------------
// parseComponent — config.cleanup.infraFunctions override
// ---------------------------------------------------------------------------

describe('parseComponent with config.cleanup.infraFunctions', () => {
  it('uses default infraFunctions when no config provided', () => {
    // Default behavior — should work as before
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'));
    expect(ir.name).toBe('Badge');
  });

  it('accepts custom infraFunctions via config', () => {
    const config = createCloudscapeConfig();
    // Override infraFunctions with a custom set
    config.cleanup.infraFunctions = ['customInfraFn'];
    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'), { config });
    expect(ir.name).toBe('Badge');
  });
});

// ---------------------------------------------------------------------------
// parseComponent — config threading through buildSkipImportNames
// ---------------------------------------------------------------------------

describe('parseComponent with config.events.dispatchFunctions', () => {
  it('skips custom dispatch function imports when config provided', () => {
    const config = createCloudscapeConfig();
    config.events.dispatchFunctions = {
      myDispatch: { import: './my-events.js', cancelable: false },
    };

    const ir = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'), { config });
    // Should still parse correctly
    expect(ir.name).toBe('Badge');
  });
});

// ---------------------------------------------------------------------------
// parseComponent — default config (no overrides) matches original behavior
// ---------------------------------------------------------------------------

describe('parseComponent backward compatibility', () => {
  it('produces identical IR with no config vs undefined config', () => {
    const irWithout = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'));
    const irWith = parseComponent(path.join(CLOUDSCAPE_SRC, 'badge'), { config: undefined });

    expect(irWithout.name).toBe(irWith.name);
    expect(irWithout.tagName).toBe(irWith.tagName);
    expect(irWithout.props.length).toBe(irWith.props.length);
    expect(irWithout.props.map(p => p.name)).toEqual(irWith.props.map(p => p.name));
  });
});
