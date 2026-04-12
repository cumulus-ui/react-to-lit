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
import type {
  ComponentIR,
  TemplateNodeIR,
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

  // Props → this.propName (exclude events — they're dispatched, not properties)
  // Slot props are included: while they render as <slot>, their names may appear
  // in conditional checks (e.g., `children && html\`...\``) that need this. prefix.
  for (const p of ir.props) {
    if (p.category === 'event') continue;
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
  for (const name of ir.skippedHookVars) {
    if (!map.has(name)) {
      map.set(name, { member: `_${name}` });
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

  // Quick text-based rewrites that don't need AST
  const quickRewrite = (text: string) => rewriteQuickPatterns(text, ir);

  // AST-based rewrite using ts-morph
  const astRewrite = (text: string, wrapperParams?: string) => {
    const quick = quickRewrite(text);
    return rewriteWithMorph(quick, memberMap, ir.localVariables, wrapperParams);
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

  // Transform state initial values
  const state = ir.state.map((s) => ({
    ...s,
    initialValue: astRewrite(s.initialValue),
  }));

  // Transform ref initial values
  const refs = ir.refs.map((r) => ({
    ...r,
    initialValue: astRewrite(r.initialValue),
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
  const template = rewriteTemplateNode(ir.template, quickRewrite, astRewrite);

  return {
    ...ir,
    handlers,
    effects,
    publicMethods,
    bodyPreamble,
    state,
    refs,
    helpers,
    computedValues,
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
      const arg = result.slice(argStart, argEnd);
      const replacement = `this.${field} = ${arg}`;
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
): string {
  // Quick check: does the text contain any member names?
  let hasAny = false;
  for (const name of memberMap.keys()) {
    if (name.length > 1 && !GLOBAL_NAMES.has(name) && text.includes(name)) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return text;

  // Wrap in a function to make it a valid source file.
  // If text looks like an object literal (starts with '{', no semicolons),
  // wrap as an expression so the parser doesn't treat it as a block statement.
  // Include wrapperParams so handler/method params are in scope as locals.
  const trimmed = text.trimStart();
  const needsExprWrap = trimmed.startsWith('{') && !trimmed.includes(';');
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
  } catch {
    return text;
  }

  // Collect locally declared names (parameters, variables, functions within this body)
  const bodyLocals = new Set<string>();
  sourceFile.forEachDescendant((node) => {
    if (Node.isVariableDeclaration(node)) {
      const nameNode = node.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        bodyLocals.add(nameNode.getText());
      } else if (Node.isObjectBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          const elName = el.getNameNode();
          if (Node.isIdentifier(elName)) bodyLocals.add(elName.getText());
        }
      } else if (Node.isArrayBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          if (Node.isBindingElement(el)) {
            const elName = el.getNameNode();
            if (Node.isIdentifier(elName)) bodyLocals.add(elName.getText());
          }
        }
      }
    }
    if (Node.isParameterDeclaration(node)) {
      const nameNode = node.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        bodyLocals.add(nameNode.getText());
      } else if (Node.isObjectBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          const elName = el.getNameNode();
          if (Node.isIdentifier(elName)) bodyLocals.add(elName.getText());
        }
      } else if (Node.isArrayBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          if (Node.isBindingElement(el)) {
            const elName = el.getNameNode();
            if (Node.isIdentifier(elName)) bodyLocals.add(elName.getText());
          }
        }
      }
    }
    if (Node.isFunctionDeclaration(node) && node.getName()) {
      bodyLocals.add(node.getName()!);
    }
  });

  // Component-level locals that are also class members should get this. prefix.
  // But body-level locals (parameters, let/const in this specific code block)
  // shadow the class member — don't rewrite those.
  const allLocals = new Set([...bodyLocals]);
  for (const local of componentLocalVars) {
    if (!memberMap.has(local)) {
      allLocals.add(local);
    }
  }

  // Find identifiers to rewrite
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isIdentifier(node)) return;

    const name = node.getText();
    if (name.length <= 1) return;
    if (GLOBAL_NAMES.has(name)) return;
    if (allLocals.has(name)) return;

    const mapping = memberMap.get(name);
    if (!mapping) return;
    if (mapping.isSetter) return; // setters handled by quickRewrite

    // Check AST context — is this a reference position?
    const parent = node.getParent();
    const isShorthand = parent && Node.isShorthandPropertyAssignment(parent)
                        && parent.getNameNode() === node;
    if (isDeclarationPosition(node) && !isShorthand) return;

    const startInWrapped = node.getStart();
    const startInOriginal = startInWrapped - prefix.length;
    if (startInOriginal < 0 || startInOriginal >= text.length) return;

    // Safety: if preceded by . or ?. in the original text, it's property access
    if (startInOriginal > 0) {
      const charBefore = text[startInOriginal - 1];
      if (charBefore === '.') return;
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
  _quickRewrite: (text: string) => string,
  astRewrite: (text: string) => string,
): TemplateNodeIR {
  return walkTemplate(node, {
    attributeExpression: (expr) => astRewrite(expr),
    expression: (expr) => astRewrite(expr),
    conditionExpression: (expr) => astRewrite(expr),
    loopIterable: (expr) => astRewrite(expr),
  });
}


