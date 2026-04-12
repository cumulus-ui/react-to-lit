/**
 * Public API entry point for @cumulus-ui/react-to-lit.
 *
 * Re-exports the main pipeline functions and types needed by
 * consumers who import the package as a library.
 */

// Parser
export { parseComponent } from './parser/index.js';
export type { ParseOptions } from './parser/index.js';

// Transforms
export { transformAll } from './transforms/index.js';
export type { TransformOptions } from './transforms/index.js';

// Emitter
export { emitComponent } from './emitter/index.js';
export type { EmitOptions } from './emitter/index.js';

// IR types — consumers need these to inspect/modify the intermediate representation
export type {
  ComponentIR,
  PropIR,
  StateIR,
  EffectIR,
  RefIR,
  HandlerIR,
  TemplateNodeIR,
  AttributeIR,
  DynamicValueIR,
  ConditionIR,
  LoopIR,
  ComputedIR,
  ControllerIR,
  ContextIR,
  PublicMethodIR,
  HelperIR,
  ImportIR,
  BaseClassIR,
} from './ir/types.js';

// Hook registry — for custom hook mappings
export { createHookRegistry } from './hooks/registry.js';
export type { HookRegistry, HookMapping, HookAction } from './hooks/registry.js';

// IR transform helpers — for writing custom transforms
export { mapIRText } from './ir/transform-helpers.js';
export type { MapTextOptions } from './ir/transform-helpers.js';

// Template walker — for writing custom template transforms
export { walkTemplate, someInTemplate, templateHasExpression } from './template-walker.js';
export type { TemplateVisitor } from './template-walker.js';

// Naming utilities — for consistent name derivation
export { camelToKebab, pascalToKebab, kebabToPascal, toTagName, isEventProp } from './naming.js';
