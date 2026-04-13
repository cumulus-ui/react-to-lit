/**
 * Cloudscape internals cleanup transform.
 *
 * Removes Cloudscape-specific infrastructure from the IR:
 * - Props starting with __ (internal props)
 * - getBaseProps/baseProps references
 * - useBaseComponent results
 * - applyDisplayName calls
 * - Analytics metadata
 * - checkSafeUrl calls
 */
import type { ComponentIR, TemplateNodeIR, AttributeIR } from '../ir/types.js';
import { SKIP_PROPS, REMOVE_ATTRS, REMOVE_ATTR_PREFIXES, INFRA_FUNCTIONS } from '../cloudscape-config.js';
import { walkTemplate } from '../template-walker.js';
import { stripFunctionCalls, replaceFunctionCalls, stripIfBlocks, unwrapFunctionCall } from '../text-utils.js';

/** Matches testUtilStyles/testutilStyles/testStyles bracket or dot access. */
const TEST_UTIL_STYLES_RE = /\btestUtilStyles(?:\[['"\w-]+\]|\.\w+)|\btestutilStyles(?:\[['"\w-]+\]|\.\w+)|\btestStyles(?:\[['"\w-]+\]|\.\w+)/g;

/** Matches analyticsSelectors bracket or dot access. */
const ANALYTICS_SELECTORS_RE = /\banalyticsSelectors(?:\[['"\w-]+\]|\.\w+)/g;

/** Matches `baseProps.className` with optional trailing comma/whitespace. */
const BASE_PROPS_CLASSNAME_RE = /\bbaseProps\.className\b,?\s*/g;

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function removeCloudscapeInternals(ir: ComponentIR): ComponentIR {
  // Remove internal props
  const props = ir.props.filter((p) => {
    if (p.name.startsWith('__')) return false;
    if (SKIP_PROPS.has(p.name)) return false;
    return true;
  });

  // Clean handler bodies
  const handlers = ir.handlers.map((h) => ({
    ...h,
    body: cleanHandlerBody(h.body),
  }));

  // Clean effect bodies and deps
  const effects = ir.effects.map((e) => ({
    ...e,
    body: cleanHandlerBody(e.body),
    cleanup: e.cleanup ? cleanHandlerBody(e.cleanup) : undefined,
    // Remove __internalRootRef from effect dependency lists
    deps: Array.isArray(e.deps)
      ? e.deps.filter((d) => !d.includes('__internalRootRef'))
      : e.deps,
  }));

  // Clean helpers — remove infrastructure and clean source
  const helpers = ir.helpers
    .filter((h) => {
      return !INFRA_FUNCTIONS.has(h.name);
    })
    .map((h) => ({
      ...h,
      source: cleanTemplateInterpolations(cleanHandlerBody(h.source)),
    }));

  // Clean template — remove Cloudscape-specific attributes
  const template = cleanTemplate(ir.template);

  // Clean body preamble
  const bodyPreamble = ir.bodyPreamble.map(cleanHandlerBody);

  // Clean public methods
  const publicMethods = ir.publicMethods.map((m) => ({
    ...m,
    body: cleanHandlerBody(m.body),
  }));

  // Clean computed value expressions
  const computedValues = ir.computedValues.map((c) => ({
    ...c,
    expression: cleanHandlerBody(c.expression),
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
    fileTypeDeclarations: ir.fileTypeDeclarations.map(cleanHandlerBody),
    fileConstants: ir.fileConstants.map(cleanHandlerBody),
  };
}

// ---------------------------------------------------------------------------
// Handler body cleanup
// ---------------------------------------------------------------------------

function cleanHandlerBody(body: string): string {
  let result = body;

  // Remove: const baseProps = getBaseProps(rest);
  result = result.replace(/const\s+baseProps\s*=\s*getBaseProps\([^)]*\)\s*;?\s*/g, '');

  // Remove: {...baseProps} spread in JSX
  result = result.replace(/\{\s*\.\.\.baseProps\s*\}\s*\n?\s*/g, '');
  // Remove ...baseProps spread in object literals (e.g., { ...baseProps, foo: bar })
  result = result.replace(/\.\.\.baseProps\s*,?\s*/g, '');
  // Remove baseProps.className references
  result = result.replace(BASE_PROPS_CLASSNAME_RE, '');

  // Remove: checkSafeUrl('Button', href);
  result = result.replace(/checkSafeUrl\([^)]*\)\s*;?\s*/g, '');

  // Remove __awsui__ infrastructure assignments (line-level statements only)
  // node.__awsui__.xxx = expr;
  result = result.replace(/^\s*\w+\.__awsui__\.\w+\s*=[^;]*;\s*$/gm, '');
  // node.__awsui__ = {};
  result = result.replace(/^\s*\w+\.__awsui__\s*=\s*\{\s*\}\s*;\s*$/gm, '');
  // if (!node.__awsui__) { node.__awsui__ = {}; }
  result = result.replace(/^\s*if\s*\(\s*!?\w+\.__awsui__\s*\)\s*\{\s*\w+\.__awsui__\s*=\s*\{\s*\}\s*;\s*\}\s*$/gm, '');

  // Remove __internalRootRef as object property value (must run BEFORE destructuring removal)
  result = result.replace(/,?\s*\w+:\s*__internalRootRef\b[^,}\n]*/g, '');
  result = result.replace(/,?\s*__internalRootRef\s*,?/g, (match) => {
    if (match.includes('\n')) return '\n';
    if (match.startsWith(',') && match.endsWith(',')) return ',';
    return '';
  });
  result = result.replace(/const\s+mergedRef\s*=\s*useMergeRefs\([^)]*\)\s*;?\s*/g, '');

  // Remove: const { __internalRootRef } = useBaseComponent(...);
  result = result.replace(/const\s+\{[^}]*\}\s*=\s*useBaseComponent\([^)]*\)\s*;?\s*/g, '');

  // Remove: applyDisplayName(...)
  result = result.replace(/applyDisplayName\([^)]*\)\s*;?\s*/g, '');

  // Unwrap: createPortal(content, target) → content
  // React portals have no Lit equivalent — just render the content directly.
  result = unwrapFunctionCall(result, 'createPortal');

  // Strip InternalBaseComponentProps from intersection types
  // (infrastructure type that adds __internalRootRef — already stripped)
  result = result.replace(/\s*&\s*InternalBaseComponentProps/g, '');

  // Replace Internal{Xxx}Props → {Xxx}Props in type annotations
  // Internal variant is the parser name; the public variant is imported.
  result = result.replace(/\bInternal(\w+Props)\b/g, '$1');

  result = result.replace(/\.\.\.(getAnalyticsMetadataAttribute|getAnalyticsLabelAttribute)\([^)]*\),?\s*/g, '');
  result = replaceFunctionCalls(result, 'getAnalyticsMetadataAttribute', '{}');
  result = replaceFunctionCalls(result, 'getAnalyticsLabelAttribute', '{}');

  // Remove: [DATA_ATTR_FUNNEL_VALUE]: uniqueId
  result = result.replace(/\[DATA_ATTR_FUNNEL_VALUE\]\s*:\s*\w+,?\s*/g, '');

  // Remove: warnOnce(...) — use balanced paren matching for multi-line/nested calls
  result = stripFunctionCalls(result, 'warnOnce');

  // Remove analytics infrastructure
  result = result.replace(ANALYTICS_SELECTORS_RE, "''");
  result = result.replace(TEST_UTIL_STYLES_RE, "''");
  result = result.replace(/\[DATA_ATTR_\w+\]\s*:\s*[^,}\n]+,?\s*/g, '');
  result = result.replace(/\bFUNNEL_KEY_\w+/g, "''");
  // Remove GeneratedAnalytics* type annotations on variables
  // Handles union types: `: GeneratedAnalytics... | OtherType | Record<string, never>`
  result = result.replace(/:\s*(?:GeneratedAnalytics\w+)(?:\s*\|\s*[\w<>,\s]+)*/g, '');

  // Remove __-prefixed infrastructure: if (__xxx) { ... } blocks (with nested braces)
  // Matches: if (__xxx), if (!__xxx), if (__xxx !== undefined), etc.
  result = stripIfBlocks(result, /if\s*\(\s*!?__\w+\b[^)]*\)/);
  // Also strip: if (!node.__awsui__) { ... } and similar __awsui__ conditionals
  result = stripIfBlocks(result, /if\s*\(\s*!?\w+\.__awsui__[^)]*\)/);
  // Remove __-prefixed variable references in expressions
  result = cleanInternalPrefixedRefs(result);
  // Remove spread of __-prefixed vars
  result = result.replace(/,?\s*\.\.\.__\w+,?/g, (m) => m.startsWith(',') && m.endsWith(',') ? ',' : '');
  // Remove assignments to __-prefixed vars: __foo = expr; or __foo = __foo ?? expr;
  result = result.replace(/^\s*__\w+\s*=[^=][^;]*;?\s*$/gm, '');
  // Remove function calls whose only argument is a __-prefixed var:
  // fireNonCancelableEvent(__onOpen); → remove entire statement
  result = result.replace(/^\s*\w+\(__\w+\)\s*;?\s*$/gm, '');
  // Also remove fire*Event calls where the first argument is __-prefixed (multi-arg):
  // fireNonCancelableEvent(__onBlurWithDetail, { relatedTarget }) → remove entire statement
  result = result.replace(/^\s*fire\w+Event\(__\w+\b[^)]*\)\s*;?\s*$/gm, '');

  // Remove __-prefixed key-value pairs and shorthand properties from object literals.
  result = removeInternalPrefixedProperties(result);
  // Also remove properties whose VALUE is a bare __xxx reference
  // e.g., { iconClass: __iconClass, size: 'lg' } → { size: 'lg' }
  result = result.replace(/,?\s*\w+\s*:\s*__\w+\s*(?=[,}])/g, '');

  // Remove __-prefixed parameters from destructuring and function params.
  // { foo, __bar, baz } → { foo, baz }
  // (a, __b, c) → (a, c)
  // Handle optional type annotations: __foo?: Type
  result = result.replace(/,\s*__\w+(?:\??\s*:\s*[^,})]*)?\s*(?=[,})])/g, '');
  result = result.replace(/\(\s*__\w+(?:\??\s*:\s*[^,})]*)?\s*,\s*/g, '(');

  // Rest/spread cleanup runs AFTER __-prefixed cleanup because ternaries
  // like `__flag ? expr : rest` simplify to `rest` only after __-prefixed
  // refs are resolved. Running rest cleanup earlier would miss these.
  result = cleanRestSpreadRefs(result);

  // Remove FunnelMetrics.xxx(...) and analytics selector function calls
  const analyticsCallPattern = /\bFunnelMetrics\.\w+\(|\b(getSubStepAllSelector|getFunnelValueSelector|getFieldSlotSeletor|getNameFromSelector|getSubStepSelector)\(/g;
  let match;
  while ((match = analyticsCallPattern.exec(result)) !== null) {
    // stripFunctionCalls expects funcName without '(' — extract it
    const funcName = match[0].slice(0, -1); // remove trailing '('
    result = stripFunctionCalls(result, funcName);
    analyticsCallPattern.lastIndex = 0; // reset after mutation
  }

  // Remove analytics metadata variables and assignments.
  // const analyticsMetadata = { ... };
  // analyticsMetadata.action = expr;
  // const analyticsComponentMetadata = { ... };
  // const componentAnalyticsMetadata = { ... };
  result = result.replace(/^\s*const\s+(?:analytics(?:Component)?Metadata|componentAnalyticsMetadata)\s*(?::\s*\w+\s*)?=[^;]*;\s*$/gm, '');
  result = result.replace(/^\s*(?:analytics(?:Component)?Metadata|componentAnalyticsMetadata)(?:\.\w+)+\s*=[^;]*;\s*$/gm, '');

  // Note: React type annotations (React.XxxEvent, React.Ref, etc.) are
  // handled by the cleanup-react-types transform — not duplicated here.

  // Simplify dead-code patterns left by rest/__ variable cleanup.
  // undefined?.xxx → undefined (optional chain on undefined)
  result = result.replace(/\bundefined\?\.\w+/g, 'undefined');
  result = cleanSimplifyUndefined(result);

  return result;
}

/**
 * Simplify expressions involving `undefined` that result from stripping
 * infrastructure variables. Applied in both code bodies and template
 * expressions to reduce always-true/always-false patterns.
 */
function cleanSimplifyUndefined(text: string): string {
  let result = text;
  // undefined ?? expr → expr
  result = result.replace(/\bundefined\s*\?\?\s*/g, '');
  // (expr !== undefined) ?? false → (expr !== undefined) — comparison is never nullish
  result = result.replace(/(\([^)]*!==\s*undefined[^)]*\))\s*\?\?\s*false/g, '$1');
  // undefined || expr → expr
  result = result.replace(/\bundefined\s*\|\|\s*/g, '');
  // !undefined → true, !null → true
  result = result.replace(/!undefined\b/g, 'true');
  result = result.replace(/!null\b/g, 'true');
  // undefined && expr → remove (undefined is falsy)
  result = result.replace(/\bundefined\s*&&\s*[^;,\n)]+/g, 'undefined');
  // (undefined || {}) → {}
  result = result.replace(/\(\s*undefined\s*\|\|\s*\{\s*\}\s*\)/g, '{}');
  return result;
}

