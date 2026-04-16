/**
 * Dead-code elimination pass.
 *
 * Given emitted Lit component code and a set of stripped/dead symbols,
 * iteratively removes declarations, object properties, template attributes,
 * and expressions that reference dead symbols.  Newly-orphaned symbols are
 * added to the dead set and the process repeats until convergence (or a
 * max-iteration cap is hit).
 *
 * Runs BEFORE `stubUndefinedSymbols` so that transitively dead code is
 * removed rather than stubbed.
 */

// ---------------------------------------------------------------------------
// Known dead-symbol patterns — framework infrastructure that shouldn't
// survive into Lit output.  These are *pattern matchers*, not hardcoded
// component names.
// ---------------------------------------------------------------------------

const DEAD_SYMBOL_PATTERNS: RegExp[] = [
  // Analytics framework
  /^analytics[A-Z]/,
  /^Analytics[A-Z]/,
  // Funnel tracking
  /^funnel[A-Z]/,
  /^FUNNEL_/,
  // Auto-generated analytics metadata types
  /^Generated\w*Metadata/,
  // Test infrastructure
  /^testUtilStyles$/,
  // Internal Cloudscape markers
  /^__awsui/,
  /^__aws/,
  // React CSS custom property injection
  /^stylePropertiesAndVariables$/,
];

/**
 * Collect symbols from the code that match known dead-framework patterns.
 * These are the initial seeds for dead-code elimination.
 */
export function collectStrippedSymbols(code: string): string[] {
  const stripped: string[] = [];
  const seen = new Set<string>();

  // Scan for identifiers in the code that match dead patterns
  const identRE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  for (const match of code.matchAll(identRE)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    if (DEAD_SYMBOL_PATTERNS.some(p => p.test(name))) {
      stripped.push(name);
    }
  }

  return stripped;
}

// ---------------------------------------------------------------------------
// Main elimination
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 10;

/**
 * Remove code that transitively depends on stripped/dead symbols.
 *
 * @param code - The full emitted component source.
 * @param strippedSymbols - Initial set of known-dead symbol names.
 * @returns The cleaned code.
 */
