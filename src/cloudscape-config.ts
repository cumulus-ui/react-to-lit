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

// ---------------------------------------------------------------------------
// Template attributes to remove
// ---------------------------------------------------------------------------

/** Attributes to strip from template elements. */
export const REMOVE_ATTRS = config.cleanup.removeAttributes;

/** Attribute prefixes to strip from template elements. */
export const REMOVE_ATTR_PREFIXES = config.cleanup.removeAttributePrefixes;

// ---------------------------------------------------------------------------
// Infrastructure functions to remove from component bodies
// ---------------------------------------------------------------------------

/** Cloudscape helper functions that should be stripped. */
export const INFRA_FUNCTIONS = config.cleanup.infraFunctions;
