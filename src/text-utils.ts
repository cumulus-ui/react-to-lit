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
 * Scan a string character-by-character, tracking bracket depth and template
 * literal interpolations. Invokes `onChar(ch, i, depth, inTemplate)` for
 * every character, indicating whether it is inside a template literal.
 *
 * Return `true` from the callback to stop scanning early; the scanner
 * will then return the current index. Returns -1 if the end of string is
 * reached without an early stop.
 */
function scanTopLevel(
  str: string,
  onChar: (ch: string, i: number, depth: number, inTemplate: boolean) => boolean | void,
): number {
  let depth = 0;
  let inTemplate = false;
  let templateBraceDepth = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (ch === '`') {
      inTemplate = !inTemplate;
      if (onChar(ch, i, depth, /* still toggling */ inTemplate)) return i;
      continue;
    }
    if (inTemplate) {
      if (ch === '$' && str[i + 1] === '{') {
        templateBraceDepth++;
        if (onChar(ch, i, depth, true)) return i;
        i++;
        if (onChar('{', i, depth, true)) return i;
      } else if (ch === '}' && templateBraceDepth > 0) {
        templateBraceDepth--;
        if (onChar(ch, i, depth, true)) return i;
      } else {
        if (onChar(ch, i, depth, true)) return i;
      }
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (onChar(ch, i, depth, false)) return i;
  }

  return -1;
}

/**
 * Find the first occurrence of `target` char at the top level — not inside
 * brackets, parens, braces, strings, or template literals.
 *
 * @returns The index of the target char, or -1 if not found.
 */
export function findTopLevel(str: string, target: string): number {
  return scanTopLevel(str, (ch, _i, depth, inTemplate) =>
    !inTemplate && ch === target && depth === 0,
  );
}

/**
 * Split a string by `separator` char, but only at the top level — not inside
 * brackets, parens, braces, strings, or template literals.
 */
export function splitTopLevel(str: string, separator: string): string[] {
  const result: string[] = [];
  let current = '';

  scanTopLevel(str, (ch, _i, depth, inTemplate) => {
    if (!inTemplate && ch === separator && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  });

  if (current.trim()) result.push(current);
  return result;
}

// ---------------------------------------------------------------------------
// Template detection
// ---------------------------------------------------------------------------

/**
 * Check if source text contains a Lit html tagged template literal.
 * Handles both `html\`` and `html \`` (with a space before the backtick).
 */
export function containsHtmlTemplate(source: string): boolean {
  return source.includes('html`') || source.includes('html `');
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

export function replaceFunctionCalls(text: string, funcName: string, replacement: string): string {
  let result = text;
  for (let safety = 0; safety < 50; safety++) {
    const idx = result.indexOf(funcName + '(');
    if (idx === -1) break;
    const openParen = idx + funcName.length;
    const closeParen = findMatchingParen(result, openParen);
    if (closeParen === -1) break;
    result = result.slice(0, idx) + replacement + result.slice(closeParen + 1);
  }
  return result;
}

/**
 * Unwrap a function call to its first argument:
 *   `funcName(firstArg, rest...)` → `firstArg`
 *
 * Uses balanced paren/bracket/quote matching so nested calls,
 * template literals, and strings inside the first argument are
 * handled correctly.
 */
export function unwrapFunctionCall(text: string, funcName: string): string {
  let result = text;
  for (let safety = 0; safety < 50; safety++) {
    const idx = result.indexOf(funcName + '(');
    if (idx === -1) break;
    const openParen = idx + funcName.length;
    const closeParen = findMatchingParen(result, openParen);
    if (closeParen === -1) break;

    // Extract the arguments string (everything between the parens)
    const argsStr = result.slice(openParen + 1, closeParen);

    // Find the first top-level comma to isolate the first argument.
    const firstArg = extractFirstArgument(argsStr);

    result = result.slice(0, idx) + firstArg + result.slice(closeParen + 1);
  }
  return result;
}

/**
 * Extract the first argument from a comma-separated argument string,
 * respecting nested parens, brackets, quotes, and template literals.
 */
function extractFirstArgument(argsStr: string): string {
  let depth = 0;
  let i = 0;

  while (i < argsStr.length) {
    const ch = argsStr[i];

    // Template literals
    if (ch === '`') {
      i++;
      while (i < argsStr.length && argsStr[i] !== '`') {
        if (argsStr[i] === '\\') { i += 2; continue; }
        if (argsStr[i] === '$' && i + 1 < argsStr.length && argsStr[i + 1] === '{') {
          i += 2;
          let braceDepth = 1;
          while (i < argsStr.length && braceDepth > 0) {
            if (argsStr[i] === '{') braceDepth++;
            else if (argsStr[i] === '}') braceDepth--;
            if (braceDepth > 0) i++;
          }
        }
        i++;
      }
      i++;
      continue;
    }

    // Quoted strings
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < argsStr.length) {
        if (argsStr[i] === '\\') { i += 2; continue; }
        if (argsStr[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }

    // Nesting
    if (ch === '(' || ch === '{' || ch === '[') { depth++; i++; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth--; i++; continue; }

    // Top-level comma — we found the boundary
    if (ch === ',' && depth === 0) {
      return argsStr.slice(0, i).trim();
    }

    i++;
  }

  // No comma found — the whole string is the first (only) argument
  return argsStr.trim();
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
