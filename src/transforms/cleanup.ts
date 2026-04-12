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
import { stripFunctionCalls, stripIfBlocks } from '../text-utils.js';

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
  result = result.replace(/\bbaseProps\.className\b,?\s*/g, '');

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

  // Remove rest/restProps/restXxx references (from const { foo, ...rest } = props — meaningless in Lit)
  result = result.replace(/\{\s*\.\.\.rest\w*\s*\}\s*\n?\s*/g, '');
  result = result.replace(/,?\s*\.\.\.rest\w*(?:\.\w+)*\s*,?/g, (m) => m.startsWith(',') && m.endsWith(',') ? ',' : '');
  result = result.replace(/\b(?:rest|restProps)\.\w+(?:\?\.\w+)*/g, 'undefined');

  // Remove: getAnalyticsMetadataAttribute(...)
  result = result.replace(/\.\.\.(getAnalyticsMetadataAttribute|getAnalyticsLabelAttribute)\([^)]*\),?\s*/g, '');

  // Remove: [DATA_ATTR_FUNNEL_VALUE]: uniqueId
  result = result.replace(/\[DATA_ATTR_FUNNEL_VALUE\]\s*:\s*\w+,?\s*/g, '');

  // Remove: warnOnce(...) — use balanced paren matching for multi-line/nested calls
  result = stripFunctionCalls(result, 'warnOnce');

  // Remove analytics infrastructure
  result = result.replace(/\banalyticsSelectors\[['"\w-]+\]/g, "''");
  result = result.replace(/\btestUtilStyles\[['"\w-]+\]|\btestutilStyles\[['"\w-]+\]|\btestStyles\[['"\w-]+\]/g, "''");
  result = result.replace(/\[DATA_ATTR_\w+\]\s*:\s*[^,}\n]+,?\s*/g, '');
  result = result.replace(/\bFUNNEL_KEY_\w+/g, "''");

  // Remove __-prefixed infrastructure: if (__xxx) { ... } blocks (with nested braces)
  result = stripIfBlocks(result, /if\s*\(\s*!?__\w+\s*\)/);

  // Remove destructuring from 'rest' — React rest props are not available in Lit
  result = result.replace(/const\s*\{[^}]*\}\s*=\s*rest\s*;?\s*/g, '');

  // Remove __xxx && expr patterns
  result = result.replace(/\b__\w+\s*&&\s*[^;,\n]+[;,]?\s*/g, '');
  // Remove __xxx ternary patterns: __xxx ? exprA : exprB → exprB
  result = result.replace(/\b__\w+\s*\?\s*[^:]+:\s*/g, '');
  // Remove !__xxx ternary patterns: !__xxx ? exprA : exprB → exprA
  result = result.replace(/!__\w+\s*\?\s*/g, '');
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
  });
}

function cleanAttribute(attr: AttributeIR): AttributeIR {
  if (typeof attr.value === 'string') return attr;

  let expr = attr.value.expression;

  // Remove baseProps.className from clsx args
  expr = expr.replace(/\bbaseProps\.className\b,?\s*/g, '');
  // Remove trailing comma if it became the last arg
  expr = expr.replace(/,\s*\)/, ')');

  return { ...attr, value: { expression: expr } };
}
