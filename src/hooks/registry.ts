export type HookAction = 'skip' | 'controller' | 'mixin' | 'utility' | 'inline' | 'context';

export interface HookMapping {
  action: HookAction;
  controller?: {
    className: string;
    importPath: string;
  };
  mixin?: string;
  utility?: {
    functionName: string;
    importPath: string;
  };
  context?: {
    contextName: string;
    contextImport: string;
    type: string;
    defaultImport?: string;
    defaultValue?: string;
  };
  reason?: string;
}

export type HookRegistry = Record<string, HookMapping>;

export function createHookRegistry(mappings: HookRegistry = {}): HookRegistry {
  return mappings;
}

export function lookupHook(
  registry: HookRegistry,
  hookName: string,
): HookMapping | undefined {
  return registry[hookName];
}
