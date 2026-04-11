/**
 * Cloudscape-specific configuration.
 *
 * Constants that are specific to the Cloudscape design system, not
 * generalizable to other React→Lit conversions. Centralized here
 * to avoid duplication across parser, transforms, and emitter.
 */

// ---------------------------------------------------------------------------
// Props to skip — Cloudscape internal infrastructure, not part of public API
// ---------------------------------------------------------------------------

/** Props that should never appear in the generated Lit component. */
export const SKIP_PROPS = new Set([
  'nativeAttributes', 'nativeInputAttributes', 'nativeButtonAttributes',
  'nativeAnchorAttributes', 'analyticsAction', 'analyticsMetadata',
]);

/** Prop name prefixes that indicate internal infrastructure. */
export const SKIP_PREFIXES = ['__'];

// ---------------------------------------------------------------------------
// Template attributes to remove
// ---------------------------------------------------------------------------

/** Attributes to strip from template elements. */
export const REMOVE_ATTRS = new Set([
  'key', 'ref', 'componentName', 'skipWarnings',
  'nativeAttributes', 'nativeInputAttributes',
  'nativeButtonAttributes', 'nativeAnchorAttributes',
]);

/** Attribute prefixes to strip from template elements. */
export const REMOVE_ATTR_PREFIXES = ['__', 'data-analytics'];

// ---------------------------------------------------------------------------
// Infrastructure functions to remove from component bodies
// ---------------------------------------------------------------------------

/** Cloudscape helper functions that should be stripped. */
export const INFRA_FUNCTIONS = new Set([
  'applyDisplayName', 'getBaseProps', 'getAnalyticsMetadataProps', 'checkSafeUrl',
]);
