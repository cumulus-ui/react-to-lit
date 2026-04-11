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
    ...ir,
    // Template tree — existing attribute-level conversion
    template: transformClsxInTemplate(ir.template),
    // Handler bodies
    handlers: ir.handlers.map((h) => ({
      ...h,
      body: replaceClsxAndStylesInText(h.body),
    })),
    // Effect bodies and cleanup
    effects: ir.effects.map((e) => ({
      ...e,
      body: replaceClsxAndStylesInText(e.body),
      cleanup: e.cleanup ? replaceClsxAndStylesInText(e.cleanup) : e.cleanup,
    })),
    // Helper function sources
    helpers: ir.helpers.map((h) => ({
      ...h,
      source: replaceClsxAndStylesInText(h.source),
    })),
    // Body preamble statements
    bodyPreamble: ir.bodyPreamble.map(replaceClsxAndStylesInText),
    // Public method bodies
    publicMethods: ir.publicMethods.map((m) => ({
      ...m,
      body: replaceClsxAndStylesInText(m.body),
    })),
    // Computed value expressions
    computedValues: ir.computedValues.map((c) => ({
      ...c,
      expression: replaceClsxAndStylesInText(c.expression),
    })),
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
  const transformedAttrs = node.attributes.map((attr) => {
    if (attr.kind === 'classMap' && typeof attr.value !== 'string') {
      return transformClassAttribute(attr);
    }
    if (typeof attr.value !== 'string' && attr.value.expression.includes('clsx(')) {
      return transformClassAttribute({ ...attr, kind: 'classMap' });
    }
    if (attr.name === 'className') {
      return { ...attr, name: 'class', kind: attr.kind === 'classMap' ? 'classMap' as const : attr.kind };
    }
    return attr;
  });

  const transformedChildren = node.children.map(transformClsxInTemplate);

  const transformedExpression = node.expression
    ? replaceClsxAndStylesInText(node.expression)
    : node.expression;

  return {
    ...node,
    expression: transformedExpression,
    attributes: transformedAttrs,
    children: transformedChildren,
    condition: node.condition
      ? {
          ...node.condition,
          alternate: node.condition.alternate
            ? transformClsxInTemplate(node.condition.alternate)
            : undefined,
        }
      : undefined,
  };
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
  const args = splitTopLevel(argsStr);

  for (const arg of args) {
    const trimmed = arg.trim();
    if (!trimmed) continue;

    // Object literal: { [styles.disabled]: isDisabled }
    if (trimmed.startsWith('{')) {
      const inner = trimmed.slice(1, -1).trim();
      const pairs = splitTopLevel(inner);
      for (const pair of pairs) {
        const entry = parseObjectEntry(pair.trim());
        if (entry) entries.push(entry);
      }
      continue;
    }

    // Conditional: condition && styles.className
    if (trimmed.includes(' && ')) {
      const parts = trimmed.split(' && ');
      if (parts.length === 2) {
        const condition = parts[0].trim();
        const rawClass = parts[1].trim();
        const className = stripStylesPrefix(rawClass);
        if (className === rawClass && rawClass.startsWith('styles[')) {
          const varExpr = rawClass.slice(7, -1);
          entries.push(`[${varExpr}]: ${condition}`);
        } else {
          entries.push(`${quoteClassName(className)}: ${condition}`);
        }
        continue;
      }
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

    // Unknown pattern — pass through as comment
    entries.push(`/* ${trimmed} */`);
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
  const colonIdx = findTopLevelColon(entry);
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
    const closeIdx = findMatchingParen(result, argsStart - 1);
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

  return result;
}

/**
 * Find the index of the closing paren that matches the open paren at `openIdx`.
 */
function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    // Skip string literals
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++; // skip escaped chars
        i++;
      }
    }
    // Skip template literals
    if (ch === '`') {
      i++;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') i++;
        if (text[i] === '$' && i + 1 < text.length && text[i + 1] === '{') {
          // Skip template expression — count braces
          i += 2;
          let braceDepth = 1;
          while (i < text.length && braceDepth > 0) {
            if (text[i] === '{') braceDepth++;
            if (text[i] === '}') braceDepth--;
            if (braceDepth > 0) i++;
          }
        }
        i++;
      }
    }
  }
  return -1;
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

/**
 * Split a string by commas, but only at the top level
 * (not inside braces, brackets, or parentheses).
 */
function splitTopLevel(str: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) result.push(current);
  return result;
}

/**
 * Find the first colon at the top level (not inside brackets/braces).
 */
function findTopLevelColon(str: string): number {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{' || ch === '[' || ch === '(' || ch === '`') depth++;
    if (ch === '}' || ch === ']' || ch === ')' || (ch === '`' && depth > 0)) depth--;
    if (ch === ':' && depth === 0) return i;
  }
  return -1;
}
