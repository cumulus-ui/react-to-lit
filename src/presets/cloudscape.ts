/**
 * Cloudscape design-system preset.
 *
 * All values formerly hard-coded in `cloudscape-config.ts` are expressed
 * here as a pure `CompilerConfig` object.  The legacy shim re-derives the
 * old Set / string[] exports from this config so existing consumers are
 * unaffected.
 */
import type { CompilerConfig } from '../config.js';
import type { HookRegistry } from '../hooks/registry.js';

// ---------------------------------------------------------------------------
// Component lists (same groupings as the original cloudscape-config.ts)
// ---------------------------------------------------------------------------

/**
 * React built-in components that produce no DOM output.
 * Fragment, StrictMode, Suspense, Profiler — invisible wrappers that exist
 * only for React's runtime.
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

// ---------------------------------------------------------------------------
// Preset factory
// ---------------------------------------------------------------------------

/**
 * Create a `CompilerConfig` pre-populated with all Cloudscape design-system
 * values.  This is a pure data migration of the original
 * `cloudscape-config.ts` — same values, structured shape.
 */
export function createCloudscapeConfig(): CompilerConfig {
  return {
    input: {
      declarationsPackage: '@cloudscape-design/components',
      skipDirectories: [
        '__a11y__', '__integ__', '__tests__', '__motion__',
        'internal', 'contexts', 'i18n', 'interfaces.ts',
        'test-utils', 'theming', 'node_modules', 'plugins',
      ],
    },
    output: {
      baseClass: { name: 'LitElement', import: 'lit' },
      classPrefix: 'Cs',
      classSuffix: 'Internal',
      tagPrefix: 'el-',
      importExtension: '.js',
    },
    cleanup: {
      skipPrefixes: ['__'],
      removeAttributes: [
        'key', 'ref', 'componentName', 'skipWarnings', 'baseProps',
        'nativeAttributes', 'nativeInputAttributes',
        'nativeButtonAttributes', 'nativeAnchorAttributes',
        'analyticsAction', 'analyticsMetadata',
      ],
      removeAttributePrefixes: ['__', 'data-analytics', 'analytics'],
      infraFunctions: [
        'applyDisplayName', 'getBaseProps', 'getAnalyticsMetadataProps', 'checkSafeUrl',
        'warnOnce', 'applyDefaults', 'FunnelMetrics', 'copyAnalyticsMetadataAttribute',
        'getAnalyticsLabelAttribute',
      ],
      unwrapComponents: [
        ...REACT_BUILTINS,
        ...THIRD_PARTY_WRAPPERS,
        ...CLOUDSCAPE_WRAPPERS,
        ...CONTEXT_PROVIDERS,
      ],
    },
    components: {
      registry: {},
      autoDerive: true,
      stripPrefixes: ['Internal'],
    },
    events: {
      dispatchFunctions: {},
      dispatchMode: 'native',
    },
    hooks: {
      'useBaseComponent': { action: 'skip', reason: 'Cloudscape telemetry' },
      'useModalContextLoadingComponent': { action: 'skip', reason: 'Cloudscape modal analytics' },
      'useModalContextLoadingButtonComponent': { action: 'skip', reason: 'Cloudscape modal analytics' },
      'usePerformanceMarks': { action: 'skip', reason: 'Cloudscape performance instrumentation' },
      'useSingleTabStopNavigation': { action: 'skip', reason: 'Cloudscape component-toolkit internal' },
      'useVisualRefresh': { action: 'skip', reason: 'Visual refresh detection' },
      'useInternalI18n': { action: 'skip', reason: 'Cloudscape i18n' },
      'useFunnel': { action: 'skip', reason: 'Cloudscape funnel analytics' },
      'useFunnelStep': { action: 'skip', reason: 'Cloudscape funnel analytics' },
      'useFunnelSubStep': { action: 'skip', reason: 'Cloudscape funnel analytics' },
      'useHiddenDescription': { action: 'skip', reason: 'ARIA pattern handled differently in Shadow DOM' },
      'useModalContext': { action: 'skip', reason: 'Cloudscape modal analytics' },
      'useControllable': {
        action: 'controller',
        controller: { className: 'ControllableController', importPath: '../internal/controllers/controllable.js' },
      },
      'useForwardFocus': { action: 'skip', reason: 'Handled by useImperativeHandle extraction' },
      'useFormFieldContext': {
        action: 'context',
        context: {
          contextName: 'formFieldContext',
          contextImport: '../internal/context/form-field-context.js',
          type: 'FormFieldContext',
          defaultImport: 'defaultFormFieldContext',
          defaultValue: 'defaultFormFieldContext',
        },
      },
      'useButtonContext': {
        action: 'context',
        context: {
          contextName: 'buttonContext',
          contextImport: '../internal/context/button-context.js',
          type: 'ButtonContext',
          defaultValue: '{ onClick: () => {} }',
        },
      },
      'useUniqueId': {
        action: 'utility',
        utility: { functionName: 'generateUniqueId', importPath: '../internal/hooks/use-unique-id.js' },
      },
      'useMergeRefs': { action: 'skip', reason: 'Ref merging not needed in Lit' },
    } satisfies HookRegistry,
  };
}
