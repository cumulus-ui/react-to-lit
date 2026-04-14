/**
 * Transform pipeline orchestrator.
 *
 * Runs all transforms in the correct order on a ComponentIR.
 */
import type { ComponentIR } from '../ir/types.js';
import type { CompilerConfig } from '../config.js';
import { transformClsx } from './clsx.js';
import { unwrapWithNativeAttributes } from './unwrap.js';
import { transformEvents } from './events.js';
import { rewriteIdentifiers } from './identifiers.js';
import { resolveComponentReferences, type ComponentRegistry, componentRegistry } from './components.js';
import { removeLibraryInternals, type CleanupPlugin } from './cleanup.js';
import { cleanupReactTypes } from './cleanup-react-types.js';
import { transformSlots } from './slots.js';
import { promoteEffectCleanupVars } from './effect-cleanup.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TransformOptions {
  skipProps?: Set<string>;
  knownComponents?: Set<string>;
  config?: CompilerConfig;
  cleanupPlugin?: CleanupPlugin;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ComponentRegistry from a ComponentsConfig record.
 *
 * The config stores component names as string tags or the sentinel
 * `'__UNWRAP__'`.  This is already compatible with the ComponentRegistry
 * type, so we just cast and return.
 */
function buildRegistryFromConfig(
  configRegistry: Record<string, string | '__UNWRAP__'>,
): ComponentRegistry {
  return configRegistry as ComponentRegistry;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run all transforms on a ComponentIR in the correct order.
 *
 * Order matters:
 * 1. Cleanup — remove library internals first
 * 2. Unwrap — unwrap WithNativeAttributes before class transforms
 * 3. Component resolution — resolve React component names to custom elements
 * 4. Slots — detect slot props and convert to <slot>
 * 5. clsx — convert className expressions to classMap
 * 6. Events — convert callback props to CustomEvent dispatch
 * 7. Identifiers — rewrite React identifiers to Lit (last, after all body transforms)
 */
export function transformAll(
  ir: ComponentIR,
  options: TransformOptions = {},
): ComponentIR {
  const config = options.config;

  const registry = config?.components?.registry && Object.keys(config.components.registry).length > 0
    ? buildRegistryFromConfig(config.components.registry)
    : componentRegistry;

  let result = ir;

  // 1. Remove library internals
  result = removeLibraryInternals(result, options.skipProps ?? new Set(), options.cleanupPlugin, config?.cleanup);

  // 1b. Replace React types with web platform equivalents
  result = cleanupReactTypes(result);

  // 2. Unwrap WithNativeAttributes
  result = { ...result, template: unwrapWithNativeAttributes(result.template, config?.cleanup?.removeAttributes) };

  // 3. Resolve component references
  const { template: resolvedTemplate, sideEffectImports } = resolveComponentReferences(
    result.template,
    registry,
    options.knownComponents,
  );
  result = {
    ...result,
    template: resolvedTemplate,
    imports: [
      ...result.imports,
      ...[...sideEffectImports].map((path) => ({
        moduleSpecifier: path,
        isSideEffect: true,
      })),
    ],
  };

  // 4. Slot detection
  result = transformSlots(result);

  // 5. clsx → classMap (template attributes + all IR text fields)
  result = transformClsx(result);

  // 6. Event callbacks → CustomEvent dispatch
  result = transformEvents(result, config?.events);

  // 6b. Promote effect cleanup variables to class fields
  result = promoteEffectCleanupVars(result);

  // 7. Identifier rewriting
  result = rewriteIdentifiers(result);

  return result;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { transformClsx } from './clsx.js';
export { unwrapWithNativeAttributes } from './unwrap.js';
export { transformEvents } from './events.js';
export { rewriteIdentifiers } from './identifiers.js';
export { resolveComponentReferences, componentRegistry } from './components.js';
export type { ComponentRegistry, RegistryEntry } from './components.js';
export { removeLibraryInternals, removeCloudscapeInternals } from './cleanup.js';
export { cleanupReactTypes } from './cleanup-react-types.js';
export { transformSlots } from './slots.js';
