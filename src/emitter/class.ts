/**
 * Class structure emission.
 *
 * Produces the full Lit component class from a ComponentIR,
 * assembling imports, properties, lifecycle, handlers, and template.
 */
import type { ComponentIR } from '../ir/types.js';
import { collectImports } from './imports.js';
import { emitProperties, emitState, emitControllers, emitContexts, emitComputed, emitRefs } from './properties.js';
import { emitLifecycle } from './lifecycle.js';
import { emitHandlers, emitPublicMethods } from './handlers.js';
import { emitRenderMethod } from './template.js';
import { getBooleanAttributes } from '../standards.js';
import { pascalToKebab, toLitEventName, toCustomEventName } from '../naming.js';

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

  // --- Helpers (utility only — render helpers go inside the class) ---
  const utilityHelpers = ir.helpers.filter(h => !isRenderHelper(h.source));
  const renderHelpers = ir.helpers.filter(h => isRenderHelper(h.source));

  for (const helper of utilityHelpers) {
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

  // --- Refs ---
  const refsCode = emitRefs(ir.refs);
  if (refsCode.trim()) {
    sections.push(refsCode);
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

  // --- Render helpers (as private methods) ---
  for (const helper of renderHelpers) {
    const method = convertToPrivateMethod(helper.source);
    sections.push(method);
    sections.push('');
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
// Render helper detection and conversion
// ---------------------------------------------------------------------------

/**
 * Check if a helper function contains template rendering (html`` tagged templates).
 */
function isRenderHelper(source: string): boolean {
  return source.includes('html`') || source.includes('html `');
}

/**
 * Convert a standalone function to a private class method.
 *
 * Uses brace-counting to robustly find the function body, handling complex
 * TypeScript signatures with generics, destructuring, and default values.
 */
function convertToPrivateMethod(source: string): string {
  // Strip export/export default
  let s = source.replace(/^\s*export\s+default\s+/, '').replace(/^\s*export\s+/, '');

  // Extract function name
  let name: string | undefined;

  // Pattern: function NAME<...>(...) { ... }
  const funcNameMatch = s.match(/^function\s+([a-zA-Z_$][\w$]*)/);
  if (funcNameMatch) {
    name = funcNameMatch[1];
    const methodName = toPrivateMethodName(name);

    // Find the first '{' that starts the function body (brace-counted)
    const bodyStart = findFunctionBodyStart(s, funcNameMatch[0].length);
    if (bodyStart >= 0) {
      // Extract params: everything between the first '(' and its matching ')' after the name
      const paramsStart = s.indexOf('(', funcNameMatch[0].length);
      const paramsEnd = findMatchingParen(s, paramsStart);
      const params = paramsStart >= 0 && paramsEnd >= 0
        ? s.slice(paramsStart + 1, paramsEnd)
        : '';
      const body = s.slice(bodyStart);
      return `  private ${methodName}(${params}) ${body.replace(/\s*$/, '')}`;
    }
  }

  // Pattern: const NAME = ... (arrow function or other)
  const constNameMatch = s.match(/^(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/);
  if (constNameMatch) {
    name = constNameMatch[1];
    const methodName = toPrivateMethodName(name);

    // Find the assignment '=' (not ==, ===, =>, !=, <=, >=)
    // This separates the type annotation from the value
    const assignIdx = findAssignmentOperator(s, constNameMatch[0].length);

    if (assignIdx >= 0) {
      const valueStr = s.slice(assignIdx + 1).trimStart();

      // Check if the value is an arrow function
      const arrowIdx = findArrowOperator(valueStr);
      if (arrowIdx >= 0) {
        // Extract params: find the '(' before '=>', then its matching ')'
        const paramsEnd = findLastParenBefore(valueStr, arrowIdx);
        const paramsStart = paramsEnd >= 0 ? findMatchingParenReverse(valueStr, paramsEnd) : -1;
        let params: string;
        if (paramsStart >= 0 && paramsEnd >= 0) {
          params = valueStr.slice(paramsStart + 1, paramsEnd);
        } else {
          // Single param without parens: size => ...
          const singleParam = valueStr.slice(0, arrowIdx).trim();
          params = singleParam;
        }

        const afterArrow = valueStr.slice(arrowIdx + 2).trimStart();
        if (afterArrow.startsWith('{')) {
          // Arrow with block body: => { ... }
          const body = afterArrow.replace(/;?\s*$/, '');
          return `  private ${methodName}(${params}) ${body}`;
        } else {
          // Arrow with expression body: => expr
          const expr = afterArrow.replace(/;?\s*$/, '');
          return `  private ${methodName}(${params}) { return ${expr}; }`;
        }
      }

      // Non-function const with html`` (e.g. object literal)
      const value = valueStr.replace(/;?\s*$/, '');
      return `  private get ${methodName}() { return ${value}; }`;
    }
  }

  // Fallback: emit as-is with a comment (indented for class body)
  return `  // TODO: convert render helper to private method\n  ${s.replace(/\n/g, '\n  ')}`;
}

/**
 * Find the opening '{' of a function body, skipping generics and params.
 * Returns the index of '{' or -1.
 */
function findFunctionBodyStart(s: string, startIdx: number): number {
  let depth = 0; // tracks <>, (), []
  let parenDepth = 0;
  let angleDepth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';

    if (inString) {
      if (ch === stringChar && prev !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '<') angleDepth++;
    else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);

    if (ch === '{' && parenDepth === 0 && angleDepth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Find the matching closing ')' for a '(' at the given index.
 * Handles nested parens and strings.
 */
function findMatchingParen(s: string, openIdx: number): number {
  if (openIdx < 0 || s[openIdx] !== '(') return -1;
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';

    if (inString) {
      if (ch === stringChar && prev !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Find the assignment '=' operator in a const/let/var declaration,
 * skipping type annotations, strings, and nested structures.
 * Does NOT match ==, ===, =>, !=, <=, >=.
 */
function findAssignmentOperator(s: string, startIdx: number): number {
  let inString = false;
  let stringChar = '';
  let parenDepth = 0;
  let angleDepth = 0;

  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    const next = i < s.length - 1 ? s[i + 1] : '';

    if (inString) {
      if (ch === stringChar && prev !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '<') angleDepth++;
    else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);

    // Match '=' that is NOT part of ==, ===, =>, !=, <=, >=
    if (ch === '=' && parenDepth === 0 && angleDepth === 0) {
      if (next === '=' || next === '>') continue; // ==, ===, =>
      if (prev === '!' || prev === '<' || prev === '>') continue; // !=, <=, >=
      return i;
    }
  }
  return -1;
}

/**
 * Find the '=>' operator in a string, skipping strings and nested structures.
 */
function findArrowOperator(s: string): number {
  let inString = false;
  let stringChar = '';
  let parenDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < s.length - 1; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';

    if (inString) {
      if (ch === stringChar && prev !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;

    // Only match '=>' at the top level (not inside parens or braces)
    // but we DO want to match after the main params paren closes
    if (ch === '=' && s[i + 1] === '>' && parenDepth === 0 && braceDepth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Find the last ')' before the given index.
 */
function findLastParenBefore(s: string, beforeIdx: number): number {
  for (let i = beforeIdx - 1; i >= 0; i--) {
    if (s[i] === ')') return i;
  }
  return -1;
}

/**
 * Find the matching '(' for a ')' at the given index, scanning backwards.
 */
function findMatchingParenReverse(s: string, closeIdx: number): number {
  if (closeIdx < 0 || s[closeIdx] !== ')') return -1;
  let depth = 0;
  // Simple reverse scan — doesn't handle strings but good enough for param lists
  for (let i = closeIdx; i >= 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Convert a function name to a private method name.
 * - "renderFoo" → "_renderFoo"
 * - "Foo" → "_renderFoo"
 * - "fooBar" → "_fooBar"
 */
function toPrivateMethodName(name: string): string {
  // Already starts with underscore
  if (name.startsWith('_')) return name;
  // PascalCase (starts with uppercase) → _renderFoo
  if (/^[A-Z]/.test(name)) {
    return `_render${name}`;
  }
  // Already starts with "render"
  if (name.startsWith('render')) {
    return `_${name}`;
  }
  // camelCase → _camelCase
  return `_${name}`;
}

// ---------------------------------------------------------------------------
// Post-processing (text-level cleanup)
// ---------------------------------------------------------------------------

function postProcessOutput(output: string): string {
  let result = output;

  // --- className → class ---
  result = result.replace(/\bclassName=/g, 'class=');

  // --- Clean up classMap objects (comment-only entries from transform) ---
  result = result.replace(/\/\*[^*]*\*\/\s*,?\s*/g, (match, offset) => {
    const before = result.slice(Math.max(0, offset - 200), offset);
    if (before.includes('classMap(') || before.includes("': ")) return '';
    return match;
  });
  result = result.replace(/\{\s*,/g, '{');
  result = result.replace(/,\s*,/g, ',');
  result = result.replace(/,\s*\}/g, ' }');

  // --- Convert remaining JSX in output to Lit syntax ---
  result = convertRemainingJsx(result);

  // --- Rewrite remaining fire* event calls ---
  // Catch any fireNonCancelableEvent(onXxx, ...) that survived through raw JSX or helpers
  result = result.replace(
    /fireNonCancelableEvent\(\s*(on[A-Z]\w*)\b/g,
    (_, propName) => {
      const eventName = toCustomEventName(propName);
      return `fireNonCancelableEvent(this, '${eventName}'`;
    },
  );
  result = result.replace(
    /fireCancelableEvent\(\s*(on[A-Z]\w*)\b/g,
    (_, propName) => {
      const eventName = toCustomEventName(propName);
      return `fireNonCancelableEvent(this, '${eventName}'`;
    },
  );
  result = result.replace(
    /fireKeyboardEvent\(\s*(on[A-Z]\w*)\b/g,
    (_, propName) => {
      const eventName = toCustomEventName(propName);
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


  // Clean up empty lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
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
    const kebab = pascalToKebab(name);
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
    if (getBooleanAttributes().has(name)) {
      return `${ws}?${name}=\${${expr}}`;
    }
    // Event handlers: onXxx → @xxx
    if (/^on[A-Z]/.test(name)) {
      const eventName = toLitEventName(name);
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

  // =>${ (arrow body fused with template) → => {
  code = code.replace(/=>\$\{\n/g, '=> {\n');
  code = code.replace(/=>\$\{(\s)/g, '=> {$1');

  return importSection + code;
}
