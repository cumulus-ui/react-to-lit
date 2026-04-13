/**
 * Identifier rewriting transform — ts-morph-based.
 *
 * Rewrites React-style identifiers to Lit-style class members:
 * - props.foo → this.foo
 * - stateName (from useState) → this._stateName
 * - setStateName(val) → this._stateName = val
 * - refName.current → this._refName
 * - handlerName → this._handlerName (in template expressions)
 * - computedName → this._computedName (in template expressions)
 * - bare prop names → this.propName (in both code bodies and templates)
 *
 * Uses ts-morph for scope-aware identifier resolution instead of regex.
 */
import { Project, SyntaxKind, Node, ts } from 'ts-morph';
import tsLib from 'typescript';
import { jsxToLitTransformerFactory } from './jsx-to-lit.js';
import type {
  ComponentIR,
  TemplateNodeIR,
  ImportIR,
} from '../ir/types.js';
import { getGlobalNames } from '../standards.js';
import { walkTemplate } from '../template-walker.js';
import { escapeRegex } from '../naming.js';
import { findMatchingParen } from '../text-utils.js';

// ---------------------------------------------------------------------------
// Member map — all identifiers that should map to class members
// ---------------------------------------------------------------------------

interface MemberMapping {
  /** The class member name (e.g., 'disabled', '_count', '_handleClick') */
  member: string;
  /** Whether this is a setter that needs special rewriting: setFoo(val) → this._foo = val */
  isSetter?: boolean;
  /** The setter's field name */
  setterField?: string;
}

function buildMemberMap(ir: ComponentIR): Map<string, MemberMapping> {
  const map = new Map<string, MemberMapping>();

  // Props → this.propName
  // Event props are included (as _onXxx) so they can be rewritten in opaque
  // expression text where the event transform doesn't reach.
  // Slot props are included: while they render as <slot>, their names may appear
  // in conditional checks (e.g., `children && html\`...\``) that need this. prefix.
  for (const p of ir.props) {
    if (p.category === 'event') {
      map.set(p.name, { member: p.name });
      continue;
    }
    if (p.category === 'slot' && p.name === 'children') {
      // 'children' conflicts with HTMLElement.children — use _hasChildren getter
      map.set('children', { member: '_hasChildren' });
      continue;
    }
    map.set(p.name, { member: p.name });
  }

  // State → this._stateName
  for (const s of ir.state) {
    map.set(s.name, { member: `_${s.name}` });
    // Setter → this._stateName = val
    map.set(s.setter, { member: `_${s.name}`, isSetter: true, setterField: `_${s.name}` });
  }

  // Refs → this._refName (and refName.current → this._refName)
  for (const r of ir.refs) {
    map.set(r.name, { member: `_${r.name}` });
  }

  // Handlers → this._handlerName
  for (const h of ir.handlers) {
    map.set(h.name, { member: `_${h.name}` });
  }

  // Computed values → this._computedName
  for (const c of ir.computedValues) {
    map.set(c.name, { member: `_${c.name}` });
  }

  // Skipped/unknown hook vars → this._varName
  // Detect setter patterns: setFoo paired with foo → treat as state setter
  const skippedSet = new Set(ir.skippedHookVars);
  for (const name of ir.skippedHookVars) {
    if (map.has(name)) continue;

    // setFoo pattern: if there's a matching foo in skippedHookVars, treat as setter
    const setterMatch = name.match(/^set([A-Z]\w*)$/);
    if (setterMatch) {
      const valueName = setterMatch[1].charAt(0).toLowerCase() + setterMatch[1].slice(1);
      if (skippedSet.has(valueName) || map.has(valueName)) {
        map.set(name, { member: `_${valueName}`, isSetter: true, setterField: `_${valueName}` });
        continue;
      }
    }

    map.set(name, { member: `_${name}` });
  }

  // Helpers (render helpers) → this._helperName()
  // Only render helpers (containing html`` templates) become class methods
  // and need this._ prefix. Utility helpers are file-level functions that
  // keep their bare names.
  // Also skip helpers that are actually constant declarations.
  const fileConstantNames = new Set<string>();
  for (const c of ir.fileConstants) {
    const m = c.match(/^(?:const|let|var)\s+(\w+)/);
    if (m) fileConstantNames.add(m[1]);
  }
  for (const h of ir.helpers) {
    if (map.has(h.name) || fileConstantNames.has(h.name)) continue;
    const trimmed = h.source.trimStart();
    // Skip constant declarations that are NOT function expressions/arrows.
    // Constants that are functions containing html`` DO become class methods
    // and need to be in the member map.
    if (trimmed.startsWith('const ') || trimmed.startsWith('let ') || trimmed.startsWith('var ')) {
      // Check if it's a function (arrow or function expression) with html``
      const isFuncWithTemplate = /=\s*(?:\([^)]*\)|[\w,\s]+)\s*=>/.test(trimmed) && h.source.includes('html`');
      if (!isFuncWithTemplate) continue;
    }
    // Only render helpers (with html`` templates) become class methods
    if (!h.source.includes('html`')) continue;
    map.set(h.name, { member: `_${h.name}` });
  }

  // Destructured prop aliases → this.propName (e.g., externalSeries → this.series)
  if (ir.propAliases) {
    for (const [alias, propName] of ir.propAliases) {
      if (!map.has(alias)) {
        // Map alias to the same member as the original prop
        const propMapping = map.get(propName);
        if (propMapping) {
          map.set(alias, { member: propMapping.member });
        }
      }
    }
  }

  return map;
}

