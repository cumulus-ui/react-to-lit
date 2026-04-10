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

// ---------------------------------------------------------------------------
// Main emission
// ---------------------------------------------------------------------------

export function emitLifecycle(effects: EffectIR[]): string {
  const lines: string[] = [];

  // Group effects by kind
  const mountEffects = effects.filter((e) => e.deps === 'empty' && !e.isLayout);
  const everyRenderEffects = effects.filter((e) => e.deps === 'none');
  const depEffects = effects.filter((e) => Array.isArray(e.deps));
  const layoutEffects = effects.filter((e) => e.isLayout);
  const cleanupEffects = effects.filter((e) => e.cleanup);

  // connectedCallback — mount-only effects
  if (mountEffects.length > 0) {
    lines.push('  override connectedCallback(): void {');
    lines.push('    super.connectedCallback();');
    for (const effect of mountEffects) {
      lines.push(`    // mount effect`);
      lines.push(indentBody(effect.body, 4));
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
  if (depEffects.length > 0) {
    lines.push('  override willUpdate(changed: PropertyValues): void {');
    lines.push('    super.willUpdate(changed);');
    for (const effect of depEffects) {
      const deps = effect.deps as string[];
      const condition = deps
        .map((d) => `changed.has('${d}')`)
        .join(' || ');
      lines.push(`    if (${condition}) {`);
      lines.push(indentBody(effect.body, 6));
      lines.push('    }');
    }
    lines.push('  }');
    lines.push('');
  }

  // updated — every-render effects and layout effects
  const updatedEffects = [...everyRenderEffects, ...layoutEffects];
  if (updatedEffects.length > 0) {
    lines.push('  override updated(): void {');
    for (const effect of updatedEffects) {
      lines.push(indentBody(effect.body, 4));
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
 */
function indentBody(body: string, indentLevel: number): string {
  let text = body.trim();

  // Strip outer braces if present
  if (text.startsWith('{') && text.endsWith('}')) {
    text = text.slice(1, -1).trim();
  }

  const indent = ' '.repeat(indentLevel);
  return text
    .split('\n')
    .map((line) => indent + line.trimStart())
    .join('\n');
}
