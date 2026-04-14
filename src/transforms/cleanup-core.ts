/**
 * Core cleanup transform — generic React → Lit patterns.
 *
 * Contains universal patterns that apply to ANY React component library,
 * not just Cloudscape. Library-specific patterns live in plugin modules
 * (e.g., `presets/cloudscape/cleanup.ts`).
 *
 * Plugins implement the {@link CleanupPlugin} interface and are applied
 * by the orchestrator in `cleanup.ts`.
 */
import type { ComponentIR, TemplateNodeIR, AttributeIR } from '../ir/types.js';
import { createDefaultConfig, type CleanupConfig } from '../config.js';
import { walkTemplate } from '../template-walker.js';
import { stripFunctionCalls, stripIfBlocks, unwrapFunctionCall } from '../text-utils.js';

export interface CleanupPlugin {
  cleanBody?: (text: string) => string;
  cleanAttribute?: (attr: AttributeIR) => AttributeIR | null;
  cleanExpression?: (expr: string) => string;
}

// ---------------------------------------------------------------------------
// Main core transform
// ---------------------------------------------------------------------------

/**
 * Apply core (generic) cleanup patterns to a ComponentIR.
 *
 * These patterns are universal to React → Lit conversions:
 * - Rest/spread cleanup
 * - `__`-prefixed infrastructure variable removal
 * - `createPortal` unwrapping
 * - Dead-code simplification (`undefined ?? x` → `x`, etc.)
 * - Configurable prop/attribute/infra-function filtering
 *
 * Library-specific patterns are NOT applied here — use a
 * {@link CleanupPlugin} via the orchestrator for those.
 */
export function applyCoreCleanup(ir: ComponentIR, skipProps: Set<string>, cleanupConfig?: CleanupConfig): ComponentIR {
  const removeAttrs = cleanupConfig?.removeAttributes ?? createDefaultConfig().cleanup.removeAttributes;
  const removeAttrPrefixes = cleanupConfig?.removeAttributePrefixes ?? createDefaultConfig().cleanup.removeAttributePrefixes;
  const infraFunctions = cleanupConfig?.infraFunctions ?? createDefaultConfig().cleanup.infraFunctions;

  const props = ir.props.filter((p) => {
    if (p.name.startsWith('__')) return false;
    if (skipProps.has(p.name)) return false;
    return true;
  });

  // Clean handler bodies
  const handlers = ir.handlers.map((h) => ({
    ...h,
    body: cleanCoreBody(h.body, skipProps),
  }));

  // Clean effect bodies and deps
  const effects = ir.effects.map((e) => ({
    ...e,
    body: cleanCoreBody(e.body, skipProps),
    cleanup: e.cleanup ? cleanCoreBody(e.cleanup, skipProps) : undefined,
    // Remove __internalRootRef from effect dependency lists
    deps: Array.isArray(e.deps)
      ? e.deps.filter((d) => !d.includes('__internalRootRef'))
      : e.deps,
  }));

  // Clean helpers — remove infrastructure and clean source
  const helpers = ir.helpers
    .filter((h) => {
      return !infraFunctions.includes(h.name);
    })
    .map((h) => ({
      ...h,
      source: cleanTemplateInterpolations(cleanCoreBody(h.source, skipProps)),
    }));

  // Clean template — remove configured attributes
  const template = cleanCoreTemplate(ir.template, removeAttrs, removeAttrPrefixes, skipProps);

  // Clean body preamble — collect locally-declared skip-prop names across all
  // preamble items so that cleanSkipPropRefs won't replace references to
  // variables declared in a sibling preamble statement (e.g., file-input
  // declares `const nativeAttributes = {...}` in one statement and uses
  // `nativeAttributes['aria-invalid']` in another).
  const preambleDeclaredNames = new Set<string>();
  for (const stmt of ir.bodyPreamble) {
    for (const sp of skipProps) {
      if (new RegExp(`(?:const|let|var)\\s+${sp}\\b`).test(stmt)) {
        preambleDeclaredNames.add(sp);
      }
    }
  }
  const bodyPreamble = ir.bodyPreamble.map((b) => cleanCoreBody(b, skipProps, preambleDeclaredNames));

  // Clean public methods
  const publicMethods = ir.publicMethods.map((m) => ({
    ...m,
    body: cleanCoreBody(m.body, skipProps),
  }));

  // Clean computed value expressions
  const computedValues = ir.computedValues.map((c) => ({
    ...c,
    expression: cleanCoreBody(c.expression, skipProps),
  }));

  return {
    ...ir,
    props,
    handlers,
    effects,
    helpers,
    template,
    bodyPreamble,
    publicMethods,
    computedValues,
    fileTypeDeclarations: ir.fileTypeDeclarations.map((d) => cleanCoreBody(d, skipProps)),
    fileConstants: ir.fileConstants.map((c) => cleanCoreBody(c, skipProps)),
  };
}

