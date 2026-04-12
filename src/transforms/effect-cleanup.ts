/**
 * Effect cleanup variable promotion.
 *
 * In React, useEffect callbacks and their cleanup functions share a
 * closure — variables defined in the effect body are accessible from
 * the cleanup.  In the Lit output, the effect body goes into
 * willUpdate()/connectedCallback() and the cleanup into
 * disconnectedCallback(), which are separate methods with no shared
 * scope.
 *
 * This transform detects `const`/`let` variable declarations inside
 * effect bodies that are referenced by the effect's cleanup function,
 * and promotes them to class fields (via skippedHookVars).  The
 * declarations become assignments to `this._varName`, and the
 * identifier rewriter handles all other references.
 */
import type { ComponentIR } from '../ir/types.js';
import { escapeRegex } from '../naming.js';

export function promoteEffectCleanupVars(ir: ComponentIR): ComponentIR {
  const promotedNames = new Set<string>();
  const effects = ir.effects.map((effect) => {
    if (!effect.cleanup) return effect;

    // Find const/let declarations in the effect body
    const declPattern = /\b(?:const|let)\s+(\w+)\s*=/g;
    const bodyVars: string[] = [];
    let match;
    while ((match = declPattern.exec(effect.body)) !== null) {
      bodyVars.push(match[1]);
    }

    if (bodyVars.length === 0) return effect;

    // Check which body variables are referenced in cleanup
    const referencedVars: string[] = [];
    for (const name of bodyVars) {
      const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`);
      if (pattern.test(effect.cleanup)) {
        referencedVars.push(name);
        promotedNames.add(name);
      }
    }

    if (referencedVars.length === 0) return effect;

    // Rewrite const/let declarations to class field assignments in the body
    let newBody = effect.body;
    for (const name of referencedVars) {
      // const name = expr  →  this._name = expr
      // let name = expr    →  this._name = expr
      const declRe = new RegExp(
        `\\b(?:const|let)\\s+${escapeRegex(name)}\\s*=`,
        'g',
      );
      newBody = newBody.replace(declRe, `this._${name} =`);
    }

    return { ...effect, body: newBody };
  });

  if (promotedNames.size === 0) return ir;

  // Add promoted names to skippedHookVars for class field emission
  const skippedHookVars = [
    ...ir.skippedHookVars,
    ...Array.from(promotedNames),
  ];

  // Remove from localVariables so the identifier rewriter adds this._ prefix
  const localVariables = new Set(ir.localVariables);
  for (const name of promotedNames) {
    localVariables.delete(name);
  }

  return { ...ir, effects, skippedHookVars, localVariables };
}
