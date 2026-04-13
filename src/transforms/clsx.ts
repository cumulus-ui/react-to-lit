/**
 * clsx → classMap transform.
 *
 * Converts clsx() call expressions in className attributes into
 * classMap()-compatible objects, stripping the styles.xxx indirection.
 *
 * Input:  clsx(styles.root, styles[`size-${size}`], { [styles.disabled]: isDisabled })
 * Output: { 'root': true, [`size-${this.size}`]: true, 'disabled': this.isDisabled }
 *
 * Processes BOTH template attributes AND all IR text fields (handler bodies,
 * effect bodies, helpers, bodyPreamble, publicMethods, computed expressions).
 */
import type { ComponentIR, TemplateNodeIR, AttributeIR } from '../ir/types.js';
import { mapIRText } from '../ir/transform-helpers.js';
import { walkTemplate } from '../template-walker.js';
import { findMatchingParen, findTopLevel, splitTopLevel } from '../text-utils.js';

// ---------------------------------------------------------------------------
// Main transform — accepts full ComponentIR
// ---------------------------------------------------------------------------

/**
 * Transform clsx expressions and styles.xxx references across the entire IR.
 *
 * 1. Template attributes: clsx → classMap object (existing behavior)
 * 2. All IR text fields: clsx() calls → classMap() calls, styles.xxx → 'xxx'
 */
export function transformClsx(ir: ComponentIR): ComponentIR {
  return {
    ...mapIRText(ir, replaceClsxAndStylesInText),
    // Template tree — existing attribute-level conversion
    template: transformClsxInTemplate(ir.template),
  };
}

// ---------------------------------------------------------------------------
// Template tree transform (existing behavior, renamed)
// ---------------------------------------------------------------------------

/**
 * Transform className attributes in the template tree,
 * converting clsx expressions to classMap-compatible expressions.
 */