// ---------------------------------------------------------------------------
// Apply plugin to an already-core-cleaned IR
// ---------------------------------------------------------------------------

/**
 * Apply a {@link CleanupPlugin} to a ComponentIR that has already been
 * through core cleanup. The plugin's methods are called on the same IR
 * fields that core cleanup processes.
 */
export function applyPlugin(ir: ComponentIR, plugin: CleanupPlugin): ComponentIR {
  const cleanBody = (text: string) => {
    let result = plugin.cleanBody ? plugin.cleanBody(text) : text;
    // Run post-plugin cleanup: remove empty if-blocks left after plugin
    // stripped function calls (e.g., warnOnce) from inside conditionals.
    for (let pass = 0; pass < 3; pass++) {
      const before = result;
      result = removeEmptyIfBlocks(result);
      if (result === before) break;
    }
    return result;
  };

  const handlers = ir.handlers.map((h) => ({
    ...h,
    body: cleanBody(h.body),
  }));

  const effects = ir.effects.map((e) => ({
    ...e,
    body: cleanBody(e.body),
    cleanup: e.cleanup ? cleanBody(e.cleanup) : undefined,
  }));

  const helpers = ir.helpers.map((h) => ({
    ...h,
    source: cleanBody(h.source),
  }));

  const bodyPreamble = ir.bodyPreamble.map((b) => cleanBody(b));

  const publicMethods = ir.publicMethods.map((m) => ({
    ...m,
    body: cleanBody(m.body),
  }));

  const computedValues = ir.computedValues.map((c) => ({
    ...c,
    expression: cleanBody(c.expression),
  }));

  const fileTypeDeclarations = ir.fileTypeDeclarations.map((d) => cleanBody(d));
  const fileConstants = ir.fileConstants.map((c) => cleanBody(c));

  // Apply plugin to template
  const template = plugin.cleanAttribute || plugin.cleanExpression
    ? applyPluginToTemplate(ir.template, plugin)
    : ir.template;

  return {
    ...ir,
    handlers,
    effects,
    helpers,
    template,
    bodyPreamble,
    publicMethods,
    computedValues,
    fileTypeDeclarations,
    fileConstants,
  };
}

