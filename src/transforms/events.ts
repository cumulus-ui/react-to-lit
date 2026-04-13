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
 *
 * When an EventsConfig is provided, dispatch function names and import paths
 * are read from config instead of the hardcoded defaults.  A `'native'`
 * dispatch mode replaces helper calls with inline `this.dispatchEvent(…)`.
 */
import type { ComponentIR, TemplateNodeIR } from '../ir/types.js';
import type { EventsConfig } from '../config.js';
import { mapIRText, collectIRText } from '../ir/transform-helpers.js';
import { toCustomEventName, escapeRegex } from '../naming.js';
import { walkTemplate } from '../template-walker.js';

// ---------------------------------------------------------------------------
// Defaults (used when no config is provided)
// ---------------------------------------------------------------------------

/** Default dispatch function registry — matches the legacy hardcoded names. */
const DEFAULT_DISPATCH_FUNCTIONS: Record<string, { import: string; cancelable: boolean }> = {
  fireNonCancelableEvent: { import: '../internal/events.js', cancelable: false },
  fireCancelableEvent:    { import: '../internal/events.js', cancelable: true },
  fireKeyboardEvent:      { import: '../internal/events.js', cancelable: false },
};

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function transformEvents(ir: ComponentIR, config?: EventsConfig): ComponentIR {
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

  // Also include prop aliases (e.g., `onFinish: onFinishHandler` → alias
  // `onFinishHandler` maps to the same event as the original prop `onFinish`).
  if (ir.propAliases) {
    for (const [alias, propName] of ir.propAliases) {
      const eventName = eventProps.get(propName);
      if (eventName) {
        eventProps.set(alias, eventName);
      }
    }
  }

  const rewrite = (text: string) => rewriteEventCalls(text, eventProps, config);

  // Transform all code bodies
  const transformed = mapIRText(ir, rewrite);

  // Transform template expressions
  const template = rewriteTemplateEvents(ir.template, eventProps, config);

  // Determine dispatch functions from config or defaults
  const isNative = config?.dispatchMode === 'native';
  const dispatchFunctions = resolveDispatchFunctions(config);

  // Check if we need event imports (not needed in native mode)
  const allCode = collectIRText({ ...transformed, template });
  const imports = [...ir.imports];

  if (!isNative) {
    // Collect which dispatch functions are actually used in the output
    const usedFunctions = new Map<string, string>(); // funcName → importPath
    for (const [funcName, funcConfig] of Object.entries(dispatchFunctions)) {
      if (allCode.includes(`${funcName}(this,`)) {
        usedFunctions.set(funcName, funcConfig.import);
      }
    }

    // For the default (no-config) case, fireKeyboardEvent is rewritten
    // to fireNonCancelableEvent, so we only check the output names.
    // Also respect hasCancelable for the cancelable import.
    if (!config) {
      // Legacy behaviour: only add cancelable import when hasCancelable flag is set
      if (!hasCancelable) {
        usedFunctions.delete('fireCancelableEvent');
      }
    }

    if (usedFunctions.size > 0) {
      // Only add event imports if not already present from the source
      const alreadyHasEventImport = ir.imports.some(imp =>
        imp.moduleSpecifier.includes('events') &&
        [...usedFunctions.keys()].some(fn => imp.namedImports?.includes(fn)),
      );

      if (!alreadyHasEventImport) {
        // Group by import path
        const byPath = new Map<string, string[]>();
        for (const [funcName, importPath] of usedFunctions) {
          const list = byPath.get(importPath) ?? [];
          list.push(funcName);
          byPath.set(importPath, list);
        }
        for (const [moduleSpecifier, namedImports] of byPath) {
          imports.push({ moduleSpecifier, namedImports });
        }
      }
    }
  }

  return {
    ...transformed,
    template,
    imports,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the dispatch function registry from config or defaults.
 */
function resolveDispatchFunctions(
  config?: EventsConfig,
): Record<string, { import: string; cancelable: boolean }> {
  if (!config) return DEFAULT_DISPATCH_FUNCTIONS;
  // When config provides an empty map, fall back to defaults (backwards compat)
  if (Object.keys(config.dispatchFunctions).length === 0) return DEFAULT_DISPATCH_FUNCTIONS;
  return config.dispatchFunctions;
}

/**
 * Build the replacement string for a helper-mode dispatch call.
 * e.g. `funcName(this, 'eventName'`
 */
function helperReplacement(funcName: string, eventName: string): string {
  return `${funcName}(this, '${eventName}'`;
}

/**
 * Get the name of the "default non-cancelable" dispatch function.
 * Used for direct callback invocations (propName?.(detail)).
 */
function getDefaultNonCancelableName(
  config: EventsConfig | undefined,
  dispatchFunctions: Record<string, { import: string; cancelable: boolean }>,
): string {
  if (!config) return 'fireNonCancelableEvent';
  // Find the first non-cancelable function from the registry
  for (const [name, cfg] of Object.entries(dispatchFunctions)) {
    if (!cfg.cancelable) return name;
  }
  // Fallback: use the first function
  const firstName = Object.keys(dispatchFunctions)[0];
  return firstName ?? 'fireNonCancelableEvent';
}

// ---------------------------------------------------------------------------
// Text rewriting
// ---------------------------------------------------------------------------

function rewriteEventCalls(
  text: string,
  eventProps: Map<string, string>,
  config?: EventsConfig,
): string {
  const isNative = config?.dispatchMode === 'native';
  const dispatchFunctions = resolveDispatchFunctions(config);

  let result = text;

  for (const [propName, eventName] of eventProps) {
    // --- Dispatch function patterns (fireNonCancelableEvent, fireCancelableEvent, etc.) ---
    for (const [funcName, funcConfig] of Object.entries(dispatchFunctions)) {
      // funcName(propName, ...) or funcName(props.propName, ...)
      const pattern = new RegExp(
        `${escapeRegex(funcName)}\\(\\s*(?:props\\.)?${escapeRegex(propName)}\\b`,
        'g',
      );

      if (isNative) {
        result = rewriteToNative(result, pattern, eventName, funcConfig.cancelable);
      } else {
        // For the default (no-config) case, fireKeyboardEvent is rewritten
        // to fireNonCancelableEvent.
        const outputName = (!config && funcName === 'fireKeyboardEvent')
          ? 'fireNonCancelableEvent'
          : funcName;
        result = result.replace(pattern, helperReplacement(outputName, eventName));
      }

      // --- Handle controlledOnXxx prefix variant ---
      const controlledName = 'controlled' + propName.charAt(0).toUpperCase() + propName.slice(1);
      const controlledPattern = new RegExp(
        `${escapeRegex(funcName)}\\(\\s*${escapeRegex(controlledName)}\\b`,
        'g',
      );
      if (isNative) {
        result = rewriteToNative(result, controlledPattern, eventName, funcConfig.cancelable);
      } else {
        const outputName = (!config && funcName === 'fireKeyboardEvent')
          ? 'fireNonCancelableEvent'
          : funcName;
        result = result.replace(controlledPattern, helperReplacement(outputName, eventName));
      }
    }

    // --- Direct callback invocations ---

    // Direct callback invocation: propName?.(detail) or props.propName?.(detail)
    const directCallOptional = new RegExp(
      `(?:props\\.)?${escapeRegex(propName)}\\?\\.\\(`,
      'g',
    );
    if (isNative) {
      result = rewriteDirectToNative(result, directCallOptional, eventName, false);
    } else {
      const defaultNonCancelable = getDefaultNonCancelableName(config, dispatchFunctions);
      result = result.replace(
        directCallOptional,
        `${defaultNonCancelable}(this, '${eventName}', `,
      );
    }

    // Direct callback invocation (non-optional): propName(detail) or props.propName(detail)
    // Only match when NOT preceded by '.', a word char, or a quote
    const directCall = new RegExp(
      `(?<![.\\w'"])${escapeRegex(propName)}\\(`,
      'g',
    );
    if (isNative) {
      result = rewriteDirectToNative(result, directCall, eventName, false);
    } else {
      const defaultNonCancelable = getDefaultNonCancelableName(config, dispatchFunctions);
      result = result.replace(
        directCall,
        `${defaultNonCancelable}(this, '${eventName}', `,
      );
    }
    // props.propName(detail) variant
    const directCallProps = new RegExp(
      `props\\.${escapeRegex(propName)}\\(`,
      'g',
    );
    if (isNative) {
      result = rewriteDirectToNative(result, directCallProps, eventName, false);
    } else {
      const defaultNonCancelable = getDefaultNonCancelableName(config, dispatchFunctions);
      result = result.replace(
        directCallProps,
        `${defaultNonCancelable}(this, '${eventName}', `,
      );
    }

    // --- Handle controlledOnXxx prefix variants for direct calls ---
    const controlledName = 'controlled' + propName.charAt(0).toUpperCase() + propName.slice(1);

    // controlledOnXxx?.(detail)
    const controlledOptional = new RegExp(
      `${escapeRegex(controlledName)}\\?\\.\\(`,
      'g',
    );
    if (isNative) {
      result = rewriteDirectToNative(result, controlledOptional, eventName, false);
    } else {
      const defaultNonCancelable = getDefaultNonCancelableName(config, dispatchFunctions);
      result = result.replace(
        controlledOptional,
        `${defaultNonCancelable}(this, '${eventName}', `,
      );
    }

    // controlledOnXxx(detail)
    const controlledDirect = new RegExp(
      `(?<![.\\w'"])${escapeRegex(controlledName)}\\(`,
      'g',
    );
    if (isNative) {
      result = rewriteDirectToNative(result, controlledDirect, eventName, false);
    } else {
      const defaultNonCancelable = getDefaultNonCancelableName(config, dispatchFunctions);
      result = result.replace(
        controlledDirect,
        `${defaultNonCancelable}(this, '${eventName}', `,
      );
    }
  }

  // Catch-all: fire*Event(expr.onXxx, ...) where onXxx was not matched
  // by per-prop patterns above. Handles nested event callbacks in compound
  // props, e.g., fireCancelableEvent(identity.onFollow, {}, event).
  // The event name is derived from the onXxx callback name using the
  // standard React event naming convention (onFollow → follow).
  result = result.replace(
    /\bfire(NonCancelable|Cancelable|Keyboard)Event\(\s*[\w.]+\.(on[A-Z]\w*)\b/g,
    (_match, type: string, callbackName: string) => {
      const eventName = toCustomEventName(callbackName);
      const funcName = type === 'Keyboard' ? 'fireNonCancelableEvent' : `fire${type}Event`;
      return `${funcName}(this, '${eventName}'`;
    },
  );

  return result;
}

// ---------------------------------------------------------------------------
// Native dispatch rewriting helpers
// ---------------------------------------------------------------------------

/**
 * Rewrite `funcName(propName, detail, ...)` → `this.dispatchEvent(new CustomEvent(...))`
 *
 * Replaces the opening of the call (matched by `pattern`) and captures
 * everything up to the balanced closing paren, then rewrites into native form.
 */
function rewriteToNative(
  text: string,
  pattern: RegExp,
  eventName: string,
  cancelable: boolean,
): string {
  const marker = `__NATIVE_DISPATCH_${eventName}_${cancelable ? 'C' : 'NC'}__`;
  let result = text.replace(pattern, marker);

  // Now find each marker and rewrite: marker, arg1, arg2)  →  native dispatch
  // The marker replaced `funcName(propName` so what follows is `, detail, event)`
  // or just `)` (no additional args)
  while (result.includes(marker)) {
    const idx = result.indexOf(marker);
    const afterMarker = idx + marker.length;
    // Find the balanced closing paren
    const closeIdx = findBalancedClose(result, afterMarker);
    if (closeIdx === -1) break; // malformed, bail

    // Extract the remaining args between marker and closing paren
    const argsStr = result.substring(afterMarker, closeIdx).trim();

    // Parse remaining args: could be empty, or ", detail" or ", detail, event"
    let detail: string;
    if (argsStr === '') {
      detail = '{}';
    } else {
      // Strip leading comma
      const stripped = argsStr.replace(/^,\s*/, '');
      if (stripped === '') {
        detail = '{}';
      } else {
        // Split on top-level commas to separate detail from event arg
        const parts = splitTopLevelCommas(stripped);
        detail = parts[0]?.trim() || '{}';
      }
    }

    const opts = cancelable
      ? `{ detail: ${detail}, bubbles: true, composed: true, cancelable: true }`
      : `{ detail: ${detail}, bubbles: true, composed: true }`;
    const replacement = `this.dispatchEvent(new CustomEvent('${eventName}', ${opts})`;

    result = result.substring(0, idx) + replacement + result.substring(closeIdx);
  }

  return result;
}

/**
 * Rewrite direct callback invocation to native dispatch.
 * `propName?.(detail)` or `propName(detail)` → `this.dispatchEvent(new CustomEvent(...))`
 */
function rewriteDirectToNative(
  text: string,
  pattern: RegExp,
  eventName: string,
  cancelable: boolean,
): string {
  const marker = `__NATIVE_DIRECT_${eventName}__`;
  let result = text.replace(pattern, `${marker}(`);

  while (result.includes(marker)) {
    const idx = result.indexOf(marker);
    const parenStart = idx + marker.length; // points to '('
    const closeIdx = findBalancedClose(result, parenStart + 1);
    if (closeIdx === -1) break;

    const argsStr = result.substring(parenStart + 1, closeIdx).trim();
    const detail = argsStr || '{}';

    const opts = cancelable
      ? `{ detail: ${detail}, bubbles: true, composed: true, cancelable: true }`
      : `{ detail: ${detail}, bubbles: true, composed: true }`;
    const replacement = `this.dispatchEvent(new CustomEvent('${eventName}', ${opts})`;

    result = result.substring(0, idx) + replacement + result.substring(closeIdx);
  }

  return result;
}

/**
 * Find the index of the balanced closing paren starting from `start`.
 * `start` should point to the character after the opening paren.
 */
function findBalancedClose(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    // Skip string literals
    else if (ch === "'" || ch === '"' || ch === '`') {
      const end = findStringEnd(text, i);
      if (end === -1) return -1;
      i = end;
    }
  }
  return -1;
}

/**
 * Find the end of a string literal starting at `start` (which points to the
 * opening quote character).
 */
function findStringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i;
  }
  return -1;
}

/**
 * Split a string on top-level commas (not inside parens/brackets/braces).
 */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const end = findStringEnd(text, i);
      if (end !== -1) {
        current += text.substring(i, end + 1);
        i = end;
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------
// Template expression rewriting
// ---------------------------------------------------------------------------

function rewriteTemplateEvents(
  node: TemplateNodeIR,
  eventProps: Map<string, string>,
  config?: EventsConfig,
): TemplateNodeIR {
  return walkTemplate(node, {
    attributeExpression: (expr) => {
      const rewritten = rewriteEventCalls(expr, eventProps, config);
      return rewritten !== expr ? rewritten : undefined;
    },
    expression: (expr) => {
      const rewritten = rewriteEventCalls(expr, eventProps, config);
      return rewritten !== expr ? rewritten : undefined;
    },
    conditionExpression: (expr) => {
      const rewritten = rewriteEventCalls(expr, eventProps, config);
      return rewritten !== expr ? rewritten : undefined;
    },
  });
}
