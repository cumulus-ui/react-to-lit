/**
 * Event callback → CustomEvent dispatch transform.
 *
 * Converts React event callback patterns:
 *   fireNonCancelableEvent(onChange, { value })
 *   fireCancelableEvent(onFollow, { href }, event)
 * into Lit event dispatch:
 *   fireNonCancelableEvent(this, 'change', { value })
 */
import type { ComponentIR, HandlerIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Transform event callback patterns in handlers.
 * - Rewrites fireNonCancelableEvent/fireCancelableEvent calls
 * - Removes event props from the props list (they become CustomEvents)
 */
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

  // Transform handler bodies
  const transformedHandlers = ir.handlers.map((handler) =>
    transformHandlerBody(handler, eventProps),
  );

  // Add fireNonCancelableEvent import if needed
  const needsEventImport = transformedHandlers.some(
    (h) => h.body.includes('fireNonCancelableEvent(this,'),
  );

  const imports = [...ir.imports];
  if (needsEventImport) {
    imports.push({
      moduleSpecifier: '../internal/events.js',
      namedImports: ['fireNonCancelableEvent'],
    });
  }

  return {
    ...ir,
    handlers: transformedHandlers,
    imports,
  };
}

// ---------------------------------------------------------------------------
// Handler body transformation
// ---------------------------------------------------------------------------

function transformHandlerBody(
  handler: HandlerIR,
  eventProps: Map<string, string>,
): HandlerIR {
  let body = handler.body;

  // Replace: fireNonCancelableEvent(onFoo, detail)
  // With:    fireNonCancelableEvent(this, 'foo', detail)
  for (const [propName, eventName] of eventProps) {
    // Pattern: fireNonCancelableEvent(propName, ...)
    const nonCancelablePattern = new RegExp(
      `fireNonCancelableEvent\\(\\s*${escapeRegex(propName)}\\b`,
      'g',
    );
    body = body.replace(
      nonCancelablePattern,
      `fireNonCancelableEvent(this, '${eventName}'`,
    );

    // Pattern: fireCancelableEvent(propName, detail, event)
    const cancelablePattern = new RegExp(
      `fireCancelableEvent\\(\\s*${escapeRegex(propName)}\\b`,
      'g',
    );
    body = body.replace(
      cancelablePattern,
      `fireNonCancelableEvent(this, '${eventName}'`,
    );
  }

  return { ...handler, body };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Convert a React event prop name to a Lit event name.
 * onChange → 'change', onFollow → 'follow', onBlur → 'blur'
 */
function propNameToEventName(propName: string): string {
  if (!propName.startsWith('on')) return propName.toLowerCase();
  // Remove 'on' prefix and lowercase the first letter
  const rest = propName.slice(2);
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
