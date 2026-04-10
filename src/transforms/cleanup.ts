/**
 * Cloudscape internals cleanup transform.
 *
 * Removes Cloudscape-specific infrastructure from the IR:
 * - Props starting with __ (internal props)
 * - getBaseProps/baseProps references
 * - useBaseComponent results
 * - applyDisplayName calls
 * - Analytics metadata
 * - checkSafeUrl calls
 */
import type { ComponentIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Props to remove
// ---------------------------------------------------------------------------

const REMOVE_PROPS = new Set([
  'nativeAttributes',
  'nativeInputAttributes',
  'nativeButtonAttributes',
  'nativeAnchorAttributes',
  'analyticsAction',
  'analyticsMetadata',
]);

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function removeCloudscapeInternals(ir: ComponentIR): ComponentIR {
  // Remove internal props
  const props = ir.props.filter((p) => {
    if (p.name.startsWith('__')) return false;
    if (REMOVE_PROPS.has(p.name)) return false;
    return true;
  });

  // Clean handler bodies
  const handlers = ir.handlers.map((h) => ({
    ...h,
    body: cleanHandlerBody(h.body),
  }));

  // Clean effect bodies
  const effects = ir.effects.map((e) => ({
    ...e,
    body: cleanHandlerBody(e.body),
    cleanup: e.cleanup ? cleanHandlerBody(e.cleanup) : undefined,
  }));

  // Clean helpers — remove helpers that are Cloudscape infrastructure
  const helpers = ir.helpers.filter((h) => {
    const infraNames = new Set(['applyDisplayName', 'getBaseProps', 'checkSafeUrl']);
    return !infraNames.has(h.name);
  });

  return {
    ...ir,
    props,
    handlers,
    effects,
    helpers,
  };
}

// ---------------------------------------------------------------------------
// Handler body cleanup
// ---------------------------------------------------------------------------

function cleanHandlerBody(body: string): string {
  let result = body;

  // Remove: const baseProps = getBaseProps(rest);
  result = result.replace(/const\s+baseProps\s*=\s*getBaseProps\([^)]*\)\s*;?\s*/g, '');

  // Remove: checkSafeUrl('Button', href);
  result = result.replace(/checkSafeUrl\([^)]*\)\s*;?\s*/g, '');

  // Remove: const { __internalRootRef } = useBaseComponent(...);
  result = result.replace(/const\s+\{[^}]*\}\s*=\s*useBaseComponent\([^)]*\)\s*;?\s*/g, '');

  // Remove: applyDisplayName(...)
  result = result.replace(/applyDisplayName\([^)]*\)\s*;?\s*/g, '');

  // Remove: getAnalyticsMetadataAttribute(...)
  result = result.replace(/\.\.\.(getAnalyticsMetadataAttribute|getAnalyticsLabelAttribute)\([^)]*\),?\s*/g, '');

  // Remove: [DATA_ATTR_FUNNEL_VALUE]: uniqueId
  result = result.replace(/\[DATA_ATTR_FUNNEL_VALUE\]\s*:\s*\w+,?\s*/g, '');

  return result;
}
