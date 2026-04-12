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
  'key', 'ref', 'componentName', 'skipWarnings', 'baseProps',
  'nativeAttributes', 'nativeInputAttributes',
  'nativeButtonAttributes', 'nativeAnchorAttributes',
  'analyticsAction', 'analyticsMetadata',
]);

/** Attribute prefixes to strip from template elements. */
export const REMOVE_ATTR_PREFIXES = ['__', 'data-analytics', 'analytics'];

// ---------------------------------------------------------------------------
// Infrastructure functions to remove from component bodies
// ---------------------------------------------------------------------------

/** Cloudscape helper functions that should be stripped. */
export const INFRA_FUNCTIONS = new Set([
  'applyDisplayName', 'getBaseProps', 'getAnalyticsMetadataProps', 'checkSafeUrl',
  'warnOnce', 'applyDefaults',
]);

// ---------------------------------------------------------------------------
// Components to unwrap (keep children, discard wrapper)
// ---------------------------------------------------------------------------

/**
 * React built-in components that produce no DOM output.
 * These are the PascalCase exports from the `react` package that act as
 * invisible wrappers — they exist only for React's runtime and have no
 * web-component equivalent.
 *
 * Derived from React 18/19 exports: Fragment, StrictMode, Suspense, Profiler.
 * Cannot be queried at compile time because React is a devDependency.
 */
const REACT_BUILTINS = [
  'Fragment', 'React.Fragment', 'Suspense', 'StrictMode', 'Profiler',
];

/**
 * Third-party wrapper components (transition libraries, focus traps, portals)
 * that wrap children without producing meaningful DOM.
 */
const THIRD_PARTY_WRAPPERS = [
  'CSSTransition', 'Transition', 'TransitionGroup',
  'FocusLock', 'Portal',
];

/**
 * Cloudscape infrastructure wrappers — analytics, context providers,
 * error boundaries, and layout utilities that exist only for React-side
 * plumbing and should be stripped in the Lit output.
 */
const CLOUDSCAPE_WRAPPERS = [
  'AnalyticsFunnel', 'AnalyticsFunnelStep', 'AnalyticsFunnelSubStep',
  'BuiltInErrorBoundary',
  'ColumnWidthsProvider',
  'ContainerHeaderContextProvider',
  'DropdownContextProvider',
  'ExpandableSectionContainer',
  'FormWithAnalytics',
  'GridNavigationProvider',
  'InternalModalAsFunnel',
  'KeyboardNavigationProvider',
  'ListComponent',
  'ModalWithAnalyticsFunnel',
  'ResetContextsForModal',
  'SingleTabStopNavigationProvider',
  'VisualContext',
  'WithNativeAttributes',
  'TableComponentsContextProvider',
];

/**
 * Explicit React Context .Provider/.Consumer wrappers to unwrap.
 * Any component name matching `*.Provider` or `*.Consumer` is also
 * caught dynamically by `shouldUnwrapComponent`.
 */
const CONTEXT_PROVIDERS = [
  'AppLayoutToolbarPublicContext.Provider',
  'ButtonContext.Provider',
  'CollectionLabelContext.Provider',
  'CollectionPreferencesMetadata.Provider',
  'DropdownContext.Provider',
  'ErrorBoundariesContext.Provider',
  'FormFieldContext.Provider',
  'FunnelNameSelectorContext.Provider',
  'InfoLinkLabelContext.Provider',
  'InternalIconContext.Provider',
  'LinkDefaultVariantContext.Provider',
  'ModalContext.Provider',
  'StickyHeaderContext.Provider',
  'TokenInlineContext.Provider',
  'WidthsContext.Provider',
];

/**
 * All components that should be unwrapped (children kept, wrapper removed).
 * Used by both the JSX pre-transformer and the IR component resolver.
 */
export const UNWRAP_COMPONENTS = new Set([
  ...REACT_BUILTINS,
  ...THIRD_PARTY_WRAPPERS,
  ...CLOUDSCAPE_WRAPPERS,
  ...CONTEXT_PROVIDERS,
]);

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