// Global names — queried from TS compiler (ES2022 + DOM), not hardcoded.
const GLOBAL_NAMES = getGlobalNames();

// Shared ts-morph Project instance (reused across calls for performance)
let _project: Project | undefined;

function getProject(): Project {
  if (!_project) {
    _project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        allowJs: true,
      },
    });
  }
  return _project;
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function rewriteIdentifiers(ir: ComponentIR): ComponentIR {
  const memberMap = buildMemberMap(ir);

  // Track PascalCase component names whose JSX was converted to html``
  const convertedComponents = new Set<string>();

  // Quick text-based rewrites that don't need AST
  const quickRewrite = (text: string) => rewriteQuickPatterns(text, ir);

  // AST-based rewrite using ts-morph
  const astRewrite = (text: string, wrapperParams?: string, isExpression?: boolean) => {
    const quick = quickRewrite(text);
    return rewriteWithMorph(quick, memberMap, ir.localVariables, wrapperParams, isExpression);
  };

  // Transform handlers (pass params so they're treated as locals in the body)
  const handlers = ir.handlers.map((h) => ({
    ...h,
    body: astRewrite(h.body, h.params),
  }));

  // Transform effects
  const effects = ir.effects.map((e) => ({
    ...e,
    body: astRewrite(e.body),
    cleanup: e.cleanup ? astRewrite(e.cleanup) : undefined,
  }));

  // Transform public methods (pass params for correct scoping)
  const publicMethods = ir.publicMethods.map((m) => ({
    ...m,
    body: astRewrite(m.body, m.params),
  }));

  // Transform body preamble
  const bodyPreamble = ir.bodyPreamble.map((s) => astRewrite(s));

  // Transform prop default values (they may reference other props)
  const props = ir.props.map((p) => ({
    ...p,
    default: p.default ? astRewrite(p.default, undefined, true) : p.default,
  }));

  // Transform state initial values
  const state = ir.state.map((s) => ({
    ...s,
    initialValue: astRewrite(s.initialValue, undefined, true),
  }));

  // Transform ref initial values
  const refs = ir.refs.map((r) => ({
    ...r,
    initialValue: astRewrite(r.initialValue, undefined, true),
  }));

  // Transform controller constructor args
  const controllers = ir.controllers.map((c) => ({
    ...c,
    constructorArgs: astRewrite(c.constructorArgs, undefined, true),
  }));

  // Transform helpers
  const helpers = ir.helpers.map((h) => ({
    ...h,
    source: astRewrite(h.source),
  }));

  // Transform computed values
  const computedValues = ir.computedValues.map((c) => ({
    ...c,
    expression: astRewrite(c.expression),
  }));

  // Transform template expressions
  const template = rewriteTemplateNode(ir.template, astRewrite, convertedComponents);

  // Preserve imports for components whose JSX was converted — the PascalCase
  // identifier no longer appears in the output but the import is needed
  // to register the custom element.
  const imports = convertedComponents.size > 0
    ? ir.imports.map((imp): ImportIR => {
        if (imp.isTypeOnly || imp.isSideEffect) return imp;
        const used = (imp.defaultImport && convertedComponents.has(imp.defaultImport)) ||
          imp.namedImports?.some(n => convertedComponents.has(n));
        return used ? { ...imp, preserve: true } : imp;
      })
    : ir.imports;

  return {
    ...ir,
    imports,
    props,
    handlers,
    effects,
    publicMethods,
    bodyPreamble,
    state,
    refs,
    helpers,
    computedValues,
    controllers,
    template,
  };
}

