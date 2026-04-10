/**
 * Emitter entry point.
 *
 * Re-exports the main emitComponent function and related types.
 */
export { emitComponent } from './class.js';
export type { EmitOptions } from './class.js';
export { ImportCollector, collectImports } from './imports.js';
export { emitProperties, emitState, emitControllers, emitContexts } from './properties.js';
export { emitLifecycle } from './lifecycle.js';
export { emitHandlers, emitPublicMethods } from './handlers.js';
export { emitRenderMethod } from './template.js';
