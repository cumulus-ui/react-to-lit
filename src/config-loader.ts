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
import type { CleanupPlugin } from './transforms/cleanup-core.js';
import { createCloudscapeConfig, cloudscapeCleanupPlugin } from './presets/cloudscape.js';

/** Known built-in presets. */
const PRESETS: Record<string, { config: () => CompilerConfig; cleanupPlugin?: CleanupPlugin }> = {
  cloudscape: { config: createCloudscapeConfig, cleanupPlugin: cloudscapeCleanupPlugin },
};

export interface LoadedConfig {
  config: CompilerConfig;
  cleanupPlugin?: CleanupPlugin;
}

/**
 * Load a compiler configuration.
 *
 * @param configPath  Path to a user config file (JS/TS module exporting a
 *                    `CompilerConfig` or a factory function returning one).
 * @param preset      Name of a built-in preset (e.g. `'cloudscape'`).
 * @returns           Resolved `CompilerConfig` with optional cleanup plugin.
 */
export async function loadConfig(
  configPath?: string,
  preset?: string,
): Promise<LoadedConfig> {
  // 1. Explicit config file takes priority
  if (configPath) {
    const resolved = path.resolve(configPath);
    const mod = (await import(resolved)) as Record<string, unknown>;

    // Support both `export default config` and `export default () => config`
    const exported = mod['default'] ?? mod['config'];
    if (typeof exported === 'function') {
      return { config: mergeWithDefaults(exported() as Partial<CompilerConfig>) };
    }
    return { config: mergeWithDefaults(exported as Partial<CompilerConfig>) };
  }

  // 2. Named preset
  if (preset) {
    const entry = PRESETS[preset];
    if (!entry) {
      throw new Error(
        `Unknown preset '${preset}'. Available presets: ${Object.keys(PRESETS).join(', ')}`,
      );
    }
    return { config: entry.config(), cleanupPlugin: entry.cleanupPlugin };
  }

  // 3. Defaults
  return { config: createDefaultConfig() };
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
    hooks: { ...defaults.hooks, ...partial.hooks },
  };
}