// ---------------------------------------------------------------------------
// Quick pattern rewrites (no AST needed)
// ---------------------------------------------------------------------------

/**
 * Rewrite patterns that are unambiguous and don't need scope analysis:
 * - props.foo → this.foo
 * - refName.current → this._refName
 * - setStateName(val) → this._stateName = val
 */
function rewriteQuickPatterns(text: string, ir: ComponentIR): string {
  let result = text;

  // setFoo(val) → this._foo = val
  // setFoo(prev => newVal) → this._foo = ((prev) => newVal)(this._foo)
  for (const s of ir.state) {
    const setter = s.setter;
    const field = `_${s.name}`;
    const pattern = new RegExp(`\\b${escapeRegex(setter)}\\(`, 'g');
    let match;
    while ((match = pattern.exec(result)) !== null) {
      const start = match.index;
      const argStart = start + match[0].length;
      const argEnd = findMatchingParen(result, argStart - 1);
      if (argEnd === -1) continue;
      const arg = result.slice(argStart, argEnd).trim();
      // Detect updater function pattern: (prev) => expr or prev => expr
      const isUpdater = /^\(?[\w,\s]*\)?\s*=>/.test(arg);
      const replacement = isUpdater
        ? `this.${field} = (${arg})(this.${field})`
        : `this.${field} = ${arg}`;
      result = result.slice(0, start) + replacement + result.slice(argEnd + 1);
      pattern.lastIndex = start + replacement.length;
    }
  }

  // Setter-like skippedHookVars: setFoo(val) → this._foo = val
  // Covers custom hooks (useControllable, etc.) returning [value, setter] pairs.
  const skippedSetterSet = new Set(ir.skippedHookVars);
  for (const name of ir.skippedHookVars) {
    const setterMatch = name.match(/^set([A-Z]\w*)$/);
    if (!setterMatch) continue;
    const valueName = setterMatch[1].charAt(0).toLowerCase() + setterMatch[1].slice(1);
    if (!skippedSetterSet.has(valueName)) continue;

    const field = `_${valueName}`;
    const pattern = new RegExp(`\\b${escapeRegex(name)}\\(`, 'g');
    let match;
    while ((match = pattern.exec(result)) !== null) {
      const start = match.index;
      const argStart = start + match[0].length;
      const argEnd = findMatchingParen(result, argStart - 1);
      if (argEnd === -1) continue;
      const arg = result.slice(argStart, argEnd).trim();
      const isUpdater = /^\(?[\w,\s]*\)?\s*=>/.test(arg);
      const replacement = isUpdater
        ? `this.${field} = (${arg})(this.${field})`
        : `this.${field} = ${arg}`;
      result = result.slice(0, start) + replacement + result.slice(argEnd + 1);
      pattern.lastIndex = start + replacement.length;
    }
  }

  // fooRef.current → this._fooRef
  for (const r of ir.refs) {
    result = result.replace(
      new RegExp(`\\b${escapeRegex(r.name)}\\.current\\b`, 'g'),
      `this._${r.name}`,
    );
  }

  // Clean up `.current` on expressions where individual refs inside were
  // already rewritten. E.g., `(cond ? this._mainActionRef : this._triggerRef).current`
  // → the refs are unwrapped but `.current` remains on the outer expression.
  result = result.replace(/\)\.current\b/g, ')');

  // Clean up `.current` on this.xxxRef.current patterns — refs that ended up
  // as computed values or skippedHookVars instead of ir.refs still need
  // `.current` stripping when they follow the Ref naming convention.
  result = result.replace(/(\bthis\.\w*[Rr]ef\w*)\.current\b/g, '$1');

  // Clean up `.current` on local aliases of refs.
  // After the identifier rewriter, a local like `const x = this._fooRef`
  // may still have `x.current[i]` or `x.current?.method()`.
  // In Lit, ref values are already unwrapped — `.current` followed by
  // `[` (index access) or `?.` (optional chain) is always a React ref leftover.
  result = result.replace(/(\b\w+)\.current(\[|\?\.)/g, '$1$2');
  // props.foo → this.foo
  result = result.replace(/\bprops\.(\w+)/g, 'this.$1');

  return result;
}