// ---------------------------------------------------------------------------
// Template cleanup
// ---------------------------------------------------------------------------

function cleanTemplate(node: TemplateNodeIR): TemplateNodeIR {
  return walkTemplate(node, {
    attribute: (attr) => {
      if (REMOVE_ATTRS.has(attr.name)) return null;
      if (attr.name.startsWith('.') && REMOVE_ATTRS.has(attr.name.slice(1))) return null;
      if (REMOVE_ATTR_PREFIXES.some((p) => attr.name.startsWith(p))) return null;
      if (attr.name.startsWith('.__')) return null;

      // Remove ALL spread attributes — React spread has no Lit equivalent
      // and all Cloudscape spreads are internal plumbing
      if (attr.kind === 'spread') return null;

      // Remove attributes that reference __-prefixed infrastructure variables
      if (typeof attr.value !== 'string') {
        const expr = attr.value.expression;
        if (expr.includes('__internalRootRef') || expr.includes('__internalRoot')) return null;
        // Remove attrs whose value is purely a __xxx variable (e.g., .icon=${__rightIcon})
        if (/^\s*__\w+\s*$/.test(expr)) return null;
      }

      // Keep — but clean the attribute expression
      return cleanAttribute(attr);
    },
    expression: (expr) => cleanExpressionText(expr),
    attributeExpression: (expr) => cleanExpressionText(expr),
    conditionExpression: (expr) => cleanExpressionText(expr),
  });
}

