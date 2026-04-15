# Fix classMap Prop Shadowing Bug

## TL;DR

> **Quick Summary**: When a body preamble variable shadows a prop name (e.g., `const className = { ... }` when `className` is also a prop), the identifier transform rewrites template references to the prop instead of the local. Fix: rename preamble variables that conflict with prop names.
> 
> **Deliverables**:
> - Preamble variables that shadow props get renamed (e.g., `className` → `_classes`)
> - Template references updated to match
> - Badge, Box, TextContent output corrected
> 
> **Estimated Effort**: Quick
> **Parallel Execution**: NO — one task

---

## Context

### The Bug
Badge's React source declares `const className = clsx(styles.badge, ...)`. After the clsx transform, the preamble has `const className = { 'badge': true, ... }`. The template has `classMap(className)`.

The identifier transform (`identifiers.ts:434`) checks: "is this local variable ALSO a class member?" If yes, it lets the member win. So `className` in the template becomes `this.className` — the deprecated string prop, not the local classMap object.

### Root Cause
`identifiers.ts:432-436`:
```typescript
const componentOnlyLocals = new Set<string>();
for (const local of componentLocalVars) {
  if (!memberMap.has(local)) {    // ← className IS in memberMap (it's a prop)
    componentOnlyLocals.add(local); // ← so className is NOT added to locals
  }
}
```

Template expressions go through `rewriteWithMorph` which doesn't see preamble declarations as locals → `className` gets rewritten to `this.className`.

### Affected Components
Badge, Box, TextContent — all have `const className = clsx(...)` in the React source where `className` is also a deprecated prop.

### The Fix
Rename preamble variables that conflict with prop names. The right place: after the clsx transform produces `const className = { ... }`, detect the conflict and rename to `_classes`. Update both the preamble statement and the template references.

This is cleaner than changing scope logic because:
- Explicit — no ambiguity about which `className` is which
- Safe — doesn't risk breaking other identifier rewrites
- The rename only fires when there's an actual name collision

---

## TODOs

- [x] 1. Rename preamble variables that shadow prop names

  **What to do**:
  - The fix goes in `src/transforms/identifiers.ts`, in the `rewriteIdentifiers` function, BEFORE the preamble is processed by `astRewrite`.
  - After building the `memberMap` (line 60) and before transforming the body preamble (line 207):
    1. Scan `ir.bodyPreamble` for variable declarations: `const NAME = ...`
    2. For each declared variable, check if `memberMap.has(NAME)` (it's also a prop/state/ref)
    3. If yes: rename the variable. Pick a new name: `_${NAME}` or `_classes` for `className` specifically. Or use a generic renaming scheme: prefix with `_local_`.
    4. Replace the declaration in the preamble: `const className = { ... }` → `const _className = { ... }`
    5. Replace all references in OTHER preamble statements and in the template expressions
    6. Add the new name to `ir.localVariables` so it's treated as a local
  - The simplest approach: do a text-based rename on the preamble + template BEFORE the identifier transform runs. For each preamble `const X = ...` where X is in memberMap:
    ```typescript
    const newName = `_${X}`;
    // Rename in preamble
    ir.bodyPreamble = ir.bodyPreamble.map(s => s.replace(new RegExp('\\b' + X + '\\b', 'g'), newName));
    // Rename in template attribute expressions and text expressions
    walkTemplate(ir.template, {
      attributeExpression: (expr) => expr.replace(new RegExp('\\b' + X + '\\b', 'g'), newName),
      expression: (expr) => expr.replace(new RegExp('\\b' + X + '\\b', 'g'), newName),
      conditionExpression: (expr) => expr.replace(new RegExp('\\b' + X + '\\b', 'g'), newName),
    });
    // Add newName to localVariables, remove old
    ir.localVariables.delete(X);
    ir.localVariables.add(newName);
    ```
  - IMPORTANT: Only rename if the variable is declared in the PREAMBLE (not if it's a prop being destructured). Check: the preamble statement must match `const/let/var X =` (assignment, not destructuring).
  - Tests:
    - Construct IR with preamble `const className = { root: true }` and prop `className`, template expression `classMap(className)` → after transform, preamble has `_className`, template has `classMap(_className)`
    - Construct IR with preamble `const foo = bar` where `foo` is NOT a prop → no rename
    - Integration: generate Badge → `classMap(_className)` or `classMap(classes)`, NOT `classMap(this.className)`
  - Run `npx vitest run` → all pass
  - Commit: `fix: rename preamble variables that shadow prop names`

  **Must NOT do**:
  - Do NOT change the `rewriteWithMorph` scope logic — too risky
  - Do NOT change the clsx transform
  - Do NOT hardcode `className` → `classes` — use generic renaming for any shadowing variable

  **Recommended Agent Profile**: `deep`

  **References**:
  - `src/transforms/identifiers.ts:41-60` — `buildMemberMap` (props → member names)
  - `src/transforms/identifiers.ts:206-207` — body preamble processing
  - `src/transforms/identifiers.ts:245-246` — template processing
  - `src/transforms/identifiers.ts:430-436` — the bug: `componentOnlyLocals` filtering
  - `src/template-walker.ts` — `walkTemplate` for traversing template expressions

  **Commit**: YES — `fix: rename preamble variables that shadow prop names`

---

## Success Criteria

```bash
npx vitest run                    # All tests pass
# Badge check:
npx tsx src/cli.ts -p @cloudscape-design/components -s vendor/cloudscape-source/src -o /tmp/r2l-shadow --component Badge --preset cloudscape
grep "classMap" /tmp/r2l-shadow/badge/internal.ts   # classMap(_className) — NOT classMap(this.className)
```
