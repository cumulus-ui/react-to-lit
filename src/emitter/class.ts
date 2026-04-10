/**
 * Class structure emission.
 *
 * Produces the full Lit component class from a ComponentIR,
 * assembling imports, properties, lifecycle, handlers, and template.
 */
import type { ComponentIR } from '../ir/types.js';
import { collectImports } from './imports.js';
import { emitProperties, emitState, emitControllers, emitContexts } from './properties.js';
import { emitLifecycle } from './lifecycle.js';
import { emitHandlers, emitPublicMethods } from './handlers.js';
import { emitRenderMethod } from './template.js';

// ---------------------------------------------------------------------------
// Main emission
// ---------------------------------------------------------------------------

export interface EmitOptions {
  /** Whether to format the output with Prettier */
  format?: boolean;
}

/**
 * Emit a full Lit component TypeScript file from a ComponentIR.
 */
export function emitComponent(ir: ComponentIR, _options: EmitOptions = {}): string {
  const collector = collectImports(ir);
  const sections: string[] = [];

  // --- Imports ---
  // (collected during emission, emitted at the end)

  // --- Host styles ---
  sections.push(`const hostStyles = css\`:host { display: block; }\`;`);
  sections.push('');

  // --- Helpers ---
  for (const helper of ir.helpers) {
    // Helpers containing JSX need manual conversion to html`` templates
    if (helper.source.includes('/>') || helper.source.includes('</')) {
      sections.push(`// WARNING: helper '${helper.name}' contains JSX — needs manual conversion to html\`\``);
    }
    sections.push(helper.source);
    sections.push('');
  }

  // --- Mixin application ---
  let baseClassName: string;
  if (ir.mixins.includes('FormControlMixin')) {
    sections.push(`const Base = FormControlMixin(CsBaseElement);`);
    sections.push('');
    baseClassName = 'Base';
  } else {
    baseClassName = ir.baseClass?.name ?? 'CsBaseElement';
  }

  // --- Class declaration ---
  const className = `Cs${ir.name}Internal`;
  sections.push(`export class ${className} extends ${baseClassName} {`);
  sections.push(`  static override styles = [sharedStyles, componentStyles, hostStyles];`);
  sections.push('');

  // --- Context consumers/providers ---
  const contextCode = emitContexts(ir.contexts);
  if (contextCode.trim()) {
    sections.push(contextCode);
  }

  // --- Properties ---
  const propsCode = emitProperties(ir.props);
  if (propsCode.trim()) {
    sections.push(propsCode);
  }

  // --- State ---
  const stateCode = emitState(ir.state);
  if (stateCode.trim()) {
    sections.push(stateCode);
  }

  // --- Controllers ---
  const controllerCode = emitControllers(ir.controllers);
  if (controllerCode.trim()) {
    sections.push(controllerCode);
  }

  // --- Lifecycle ---
  const lifecycleCode = emitLifecycle(ir.effects);
  if (lifecycleCode.trim()) {
    sections.push(lifecycleCode);
  }

  // --- Public methods ---
  const publicMethodCode = emitPublicMethods(ir.publicMethods);
  if (publicMethodCode.trim()) {
    sections.push(publicMethodCode);
  }

  // --- Handlers ---
  const handlerCode = emitHandlers(ir.handlers);
  if (handlerCode.trim()) {
    sections.push(handlerCode);
  }

  // --- Render method ---
  const renderCode = emitRenderMethod(ir.template, collector);
  sections.push(renderCode);

  // --- Close class ---
  sections.push('}');

  // --- Assemble final output ---
  const importsStr = collector.emit();
  const bodyStr = sections.join('\n');

  return `${importsStr}\n\n${bodyStr}\n`;
}