// ---------------------------------------------------------------------------
// ts-morph-based identifier rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite bare identifiers to class members using ts-morph scope analysis.
 *
 * Wraps the text in a function body, parses it, walks all identifiers,
 * checks if each is a free variable (not declared locally), and if it
 * matches a known class member, prefixes it with `this.` + the member name.
 */
function rewriteWithMorph(
  text: string,
  memberMap: Map<string, MemberMapping>,
  componentLocalVars: Set<string>,
  wrapperParams?: string,
  isExpression?: boolean,
): string {
  // Quick check: does the text contain any member names?
  let hasAny = false;
  for (const name of memberMap.keys()) {
    if (name.length > 1 && text.includes(name)) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return text;

  // Wrap in a function to make it a valid source file.
  // If text looks like an object literal (starts with '{'), wrap as an
  // expression so the parser doesn't treat it as a block statement.
  // When the caller knows the text is an expression (computed values,
  // initial values, etc.), always apply expression wrapping for '{'.
  // Without this, object literals containing nested arrow functions
  // with semicolons are misdetected as block statements.
  // Include wrapperParams so handler/method params are in scope as locals.
  const trimmed = text.trimStart();
  const needsExprWrap = isExpression
    ? trimmed.startsWith('{')
    : (trimmed.startsWith('{') && !trimmed.includes(';'));
  const exprPrefix = needsExprWrap ? 'const __expr = ' : '';
  const prefix = `function __wrapper(${wrapperParams ?? ''}) {\n${exprPrefix}`;
  const suffix = '\n}';
  const wrapped = prefix + text + suffix;

  const project = getProject();

  // Remove old file if it exists, create new one
  const existing = project.getSourceFile('__body.ts');
  if (existing) project.removeSourceFile(existing);

  let sourceFile;
  try {
    sourceFile = project.createSourceFile('__body.ts', wrapped);
  } catch (e) {
    // Parse failure — return text unmodified but log so it's diagnosable
    console.warn(`[identifiers] failed to parse body for rewriting: ${(e as Error).message?.slice(0, 120)}`);
    return text;
  }

  // Build a set of component-level locals that are NOT class members
  // (these should never be rewritten regardless of scope).
  const componentOnlyLocals = new Set<string>();
  for (const local of componentLocalVars) {
    if (!memberMap.has(local)) {
      componentOnlyLocals.add(local);
    }
  }

  // Get the wrapper function node — declarations directly inside it are
  // "top-level" locals for the body and should shadow class members.
  // Declarations inside nested functions/arrows should only shadow within
  // their own scope.
  const wrapperFunc = sourceFile.getFunctions()[0];
  const wrapperBody = wrapperFunc?.getBody();

  // Collect ONLY top-level locals (direct children of the wrapper body).
  // Nested arrow/function params do NOT go in here — they only shadow
  // within their own scope, which we check per-identifier below.
  const topLevelLocals = new Set<string>();
  if (wrapperBody && Node.isBlock(wrapperBody)) {
    for (const stmt of wrapperBody.getStatements()) {
      if (Node.isVariableStatement(stmt)) {
        for (const decl of stmt.getDeclarationList().getDeclarations()) {
          collectDeclNames(decl.getNameNode(), topLevelLocals);
        }
      } else if (Node.isFunctionDeclaration(stmt) && stmt.getName()) {
        topLevelLocals.add(stmt.getName()!);
      }
    }
  }
  // Also include wrapper function parameters as top-level locals
  if (wrapperFunc) {
    for (const param of wrapperFunc.getParameters()) {
      collectDeclNames(param.getNameNode(), topLevelLocals);
    }
  }

  // Find identifiers to rewrite
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isIdentifier(node)) return;

    const name = node.getText();
    if (name.length <= 1) return;
    if (GLOBAL_NAMES.has(name) && !memberMap.has(name)) return;
    if (componentOnlyLocals.has(name)) return;
    if (topLevelLocals.has(name)) return;
    // Scope-aware check: if a nested function/arrow declares this name
    // as a parameter or local, and we're inside that scope, skip rewriting.
    if (isShadowedByNestedScope(node, name, wrapperBody)) return;

    const mapping = memberMap.get(name);
    if (!mapping) return;
    // Setters in call expressions (setFoo(val)) are handled by quickRewrite.
    // But setters used as references (e.g., passed as props) still need this._ prefix.
    if (mapping.isSetter) {
      const parent = node.getParent();
      if (parent && Node.isCallExpression(parent) && parent.getExpression() === node) {
        return; // call expression — handled by quickRewrite
      }
    }

    // Check AST context — is this a reference position?
    const parent = node.getParent();
    const isShorthand = parent && Node.isShorthandPropertyAssignment(parent)
                        && parent.getNameNode() === node;
    if (isDeclarationPosition(node) && !isShorthand) return;

    const startInWrapped = node.getStart();
    const startInOriginal = startInWrapped - prefix.length;
    if (startInOriginal < 0 || startInOriginal >= text.length) return;

    // Safety: if preceded by . or ?. in the original text, it's property access.
    // But ... (spread) is NOT property access.
    if (startInOriginal > 0) {
      const charBefore = text[startInOriginal - 1];
      if (charBefore === '.') {
        // Check for spread operator (...)
        const isSpread = startInOriginal >= 3 &&
          text[startInOriginal - 3] === '.' &&
          text[startInOriginal - 2] === '.' &&
          text[startInOriginal - 1] === '.';
        if (!isSpread) return;
      }
    }

    replacements.push({
      start: startInOriginal,
      end: startInOriginal + name.length,
      // Shorthand { foo } → { foo: this._foo }; normal foo → this._foo
      replacement: isShorthand
        ? `${name}: this.${mapping.member}`
        : `this.${mapping.member}`,
    });
  });

  // Apply in reverse order
  replacements.sort((a, b) => b.start - a.start);
  let result = text;
  for (const { start, end, replacement } of replacements) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scope-aware helpers for identifier rewriting