function cleanAttribute(attr: AttributeIR): AttributeIR {
  if (typeof attr.value === 'string') return attr;

  let expr = attr.value.expression;

  // Remove baseProps.className from clsx args
  expr = expr.replace(BASE_PROPS_CLASSNAME_RE, '');
  // Remove testUtilStyles/analyticsSelectors bracket access
  expr = expr.replace(TEST_UTIL_STYLES_RE, "''");
  expr = expr.replace(ANALYTICS_SELECTORS_RE, "''");
  // Remove trailing comma if it became the last arg
  expr = expr.replace(/,\s*\)/, ')');

  return { ...attr, value: { expression: expr } };
}

/** Clean infrastructure references from expression text (including nested html`` literals). */
function cleanExpressionText(expr: string): string {
  let result = expr;
  result = result.replace(TEST_UTIL_STYLES_RE, "''");
  result = result.replace(ANALYTICS_SELECTORS_RE, "''");
  result = cleanRestSpreadRefs(result);
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
function cleanRestSpreadRefs(text: string): string {
  let result = text;
  // {...rest} or {...restProps} spread in JSX/objects
  result = result.replace(/\{\s*\.\.\.rest\w*\s*\}\s*\n?\s*/g, '');
  // ...rest or ...restProps in argument/object positions
  result = result.replace(/,?\s*\.\.\.rest\w*(?:\.\w+)*\s*,?/g,
    (m) => m.startsWith(',') && m.endsWith(',') ? ',' : '');
  // rest.xxx or restProps.xxx property access → undefined
  result = result.replace(/\b(?:rest|restProps)\.\w+(?:\?\.\w+)*/g, 'undefined');
  // const { a, b } = rest; → remove (destructuring from rest is meaningless)
  result = result.replace(/const\s*\{[^}]*\}\s*=\s*rest\s*;?\s*/g, '');
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
 * Applied to both code bodies and template expressions.
 */
function cleanInternalPrefixedRefs(text: string): string {
  let result = text;
  // __xxx && expr → remove (the internal flag is always false/absent)
  result = result.replace(/\b__\w+\s*&&\s*[^;,\n]+[;,]?\s*/g, '');
  // expr && __xxx → expr && false (keep the left side, __xxx is always false)
  result = result.replace(/&&\s*__\w+\b/g, '&& false');
  // expr || __xxx → expr (remove the __xxx alternative)
  result = result.replace(/\|\|\s*__\w+\b/g, '');
  // __xxx ?? fallback → fallback (the internal prop is always absent)
  result = result.replace(/\b__\w+\s*\?\?\s*/g, '');
  // __xxx || fallback → fallback (the internal prop is always falsy)
  result = result.replace(/\b__\w+\s*\|\|\s*/g, '');
  // __xxx ? exprA : exprB → exprB (take the else branch)
  result = result.replace(/\b__\w+\s*\?\s*[^:]+:\s*/g, '');
  // !__xxx ? exprA : exprB → exprA (negated: take the then branch)
  result = result.replace(/!__\w+\s*\?\s*/g, '');
  // Simplify unreachable nullish coalescing: (expr !== undefined) ?? false → (expr !== undefined)
  result = result.replace(/(\([^)]+!==\s*undefined\))\s*\?\?\s*false/g, '$1');
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
function cleanInternalPrefixedRefsInExpr(text: string): string {
  let result = text;
  // !__xxx && expr — the negated internal is always true, keep expr
  // (must run before the non-negated pattern)
  result = result.replace(/!__\w+\s*&&\s*/g, '');
  // __xxx && expr — only consume up to the next comma or closing brace/paren
  // (not greedy past structural delimiters)
  result = result.replace(/\b__\w+\s*&&\s*[^;,}\n)]+/g, 'false');
  // !__xxx ? exprA : exprB → exprA
  result = result.replace(/!__\w+\s*\?\s*/g, '');
  // __xxx ? exprA : exprB → exprB
  result = result.replace(/\b__\w+\s*\?\s*[^:]+:\s*/g, '');
  // Bare __xxx (e.g., classMap value, standalone reference) → false
  result = result.replace(/\b__\w+\b/g, 'false');
  return result;
}