export function eliminateDeadCode(code: string, strippedSymbols: string[], conservative = false): string {
  if (strippedSymbols.length === 0) return code;

  const dead = new Set(strippedSymbols);
  let result = code;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const { code: cleaned, newDead } = eliminatePass(result, dead, conservative);
    if (newDead.length === 0) {
      result = cleaned;
      break;
    }
    for (const sym of newDead) dead.add(sym);
    result = cleaned;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Single elimination pass
// ---------------------------------------------------------------------------

interface PassResult {
  code: string;
  newDead: string[];
}

function eliminatePass(code: string, dead: Set<string>, conservative: boolean): PassResult {
  const newDead: string[] = [];
  const lines = code.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip empty lines
    if (trimmed === '') {
      result.push(line);
      i++;
      continue;
    }

    // --- Type/interface declarations referencing dead symbols ---
    if (!conservative && /^(?:type|interface)\s+\w+/.test(trimmed)) {
      const typeMatch = trimmed.match(/^(?:type|interface)\s+(\w+)/);
      const declEnd = findBlockEnd(lines, i);
      const block = lines.slice(i, declEnd + 1).join('\n');
      if (typeMatch && blockReferencesDead(block, dead)) {
        newDead.push(typeMatch[1]);
        i = declEnd + 1;
        continue;
      }
    }

    // --- const/let/var declarations ---
    if (!conservative) {
      const varMatch = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*[=:]/);
      if (varMatch) {
        const varName = varMatch[1];
        const declEnd = findStatementEnd(lines, i);
        const block = lines.slice(i, declEnd + 1).join('\n');

        if (blockReferencesDead(block, dead)) {
          newDead.push(varName);
          i = declEnd + 1;
          continue;
        }
      }

      // --- Destructured declarations: const { a, b } = ... ---
      const destructMatch = trimmed.match(/^(?:const|let|var)\s+\{([^}]+)\}\s*=/);
      if (destructMatch) {
        const declEnd = findStatementEnd(lines, i);
        const block = lines.slice(i, declEnd + 1).join('\n');
        if (blockReferencesDead(block, dead)) {
          const names = destructMatch[1].split(',').map(p => {
            const t = p.trim();
            const colonMatch = t.match(/\w+\s*:\s*(\w+)/);
            return colonMatch ? colonMatch[1] : t.match(/^(\w+)/)?.[1];
          }).filter(Boolean) as string[];
          newDead.push(...names);
          i = declEnd + 1;
          continue;
        }
      }
    }

    // --- Object property shorthand `deadSymbol,` or `key: deadSymbol,` ---
    if (isObjectPropertyLine(trimmed, dead)) {
      i++;
      continue;
    }

    // --- Template attributes: .attr=${deadSymbol} or attr=${deadSymbol} ---
    const attrCleaned = removeDeadTemplateAttributes(line, dead);
    if (attrCleaned !== line) {
      if (attrCleaned.trim()) {
        result.push(attrCleaned);
      }
      i++;
      continue;
    }

    // --- Standalone expression statements referencing dead symbols ---
    if (isStandaloneDeadExpression(trimmed, dead)) {
      i++;
      continue;
    }

    // --- if (deadSymbol) { ... } blocks ---
    if (!conservative && /^if\s*\(/.test(trimmed) && conditionReferencesDead(trimmed, dead)) {
      const blockEnd = findBlockEnd(lines, i);
      let end = blockEnd + 1;
      while (end < lines.length) {
        const nextTrimmed = lines[end].trimStart();
        if (/^else\s+if\s*\(/.test(nextTrimmed) || /^else\s*\{/.test(nextTrimmed)) {
          end = findBlockEnd(lines, end) + 1;
        } else {
          break;
        }
      }
      i = end;
      continue;
    }

    // --- Private class members referencing dead symbols ---
    if (!conservative) {
      const memberMatch = trimmed.match(/^(?:@\w+[^)]*\)\s*)?private\s+(?:get\s+)?(_?\w+)/);
      if (memberMatch) {
        const memberName = memberMatch[1];
        const declEnd = findMemberEnd(lines, i);
        const block = lines.slice(i, declEnd + 1).join('\n');
        if (blockOnlyReferencesDead(block, dead, memberName)) {
          newDead.push(memberName);
          i = declEnd + 1;
          continue;
        }
      }
    }

    result.push(line);
    i++;
  }

  return { code: result.join('\n'), newDead };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a block of code references any dead symbol.
 */
