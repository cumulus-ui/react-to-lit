/**
 * Event callback → CustomEvent dispatch transform.
 *
 * Converts React event callback patterns:
 *   fireNonCancelableEvent(onChange, { value })
 *   fireCancelableEvent(onFollow, { href }, event)
 * into Lit event dispatch:
 *   fireNonCancelableEvent(this, 'change', { value })
 *
 * Scans all code: handlers, effects, helpers, and template expressions.
 */
import type { ComponentIR, HandlerIR, TemplateNodeIR, AttributeIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function transformEvents(ir: ComponentIR): ComponentIR {
  // Collect event prop names
  const eventProps = new Map<string, string>(); // propName → eventName
  for (const prop of ir.props) {
    if (prop.category === 'event') {
      const eventName = propNameToEventName(prop.name);
      eventProps.set(prop.name, eventName);
    }
  }

  if (eventProps.size === 0) return ir;

  const rewrite = (text: string) => rewriteEventCalls(text, eventProps);

  // Transform handler bodies
  const handlers = ir.handlers.map((h) => ({
    ...h,
    body: rewrite(h.body),
  }));

  // Transform effect bodies
  const effects = ir.effects.map((e) => ({
    ...e,
    body: rewrite(e.body),
    cleanup: e.cleanup ? rewrite(e.cleanup) : undefined,
  }));

  // Transform helper source
  const helpers = ir.helpers.map((h) => ({
    ...h,
    source: rewrite(h.source),
  }));

  // Transform public methods
  const publicMethods = ir.publicMethods.map((m) => ({
    ...m,
    body: rewrite(m.body),
  }));

  // Transform body preamble
  const bodyPreamble = ir.bodyPreamble.map(rewrite);

  // Transform template expressions
  const template = rewriteTemplateEvents(ir.template, eventProps);

  // Check if we need event import
  const allCode = [
    ...handlers.map((h) => h.body),
    ...effects.map((e) => e.body),
    ...helpers.map((h) => h.source),
    ...publicMethods.map((m) => m.body),
    ...bodyPreamble,
  ].join('\n');

  const needsEventImport = allCode.includes('fireNonCancelableEvent(this,');

  const imports = [...ir.imports];
  if (needsEventImport) {
    imports.push({
      moduleSpecifier: '../internal/events.js',
      namedImports: ['fireNonCancelableEvent'],
    });
  }

  return {
    ...ir,
    handlers,
    effects,
    helpers,
    publicMethods,
    bodyPreamble,
    template,
    imports,
  };
}

// ---------------------------------------------------------------------------
// Text rewriting
// ---------------------------------------------------------------------------

function rewriteEventCalls(
  text: string,
  eventProps: Map<string, string>,
): string {
  let result = text;

  for (const [propName, eventName] of eventProps) {
    // fireNonCancelableEvent(propName, ...)
    const nonCancelablePattern = new RegExp(
      `fireNonCancelableEvent\\(\\s*${escapeRegex(propName)}\\b`,
      'g',
    );
    result = result.replace(
      nonCancelablePattern,
      `fireNonCancelableEvent(this, '${eventName}'`,
    );

    // fireCancelableEvent(propName, detail, event)
    const cancelablePattern = new RegExp(
      `fireCancelableEvent\\(\\s*${escapeRegex(propName)}\\b`,
      'g',
    );
    result = result.replace(
      cancelablePattern,
      `fireNonCancelableEvent(this, '${eventName}'`,
    );

    // Direct callback invocation: propName?.(detail) or propName(detail)
    // onChange?.({ checked: true }) → fireNonCancelableEvent(this, 'change', { checked: true })
    const directCallOptional = new RegExp(
      `${escapeRegex(propName)}\\?\\.\\(`,
      'g',
    );
    result = result.replace(
      directCallOptional,
      `fireNonCancelableEvent(this, '${eventName}', `,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Template expression rewriting
// ---------------------------------------------------------------------------

function rewriteTemplateEvents(
  node: TemplateNodeIR,
  eventProps: Map<string, string>,
): TemplateNodeIR {
  // Rewrite attribute expressions
  const attrs = node.attributes.map((attr) => rewriteAttrEvent(attr, eventProps));

  // Recurse
  const children = node.children.map((c) => rewriteTemplateEvents(c, eventProps));

  return {
    ...node,
    attributes: attrs,
    children,
    condition: node.condition
      ? {
          ...node.condition,
          alternate: node.condition.alternate
            ? rewriteTemplateEvents(node.condition.alternate, eventProps)
            : undefined,
        }
      : undefined,
  };
}

function rewriteAttrEvent(
  attr: AttributeIR,
  eventProps: Map<string, string>,
): AttributeIR {
  if (typeof attr.value === 'string') return attr;
  const rewritten = rewriteEventCalls(attr.value.expression, eventProps);
  if (rewritten === attr.value.expression) return attr;
  return { ...attr, value: { expression: rewritten } };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function propNameToEventName(propName: string): string {
  if (!propName.startsWith('on')) return propName.toLowerCase();
  const rest = propName.slice(2);
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
