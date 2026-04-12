/**
 * Event callback → CustomEvent dispatch transform.
 *
 * Converts React event callback patterns:
 *   fireNonCancelableEvent(onChange, { value })
 *   fireCancelableEvent(onFollow, { href }, event)
 *   fireKeyboardEvent(onKeyDown, event)
 * into Lit event dispatch:
 *   fireNonCancelableEvent(this, 'change', { value })
 *
 * Also handles:
 *   - controlledOnChange(...) and controlledOnChange?.(...) prefixed handlers
 *   - Direct propName(detail) invocations (non-optional chaining)
 *
 * Scans all code: handlers, effects, helpers, and template expressions.
 */
import type { ComponentIR, TemplateNodeIR } from '../ir/types.js';
import { mapIRText } from '../ir/transform-helpers.js';
import { toCustomEventName, escapeRegex } from '../naming.js';
import { walkTemplate } from '../template-walker.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function transformEvents(ir: ComponentIR): ComponentIR {
  // Collect event prop names
  const eventProps = new Map<string, string>(); // propName → eventName
  let hasCancelable = false;
  for (const prop of ir.props) {
    if (prop.category === 'event') {
      const eventName = toCustomEventName(prop.name);
      eventProps.set(prop.name, eventName);
      if (prop.eventCancelable) {
        hasCancelable = true;
      }
    }
  }

  if (eventProps.size === 0) return ir;

  const rewrite = (text: string) => rewriteEventCalls(text, eventProps);

  // Transform all code bodies
  const transformed = mapIRText(ir, rewrite);

  // Transform template expressions
  const template = rewriteTemplateEvents(ir.template, eventProps);

  // Check if we need event import
  const allCode = [
    ...transformed.handlers.map((h) => h.body),
    ...transformed.effects.map((e) => e.body),
    ...transformed.helpers.map((h) => h.source),
    ...transformed.publicMethods.map((m) => m.body),
    ...transformed.bodyPreamble,
  ].join('\n');

  const needsNonCancelableImport = allCode.includes('fireNonCancelableEvent(this,');
  const needsCancelableImport = hasCancelable && allCode.includes('fireCancelableEvent(this,');

  const imports = [...ir.imports];
  if (needsNonCancelableImport || needsCancelableImport) {
    const namedImports: string[] = [];
    if (needsNonCancelableImport) namedImports.push('fireNonCancelableEvent');
    if (needsCancelableImport) namedImports.push('fireCancelableEvent');
    imports.push({
      moduleSpecifier: '../internal/events.js',
      namedImports,
    });
  }

  return {
    ...transformed,
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
      `fireCancelableEvent(this, '${eventName}'`,
    );

    // fireKeyboardEvent(propName, event) → fireNonCancelableEvent(this, 'eventName', event)
    const keyboardPattern = new RegExp(
      `fireKeyboardEvent\\(\\s*${escapeRegex(propName)}\\b`,
      'g',
    );
    result = result.replace(
      keyboardPattern,
      `fireNonCancelableEvent(this, '${eventName}'`,
    );

    // Direct callback invocation: propName?.(detail)
    // onChange?.({ checked: true }) → fireNonCancelableEvent(this, 'change', { checked: true })
    const directCallOptional = new RegExp(
      `${escapeRegex(propName)}\\?\\.\\(`,
      'g',
    );
    result = result.replace(
      directCallOptional,
      `fireNonCancelableEvent(this, '${eventName}', `,
    );

    // Direct callback invocation (non-optional): propName(detail)
    // onChange({ checked: true }) → fireNonCancelableEvent(this, 'change', { checked: true })
    // Only match when NOT preceded by '.', a word char, or a quote (to avoid matching
    // already-converted patterns like fireNonCancelableEvent(this, 'change') or object.onChange(x))
    const directCall = new RegExp(
      `(?<![.\\w'"])${escapeRegex(propName)}\\(`,
      'g',
    );
    result = result.replace(
      directCall,
      `fireNonCancelableEvent(this, '${eventName}', `,
    );

    // --- Handle controlledOnXxx prefix variants ---
    // Some components rename event handlers: onNavigationChange: controlledOnNavigationChange
    // These appear as controlledOnXxx?.(detail) or controlledOnXxx(detail) or in fire*Event calls
    const controlledName = 'controlled' + propName.charAt(0).toUpperCase() + propName.slice(1);

    // fire*Event(controlledOnXxx, ...) patterns
    const controlledNonCancelable = new RegExp(
      `fireNonCancelableEvent\\(\\s*${escapeRegex(controlledName)}\\b`,
      'g',
    );
    result = result.replace(
      controlledNonCancelable,
      `fireNonCancelableEvent(this, '${eventName}'`,
    );

    const controlledCancelable = new RegExp(
      `fireCancelableEvent\\(\\s*${escapeRegex(controlledName)}\\b`,
      'g',
    );
    result = result.replace(
      controlledCancelable,
      `fireCancelableEvent(this, '${eventName}'`,
    );

    const controlledKeyboard = new RegExp(
      `fireKeyboardEvent\\(\\s*${escapeRegex(controlledName)}\\b`,
      'g',
    );
    result = result.replace(
      controlledKeyboard,
      `fireNonCancelableEvent(this, '${eventName}'`,
    );

    // controlledOnXxx?.(detail) → fireNonCancelableEvent(this, 'eventName', detail)
    const controlledOptional = new RegExp(
      `${escapeRegex(controlledName)}\\?\\.\\(`,
      'g',
    );
    result = result.replace(
      controlledOptional,
      `fireNonCancelableEvent(this, '${eventName}', `,
    );

    // controlledOnXxx(detail) → fireNonCancelableEvent(this, 'eventName', detail)
    const controlledDirect = new RegExp(
      `(?<![.\\w'"])${escapeRegex(controlledName)}\\(`,
      'g',
    );
    result = result.replace(
      controlledDirect,
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
  return walkTemplate(node, {
    attributeExpression: (expr) => {
      const rewritten = rewriteEventCalls(expr, eventProps);
      return rewritten !== expr ? rewritten : undefined;
    },
    expression: (expr) => {
      const rewritten = rewriteEventCalls(expr, eventProps);
      return rewritten !== expr ? rewritten : undefined;
    },
    conditionExpression: (expr) => {
      const rewritten = rewriteEventCalls(expr, eventProps);
      return rewritten !== expr ? rewritten : undefined;
    },
  });
}
