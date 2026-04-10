/**
 * clsx → classMap transform.
 *
 * Converts clsx() call expressions in className attributes into
 * classMap()-compatible objects, stripping the styles.xxx indirection.
 *
 * Input:  clsx(styles.root, styles[`size-${size}`], { [styles.disabled]: isDisabled })
 * Output: { 'root': true, [`size-${this.size}`]: true, 'disabled': this.isDisabled }
 */
import type { TemplateNodeIR, AttributeIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Transform className attributes in the template tree,
 * converting clsx expressions to classMap-compatible expressions.
 */
export function transformClsx(node: TemplateNodeIR): TemplateNodeIR {
  const transformedAttrs = node.attributes.map((attr) => {
    if (attr.kind === 'classMap' && typeof attr.value !== 'string') {
      return transformClassAttribute(attr);
    }
    // Also handle any attribute expression containing clsx()
    if (typeof attr.value !== 'string' && attr.value.expression.includes('clsx(')) {
      return transformClassAttribute({ ...attr, kind: 'classMap' });
    }
    // Transform className → class for any remaining className attributes
    if (attr.name === 'className') {
      return { ...attr, name: 'class', kind: attr.kind === 'classMap' ? 'classMap' as const : attr.kind };
    }
    return attr;
  });

  const transformedChildren = node.children.map(transformClsx);

  return {
    ...node,
    attributes: transformedAttrs,
    children: transformedChildren,
    condition: node.condition
      ? {
          ...node.condition,
          alternate: node.condition.alternate
            ? transformClsx(node.condition.alternate)
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
        const className = stripStylesPrefix(parts[1].trim());
        entries.push(`${quoteClassName(className)}: ${condition}`);
        continue;
      }
    }

    // Static class: styles.root or styles['class-name']
    if (trimmed.startsWith('styles')) {
      const className = stripStylesPrefix(trimmed);
      entries.push(`${quoteClassName(className)}: true`);
      continue;
    }

    // Template literal in styles: styles[`variant-${variant}`]
    if (trimmed.includes('styles[')) {
      const className = stripStylesPrefix(trimmed);
      if (className.includes('${')) {
        entries.push(`[\`${className}\`]: true`);
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
    return `'${className}': ${value}`;
  }

  return `${key}: ${value}`;
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