function applyPluginToTemplate(node: TemplateNodeIR, plugin: CleanupPlugin): TemplateNodeIR {
  return walkTemplate(node, {
    attribute: plugin.cleanAttribute
      ? (attr) => plugin.cleanAttribute!(attr)
      : undefined,
    expression: plugin.cleanExpression
      ? (expr) => plugin.cleanExpression!(expr)
      : undefined,
    attributeExpression: plugin.cleanExpression
      ? (expr) => plugin.cleanExpression!(expr)
      : undefined,
    conditionExpression: plugin.cleanExpression
      ? (expr) => plugin.cleanExpression!(expr)
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Core body cleanup — generic React → Lit patterns
// ---------------------------------------------------------------------------

/**
 * Clean generic React infrastructure from a code body.
 *
 * This handles patterns common to ANY React component library:
 * - Rest/spread variable cleanup
 * - `__`-prefixed infrastructure variable removal
 * - `createPortal` unwrapping
 * - Configurable skip-prop reference cleanup
 * - Dead-code simplification
 */
export function cleanCoreBody(body: string, skipProps: Set<string>, declaredNames?: Set<string>): string {
  let result = body;

  // Unwrap: createPortal(content, target) → content
  // React portals have no Lit equivalent — just render the content directly.
  result = unwrapFunctionCall(result, 'createPortal');

  // Remove references to SKIP_PROPS (infrastructure props stripped from declarations).
  result = cleanSkipPropRefs(result, skipProps, declaredNames);

  // Remove __-prefixed infrastructure: if (__xxx) { ... } blocks (with nested braces)
  result = stripIfBlocks(result, /if\s*\(\s*!?__\w+\b[^)]*\)/);
  // Remove __-prefixed variable references in expressions
  result = cleanInternalPrefixedRefs(result);
  // Remove spread of __-prefixed vars
  result = result.replace(/,?\s*\.\.\.__\w+,?/g, (m) => m.startsWith(',') && m.endsWith(',') ? ',' : '');
  // Remove assignments to __-prefixed vars: __foo = expr; or __foo = __foo ?? expr;
  result = result.replace(/^\s*__\w+\s*=[^=][^;]*;?\s*$/gm, '');
  // Remove function calls whose only argument is a __-prefixed var:
  result = result.replace(/^\s*\w+\(__\w+\)\s*;?\s*$/gm, '');
  // Also remove fire*Event calls where the first argument is __-prefixed (multi-arg):
  result = result.replace(/^\s*fire\w+Event\(__\w+\b[^)]*\)\s*;?\s*$/gm, '');

  // Remove __-prefixed key-value pairs and shorthand properties from object literals.
  result = removeInternalPrefixedProperties(result);
  // Also remove properties whose VALUE is a bare __xxx reference
  result = result.replace(/,?\s*\w+\s*:\s*__\w+\s*(?=[,}])/g, '');

  // Remove __-prefixed parameters from destructuring and function params.
  result = result.replace(/,\s*__\w+(?:\??\s*:\s*[^,})]*)?\s*(?=[,})])/g, '');
  result = result.replace(/\(\s*__\w+(?:\??\s*:\s*[^,})]*)?\s*,\s*/g, '(');

  // Rest/spread cleanup runs AFTER __-prefixed cleanup because ternaries
  // like `__flag ? expr : rest` simplify to `rest` only after __-prefixed
  // refs are resolved. Running rest cleanup earlier would miss these.
  result = cleanRestSpreadRefs(result);

  // Simplify dead-code patterns left by rest/__ variable cleanup.
  result = result.replace(/\bundefined\?\.\w+/g, 'undefined');
  result = cleanSimplifyUndefined(result);

  // Clean up empty or near-empty object literals left after spread removal:
  // `const x: Type = { };` or `const x: Type = ;` → `const x: Type = {};`
  result = result.replace(/=\s*\{\s*,?\s*\}\s*;/g, '= {};');
  // `= ;` left when all entries including braces were removed
  result = result.replace(/=\s*;/g, '= {};');

  // Remove if-blocks with undefined/false conditions left after cleanup:
  // `if (undefined) { ... }` or `if (false) { ... }`
  result = stripIfBlocks(result, /if\s*\(\s*(?:undefined|false)\s*\)/);

  // Iteratively remove if-blocks with empty bodies (left after inner statements
  // were stripped). Uses balanced-brace matching for nested blocks.
  for (let pass = 0; pass < 3; pass++) {
    const before = result;
    result = removeEmptyIfBlocks(result);
    if (result === before) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core template cleanup
// ---------------------------------------------------------------------------

function cleanCoreTemplate(node: TemplateNodeIR, removeAttrs: string[], removeAttrPrefixes: string[], skipProps: Set<string>): TemplateNodeIR {
  return walkTemplate(node, {
    attribute: (attr) => {
      if (removeAttrs.includes(attr.name)) return null;
      if (attr.name.startsWith('.') && removeAttrs.includes(attr.name.slice(1))) return null;
      if (removeAttrPrefixes.some((p) => attr.name.startsWith(p))) return null;
      if (attr.name.startsWith('.__')) return null;

      // Remove ALL spread attributes — React spread has no Lit equivalent
      if (attr.kind === 'spread') return null;

      // Remove attributes that reference __-prefixed infrastructure variables
      if (typeof attr.value !== 'string') {
        const expr = attr.value.expression;
        if (expr.includes('__internalRootRef') || expr.includes('__internalRoot')) return null;
        if (/^\s*__\w+\s*$/.test(expr)) return null;
      }

      return attr;
    },
    expression: (expr) => cleanCoreExpressionText(expr, skipProps),
    attributeExpression: (expr) => cleanCoreExpressionText(expr, skipProps),
    conditionExpression: (expr) => cleanCoreExpressionText(expr, skipProps),
  });
}

/**
 * Clean core infrastructure references from expression text.
 * Does NOT include library-specific replacements (those go in plugins).
 */
function cleanCoreExpressionText(expr: string, skipProps: Set<string>): string {
  let result = expr;
  result = cleanRestSpreadRefs(result);
  result = cleanSkipPropRefs(result, skipProps);
  result = cleanInternalPrefixedRefsInExpr(result);
  result = cleanSimplifyUndefined(result);
  return result;
}

// ---------------------------------------------------------------------------
// Rest/spread cleanup (general React pattern)
// ---------------------------------------------------------------------------

/**
 * Clean rest/spread variable references.
 *
 * React components commonly destructure props with rest syntax:
 *   const { value, disabled, ...rest } = props;
 * Then use rest.xxx or {...rest} to forward remaining props.
 *
 * Lit components don't forward arbitrary attributes, so these references
 * become dead code.  Replace property accesses with undefined and remove
 * spread expressions.
 */
export function cleanRestSpreadRefs(text: string): string {
  let result = text;
  // {...rest} or {...restProps} or {...props} spread in JSX/objects
  result = result.replace(/\{\s*\.\.\.(?:rest\w*|props)\s*\}\s*\n?\s*/g, '');
  // ...rest or ...restProps or ...props in argument/object positions
  result = result.replace(/,?\s*\.\.\.(?:rest\w*|props)(?:\.\w+)*\s*,?/g,
    (m) => m.startsWith(',') && m.endsWith(',') ? ',' : '');
  // rest.xxx or restProps.xxx or props.xxx property access → undefined
  result = result.replace(/\b(?:rest|restProps|props)\.\w+(?:\?\.\w+)*/g, 'undefined');
  // const { a, b } = rest; → remove (destructuring from rest is meaningless)
  result = result.replace(/const\s*\{[^}]*\}\s*=\s*(?:rest|props)\s*;?\s*/g, '');
  return result;
}

