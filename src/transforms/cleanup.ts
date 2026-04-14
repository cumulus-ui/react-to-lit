/**
 * Cleanup transform orchestrator.
 *
 * Composes core (generic) cleanup with library-specific plugins.
 */
import type { ComponentIR } from '../ir/types.js';
import type { CleanupConfig } from '../config.js';
import { applyCoreCleanup, applyPlugin, type CleanupPlugin } from './cleanup-core.js';

export type { CleanupPlugin } from './cleanup-core.js';

export function removeLibraryInternals(
  ir: ComponentIR,
  skipProps: Set<string>,
  plugin?: CleanupPlugin,
  cleanupConfig?: CleanupConfig,
): ComponentIR {
  let result = applyCoreCleanup(ir, skipProps, cleanupConfig);

  if (plugin) {
    result = applyPlugin(result, plugin);
  }

  return result;
}

export { removeLibraryInternals as removeCloudscapeInternals };
