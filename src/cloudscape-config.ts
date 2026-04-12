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
]);

/** Attribute prefixes to strip from template elements. */
export const REMOVE_ATTR_PREFIXES = ['__', 'data-analytics'];

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
 * React wrapper components that have no Lit equivalent.
 * Used by both the JSX pre-transformer and the IR component resolver.
 */
export const UNWRAP_COMPONENTS = new Set([
  // React built-ins
  'Fragment', 'React.Fragment', 'Suspense', 'StrictMode',
  // Transition wrappers
  'CSSTransition', 'Transition', 'TransitionGroup',
  // Cloudscape infrastructure wrappers
  'AnalyticsFunnel', 'AnalyticsFunnelStep', 'AnalyticsFunnelSubStep',
  'AppLayoutToolbarPublicContext.Provider',
  'BuiltInErrorBoundary',
  'ButtonContext.Provider',
  'CollectionLabelContext.Provider',
  'CollectionPreferencesMetadata.Provider',
  'ColumnWidthsProvider',
  'ContainerHeaderContextProvider',
  'DropdownContext.Provider', 'DropdownContextProvider',
  'ErrorBoundariesContext.Provider',
  'ExpandableSectionContainer',
  'FocusLock',
  'FormFieldContext.Provider',
  'FormWithAnalytics',
  'FunnelNameSelectorContext.Provider',
  'GridNavigationProvider',
  'InfoLinkLabelContext.Provider',
  'InternalIconContext.Provider',
  'InternalModalAsFunnel',
  'KeyboardNavigationProvider',
  'LinkDefaultVariantContext.Provider',
  'ListComponent',
  'ModalContext.Provider',
  'ModalWithAnalyticsFunnel',
  'Portal',
  'ResetContextsForModal',
  'SingleTabStopNavigationProvider',
  'StickyHeaderContext.Provider',
  'TableComponentsContextProvider',
  'TokenInlineContext.Provider',
  'VisualContext',
  'WidthsContext.Provider',
  'WithNativeAttributes',
]);