// ---------------------------------------------------------------------------
// SKIP_PROPS reference cleanup
// ---------------------------------------------------------------------------

/**
 * Clean references to SKIP_PROPS names in code bodies.
 *
 * Props in SKIP_PROPS (nativeAttributes, nativeButtonAttributes, etc.) are
 * stripped from the component's property declarations, but code bodies may
 * still reference them as variables. This function replaces those references
 * with `undefined` so downstream dead-code simplification can clean them up.
 *
 * Carefully avoids stripping local variable declarations of the same name
 * (e.g., `const nativeAttributes = { ... }` in file-input).
 */
export function cleanSkipPropRefs(text: string, skipProps: Set<string>, declaredNames?: Set<string>): string {
  let result = text;
  for (const skipProp of skipProps) {
    // Skip if there's a local declaration of this name (in this text or sibling texts)
    const declPattern = new RegExp(`(?:const|let|var)\\s+${skipProp}\\b`);
    if (declPattern.test(result)) continue;
    if (declaredNames?.has(skipProp)) continue;

    // Property access: skipProp?.tabIndex or skipProp.xxx → undefined
    const propAccessRe = new RegExp(`\\b${skipProp}(?:\\?\\.|\\.)[\\w.?]+`, 'g');
    result = result.replace(propAccessRe, 'undefined');

    // Bare reference as function argument or standalone:
    const bareRefRe = new RegExp(
      `(?<!(?:const|let|var)\\s)\\b${skipProp}\\b(?!\\s*[=:])`,
      'g',
    );
    result = result.replace(bareRefRe, 'undefined');
  }
  // Remove assignment statements where `undefined` ended up on the LHS:
  // undefined.xxx = expr; or undefined['xxx'] = expr; or undefined = expr;
  result = result.replace(/^\s*undefined(?:\.\w+|\[['"][^'"]*['"]\])?\s*=[^=][^;]*;?\s*$/gm, '');
  return result;
}

