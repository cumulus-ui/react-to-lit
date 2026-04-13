/**
 * Cleanup transform orchestrator.
 *
 * Composes core (generic) cleanup with library-specific plugins.
 * By default, applies the Cloudscape cleanup plugin for backward
 * compatibility. Pass an explicit plugin (or `undefined`) to control
 * which library-specific patterns are applied.
 *
 * This module is the public API consumed by `transforms/index.ts`.
 */
import type { ComponentIR } from '../ir/types.js';
import type { CleanupConfig } from '../config.js';
import { applyCoreCleanup, applyPlugin, type CleanupPlugin } from './cleanup-core.js';
import { cloudscapeCleanupPlugin } from '../presets/cloudscape/cleanup.js';

// Re-export the plugin interface for consumers
export type { CleanupPlugin } from './cleanup-core.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Remove library internals from a ComponentIR.
 *
 * 1. Applies core (generic) React → Lit cleanup patterns.
 * 2. Applies a library-specific {@link CleanupPlugin} for additional patterns.
 *
 * Behavior:
 * - Called with no arguments: applies core + Cloudscape plugin (backward compat).
 * - Called with `config` but no `plugin`: applies core only (pure generic mode).
 * - Called with both `config` and `plugin`: applies core + the given plugin.
 *
 * @param ir      The component IR to clean.
 * @param config  Optional cleanup configuration (skip props, remove attrs, etc.).
 * @param plugin  Optional library-specific cleanup plugin. When omitted AND
 *                `config` is also omitted, defaults to the Cloudscape plugin.
 */
export function removeLibraryInternals(
  ir: ComponentIR,
  config?: CleanupConfig,
  plugin?: CleanupPlugin,
): ComponentIR {
  // 1. Core cleanup (generic patterns)
  let result = applyCoreCleanup(ir, config);

  // 2. Library-specific plugin
  // When called with no args at all, default to Cloudscape (backward compat).
  // When called with config but no plugin, skip library-specific cleanup.
  const effectivePlugin = plugin ?? (config === undefined ? cloudscapeCleanupPlugin : undefined);
  if (effectivePlugin) {
    result = applyPlugin(result, effectivePlugin);
  }

  return result;
}

/** Backward-compatible alias. */
export { removeLibraryInternals as removeCloudscapeInternals };
