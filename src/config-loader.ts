/**
 * Configuration loader for the CLI.
 *
 * Resolves a `CompilerConfig` from one of three sources (in priority order):
 *   1. An explicit `--config <path>` file (dynamic import, merged with defaults)
 *   2. A named `--preset <name>` (currently only 'cloudscape')
 *   3. Sensible zero-config defaults
 */

import path from 'node:path';
import type { CompilerConfig } from './config.js';
import { createDefaultConfig } from './config.js';
import { createCloudscapeConfig } from './presets/cloudscape.js';

/** Known built-in presets. */
const PRESETS: Record<string, () => CompilerConfig> = {
  cloudscape: createCloudscapeConfig,
};

/**
 * Load a compiler configuration.
 *
 * @param configPath  Path to a user config file (JS/TS module exporting a
 *                    `CompilerConfig` or a factory function returning one).
 * @param preset      Name of a built-in preset (e.g. `'cloudscape'`).
 * @returns           Resolved `CompilerConfig`.
 */
export async function loadConfig(
  configPath?: string,
  preset?: string,
): Promise<CompilerConfig> {
  // 1. Explicit config file takes priority
  if (configPath) {
    const resolved = path.resolve(configPath);
    const mod = (await import(resolved)) as Record<string, unknown>;

    // Support both `export default config` and `export default () => config`
    const exported = mod['default'] ?? mod['config'];
    if (typeof exported === 'function') {
      return mergeWithDefaults(exported() as Partial<CompilerConfig>);
    }
    return mergeWithDefaults(exported as Partial<CompilerConfig>);
  }

  // 2. Named preset
  if (preset) {
    const factory = PRESETS[preset];
    if (!factory) {
      throw new Error(
        `Unknown preset '${preset}'. Available presets: ${Object.keys(PRESETS).join(', ')}`,
      );
    }
    return factory();
  }

  // 3. Defaults
  return createDefaultConfig();
}

/**
 * Shallow-merge a partial user config on top of the defaults.
 * Each top-level section is spread independently so users only need to
 * specify the fields they want to override.
 */
function mergeWithDefaults(partial: Partial<CompilerConfig>): CompilerConfig {
  const defaults = createDefaultConfig();
  return {
    input: { ...defaults.input, ...partial.input },
    output: { ...defaults.output, ...partial.output },
    cleanup: { ...defaults.cleanup, ...partial.cleanup },
    components: { ...defaults.components, ...partial.components },
    events: { ...defaults.events, ...partial.events },
  };
}