function transformClsxInTemplate(node: TemplateNodeIR): TemplateNodeIR {
  return walkTemplate(node, {
    attribute: (attr) => {
      if (attr.kind === 'classMap' && typeof attr.value !== 'string') {
        // If the classMap expression is just a styles.xxx reference,
        // convert to a plain class attribute with the stripped class name.
        const expr = attr.value.expression.trim();
        if (/^styles[.[']/.test(expr) && !expr.includes(',') && !expr.includes('{')) {
          const className = replaceStylesInText(expr);
          // Strip JS string quotes — static HTML attributes don't need them
          const bare = className.replace(/^['"`]|['"`]$/g, '');
          return { ...attr, name: 'class', kind: 'static' as const, value: bare };
        }
        return transformClassAttribute(attr);
      }
      if (typeof attr.value !== 'string' && attr.value.expression.includes('clsx(')) {
        return transformClassAttribute({ ...attr, kind: 'classMap' });
      }
      if (attr.name === 'className') {
        return { ...attr, name: 'class', kind: attr.kind === 'classMap' ? 'classMap' as const : attr.kind };
      }
      return undefined; // keep as-is
    },
    attributeExpression: (expr) => {
      const replaced = replaceClsxAndStylesInText(expr);
      return replaced !== expr ? replaced : undefined;
    },
    expression: (expr) => {
      const replaced = replaceClsxAndStylesInText(expr);
      return replaced !== expr ? replaced : undefined;
    },
  });
}

// ---------------------------------------------------------------------------
// Class attribute transform
// ---------------------------------------------------------------------------

function transformClassAttribute(attr: AttributeIR): AttributeIR {
  const expr = typeof attr.value === 'string' ? attr.value : attr.value.expression;

  // Try to parse and convert clsx expression
  const converted = convertClsxToClassMap(expr);

  return {
    ...attr,
    name: 'class',
    value: { expression: converted },
  };
}

/**
 * Convert a clsx/className expression to a classMap-compatible string.
 *
 * This does textual transformations rather than full AST parsing,
 * which handles the common Cloudscape patterns.
 */
function convertClsxToClassMap(expr: string): string {
  // If it's already a simple styles.xxx reference (not clsx), convert directly
  if (expr.startsWith('styles.') && !expr.includes(',') && !expr.includes('(')) {
    const className = stripStylesPrefix(expr);
    return `{ '${className}': true }`;
  }

  // If it's a clsx() call, parse the arguments
  const clsxMatch = expr.match(/^clsx\(([\s\S]*)\)$/);
  if (!clsxMatch) {
    // Not a recognized pattern — return as-is
    return expr;
  }

  const argsStr = clsxMatch[1];
  return parseClsxArgs(argsStr);
}

/**
 * Parse clsx arguments and produce a classMap object literal.
 */
function parseClsxArgs(argsStr: string): string {
  const entries: string[] = [];

  // Split top-level arguments (not inside braces or parens)
  const args = splitTopLevel(argsStr, ',');

  for (const arg of args) {
    const trimmed = arg.trim();
    if (!trimmed) continue;

    // Object literal: { [styles.disabled]: isDisabled }
    if (trimmed.startsWith('{')) {
      const inner = trimmed.slice(1, -1).trim();
      const pairs = splitTopLevel(inner, ',');
      for (const pair of pairs) {
        const entry = parseObjectEntry(pair.trim());
        if (entry) entries.push(entry);
      }
      continue;
    }

    // Conditional: condition && styles.className (or ternary/array variants)
    if (trimmed.includes(' && ')) {
      // Split on first ' && ' only (condition may contain && but class part won't)
      const andIdx = trimmed.indexOf(' && ');
      const condition = trimmed.slice(0, andIdx).trim();
      const rawClass = trimmed.slice(andIdx + 4).trim();

      // Array-wrapped class: condition && [styles['xxx']] or [styles[`xxx`]]
      if (rawClass.startsWith('[') && rawClass.endsWith(']') && rawClass.includes('styles')) {
        const inner = rawClass.slice(1, -1).trim();
        const className = stripStylesPrefix(inner);
        if (className.includes('${')) {
          entries.push(`[\`${className}\`]: ${condition}`);
        } else if (className !== inner) {
          entries.push(`'${className}': ${condition}`);
        } else {
          // Unrecognized array-wrapped pattern — skip
        }
        continue;
      }

      // Ternary: condition && (expr ? styles['a'] : styles['b'])
      if (rawClass.startsWith('(') && rawClass.endsWith(')')) {
        const inner = rawClass.slice(1, -1).trim();
        const ternaryMatch = inner.match(/^(.+?)\s*\?\s*(styles[\[.][^\s:]+)\s*:\s*(styles[\[.][^\s)]+)$/);
        if (ternaryMatch) {
          const [, ternCond, styleA, styleB] = ternaryMatch;
          const classA = stripStylesPrefix(styleA.trim());
          const classB = stripStylesPrefix(styleB.trim());
          // Emit as: condition && ternCond → classA, condition && !ternCond → classB
          entries.push(`'${classA}': ${condition} && ${ternCond.trim()}`);
          entries.push(`'${classB}': ${condition} && !(${ternCond.trim()})`);
          continue;
        }
      }

      // Simple: condition && styles.xxx
      const className = stripStylesPrefix(rawClass);
      if (className !== rawClass) {
        entries.push(`${quoteClassName(className)}: ${condition}`);
        continue;
      }
      if (rawClass.startsWith('styles[')) {
        const varExpr = rawClass.slice(7, -1);
        entries.push(`[${varExpr}]: ${condition}`);
        continue;
      }
      // Fallback for unrecognized && patterns — skip
      continue;
    }

    // Static class: styles.root or styles['class-name']
    if (trimmed.startsWith('styles.')) {
      const className = stripStylesPrefix(trimmed);
      entries.push(`${quoteClassName(className)}: true`);
      continue;
    }

    // Bracket access: styles[`variant-${v}`], styles['name'], styles[variable]
    if (trimmed.startsWith('styles[')) {
      const className = stripStylesPrefix(trimmed);
      if (className.includes('${')) {
        entries.push(`[\`${className}\`]: true`);
      } else if (className === trimmed) {
        // stripStylesPrefix returned unchanged → dynamic variable like styles[size]
        const varExpr = trimmed.slice(7, -1); // extract between styles[ and ]
        entries.push(`[${varExpr}]: true`);
      } else {
        entries.push(`'${className}': true`);
      }
      continue;
    }

    // Variable reference (e.g., baseProps.className) — skip Cloudscape internal
    if (trimmed.includes('baseProps') || trimmed.includes('props.className')) {
      continue;
    }

    // Unknown pattern — skip rather than emit broken syntax
    continue;
  }

  if (entries.length === 0) {
    return '{}';
  }

  return `{ ${entries.join(', ')} }`;
}

/**
 * Parse a single key-value pair from an object literal inside clsx.
 * E.g.: [styles.disabled]: isNotInteractive
 */
function parseObjectEntry(entry: string): string | null {
  const colonIdx = findTopLevel(entry, ':');
  if (colonIdx === -1) return null;

  const key = entry.slice(0, colonIdx).trim();
  const value = entry.slice(colonIdx + 1).trim();

  // Key: [styles.disabled] or [styles['button-no-wrap']]
  if (key.startsWith('[') && key.endsWith(']')) {
    const inner = key.slice(1, -1).trim();
    const className = stripStylesPrefix(inner);
    if (className.includes('${')) {
      return `[\`${className}\`]: ${value}`;
    }
    if (className === inner && inner.startsWith('styles[')) {
      const varExpr = inner.slice(7, -1);
      return `[${varExpr}]: ${value}`;
    }
    return `'${className}': ${value}`;
  }

  return `${key}: ${value}`;
}

// ---------------------------------------------------------------------------
// Text-level clsx() and styles.xxx replacement
// ---------------------------------------------------------------------------

/**
 * Replace clsx() calls and styles.xxx references in arbitrary text.
 *
 * For code bodies (handlers, effects, helpers, etc.):
 * - `clsx(styles.root, ...)` → `classMap({ 'root': true, ... })`
 * - `styles.root` → `'root'`
 * - `styles['button-disabled']` → `'button-disabled'`
 * - `styles[\`variant-${v}\`]` → `` `variant-${v}` ``
 */
function replaceClsxAndStylesInText(text: string): string {
  let result = text;

  // 1. Replace clsx(...) calls with classMap({...})
  result = replaceClsxCallsInText(result);

  // 2. Replace styles.xxx references
  result = replaceStylesInText(result);

  return result;
}

/**
 * Find and replace clsx(...) calls in text with classMap({...}).
 *
 * Uses balanced-paren matching to find the full clsx() call,
 * then converts the arguments to a classMap object.
 */
function replaceClsxCallsInText(text: string): string {
  let result = text;
  let searchFrom = 0;

  while (true) {
    const idx = result.indexOf('clsx(', searchFrom);
    if (idx === -1) break;

    // Find the matching closing paren
    const argsStart = idx + 5; // after 'clsx('
    const closeIdx = findMatchingParen(result, argsStart - 1, { allBrackets: true });
    if (closeIdx === -1) {
      // Can't find matching paren — skip this occurrence
      searchFrom = argsStart;
      continue;
    }

    const argsStr = result.slice(argsStart, closeIdx);
    const classMapObj = parseClsxArgs(argsStr);
    const replacement = `classMap(${classMapObj})`;

    result = result.slice(0, idx) + replacement + result.slice(closeIdx + 1);
    searchFrom = idx + replacement.length;
  }

  return result;
}

/**
 * Replace styles.xxx / styles['xxx'] / styles[`xxx`] references in text.
 *
 * Shadow DOM doesn't need CSS module scoping, so:
 * - styles.root → 'root'
 * - styles['button-disabled'] → 'button-disabled'
 * - styles[`variant-${v}`] → `variant-${v}`
 */
function replaceStylesInText(text: string): string {
  let result = text;

  // styles[`template-${expr}`] → `template-${expr}` (must come before styles.xxx)
  result = result.replace(/\bstyles\[(`[^`]+`)\]/g, '$1');

  // styles['class-name'] → 'class-name'
  result = result.replace(/\bstyles\['([^']+)'\]/g, "'$1'");

  result = result.replace(/\bstyles\["([^"]+)"\]/g, "'$1'");

  result = result.replace(/\bstyles\.(\w+)\b/g, "'$1'");

  // classMap('string') → 'string' — degenerate classMap with a single string arg
  // (happens when styles.xxx was the sole classMap argument)
  result = result.replace(/classMap\(('[^']+')\)/g, '$1');
  result = result.replace(/classMap\((`[^`]+`)\)/g, '$1');

  // class=${'literal'} → class="literal" — static string in dynamic binding is redundant
  result = result.replace(/\bclass=\$\{'([^']*)'\}/g, 'class="$1"');

  return result;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Quote a class name correctly: use backticks if it contains ${}, single quotes otherwise.
 */
function quoteClassName(name: string): string {
  if (name.includes('${')) {
    return `[\`${name}\`]`;
  }
  return `'${name}'`;
}

/**
 * Strip styles.xxx or styles['xxx'] or styles[`xxx`] prefix.
 */
function stripStylesPrefix(expr: string): string {
  // styles.root → root
  const dotMatch = expr.match(/^styles\.(\w+)$/);
  if (dotMatch) return dotMatch[1];

  // styles['class-name'] → class-name
  const bracketStringMatch = expr.match(/^styles\['([^']+)'\]$/);
  if (bracketStringMatch) return bracketStringMatch[1];

  // styles["class-name"] → class-name
  const bracketDoubleMatch = expr.match(/^styles\["([^"]+)"\]$/);
  if (bracketDoubleMatch) return bracketDoubleMatch[1];

  // styles[`variant-${variant}`] → variant-${variant}
  const templateMatch = expr.match(/^styles\[`([^`]+)`\]$/);
  if (templateMatch) return templateMatch[1];

  // Fallback: return as-is
  return expr;
}

