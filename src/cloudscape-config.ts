/**
 * Cloudscape-specific configuration.
 *
 * Constants that are specific to the Cloudscape design system, not
 * generalizable to other React→Lit conversions. Centralized here
 * to avoid duplication across parser, transforms, and emitter.
 *
 * This file is a backward-compatibility shim.  All values are now
 * defined in the structured preset at `./presets/cloudscape.ts` and
 * re-derived here so that existing consumer imports keep working.
 */

import { createCloudscapeConfig } from './presets/cloudscape.js';

const config = createCloudscapeConfig();

export const SKIP_PREFIXES = config.cleanup.skipPrefixes;

// ---------------------------------------------------------------------------
// Template attributes to remove
// ---------------------------------------------------------------------------

/** Attributes to strip from template elements. */
export const REMOVE_ATTRS = new Set(config.cleanup.removeAttributes);

/** Attribute prefixes to strip from template elements. */
export const REMOVE_ATTR_PREFIXES = config.cleanup.removeAttributePrefixes;

// ---------------------------------------------------------------------------
// Infrastructure functions to remove from component bodies
// ---------------------------------------------------------------------------

/** Cloudscape helper functions that should be stripped. */
export const INFRA_FUNCTIONS = new Set(config.cleanup.infraFunctions);

// ---------------------------------------------------------------------------
// Components to unwrap (keep children, discard wrapper)
// ---------------------------------------------------------------------------

/**
 * All components that should be unwrapped (children kept, wrapper removed).
 * Used by both the JSX pre-transformer and the IR component resolver.
 */
export const UNWRAP_COMPONENTS = new Set(config.cleanup.unwrapComponents);

/**
 * Check if a component name should be unwrapped.
 * Uses both the explicit set AND pattern matching for React Context
 * providers/consumers that may not be listed explicitly.
 */
export function shouldUnwrapComponent(name: string): boolean {
  if (UNWRAP_COMPONENTS.has(name)) return true;
  // Any Xxx.Provider or Xxx.Consumer is a React Context wrapper
  if (name.endsWith('.Provider') || name.endsWith('.Consumer')) return true;
  return false;
}