// ---------------------------------------------------------------------------
// __-prefixed internal variable cleanup
// ---------------------------------------------------------------------------

/**
 * Clean __-prefixed internal infrastructure variable references.
 *
 * React component libraries use __-prefixed props to pass internal
 * configuration between components (e.g., __disableActionsWrapping,
 * __fullPage). These props are stripped from the Lit component's
 * property declarations, but their usage in expressions must also
 * be cleaned.
 *
 * Applied to code bodies.
 */
export function cleanInternalPrefixedRefs(text: string): string {
  let result = text;
  result = result.replace(/\b__\w+\s*&&\s*[^;,\n]+[;,]?\s*/g, '');
  result = result.replace(/&&\s*__\w+\b/g, '&& false');
  result = result.replace(/\|\|\s*__\w+\b/g, '');
  result = result.replace(/\b__\w+\s*\?\?\s*/g, '');
  result = result.replace(/\b__\w+\s*\|\|\s*/g, '');
  // __xxx ? trueBranch : falseBranch → falseBranch
  // Uses depth-aware matching to find the ternary colon at depth 0,
  // skipping colons inside nested object literals ({ key: value }).
  result = replaceInternalPrefixedTernaries(result);
  result = result.replace(/!__\w+\s*\?\s*/g, '');
  result = result.replace(/(\([^)]+!==\s*undefined\))\s*\?\?\s*false/g, '$1');
  return result;
}

/**
 * Replace `__xxx ? trueBranch : falseBranch` with just `falseBranch`.
 * Uses depth counting to find the ternary `:` at brace/paren depth 0,
 * handling nested `{ key: value }` objects in the true-branch.
 */
function replaceInternalPrefixedTernaries(text: string): string {
  const pattern = /\b__\w+\s*\?\s*/g;
  let result = text;
  let match;
  while ((match = pattern.exec(result)) !== null) {
    const start = match.index;
    const afterQuestion = start + match[0].length;
    // Walk forward from the true-branch, tracking brace/paren depth
    let depth = 0;
    let colonPos = -1;
    for (let i = afterQuestion; i < result.length; i++) {
      const ch = result[i];
      if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
      if (ch === '}' || ch === ')' || ch === ']') { depth--; continue; }
      if (ch === ':' && depth === 0) { colonPos = i; break; }
      // Stop at statement terminators at depth 0 (but NOT newlines — ternaries span lines)
      if (ch === ';' && depth === 0) break;
    }
    if (colonPos === -1) continue;
    // Skip whitespace after the colon (including newlines and indentation)
    let falseStart = colonPos + 1;
    while (falseStart < result.length && /\s/.test(result[falseStart])) falseStart++;
    // Replace the entire `__xxx ? trueBranch : ` with nothing, keeping falseBranch
    result = result.slice(0, start) + result.slice(falseStart);
    pattern.lastIndex = start; // reset to re-scan from the replacement point
  }
  return result;
}

/**
 * Expression-safe version of __-prefixed cleanup for template expressions.
 *
 * Template expressions appear inside classMap objects, attribute bindings,
 * and interpolations where commas and braces are structural delimiters.
 * Uses more conservative patterns than the code-body version to avoid
 * consuming object literal syntax.
 */
export function cleanInternalPrefixedRefsInExpr(text: string): string {
  let result = text;
  result = result.replace(/!__\w+\s*&&\s*/g, '');
  result = result.replace(/\b__\w+\s*&&\s*[^;,}\n)]+/g, 'false');
  result = result.replace(/!__\w+\s*\?\s*/g, '');
  result = result.replace(/\b__\w+\s*\?\s*[^:]+:\s*/g, '');
  result = result.replace(/\b__\w+\b/g, 'false');
  return result;
}

/**
 * Clean __-prefixed references inside template literal interpolations (${...})
 * found within html`` tagged templates in render helper source text.
 */