// ---------------------------------------------------------------------------

/**
 * Collect declared names from a name node (identifier, object/array binding pattern).
 */
function collectDeclNames(nameNode: Node, out: Set<string>): void {
  if (Node.isIdentifier(nameNode)) {
    out.add(nameNode.getText());
  } else if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      collectDeclNames(el.getNameNode(), out);
    }
  } else if (Node.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      if (Node.isBindingElement(el)) {
        collectDeclNames(el.getNameNode(), out);
      }
    }
  }
}

/**
 * Check if an identifier is shadowed by a nested scope (arrow function,
 * function expression, or nested function declaration) between the identifier
 * and the wrapper body.
 *
 * This correctly handles cases like:
 *   series.map(({ series, color }) => ...)
 * where the outer `series` should be rewritten but the inner `series` shouldn't.
 */
function isShadowedByNestedScope(
  idNode: Node,
  name: string,
  wrapperBody: Node | undefined,
): boolean {
  if (!wrapperBody) return false;

  // Walk up from the identifier's parent to the wrapper body.
  // At each scope boundary (arrow function, function expression/declaration),
  // check if that scope declares `name` as a parameter or local variable.
  let current: Node | undefined = idNode.getParent();
  while (current && current !== wrapperBody) {
    if (
      Node.isArrowFunction(current) ||
      Node.isFunctionExpression(current) ||
      Node.isFunctionDeclaration(current)
    ) {
      // Check parameters
      const params = current.getParameters();
      for (const param of params) {
        const names = new Set<string>();
        collectDeclNames(param.getNameNode(), names);
        if (names.has(name)) return true;
      }
      // Check local variable declarations in this function body
      const body = Node.isArrowFunction(current) ? current.getBody() : current.getBody();
      if (body && Node.isBlock(body)) {
        for (const stmt of body.getStatements()) {
          if (Node.isVariableStatement(stmt)) {
            for (const decl of stmt.getDeclarationList().getDeclarations()) {
              const names = new Set<string>();
              collectDeclNames(decl.getNameNode(), names);
              if (names.has(name)) return true;
            }
          }
        }
      }
    }
    // Also check for-of/for-in/for loop variable declarations
    if (Node.isForOfStatement(current) || Node.isForInStatement(current)) {
      const init = current.getInitializer();
      if (init && Node.isVariableDeclarationList(init)) {
        for (const decl of init.getDeclarations()) {
          const names = new Set<string>();
          collectDeclNames(decl.getNameNode(), names);
          if (names.has(name)) return true;
        }
      }
    }
    current = current.getParent();
  }
  return false;
}

/**
 * Check if a ts-morph identifier node is in a declaration position.
 */
