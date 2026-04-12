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
import { findMatchingParen } from '../text-utils.js';

// ---------------------------------------------------------------------------
// Main emission
// ---------------------------------------------------------------------------

export function emitLifecycle(effects: EffectIR[]): string {
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
    for (const effect of mountEffects) {
      const hasCleanup = !!effect.cleanup;
      if (mountEffects.length > 1) {
        lines.push('    {');
        lines.push(indentBody(effect.body, 6, hasCleanup));
        lines.push('    }');
      } else {
        lines.push(indentBody(effect.body, 4, hasCleanup));
      }
    }
    lines.push('  }');
    lines.push('');
  }

  // firstUpdated — layout mount effects (isLayout + empty deps)
  if (layoutMountEffects.length > 0) {
    lines.push('  override firstUpdated(): void {');
    for (const effect of layoutMountEffects) {
      const hasCleanup = !!effect.cleanup;
      if (layoutMountEffects.length > 1) {
        lines.push('    {');
        lines.push(indentBody(effect.body, 6, hasCleanup));
        lines.push('    }');
      } else {
        lines.push(indentBody(effect.body, 4, hasCleanup));
      }
    }
    lines.push('  }');
    lines.push('');
  }

  // disconnectedCallback — cleanup functions
  if (cleanupEffects.length > 0) {
    lines.push('  override disconnectedCallback(): void {');
    lines.push('    super.disconnectedCallback();');
    for (const effect of cleanupEffects) {
      lines.push(`    // cleanup`);
      lines.push(indentBody(effect.cleanup!, 4));
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
    for (const effect of updatedEffects) {
      const hasCleanup = !!effect.cleanup;
      if (updatedEffects.length > 1) {
        lines.push('    {');
        lines.push(indentBody(effect.body, 6, hasCleanup));
        lines.push('    }');
      } else {
        lines.push(indentBody(effect.body, 4, hasCleanup));
      }
    }
    lines.push('  }');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 */
function stripCleanupReturns(text: string): string {
  // Match: return () => { or return function() {
  const pattern = /\breturn\s+(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*\{/g;
  let result = text;
  let match;
  while ((match = pattern.exec(result)) !== null) {
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
    pattern.lastIndex = match.index; // re-scan from same position
  }
  return result.trim();
}
