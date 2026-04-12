/**
 * Shared text-level parsing utilities.
 *
 * Robust string scanning that correctly handles quoted strings and
 * template literals with `${...}` interpolation. Used by transforms,
 * emitter, and anywhere that needs balanced-delimiter matching on
 * source text.
 */

// ---------------------------------------------------------------------------
// Balanced paren matching
// ---------------------------------------------------------------------------

export interface FindMatchingParenOptions {
  /** Track all bracket types `(){}[]` rather than just `()`. Default: false. */
  allBrackets?: boolean;
}

/**
 * Find the closing paren/bracket that matches the open delimiter at `openPos`.
 * Correctly skips quoted strings (`'`, `"`) and template literals (`` ` ``
 * with `${...}` interpolation).
 *
 * @param allBrackets - When true, tracks `()`, `{}`, and `[]` together.
 *   When false (default), only tracks `()`.
 * @returns The index of the closing delimiter, or -1 if not found.
 */
export function findMatchingParen(
  text: string,
  openPos: number,
  options: FindMatchingParenOptions = {},
): number {
  const allBrackets = options.allBrackets ?? false;
  let depth = 0;
  let i = openPos;

  while (i < text.length) {
    const ch = text[i];

    // Template literals — track `${...}` interpolation
    if (ch === '`') {
      i++;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '$' && i + 1 < text.length && text[i + 1] === '{') {
          // Recurse into interpolation to find its closing `}`
          i += 2;
          let braceDepth = 1;
          while (i < text.length && braceDepth > 0) {
            if (text[i] === '{') braceDepth++;
            else if (text[i] === '}') braceDepth--;
            if (braceDepth > 0) i++;
          }
        }
        i++;
      }
      i++; // skip closing backtick
      continue;
    }

    // Single/double quoted strings
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) break;
        i++;
      }
      i++; // skip closing quote
      continue;
    }

    // Depth tracking
    if (allBrackets) {
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return i;
      }
    } else {
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i; }
    }

    i++;
  }

  return -1;
}

// ---------------------------------------------------------------------------
// Top-level scanning
// ---------------------------------------------------------------------------

/**
 * Find the first occurrence of `target` char at the top level — not inside
 * brackets, parens, braces, strings, or template literals.
 *
 * @returns The index of the target char, or -1 if not found.
 */
export function findTopLevel(str: string, target: string): number {
  let depth = 0;
  let inTemplate = false;
  let templateBraceDepth = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (ch === '`') {
      inTemplate = !inTemplate;
      continue;
    }
    if (inTemplate) {
      if (ch === '$' && str[i + 1] === '{') {
        templateBraceDepth++;
        i++;
      } else if (ch === '}' && templateBraceDepth > 0) {
        templateBraceDepth--;
      }
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === target && depth === 0) return i;
  }

  return -1;
}

/**
 * Split a string by `separator` char, but only at the top level — not inside
 * brackets, parens, braces, strings, or template literals.
 */
export function splitTopLevel(str: string, separator: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inTemplate = false;
  let templateBraceDepth = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (ch === '`') {
      inTemplate = !inTemplate;
      current += ch;
      continue;
    }
    if (inTemplate) {
      if (ch === '$' && str[i + 1] === '{') {
        templateBraceDepth++;
        current += ch + '{';
        i++;
      } else if (ch === '}' && templateBraceDepth > 0) {
        templateBraceDepth--;
        current += ch;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === separator && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) result.push(current);
  return result;
}

// ---------------------------------------------------------------------------
// Code stripping utilities
// ---------------------------------------------------------------------------

/**
 * Strip all calls to a named function from source text, handling
 * multi-line calls and nested parens via balanced matching.
 */
export function stripFunctionCalls(text: string, funcName: string): string {
  let result = text;
  for (let safety = 0; safety < 50; safety++) {
    const idx = result.indexOf(funcName + '(');
    if (idx === -1) break;
    const openParen = idx + funcName.length;
    const closeParen = findMatchingParen(result, openParen);
    if (closeParen === -1) break;
    let end = closeParen + 1;
    while (end < result.length && (result[end] === ' ' || result[end] === '\t')) end++;
    if (end < result.length && result[end] === ';') end++;
    if (end < result.length && result[end] === '\n') end++;
    result = result.slice(0, idx) + result.slice(end);
  }
  return result;
}

/**
 * Strip if-blocks matching a condition pattern, using balanced brace matching.
 */
export function stripIfBlocks(text: string, conditionPattern: RegExp): string {
  let result = text;
  for (let safety = 0; safety < 50; safety++) {
    const m = conditionPattern.exec(result);
    if (!m) break;
    let braceStart = m.index + m[0].length;
    while (braceStart < result.length && result[braceStart] !== '{') braceStart++;
    if (braceStart >= result.length) break;
    const braceEnd = findMatchingParen(result, braceStart, { allBrackets: true });
    if (braceEnd === -1) break;
    let end = braceEnd + 1;
    if (end < result.length && result[end] === '\n') end++;
    result = result.slice(0, m.index) + result.slice(end);
  }
  return result;
}
