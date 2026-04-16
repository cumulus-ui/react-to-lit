/**
 * Emitter entry point.
 *
 * Re-exports the main emitComponent function and related types.
 */
export { emitComponent } from './class.js';
export type { EmitOptions } from './class.js';
export { ImportCollector, collectImports } from './imports.js';
export { emitProperties, emitState, emitControllers, emitContexts, emitComputed, emitRefs, emitSkippedHookVars } from './properties.js';
export { emitLifecycle } from './lifecycle.js';
export { emitHandlers, emitPublicMethods } from './handlers.js';
export { emitRenderMethod } from './template.js';
export { emitController, deriveControllerName } from './controllers.js';
export { emitUtility } from './utilities.js';
export { stubUndefinedSymbols } from './undefined-symbols.js';
export type { StubMode, StubOptions } from './undefined-symbols.js';