/**
 * Clean __-prefixed references inside template literal interpolations (${...})
 * found within html`` tagged templates in render helper source text.
 *
 * The code-body cleanup (cleanInternalPrefixedRefs) handles __xxx in
 * conditionals and assignments, but template attribute bindings like
 * `.prop=${__xxx}` need the expression-safe version that replaces bare
 * __xxx with false.
 */
function cleanTemplateInterpolations(source: string): string {
  // Only process if there are __-prefixed identifiers remaining
  if (!/\b__\w+/.test(source)) return source;

  // Find all ${...} interpolations and apply expression cleanup
  // Use balanced brace matching to correctly handle nested ${...}
  let result = '';
  let i = 0;
  while (i < source.length) {
    // Look for ${
    const dollarBrace = source.indexOf('${', i);
    if (dollarBrace === -1) {
      result += source.slice(i);
      break;
    }
    // Copy text up to and including ${
    result += source.slice(i, dollarBrace + 2);
    // Find matching }
    let depth = 1;
    let j = dollarBrace + 2;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') depth--;
      if (depth > 0) j++;
    }
    // Extract interpolation content
    const content = source.slice(dollarBrace + 2, j);
    // Apply expression cleanup if it contains __-prefixed refs
    if (/\b__\w+/.test(content)) {
      result += cleanInternalPrefixedRefsInExpr(content);
    } else {
      result += content;
    }
    // Skip past the closing }
    result += '}';
    i = j + 1;
  }
  return result;
}

/**
 * Remove __-prefixed key-value pairs from object literals in code text.
 * Handles nested function calls in values via balanced paren matching.
 *
 * `{ foo: 1, __bar: someCall(a, b), baz: 2 }` → `{ foo: 1, baz: 2 }`
 */
function removeInternalPrefixedProperties(text: string): string {
  // Match `__propName:` or `__propName?:` at the start of a key-value pair
  const pattern = /,?\s*__\w+\??\s*:/g;
  let result = text;
  let match;

  while ((match = pattern.exec(result)) !== null) {
    const keyStart = match.index;
    const valueStart = keyStart + match[0].length;

    // Find the end of the value — scan forward, respecting balanced parens/brackets
    let depth = 0;
    let i = valueStart;
    while (i < result.length) {
      const ch = result[i];
      if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break; // hit the end of the enclosing object
        depth--;
        i++;
        continue;
      }
      if (ch === ',' && depth === 0) { i++; break; } // end of this value
      // Skip strings
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

    // Remove the key-value pair (including leading comma if present)
    result = result.slice(0, keyStart) + result.slice(i);
    pattern.lastIndex = keyStart; // rescan from same position
  }

  return result;
}
