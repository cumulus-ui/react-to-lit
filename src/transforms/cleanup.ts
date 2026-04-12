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
import { stripFunctionCalls, stripIfBlocks, unwrapFunctionCall } from '../text-utils.js';

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
      source: cleanHandlerBody(h.source),
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

  // Remove rest/spread references (general React pattern)
  result = cleanRestSpreadRefs(result);
  result = result.replace(/\.\.\.(getAnalyticsMetadataAttribute|getAnalyticsLabelAttribute)\([^)]*\),?\s*/g, '');

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
  result = stripIfBlocks(result, /if\s*\(\s*!?__\w+\s*\)/);

  // Remove __-prefixed variable references in expressions
  result = cleanInternalPrefixedRefs(result);
  // Remove spread of __-prefixed vars
  result = result.replace(/,?\s*\.\.\.__\w+,?/g, (m) => m.startsWith(',') && m.endsWith(',') ? ',' : '');

  // Remove FunnelMetrics.xxx(...) and analytics selector function calls
  const analyticsCallPattern = /\bFunnelMetrics\.\w+\(|\b(getSubStepAllSelector|getFunnelValueSelector|getFieldSlotSeletor|getNameFromSelector|getSubStepSelector)\(/g;
  let match;
  while ((match = analyticsCallPattern.exec(result)) !== null) {
    // stripFunctionCalls expects funcName without '(' — extract it
    const funcName = match[0].slice(0, -1); // remove trailing '('
    result = stripFunctionCalls(result, funcName);
    analyticsCallPattern.lastIndex = 0; // reset after mutation
  }

  // Note: React type annotations (React.XxxEvent, React.Ref, etc.) are
  // handled by the cleanup-react-types transform — not duplicated here.

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
  // __xxx ? exprA : exprB → exprB (take the else branch)
  result = result.replace(/\b__\w+\s*\?\s*[^:]+:\s*/g, '');
  // !__xxx ? exprA : exprB → exprA (negated: take the then branch)
  result = result.replace(/!__\w+\s*\?\s*/g, '');
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
