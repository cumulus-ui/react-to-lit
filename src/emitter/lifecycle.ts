/**
 * Lifecycle method emission.
 *
 * Maps EffectIR entries to Lit lifecycle methods:
 * - deps='empty' → connectedCallback()
 * - deps='none' → updated()
 * - deps=[...] → willUpdate(changed) with changed.has() guards
 * - cleanup → disconnectedCallback()
 */
import type { EffectIR } from '../ir/types.js';
import type { DeferredInit } from './properties.js';
import { findMatchingParen } from '../text-utils.js';

// ---------------------------------------------------------------------------
// Main emission
// ---------------------------------------------------------------------------

export function emitLifecycle(effects: EffectIR[], deferredInits: DeferredInit[] = []): string {
  const lines: string[] = [];

  // Deduplicate effects by normalized body + deps (same body with different deps is meaningful)
  const seen = new Set<string>();
  const uniqueEffects = effects.filter((e) => {
    const depsKey = Array.isArray(e.deps) ? e.deps.join(',') : String(e.deps);
    const key = depsKey + '|' + e.body.replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Group effects by kind
  const mountEffects = uniqueEffects.filter((e) => e.deps === 'empty' && !e.isLayout);
  const layoutMountEffects = uniqueEffects.filter((e) => e.isLayout && e.deps === 'empty');
  const everyRenderEffects = uniqueEffects.filter((e) => e.deps === 'none');
  const depEffects = uniqueEffects.filter((e) => Array.isArray(e.deps) && !e.isLayout);
  const layoutDepEffects = uniqueEffects.filter((e) => e.isLayout && Array.isArray(e.deps));
  const layoutNoDepsEffects = uniqueEffects.filter((e) => e.isLayout && e.deps === 'none');
  const cleanupEffects = uniqueEffects.filter((e) => e.cleanup);

  // connectedCallback — mount-only effects
  if (mountEffects.length > 0) {
    lines.push('  override connectedCallback(): void {');
    lines.push('    super.connectedCallback();');
    emitEffectBodies(mountEffects, lines);
    lines.push('  }');
    lines.push('');
  }

  // firstUpdated — deferred property/state initializations + layout mount effects
  if (deferredInits.length > 0 || layoutMountEffects.length > 0) {
    lines.push('  override firstUpdated(): void {');
    // Deferred inits first (state/prop values that reference other props)
    for (const init of deferredInits) {
      lines.push(`    ${init.assignment}`);
    }
    if (layoutMountEffects.length > 0) {
      emitEffectBodies(layoutMountEffects, lines);
    }
    lines.push('  }');
    lines.push('');
  }

  // disconnectedCallback — cleanup functions
  if (cleanupEffects.length > 0) {
    lines.push('  override disconnectedCallback(): void {');
    lines.push('    super.disconnectedCallback();');
    for (const effect of cleanupEffects) {
      if (!effect.cleanup) continue; // guarded by filter above
      lines.push(`    // cleanup`);
      lines.push(indentBody(effect.cleanup, 4));
    }
    lines.push('  }');
    lines.push('');
  }

  // willUpdate — dependency-tracked effects
  const allDepEffects = [...depEffects, ...layoutDepEffects];
  if (allDepEffects.length > 0) {
    lines.push('  override willUpdate(changed: PropertyValues): void {');
    lines.push('    super.willUpdate(changed);');
    for (const effect of allDepEffects) {
      const deps = effect.deps as string[];
      const hasCleanup = !!effect.cleanup;
      const condition = deps
        .map((d) => `changed.has('${d}')`)
        .join(' || ');
      lines.push(`    if (${condition}) {`);
      lines.push(indentBody(effect.body, 6, hasCleanup));
      lines.push('    }');
    }
    lines.push('  }');
    lines.push('');
  }

  // updated — every-render effects and layout effects without deps
  const updatedEffects = [...everyRenderEffects, ...layoutNoDepsEffects];
  if (updatedEffects.length > 0) {
    lines.push('  override updated(): void {');
    emitEffectBodies(updatedEffects, lines);
    lines.push('  }');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emit a list of effects into a lifecycle method body.
 * When there are multiple effects, wraps each in braces for isolation.
 */
function emitEffectBodies(
  effects: EffectIR[],
  lines: string[],
): void {
  for (const effect of effects) {
    const hasCleanup = !!effect.cleanup;
    if (effects.length > 1) {
      lines.push('    {');
      lines.push(indentBody(effect.body, 6, hasCleanup));
      lines.push('    }');
    } else {
      lines.push(indentBody(effect.body, 4, hasCleanup));
    }
  }
}

/**
 * Indent a body block of source text.
 * Strips the outer { } if present and re-indents.
 * Optionally strips the cleanup return statement (return () => { ... }).
 */
function indentBody(body: string, indentLevel: number, stripCleanupReturn = false): string {
  let text = body.trim();

  // Strip outer braces if present
  if (text.startsWith('{') && text.endsWith('}')) {
    text = text.slice(1, -1).trim();
  }

  // Strip cleanup returns: `return () => { ... };` anywhere in the body.
  // The cleanup is handled separately in disconnectedCallback.
  // Uses balanced brace matching for robustness with nested blocks.
  if (stripCleanupReturn) {
    text = stripCleanupReturns(text);
  }

  const lines = text.split('\n');
  // Find minimum indentation across non-empty lines to preserve relative nesting
  const minIndent = lines.reduce((min, line) => {
    if (line.trim().length === 0) return min;
    const leading = line.match(/^(\s*)/)?.[1].length ?? 0;
    return Math.min(min, leading);
  }, Infinity);
  const strip = minIndent === Infinity ? 0 : minIndent;

  const indent = ' '.repeat(indentLevel);
  return lines
    .map((line) => {
      if (line.trim().length === 0) return '';
      return indent + line.slice(strip);
    })
    .join('\n');
}

/**
 * Strip all `return () => { ... }` and `return function() { ... }` patterns
 * from effect body text, using balanced brace matching.
 * Also handles expression-body arrows: `return () => expr;`
 */
function stripCleanupReturns(text: string): string {
  // Pass 1: Block-body arrows and function expressions: return () => { ... }
  const blockPattern = /\breturn\s+(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*\{/g;
  let result = text;
  let match;
  while ((match = blockPattern.exec(result)) !== null) {
    // Find the opening brace
    const braceStart = result.indexOf('{', match.index + 6);
    if (braceStart === -1) continue;
    // Find the matching closing brace
    const braceEnd = findMatchingParen(result, braceStart, { allBrackets: true });
    if (braceEnd === -1) continue;
    // Remove from 'return' to the closing brace + optional semicolon
    let endPos = braceEnd + 1;
    if (result[endPos] === ';') endPos++;
    result = result.slice(0, match.index) + result.slice(endPos);
    blockPattern.lastIndex = match.index; // re-scan from same position
  }

  // Pass 2: Expression-body arrows: return () => expr;
  // These don't have a block body — the arrow is followed by an expression
  // terminated by a semicolon (at balanced depth).
  const exprPattern = /\breturn\s+\(\s*\)\s*=>\s*/g;
  while ((match = exprPattern.exec(result)) !== null) {
    const exprStart = match.index + match[0].length;
    // If followed by '{', it was already handled in pass 1 (or a block body)
    if (result[exprStart] === '{') continue;
    // Scan to end of expression: find ; at depth 0
    let depth = 0;
    let i = exprStart;
    while (i < result.length) {
      const ch = result[i];
      if (ch === '(' || ch === '[') { depth++; }
      else if (ch === ')' || ch === ']') { depth--; }
      else if (ch === ';' && depth === 0) { i++; break; }
      else if (ch === '\n' && depth === 0) { break; }
      i++;
    }
    result = result.slice(0, match.index) + result.slice(i);
    exprPattern.lastIndex = match.index;
  }

  return result.trim();
}