function isDeclarationPosition(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;

  // obj.propName — the name after a dot is not a declaration
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return false;

  // Variable declaration name
  if (Node.isVariableDeclaration(parent) && parent.getNameNode() === node) return true;

  // Parameter name
  if (Node.isParameterDeclaration(parent) && parent.getNameNode() === node) return true;

  // Function declaration name
  if (Node.isFunctionDeclaration(parent) && parent.getNameNode() === node) return true;
  if (Node.isFunctionExpression(parent) && parent.getNameNode() === node) return true;

  // Property assignment key: { propName: value }
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) return true;

  // Shorthand property: { propName }
  if (Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === node) return true;

  // Binding element: const { propName } = obj
  if (Node.isBindingElement(parent)) {
    const nameNode = parent.getNameNode();
    const propName = parent.getPropertyNameNode();
    // If this is the name (target), it's a declaration
    if (nameNode === node) return true;
    // If this is the property name (source), it's a declaration context too
    if (propName === node) return true;
  }

  // Import specifier
  if (Node.isImportSpecifier(parent)) return true;
  if (Node.isExportSpecifier(parent)) return true;

  // Type positions
  if (Node.isTypeReference(parent)) return true;
  if (parent.getKind() === SyntaxKind.QualifiedName) return true;
  if (Node.isPropertySignature(parent) && parent.getNameNode() === node) return true;
  if (Node.isInterfaceDeclaration(parent) && parent.getNameNode() === node) return true;
  if (Node.isTypeAliasDeclaration(parent) && parent.getNameNode() === node) return true;

  // Method/property declaration name
  if (Node.isMethodDeclaration(parent) && parent.getNameNode() === node) return true;
  if (Node.isPropertyDeclaration(parent) && parent.getNameNode() === node) return true;
  if (Node.isGetAccessorDeclaration(parent) && parent.getNameNode() === node) return true;
  if (Node.isSetAccessorDeclaration(parent) && parent.getNameNode() === node) return true;

  // Class declaration name
  if (Node.isClassDeclaration(parent) && parent.getNameNode() === node) return true;

  // Labeled statement
  if (Node.isLabeledStatement(parent) && parent.getLabel() === node) return true;

  // Enum member name
  if (Node.isEnumMember(parent) && parent.getNameNode() === node) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Template tree rewriting
// ---------------------------------------------------------------------------

function rewriteTemplateNode(
  node: TemplateNodeIR,
  astRewrite: (text: string) => string,
  convertedComponents: Set<string>,
): TemplateNodeIR {
  return walkTemplate(node, {
    attributeExpression: (expr) => astRewrite(expr),
    expression: (expr) => {
      // If the expression contains raw JSX, convert to html`` FIRST,
      // then rewrite identifiers in the resulting valid TS.
      // Running astRewrite first garbles JSX in .ts mode.
      if (hasRawJsx(expr)) {
        for (const m of expr.matchAll(/(?<!\w)<([A-Z]\w*)/g)) {
          convertedComponents.add(m[1]);
        }
        return astRewrite(convertRemainingJsx(expr));
      }
      return convertRemainingJsx(astRewrite(expr));
    },
    conditionExpression: (expr) => astRewrite(expr),
    loopIterable: (expr) => astRewrite(expr),
  });
}

/**
 * Detect raw JSX in expression text: PascalCase tags with closing syntax,
 * but not TypeScript generics (preceded by a word character).
 */
function hasRawJsx(text: string): boolean {
  if (text.includes('html`')) return false;
  if (text.includes('<>')) return true;
  return (/(?<!\w)<[A-Z]\w*[\s>\/]/.test(text)) &&
    (/\/>/.test(text) || /<\/[A-Z]/.test(text));
}

/**
 * Convert raw JSX in expression text to Lit html`` tagged templates.
 */
function convertRemainingJsx(text: string): string {
  if (!hasRawJsx(text)) return text;

  const wrapper = `const __jsxExpr = ${text};`;
  const tempFile = tsLib.createSourceFile(
    '__jsx_expr.tsx', wrapper, tsLib.ScriptTarget.ES2019, true, tsLib.ScriptKind.TSX,
  );
  const result = tsLib.transform(tempFile, [jsxToLitTransformerFactory]);
  const printer = tsLib.createPrinter({ newLine: tsLib.NewLineKind.LineFeed });
  let printed = printer.printFile(result.transformed[0]);
  printed = printed.replace(/\b(html|svg) `/g, '$1`');
  result.dispose();

  // Extract expression from `const __jsxExpr = <converted>;`
  const eqIdx = printed.indexOf('=');
  if (eqIdx > -1) {
    return printed.slice(eqIdx + 1).replace(/;\s*$/, '').trim();
  }
  return text;
}