function blockReferencesDead(block: string, dead: Set<string>): boolean {
  for (const sym of dead) {
    if (new RegExp('\\b' + escapeRegExp(sym) + '\\b').test(block)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a block ONLY exists because of dead symbols — i.e., the body
 * (excluding the member's own name) references at least one dead symbol.
 */
function blockOnlyReferencesDead(block: string, dead: Set<string>, selfName: string): boolean {
  const deadWithoutSelf = new Set(dead);
  deadWithoutSelf.delete(selfName);
  return blockReferencesDead(block, deadWithoutSelf);
}

/**
 * Check if a line is an object property referencing a dead symbol.
 * Patterns:
 *   - `deadSymbol,`  (shorthand)
 *   - `key: deadSymbol,`
 *   - `key: deadSymbol`
 *   - `[key]: deadSymbol,`
 */
function isObjectPropertyLine(trimmed: string, dead: Set<string>): boolean {
  // Shorthand: just the symbol name with optional trailing comma
  const shorthandMatch = trimmed.match(/^(\w+)\s*,?\s*$/);
  if (shorthandMatch && dead.has(shorthandMatch[1])) return true;

  // key: deadSymbol or key: deadSymbol,
  const kvMatch = trimmed.match(/^\w+\s*:\s*(\w+)\s*,?\s*$/);
  if (kvMatch && dead.has(kvMatch[1])) return true;

  // Quoted key: 'key': deadSymbol,
  const quotedKvMatch = trimmed.match(/^['"][\w-]+['"]\s*:\s*(\w+)\s*,?\s*$/);
  if (quotedKvMatch && dead.has(quotedKvMatch[1])) return true;

  return false;
}

function extractObjectPropertyName(trimmed: string): string | undefined {
  const shorthandMatch = trimmed.match(/^(\w+)\s*,?\s*$/);
  if (shorthandMatch) return shorthandMatch[1];
  const kvMatch = trimmed.match(/^(\w+)\s*:/);
  if (kvMatch) return kvMatch[1];
  return undefined;
}

/**
 * Remove template attributes that reference dead symbols.
 * Patterns:
 *   - `.attr=${deadSymbol}`
 *   - `attr=${deadSymbol}`
 *   - `?attr=${deadSymbol}`
 *   - `@event=${deadSymbol}`
 *   - `.style=${deadSymbol}`
 */
function removeDeadTemplateAttributes(line: string, dead: Set<string>): string {
  let result = line;
  for (const sym of dead) {
    // Match various Lit binding prefixes: .prop=, ?bool=, @event=, attr=
    const attrRE = new RegExp(
      '\\s+[.?@]?[\\w-]+=\\$\\{' + escapeRegExp(sym) + '\\}',
      'g',
    );
    result = result.replace(attrRE, '');
  }
  return result;
}

/**
 * Check if a trimmed line is a standalone expression that only references
 * dead symbols (e.g., a function call with dead args, or bare dead reference).
 */
function isStandaloneDeadExpression(trimmed: string, dead: Set<string>): boolean {
  for (const sym of dead) {
    if (trimmed === sym + ';' || trimmed === sym) return true;
  }
  // Function call: deadFunc(...) — but NOT method declarations like `name(...): Type {`
  const callMatch = trimmed.match(/^(\w+)\s*\(/);
  if (callMatch && dead.has(callMatch[1])) {
    // Exclude method/function declarations (end with { or have : returnType)
    if (/\)\s*(?::\s*\S+\s*)?\{?\s*$/.test(trimmed)) return false;
    return true;
  }

  return false;
}

/**
 * Check if the condition of an if-statement references a dead symbol.
 */
function conditionReferencesDead(trimmed: string, dead: Set<string>): boolean {
  const condMatch = trimmed.match(/^if\s*\((.+?)\)\s*\{?\s*$/);
  if (!condMatch) return false;
  const condition = condMatch[1];
  for (const sym of dead) {
    if (new RegExp('\\b' + escapeRegExp(sym) + '\\b').test(condition)) {
      return true;
    }
  }
  return false;
}

/**
 * Find the end of a statement starting at line `start`.
 * For single-line statements (ending with `;`), returns `start`.
 * For multi-line (braces), tracks depth.
 */
function findStatementEnd(lines: string[], start: number): number {
  const firstLine = lines[start];
  // Single line ending with semicolon, no opening brace
  if (/;\s*$/.test(firstLine) && !firstLine.includes('{')) {
    return start;
  }

  let braceDepth = 0;
  let foundOpen = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { braceDepth++; foundOpen = true; }
      if (ch === '}') braceDepth--;
    }
    if (foundOpen && braceDepth <= 0) return i;
    if (!foundOpen && /;\s*$/.test(lines[i])) return i;
  }
  return start;
}

/**
 * Find the end of a block (brace-delimited) starting at line `start`.
 */
function findBlockEnd(lines: string[], start: number): number {
  let braceDepth = 0;
  let foundOpen = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { braceDepth++; foundOpen = true; }
      if (ch === '}') braceDepth--;
    }
    if (foundOpen && braceDepth <= 0) return i;
    // No braces at all — single line
    if (i === start && /;\s*$/.test(lines[i])) return i;
  }
  return start;
}

/**
 * Find the end of a class member declaration.
 */
function findMemberEnd(lines: string[], start: number): number {
  return findStatementEnd(lines, start);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
