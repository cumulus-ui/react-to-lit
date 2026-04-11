/**
 * Transform pipeline orchestrator.
 *
 * Runs all transforms in the correct order on a ComponentIR.
 */
import type { ComponentIR } from '../ir/types.js';
import { transformClsx } from './clsx.js';
import { unwrapWithNativeAttributes } from './unwrap.js';
import { transformEvents } from './events.js';
import { rewriteIdentifiers } from './identifiers.js';
import { resolveComponentReferences, type ComponentRegistry, cloudscapeComponentRegistry } from './components.js';
import { removeCloudscapeInternals } from './cleanup.js';
import { transformSlots } from './slots.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TransformOptions {
  /** Component registry for resolving React components to custom elements */
  componentRegistry?: ComponentRegistry;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run all transforms on a ComponentIR in the correct order.
 *
 * Order matters:
 * 1. Cleanup — remove Cloudscape internals first
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
  const registry = options.componentRegistry ?? cloudscapeComponentRegistry;

  let result = ir;

  // 1. Remove Cloudscape internals
  result = removeCloudscapeInternals(result);

  // 2. Unwrap WithNativeAttributes
  result = { ...result, template: unwrapWithNativeAttributes(result.template) };

  // 3. Resolve component references
  const { template: resolvedTemplate, sideEffectImports } = resolveComponentReferences(
    result.template,
    registry,
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
  result = transformEvents(result);

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
export { resolveComponentReferences, cloudscapeComponentRegistry } from './components.js';
export type { ComponentRegistry } from './components.js';
export { removeCloudscapeInternals } from './cleanup.js';
export { transformSlots } from './slots.js';
