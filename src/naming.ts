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
  return camelToKebab(str);
}

/**
 * Convert kebab-case to PascalCase.
 * `button-dropdown` → `ButtonDropdown`
 */
export function kebabToPascal(str: string): string {
  return str.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// ---------------------------------------------------------------------------
// Event naming
// ---------------------------------------------------------------------------

/**
 * Check if a prop name is a React event handler.
 * Follows the React convention: `onXxx` where X is uppercase.
 */
export function isEventProp(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

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

// ---------------------------------------------------------------------------
// React → HTML attribute mapping
// ---------------------------------------------------------------------------

/** React attribute names that differ from their HTML equivalents. */
const REACT_TO_HTML_ATTRS: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
  tabIndex: 'tabindex',
  autoFocus: 'autofocus',
  readOnly: 'readonly',
};

/**
 * Convert a React attribute name to its HTML equivalent.
 * Returns the HTML name if different, or the original name unchanged.
 */
export function reactAttrToHtml(name: string): string {
  return REACT_TO_HTML_ATTRS[name] ?? name;
}

// ---------------------------------------------------------------------------
// Component tag derivation
// ---------------------------------------------------------------------------

/**
 * Derive a custom element tag name from a React component name.
 *
 * Always produces `el-{kebab-name}` — a neutral, valid custom element tag.
 * The `el-` prefix ensures the hyphen requirement and provides a uniform
 * namespace that the consumer can remap (e.g., `el-button` → `cs-button`).
 *
 * - `InternalButton` → `el-internal-button`
 * - `Button` → `el-button`
 * - `Dropdown` → `el-dropdown`
 * - `TabHeaderBar` → `el-tab-header-bar`
 */
export function toTagName(reactComponentName: string): string {
  return `el-${pascalToKebab(reactComponentName)}`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Escape a string for use in a RegExp.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
