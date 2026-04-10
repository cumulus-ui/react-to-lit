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

  const raw = `${importsStr}\n\n${bodyStr}\n`;

  // Final text-based cleanup for any remaining React patterns
  return postProcessOutput(raw);
}

// ---------------------------------------------------------------------------
// Post-processing (text-level cleanup)
// ---------------------------------------------------------------------------

function postProcessOutput(output: string): string {
  let result = output;

  // className → class (in template attributes)
  result = result.replace(/\bclassName=/g, 'class=');

  // className={...} → class=${classMap(...)} in inline JSX within templates
  result = result.replace(/class=\{clsx\(([^)]*)\)\}/g, (_, args) => {
    return `class=\${classMap(${convertClsxArgs(args)})}`;
  });

  // Strip remaining __internalRootRef references
  result = result.replace(/\.__internalRootRef=\$\{[^}]+\}\s*/g, '');
  result = result.replace(/\bref=\{__internalRootRef\}\s*/g, '');

  // Strip nativeAttributes / nativeInputAttributes in templates
  result = result.replace(/\bnativeAttributes=\{[^}]*\}\s*/g, '');
  result = result.replace(/\bnativeInputAttributes=\{[^}]*\}\s*/g, '');

  // Clean up empty lines (more than 2 consecutive)
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

/**
 * Simple clsx args → classMap object conversion for text-level cleanup.
 */
function convertClsxArgs(args: string): string {
  // If it's already an object literal, return as-is
  if (args.trim().startsWith('{')) return args;

  const parts = args.split(',').map(p => p.trim()).filter(Boolean);
  const entries: string[] = [];

  for (const part of parts) {
    // styles.foo → 'foo': true
    const dotMatch = part.match(/^styles\.(\w+)$/);
    if (dotMatch) {
      entries.push(`'${dotMatch[1]}': true`);
      continue;
    }
    // styles['foo'] → 'foo': true
    const bracketMatch = part.match(/^styles\['([^']+)'\]$/);
    if (bracketMatch) {
      entries.push(`'${bracketMatch[1]}': true`);
      continue;
    }
    // condition && styles.foo → 'foo': condition
    const condMatch = part.match(/^(.+?)\s*&&\s*styles[.[]'?(\w+)'?\]?$/);
    if (condMatch) {
      entries.push(`'${condMatch[2]}': ${condMatch[1]}`);
      continue;
    }
    // Pass through anything else
    entries.push(`/* ${part} */`);
  }

  return `{ ${entries.join(', ')} }`;
}
