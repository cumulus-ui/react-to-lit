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

// ---------------------------------------------------------------------------
// Props to remove
// ---------------------------------------------------------------------------

const REMOVE_PROPS = new Set([
  'nativeAttributes',
  'nativeInputAttributes',
  'nativeButtonAttributes',
  'nativeAnchorAttributes',
  'analyticsAction',
  'analyticsMetadata',
]);

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function removeCloudscapeInternals(ir: ComponentIR): ComponentIR {
  // Remove internal props
  const props = ir.props.filter((p) => {
    if (p.name.startsWith('__')) return false;
    if (REMOVE_PROPS.has(p.name)) return false;
    // Remove 'style' prop from Cloudscape theming (not CSS style)
    if (p.name === 'style' && !p.default) return false;
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
      const infraNames = new Set(['applyDisplayName', 'getBaseProps', 'checkSafeUrl']);
      return !infraNames.has(h.name);
    })
    .map((h) => ({
      ...h,
      source: cleanHandlerBody(h.source),
    }));

  // Clean template — remove Cloudscape-specific attributes
  const template = cleanTemplate(ir.template);

  // Clean body preamble
  const bodyPreamble = ir.bodyPreamble.map(cleanHandlerBody);

  return {
    ...ir,
    props,
    handlers,
    effects,
    helpers,
    template,
    bodyPreamble,
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
  // Remove baseProps.className references
  result = result.replace(/\bbaseProps\.className\b,?\s*/g, '');

  // Remove: checkSafeUrl('Button', href);
  result = result.replace(/checkSafeUrl\([^)]*\)\s*;?\s*/g, '');

  // Remove __internalRootRef as object property value (must run BEFORE destructuring removal)
  result = result.replace(/,?\s*\w+:\s*__internalRootRef\b[^,}\n]*/g, '');
  // Remove __internalRootRef in destructuring: `{ __internalRootRef, ...rest }`
  result = result.replace(/,?\s*__internalRootRef\s*,?/g, (match) => {
    if (match.startsWith(',') && match.endsWith(',')) return ',';
    return '';
  });
  result = result.replace(/const\s+mergedRef\s*=\s*useMergeRefs\([^)]*\)\s*;?\s*/g, '');

  // Remove: const { __internalRootRef } = useBaseComponent(...);
  result = result.replace(/const\s+\{[^}]*\}\s*=\s*useBaseComponent\([^)]*\)\s*;?\s*/g, '');

  // Remove: applyDisplayName(...)
  result = result.replace(/applyDisplayName\([^)]*\)\s*;?\s*/g, '');

  // Remove: getAnalyticsMetadataAttribute(...)
  result = result.replace(/\.\.\.(getAnalyticsMetadataAttribute|getAnalyticsLabelAttribute)\([^)]*\),?\s*/g, '');

  // Remove: [DATA_ATTR_FUNNEL_VALUE]: uniqueId
  result = result.replace(/\[DATA_ATTR_FUNNEL_VALUE\]\s*:\s*\w+,?\s*/g, '');

  // Strip React type annotations: React.KeyboardEvent<Element> → KeyboardEvent
  result = result.replace(/React\.\w+Event<[^>]+>/g, (match) => {
    return match.replace(/^React\./, '').replace(/<[^>]+>$/, '');
  });
  // React.Ref<...> → any, React.RefObject<...> → any
  result = result.replace(/React\.(Ref|RefObject|MutableRefObject)<[^>]+>/g, 'any');
  // React.HTMLAttributes<...> → any
  result = result.replace(/React\.\w+Attributes<[^>]+>/g, 'any');

  return result;
}

// ---------------------------------------------------------------------------
// Template cleanup
// ---------------------------------------------------------------------------

/** Attribute names to remove from template elements */
const REMOVE_ATTRS = new Set([
  'ref',
  'componentName',
  'nativeAttributes',
  'nativeInputAttributes',
  'nativeButtonAttributes',
  'nativeAnchorAttributes',
  'skipWarnings',
]);

/** Attribute name prefixes to remove */
const REMOVE_ATTR_PREFIXES = ['__', 'data-analytics'];

function cleanTemplate(node: TemplateNodeIR): TemplateNodeIR {
  // Remove Cloudscape-specific attributes
  const cleanedAttrs = node.attributes.filter((attr) => {
    if (REMOVE_ATTRS.has(attr.name)) return false;
    if (attr.name.startsWith('.') && REMOVE_ATTRS.has(attr.name.slice(1))) return false;
    if (REMOVE_ATTR_PREFIXES.some((p) => attr.name.startsWith(p))) return false;
    if (attr.name.startsWith('.__')) return false;

    // Remove ALL spread attributes — React spread has no Lit equivalent
    // and all Cloudscape spreads are internal plumbing
    if (attr.kind === 'spread') {
      return false;
    }

    // Remove attributes that reference __internalRootRef
    if (typeof attr.value !== 'string') {
      const expr = attr.value.expression;
      if (expr.includes('__internalRootRef') || expr.includes('__internalRoot')) return false;
    }

    return true;
  });

  // Clean attribute expressions
  const cleanedAttrValues = cleanedAttrs.map((attr) => cleanAttribute(attr));

  // Recurse into children
  const cleanedChildren = node.children.map(cleanTemplate);

  return {
    ...node,
    attributes: cleanedAttrValues,
    children: cleanedChildren,
    condition: node.condition
      ? {
          ...node.condition,
          alternate: node.condition.alternate ? cleanTemplate(node.condition.alternate) : undefined,
        }
      : undefined,
  };
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
