/**
 * Hook mapping registry.
 *
 * Maps React hook names (both standard and custom) to their Lit equivalents.
 * This is the extensibility point — for a non-Cloudscape React library,
 * provide your own registry via the config file.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookAction = 'skip' | 'controller' | 'mixin' | 'utility' | 'inline' | 'context';

export interface HookMapping {
  /** What to do when the parser encounters this hook */
  action: HookAction;

  /** For 'controller': emit a ControllerIR */
  controller?: {
    className: string;
    importPath: string;
  };

  /** For 'mixin': add to ComponentIR.mixins */
  mixin?: string;

  /** For 'utility': inline the result as a plain function call */
  utility?: {
    functionName: string;
    importPath: string;
  };

  /** For 'context': consume a Lit context */
  context?: {
    contextName: string;
    contextImport: string;
    type: string;
    defaultImport?: string;
    defaultValue?: string;
  };

  /** For 'skip': reason why this hook is dropped */
  reason?: string;
}

export type HookRegistry = Record<string, HookMapping>;

// ---------------------------------------------------------------------------
// Default Cloudscape registry
// ---------------------------------------------------------------------------

export const cloudscapeHookRegistry: HookRegistry = {
  // -----------------------------------------------------------------------
  // Cloudscape infrastructure — skip (telemetry, analytics, toolkit internals)
  // -----------------------------------------------------------------------
  'useBaseComponent': {
    action: 'skip',
    reason: 'Cloudscape telemetry — not needed in Lit',
  },
  'useModalContextLoadingComponent': {
    action: 'skip',
    reason: 'Cloudscape modal analytics',
  },
  'useModalContextLoadingButtonComponent': {
    action: 'skip',
    reason: 'Cloudscape modal analytics',
  },
  'usePerformanceMarks': {
    action: 'skip',
    reason: 'Cloudscape performance instrumentation',
  },
  'useSingleTabStopNavigation': {
    action: 'skip',
    reason: 'Cloudscape component-toolkit internal',
  },
  'useInternalI18n': {
    action: 'skip',
    reason: 'Cloudscape i18n — handled separately in Lit',
  },
  'useFunnel': {
    action: 'skip',
    reason: 'Cloudscape funnel analytics',
  },
  'useFunnelStep': {
    action: 'skip',
    reason: 'Cloudscape funnel analytics',
  },
  'useFunnelSubStep': {
    action: 'skip',
    reason: 'Cloudscape funnel analytics',
  },
  'useHiddenDescription': {
    action: 'skip',
    reason: 'ARIA pattern handled differently in Shadow DOM',
  },
  'useModalContext': {
    action: 'skip',
    reason: 'Cloudscape modal analytics',
  },

  // -----------------------------------------------------------------------
  // Mapped to Lit equivalents
  // -----------------------------------------------------------------------
  'useControllable': {
    action: 'controller',
    controller: {
      className: 'ControllableController',
      importPath: '../internal/controllers/controllable.js',
    },
  },
  'useForwardFocus': {
    action: 'skip',
    reason: 'Handled by public method extraction from useImperativeHandle',
  },
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
    utility: {
      functionName: 'generateUniqueId',
      importPath: '../internal/hooks/use-unique-id.js',
    },
  },
  'useMergeRefs': {
    action: 'skip',
    reason: 'Ref merging not needed in Lit — use direct DOM queries',
  },
};

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/**
 * Create a merged registry from defaults + user overrides.
 */
export function createHookRegistry(overrides?: HookRegistry): HookRegistry {
  return { ...cloudscapeHookRegistry, ...overrides };
}

/**
 * Look up a hook in the registry.
 * Returns undefined if the hook is not registered (treat as unknown).
 */
export function lookupHook(
  registry: HookRegistry,
  hookName: string,
): HookMapping | undefined {
  return registry[hookName];
}
