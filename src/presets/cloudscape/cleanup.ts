/**
 * Cloudscape-specific cleanup plugin.
 *
 * Contains patterns that are specific to the Cloudscape design system's
 * internal infrastructure. These patterns are applied AFTER the core
 * generic cleanup in `cleanup-core.ts`.
 *
 * Patterns handled:
 * - `baseProps` / `getBaseProps` removal
 * - `checkSafeUrl` removal
 * - `__awsui__` assignment removal
 * - `useBaseComponent` removal
 * - `applyDisplayName` removal
 * - `testUtilStyles` / `analyticsSelectors` replacement
 * - `FunnelMetrics` / analytics metadata removal
 * - `DATA_ATTR_FUNNEL_VALUE` / `FUNNEL_KEY_*` removal
 * - `GeneratedAnalytics*` type annotation removal
 * - `InternalBaseComponentProps` stripping
 */
import type { AttributeIR } from '../../ir/types.js';
import type { CleanupPlugin } from '../../transforms/cleanup-core.js';
import { TEST_UTIL_STYLES_RE, ANALYTICS_SELECTORS_RE, BASE_PROPS_CLASSNAME_RE } from '../../transforms/cleanup-core.js';
import { stripFunctionCalls, replaceFunctionCalls, stripIfBlocks } from '../../text-utils.js';

// ---------------------------------------------------------------------------
// Body cleanup — Cloudscape infrastructure
// ---------------------------------------------------------------------------

function cleanCloudscapeBody(body: string): string {
  let result = body;

  // Remove: const baseProps = getBaseProps(rest);
  result = result.replace(/const\s+baseProps\s*=\s*getBaseProps\([^)]*\)\s*;?\s*/g, '');

  // Remove: {...baseProps} spread in JSX
  result = result.replace(/\{\s*\.\.\.baseProps\s*\}\s*\n?\s*/g, '');
  // Remove ...baseProps spread in object literals
  result = result.replace(/\.\.\.baseProps\s*,?\s*/g, '');
  // Remove baseProps.className references
  result = result.replace(BASE_PROPS_CLASSNAME_RE, '');

  // Remove: checkSafeUrl('Button', href);
  result = result.replace(/checkSafeUrl\([^)]*\)\s*;?\s*/g, '');

  // Remove __awsui__ infrastructure assignments (line-level statements only)
  result = result.replace(/^\s*\w+\.__awsui__\.\w+\s*=[^;]*;\s*$/gm, '');
  result = result.replace(/^\s*\w+\.__awsui__\s*=\s*\{\s*\}\s*;\s*$/gm, '');
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

  // Strip InternalBaseComponentProps from intersection types
  result = result.replace(/\s*&\s*InternalBaseComponentProps/g, '');

  // Replace Internal{Xxx}Props → {Xxx}Props in type annotations
  result = result.replace(/\bInternal(\w+Props)\b/g, '$1');

  // Remove analytics metadata spreads
  result = result.replace(/\.\.\.(getAnalyticsMetadataAttribute|getAnalyticsLabelAttribute)\([^)]*\),?\s*/g, '');
  // Replace standalone calls with empty object (they may be used as values)
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
  result = result.replace(/:\s*(?:GeneratedAnalytics\w+)(?:\s*\|\s*[\w<>,\s]+)*/g, '');

  // Also strip: if (!node.__awsui__) { ... } and similar __awsui__ conditionals
  result = stripIfBlocks(result, /if\s*\(\s*!?\w+\.__awsui__[^)]*\)/);

  // Remove FunnelMetrics.xxx(...) and analytics selector function calls
  const analyticsCallPattern = /\bFunnelMetrics\.\w+\(|\b(getSubStepAllSelector|getFunnelValueSelector|getFieldSlotSeletor|getNameFromSelector|getSubStepSelector)\(/g;
  let match;
  while ((match = analyticsCallPattern.exec(result)) !== null) {
    const funcName = match[0].slice(0, -1); // remove trailing '('
    result = stripFunctionCalls(result, funcName);
    analyticsCallPattern.lastIndex = 0; // reset after mutation
  }

  // Remove analytics metadata variables and assignments.
  result = result.replace(/^\s*const\s+(?:analytics(?:Component)?Metadata|componentAnalyticsMetadata)\s*(?::\s*\w+\s*)?=[^;]*;\s*$/gm, '');
  result = result.replace(/^\s*(?:analytics(?:Component)?Metadata|componentAnalyticsMetadata)(?:\.\w+)+\s*=[^;]*;\s*$/gm, '');

  return result;
}

// ---------------------------------------------------------------------------
// Attribute cleanup — Cloudscape infrastructure
// ---------------------------------------------------------------------------

function cleanCloudscapeAttribute(attr: AttributeIR): AttributeIR | null {
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

// ---------------------------------------------------------------------------
// Expression cleanup — Cloudscape infrastructure
// ---------------------------------------------------------------------------

function cleanCloudscapeExpression(expr: string): string {
  let result = expr;
  result = result.replace(TEST_UTIL_STYLES_RE, "''");
  result = result.replace(ANALYTICS_SELECTORS_RE, "''");
  return result;
}

// ---------------------------------------------------------------------------
// Exported plugin
// ---------------------------------------------------------------------------

/**
 * Cloudscape design-system cleanup plugin.
 *
 * Removes Cloudscape-specific infrastructure patterns from the IR
 * after core generic cleanup has been applied.
 */
export const cloudscapeCleanupPlugin: CleanupPlugin = {
  cleanBody: cleanCloudscapeBody,
  cleanAttribute: cleanCloudscapeAttribute,
  cleanExpression: cleanCloudscapeExpression,
};
