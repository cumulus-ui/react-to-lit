/**
 * Class structure emission.
 *
 * Produces the full Lit component class from a ComponentIR,
 * assembling imports, properties, lifecycle, handlers, and template.
 */
import type { ComponentIR } from '../ir/types.js';
import { collectImports } from './imports.js';
import { emitProperties, emitState, emitControllers, emitContexts, emitComputed } from './properties.js';
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

  // --- Computed values (useMemo → getters) ---
  const computedCode = emitComputed(ir.computedValues);
  if (computedCode.trim()) {
    sections.push(computedCode);
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

  // Body preamble is NOT emitted — it's intermediate React code (attribute builders,
  // className computations) that has been processed by transforms. The useful parts
  // (hooks, handlers) are already in the IR. Emitting it would produce broken React syntax.

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

  // --- React type annotations → native DOM types ---
  result = result.replace(/React\.MouseEvent(<[^>]*>)?/g, 'MouseEvent');
  result = result.replace(/React\.KeyboardEvent(<[^>]*>)?/g, 'KeyboardEvent');
  result = result.replace(/React\.FocusEvent(<[^>]*>)?/g, 'FocusEvent');
  result = result.replace(/React\.ChangeEvent(<[^>]*>)?/g, 'Event');
  result = result.replace(/React\.FormEvent(<[^>]*>)?/g, 'Event');
  result = result.replace(/React\.SyntheticEvent(<[^>]*>)?/g, 'Event');
  result = result.replace(/React\.DragEvent(<[^>]*>)?/g, 'DragEvent');
  result = result.replace(/React\.ClipboardEvent(<[^>]*>)?/g, 'ClipboardEvent');
  result = result.replace(/React\.PointerEvent(<[^>]*>)?/g, 'PointerEvent');
  result = result.replace(/React\.TouchEvent(<[^>]*>)?/g, 'TouchEvent');
  result = result.replace(/React\.WheelEvent(<[^>]*>)?/g, 'WheelEvent');
  result = result.replace(/React\.AnimationEvent(<[^>]*>)?/g, 'AnimationEvent');
  result = result.replace(/React\.TransitionEvent(<[^>]*>)?/g, 'TransitionEvent');
  result = result.replace(/React\.CompositionEvent(<[^>]*>)?/g, 'CompositionEvent');
  result = result.replace(/React\.UIEvent(<[^>]*>)?/g, 'UIEvent');
  // React types
  result = result.replace(/React\.Ref<[^>]*>/g, 'any');
  result = result.replace(/React\.RefObject<[^>]*>/g, 'any');
  result = result.replace(/React\.MutableRefObject<[^>]*>/g, 'any');
  result = result.replace(/React\.CSSProperties/g, 'Record<string, string>');
  result = result.replace(/React\.ReactNode/g, 'unknown');
  result = result.replace(/React\.ReactElement(<[^>]*>)?/g, 'unknown');
  result = result.replace(/React\.\w+HTMLAttributes<[^>]*>/g, 'Record<string, unknown>');
  // Catch remaining React.Xxx patterns
  result = result.replace(/React\.(\w+)Event/g, '$1Event');
  // React.useRef → useRef (in helper bodies)
  result = result.replace(/React\.useRef/g, 'useRef');
  result = result.replace(/React\.useEffect/g, 'useEffect');
  result = result.replace(/React\.useState/g, 'useState');
  result = result.replace(/React\.useCallback/g, 'useCallback');
  result = result.replace(/React\.useMemo/g, 'useMemo');
  result = result.replace(/React\.useImperativeHandle/g, 'useImperativeHandle');
  result = result.replace(/React\.Fragment/g, '');
  result = result.replace(/React\.forwardRef\(/g, '(');
  result = result.replace(/React\.createElement/g, 'document.createElement');

  // --- className → class ---
  result = result.replace(/\bclassName=/g, 'class=');

  // className={clsx(...)} → class=${classMap(...)}
  result = result.replace(/class=\{clsx\(([^)]*)\)\}/g, (_, args) => {
    return `class=\${classMap(${convertClsxArgs(args)})}`;
  });

  // --- Clean up classMap objects ---
  // Remove comment-only entries: { /* comment */, 'foo': true } → { 'foo': true }
  result = result.replace(/\/\*[^*]*\*\/\s*,?\s*/g, (match, offset) => {
    const before = result.slice(Math.max(0, offset - 50), offset);
    if (before.includes('classMap(') || before.includes("': ")) return '';
    return match;
  });
  // Remove leading/trailing commas in objects: { , 'foo': true } → { 'foo': true }
  result = result.replace(/\{\s*,/g, '{');
  result = result.replace(/,\s*\}/g, ' }');

  // --- Convert remaining JSX in output to Lit syntax ---
  result = convertRemainingJsx(result);

  // --- Rewrite remaining fire* event calls ---
  // Catch any fireNonCancelableEvent(onXxx, ...) that survived through raw JSX or helpers
  result = result.replace(
    /fireNonCancelableEvent\(\s*(on[A-Z]\w*)\b/g,
    (_, propName) => {
      const eventName = propName.slice(2, 3).toLowerCase() + propName.slice(3);
      return `fireNonCancelableEvent(this, '${eventName}'`;
    },
  );
  result = result.replace(
    /fireCancelableEvent\(\s*(on[A-Z]\w*)\b/g,
    (_, propName) => {
      const eventName = propName.slice(2, 3).toLowerCase() + propName.slice(3);
      return `fireNonCancelableEvent(this, '${eventName}'`;
    },
  );
  result = result.replace(
    /fireKeyboardEvent\(\s*(on[A-Z]\w*)\b/g,
    (_, propName) => {
      const eventName = propName.slice(2, 3).toLowerCase() + propName.slice(3);
      return `fireNonCancelableEvent(this, '${eventName}'`;
    },
  );

  // --- Strip remaining Cloudscape internals ---
  result = result.replace(/\.__internalRootRef=\$\{[^}]+\}\s*/g, '');
  result = result.replace(/\bref=\{__internalRootRef\}\s*/g, '');
  result = result.replace(/\bref=\{null\}\s*/g, '');
  result = result.replace(/\bnativeAttributes=\{[^}]*\}\s*/g, '');
  result = result.replace(/\bnativeInputAttributes=\{[^}]*\}\s*/g, '');

  // Note: PascalCase→kebab conversion for component tags is handled by the
  // component registry in the template IR. We do NOT convert in post-processing
  // because it would break raw JSX in helper function bodies.

  // --- Convert styles.xxx to plain class names (only in code, not imports) ---
  // Split into import section and code section to avoid mangling import paths
  const importEnd = result.lastIndexOf("import ");
  const importEndLine = result.indexOf('\n', result.indexOf(';', importEnd));
  if (importEndLine > 0) {
    const importSection = result.slice(0, importEndLine + 1);
    let codeSection = result.slice(importEndLine + 1);
    codeSection = codeSection.replace(/\bstyles\.(\w+)\b/g, "'$1'");
    codeSection = codeSection.replace(/\bstyles\['([^']+)'\]/g, "'$1'");
    codeSection = codeSection.replace(/\bstyles\["([^"]+)"\]/g, "'$1'");
    // Preserve template literals: styles[`foo-${bar}`] → `foo-${bar}`
    codeSection = codeSection.replace(/\bstyles\[(`[^`]+`)\]/g, '$1');
    // Fix any single-quoted strings that contain ${} → backtick template literals
    codeSection = codeSection.replace(/'([^']*\$\{[^']*)'(?=\s*[:\]}),])/g, '`$1`');
    result = importSection + codeSection;
  }

  // Clean up empty lines
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

/**
 * Convert remaining raw JSX patterns to Lit syntax in the code section.
 */
function convertRemainingJsx(output: string): string {
  // Split into import section and code section
  const importEnd = output.lastIndexOf("import ");
  const importEndLine = output.indexOf('\n', output.indexOf(';', importEnd));
  if (importEndLine <= 0) return output;

  const importSection = output.slice(0, importEndLine + 1);
  let code = output.slice(importEndLine + 1);

  // Convert PascalCase JSX component tags to kebab-case custom elements
  // <RadioButton → <cs-radio-button, </RadioButton → </cs-radio-button
  // Match when < is preceded by whitespace, newline, (, `, >, $ (template expressions)
  code = code.replace(/(?<=[\s\n(`>$])(<\/?)(([A-Z][a-z]+){2,})\b/g, (match, prefix, name) => {
    if (/^(Object|Array|String|Number|Boolean|Map|Set|Error|Promise|Date|RegExp|Symbol|Function|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Parameters|InstanceType)$/.test(name)) return match;
    const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    return `${prefix}cs-${kebab}`;
  });
  // Also handle single-word PascalCase components that are known Cloudscape internals
  code = code.replace(/(?<=[\s\n(`>$])(<\/?)(Dropdown|Grid|Tile|Option|Tag|Transition|Portal)\b/g, (_, prefix, name) => {
    return `${prefix}cs-${name.toLowerCase()}`;
  });

  // Remove key={...} attributes
  code = code.replace(/\s+key=\{[^}]*\}/g, '');

  // Remove ref={...} attributes (already handled by cleanup but catch stragglers)
  code = code.replace(/\s+ref=\{[^}]*\}/g, '');

  // Remove {...spread} JSX attributes (including multiline)
  code = code.replace(/\n\s*\{\.\.\.[\s\S]*?\}\s*(?=\n\s*[<>/])/g, '\n');

  // Convert JSX expression attributes: prop={expr} → .prop=${expr}
  // Only match inside what looks like an element tag (after < and before > or />)
  code = code.replace(/(\s)([\w-]+)=\{([^}]*)\}/g, (match, ws, name, expr) => {
    // Skip already-converted Lit bindings
    if (name.startsWith('@') || name.startsWith('?') || name.startsWith('.')) return match;
    // Skip class= (already converted by classMap)
    if (name === 'class') return match;
    // Boolean attributes
    if (/^(disabled|checked|readOnly|readonly|required|hidden|indeterminate|open|multiple|selected)$/.test(name)) {
      return `${ws}?${name}=\${${expr}}`;
    }
    // Event handlers: onXxx → @xxx
    if (/^on[A-Z]/.test(name)) {
      const eventName = name.slice(2).toLowerCase();
      return `${ws}@${eventName}=\${${expr}}`;
    }
    // Property binding
    return `${ws}.${name}=\${${expr}}`;
  });

  // Convert JSX children expressions: >{expr}< → >${expr}<
  code = code.replace(/>\s*\{([^}]+)\}\s*</g, '>${$1}<');

  // Wrap JSX inside ${ } expressions with html``
  // Pattern: ${expr && (\n  <cs-xxx → ${expr ? html`\n  <cs-xxx : nothing
  code = code.replace(
    /\$\{([^}]+)\s*&&\s*\(\s*\n(\s*<cs-)/g,
    '${$1 ? html`\n$2',
  );
  // Close these with ` : nothing}
  code = code.replace(
    /(<\/cs-[\w-]+>|\/?>)\s*\n(\s*)\)\}/g,
    '$1\n$2` : nothing}',
  );

  // Wrap ternary JSX: ? <cs-xxx → ? html`<cs-xxx
  code = code.replace(/\?\s*<(cs-[\w-]+)/g, '? html`<$1');
  // And the else branch: : <cs-xxx → : html`<cs-xxx
  code = code.replace(/:\s*<(cs-[\w-]+)/g, ': html`<$1');

  // Wrap .map() callback bodies containing Lit elements in html``
  code = code.replace(
    /\.map\((\([^)]*\))\s*=>\s*\(\s*\n(\s*<)/g,
    '.map($1 => html`\n$2',
  );
  // Close html`` at the end of .map() callbacks
  code = code.replace(
    /(<\/cs-[\w-]+>)\s*\n(\s*)\)\)/g,
    '$1\n$2`)',
  );

  // Wrap return (<cs-xxx...) patterns in handlers with html``
  code = code.replace(
    /return\s*\(\s*\n(\s*<cs-)/g,
    'return html`\n$1',
  );
  // Also handle return (<div... patterns
  code = code.replace(
    /return\s*\(\s*\n(\s*<[a-z])/g,
    'return html`\n$1',
  );
  // Close the html`` at the matching closing paren for return(...) patterns
  // Handles: </cs-xxx>\n    ); → </cs-xxx>\n    `;
  //          />\n    ); → />\n    `;
  code = code.replace(
    /((?:<\/(?:cs-[\w-]+|div|span|button|a|input|label|ul|li|nav|section|form|textarea|select|table|tr|td|th)>|\/?>))\s*\n(\s*)\);/g,
    '$1\n$2`;',
  );

  return importSection + code;
}