export function cleanTemplateInterpolations(source: string): string {
  if (!/\b__\w+/.test(source)) return source;

  let result = '';
  let i = 0;
  while (i < source.length) {
    const dollarBrace = source.indexOf('${', i);
    if (dollarBrace === -1) {
      result += source.slice(i);
      break;
    }
    result += source.slice(i, dollarBrace + 2);
    let depth = 1;
    let j = dollarBrace + 2;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') depth--;
      if (depth > 0) j++;
    }
    const content = source.slice(dollarBrace + 2, j);
    if (/\b__\w+/.test(content)) {
      result += cleanInternalPrefixedRefsInExpr(content);
    } else {
      result += content;
    }
    result += '}';
    i = j + 1;
  }
  return result;
}

/**
 * Simplify expressions involving `undefined` that result from stripping
 * infrastructure variables. Applied in both code bodies and template
 * expressions to reduce always-true/always-false patterns.
 */
export function cleanSimplifyUndefined(text: string): string {
  let result = text;
  result = result.replace(/\bundefined\s*\?\?\s*/g, '');
  result = result.replace(/(\([^)]*!==\s*undefined[^)]*\))\s*\?\?\s*false/g, '$1');
  result = result.replace(/\bundefined\s*\|\|\s*/g, '');
  result = result.replace(/!undefined\b/g, 'true');
  result = result.replace(/!null\b/g, 'true');
  result = result.replace(/\bundefined\s*&&\s*[^;,\n)]+/g, 'undefined');
  result = result.replace(/\(\s*undefined\s*\|\|\s*\{\s*\}\s*\)/g, '{}');
  return result;
}

/**
 * Remove if-blocks whose body is empty (whitespace-only after balanced brace matching).
 * Handles multiline blocks and nested parentheses in conditions.
 */
function removeEmptyIfBlocks(text: string): string {
  // Find `if` keyword followed by `(`
  const ifKeyword = /\bif\s*\(/g;
  let result = text;
  let match;
  while ((match = ifKeyword.exec(result)) !== null) {
    // Find balanced closing paren for the condition
    const condOpen = match.index + match[0].length - 1; // position of `(`
    let depth = 1;
    let i = condOpen + 1;
    while (i < result.length && depth > 0) {
      if (result[i] === '(') depth++;
      else if (result[i] === ')') depth--;
      i++;
    }
    if (depth !== 0) continue;
    // Skip whitespace to find opening brace
    let j = i;
    while (j < result.length && /\s/.test(result[j])) j++;
    if (result[j] !== '{') continue;
    const openBrace = j;
    // Find balanced closing brace
    depth = 1;
    let k = openBrace + 1;
    while (k < result.length && depth > 0) {
      if (result[k] === '{') depth++;
      else if (result[k] === '}') depth--;
      k++;
    }
    if (depth !== 0) continue;
    const closeBrace = k - 1;
    const body = result.slice(openBrace + 1, closeBrace);
    if (body.trim() === '') {
      // Remove the entire if-block including leading whitespace on its line
      let lineStart = match.index;
      while (lineStart > 0 && result[lineStart - 1] !== '\n') lineStart--;
      let lineEnd = closeBrace + 1;
      while (lineEnd < result.length && (result[lineEnd] === '\n' || result[lineEnd] === '\r')) lineEnd++;
      result = result.slice(0, lineStart) + result.slice(lineEnd);
      ifKeyword.lastIndex = lineStart;
    }
  }
  return result;
}

/**
 * Remove __-prefixed key-value pairs from object literals in code text.
 * Handles nested function calls in values via balanced paren matching.
 */
export function removeInternalPrefixedProperties(text: string): string {
  const pattern = /,?\s*__\w+\??\s*:/g;
  let result = text;
  let match;

  while ((match = pattern.exec(result)) !== null) {
    const keyStart = match.index;
    const valueStart = keyStart + match[0].length;

    let depth = 0;
    let i = valueStart;
    while (i < result.length) {
      const ch = result[i];
      if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--;
        i++;
        continue;
      }
      if (ch === ',' && depth === 0) { i++; break; }
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        i++;
        while (i < result.length && result[i] !== quote) {
          if (result[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      i++;
    }

    result = result.slice(0, keyStart) + result.slice(i);
    pattern.lastIndex = keyStart;
  }

  return result;
}
