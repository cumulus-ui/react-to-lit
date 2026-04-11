/**
 * Shared naming utilities.
 *
 * Single-source-of-truth for name conversions used across
 * parser, transforms, and emitter.
 */

// ---------------------------------------------------------------------------
// Case conversion
// ---------------------------------------------------------------------------

/**
 * Convert camelCase to kebab-case.
 * `readOnly` → `read-only`, `ariaLabel` → `aria-label`
 */
export function camelToKebab(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Convert PascalCase to kebab-case.
 * `ButtonDropdown` → `button-dropdown`, `InternalIcon` → `internal-icon`
 */
export function pascalToKebab(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Convert kebab-case to PascalCase.
 * `button-dropdown` → `ButtonDropdown`
 */
export function kebabToPascal(str: string): string {
  return str.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// ---------------------------------------------------------------------------
// Event name derivation
// ---------------------------------------------------------------------------

/**
 * Convert React event prop name to Lit template event binding name.
 * `onKeyDown` → `keydown` (all lowercase, for `@keydown=`)
 */
export function toLitEventName(reactPropName: string): string {
  return reactPropName.slice(2).toLowerCase();
}

/**
 * Convert React event prop name to CustomEvent name.
 * `onKeyDown` → `keyDown` (preserves internal casing, for `fireNonCancelableEvent(this, 'keyDown')`)
 */
export function toCustomEventName(reactPropName: string): string {
  return reactPropName.charAt(2).toLowerCase() + reactPropName.slice(3);
}
