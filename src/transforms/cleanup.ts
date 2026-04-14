/**
 * Cleanup transform orchestrator.
 *
 * Composes core (generic) cleanup with library-specific plugins.
 */
import type { ComponentIR } from '../ir/types.js';
import { applyCoreCleanup, applyPlugin, type CleanupPlugin } from './cleanup-core.js';
import { cloudscapeCleanupPlugin } from '../presets/cloudscape.js';

export type { CleanupPlugin } from './cleanup-core.js';

export function removeLibraryInternals(
  ir: ComponentIR,
  skipProps: Set<string>,
  plugin?: CleanupPlugin,
): ComponentIR {
  let result = applyCoreCleanup(ir, skipProps);

  const effectivePlugin = plugin ?? cloudscapeCleanupPlugin;
  if (effectivePlugin) {
    result = applyPlugin(result, effectivePlugin);
  }

  return result;
}

export { removeLibraryInternals as removeCloudscapeInternals };
