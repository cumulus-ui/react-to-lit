/**
 * Component function finder.
 *
 * Detects the React component function across index.tsx and internal.tsx,
 * handling all Cloudscape patterns:
 * - Pattern A: Single function in index.tsx (Badge)
 * - Pattern B: Wrapper in index.tsx + implementation in internal.tsx (Spinner)
 * - Pattern C: forwardRef in index.tsx + forwardRef in internal.tsx (Button)
 */
import ts from 'typescript';
import path from 'node:path';
import { getNodeText } from './program.js';
import { isExported, isDefault } from './utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawComponent {
  /** Component name (e.g. "Badge", "Button") */
  name: string;

  /** Whether the component uses React.forwardRef */
  forwardRef: boolean;

  /** The function body to parse (from internal.tsx or index.tsx) */
  body: ts.Block | ts.Expression;

  /** The parameter list (props destructuring) */
  parameters: ts.NodeArray<ts.ParameterDeclaration>;

  /** The source file containing the implementation */
  sourceFile: ts.SourceFile;

  /** Props type name (e.g. "BadgeProps", "InternalButtonProps") */
  propsTypeName?: string;

  /** Default values extracted from the index.tsx wrapper */
  defaultsFromIndex: Map<string, string>;

  /** Default values extracted from the internal.tsx function */
  defaultsFromInternal: Map<string, string>;

  /** Whether there's a separate internal.tsx */
  hasInternal: boolean;
}

// ---------------------------------------------------------------------------
// Main finder
// ---------------------------------------------------------------------------

/**
 * Find the component function across index and internal source files.
 * Returns the merged component info needed for further parsing.
 */
export function findComponent(
  indexFile: ts.SourceFile,
  internalFile?: ts.SourceFile,
): RawComponent {
  // First, look at index.tsx to find the public component
  const indexComponent = findComponentInFile(indexFile);
  if (!indexComponent) {
    throw new Error(`No component function found in ${indexFile.fileName}`);
  }

  const defaultsFromIndex = extractDefaults(indexComponent.parameters, indexFile);

  // If there's no internal.tsx, the index IS the implementation
  if (!internalFile) {
    return {
      name: indexComponent.name,
      forwardRef: indexComponent.forwardRef,
      body: indexComponent.body,
      parameters: indexComponent.parameters,
      sourceFile: indexFile,
      propsTypeName: indexComponent.propsTypeName,
      defaultsFromIndex,
      defaultsFromInternal: new Map(),
      hasInternal: false,
    };
  }

  // If a second source file exists, check whether the entry file actually
  // delegates to it. In the wrapper+implementation pattern, the entry file
  // imports from the second file and re-exports or wraps it. If the entry
  // doesn't reference the second file at all, it's self-contained and the
  // second file only has helper components (not the main implementation).
  const entryDir = path.dirname(indexFile.fileName);
  const secondFileBase = path.resolve(internalFile.fileName).replace(/\.\w+$/, '');
  const entryDelegatesToSecondFile = indexFile.statements.some(stmt => {
    if (!ts.isImportDeclaration(stmt)) return false;
    const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
    if (!spec.startsWith('.')) return false;
    // Resolve the specifier relative to the entry file's directory,
    // stripping any extension so bare specifiers match too.
    const resolved = path.resolve(entryDir, spec).replace(/\.\w+$/, '');
    return resolved === secondFileBase;
  });

  if (!entryDelegatesToSecondFile) {
    // Entry file is self-contained — use it as the implementation
    return {
      name: indexComponent.name,
      forwardRef: indexComponent.forwardRef,
      body: indexComponent.body,
      parameters: indexComponent.parameters,
      sourceFile: indexFile,
      propsTypeName: indexComponent.propsTypeName,
      defaultsFromIndex,
      defaultsFromInternal: new Map(),
      hasInternal: false,
    };
  }

  // The entry delegates to the second file — find the implementation there
  const internalComponent = findComponentInFile(internalFile);
  if (!internalComponent) {
    throw new Error(`No component function found in ${internalFile.fileName}`);
  }

  const defaultsFromInternal = extractDefaults(internalComponent.parameters, internalFile);

  return {
    name: indexComponent.name,
    forwardRef: indexComponent.forwardRef || internalComponent.forwardRef,
    body: internalComponent.body,
    parameters: internalComponent.parameters,
    sourceFile: internalFile,
    propsTypeName: internalComponent.propsTypeName,
    defaultsFromIndex,
    defaultsFromInternal,
    hasInternal: true,
  };
}

// ---------------------------------------------------------------------------
// File-level component detection
// ---------------------------------------------------------------------------

interface RawComponentInFile {
  name: string;
  forwardRef: boolean;
  body: ts.Block | ts.Expression;
  parameters: ts.NodeArray<ts.ParameterDeclaration>;
  propsTypeName?: string;
}

function findComponentInFile(sourceFile: ts.SourceFile): RawComponentInFile | null {
  // Strategy 1: export default function Foo(props) { ... }
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && hasExportDefault(stmt) && stmt.body) {
      const name = stmt.name?.text ?? 'Unknown';
      return {
        name,
        forwardRef: false,
        body: stmt.body,
        parameters: stmt.parameters,
        propsTypeName: extractPropsTypeName(stmt.parameters),
      };
    }
  }

  // Strategy 2: const Foo = React.forwardRef<Ref, Props>((...) => { ... })
  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const result = extractFromForwardRef(decl, sourceFile);
        if (result) return result;
      }
    }
  }

  // Strategy 3: export default React.forwardRef(InternalFoo)
  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const result = extractFromForwardRefExpression(stmt.expression, 'Unknown', sourceFile);
      if (result) return result;
    }
  }

  // Strategy 4: export default <Identifier> — resolve to function/arrow/forwardRef in same file
  const defaultExport = sourceFile.statements.find(
    (s) => ts.isExportAssignment(s) && !(s as ts.ExportAssignment).isExportEquals,
  ) as ts.ExportAssignment | undefined;

  if (defaultExport && ts.isIdentifier(defaultExport.expression)) {
    const exportedName = defaultExport.expression.text;
    const resolved = resolveIdentifier(exportedName, sourceFile);
    if (resolved) return resolved;
  }

  // Strategy 5: For internal.tsx or implementation.tsx — look for the "main" export
  const fileName = sourceFile.fileName.split('/').pop()?.replace(/\.(tsx?|jsx?)$/, '');
  if (fileName === 'internal' || fileName === 'implementation') {
    // Look for exported function declarations (with any name)
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        if (isExported(stmt)) {
          return {
            name: stmt.name.text,
            forwardRef: false,
            body: stmt.body,
            parameters: stmt.parameters,
            propsTypeName: extractPropsTypeName(stmt.parameters),
          };
        }
      }
    }

    // Look for export const InternalFoo = arrow/forwardRef
    for (const stmt of sourceFile.statements) {
      if (ts.isVariableStatement(stmt)) {
        if (!isExported(stmt)) continue;

        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const name = decl.name.text;

          // const InternalFoo = React.forwardRef(...)
          const fwdResult = extractFromForwardRef(decl, sourceFile);
          if (fwdResult) return fwdResult;

          // const InternalFoo = (props) => { ... }
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            const fn = decl.initializer;
            return {
              name,
              forwardRef: false,
              body: fn.body,
              parameters: fn.parameters,
              propsTypeName: extractPropsTypeName(fn.parameters),
            };
          }
        }
      }
    }

    // Look for function declarations (non-export-default)
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        const name = stmt.name.text;
        if (name.startsWith('Internal') || name === 'default') {
          return {
            name,
            forwardRef: false,
            body: stmt.body,
            parameters: stmt.parameters,
            propsTypeName: extractPropsTypeName(stmt.parameters),
          };
        }
      }
    }
  }

  return null;
}

/**
 * Resolve a named identifier to its function/arrow/forwardRef declaration.
 */
function resolveIdentifier(
  name: string,
  sourceFile: ts.SourceFile,
): RawComponentInFile | null {
  for (const stmt of sourceFile.statements) {
    // function Foo(...) { ... }
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name && stmt.body) {
      return {
        name,
        forwardRef: false,
        body: stmt.body,
        parameters: stmt.parameters,
        propsTypeName: extractPropsTypeName(stmt.parameters),
      };
    }

    // const Foo = React.forwardRef(...) or const Foo = (...) => { ... }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
        if (!decl.initializer) continue;

        // Try forwardRef first
        const fwdResult = extractFromForwardRef(decl, sourceFile);
        if (fwdResult) return fwdResult;

        // Arrow function or function expression (also unwrap type assertions)
        const unwrapped = unwrapTypeAssertions(decl.initializer);
        if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
          const fn = unwrapped;
          return {
            name,
            forwardRef: false,
            body: ts.isBlock(fn.body) ? fn.body : fn.body,
            parameters: fn.parameters,
            propsTypeName: extractPropsTypeName(fn.parameters),
          };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// forwardRef extraction helpers
// ---------------------------------------------------------------------------

function extractFromForwardRef(
  decl: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
): RawComponentInFile | null {
  if (!ts.isIdentifier(decl.name) || !decl.initializer) return null;
  const name = decl.name.text;
  // Unwrap type assertions: React.forwardRef(...) as FooType
  const expr = unwrapTypeAssertions(decl.initializer);
  return extractFromForwardRefExpression(expr, name, sourceFile);
}

/**
 * Unwrap AsExpression and TypeAssertionExpression wrappers.
 * Handles: React.forwardRef(...) as FooType
 */
function unwrapTypeAssertions(expr: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expr)) return unwrapTypeAssertions(expr.expression);
  if (ts.isTypeAssertionExpression(expr)) return unwrapTypeAssertions(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return unwrapTypeAssertions(expr.expression);
  return expr;
}

function extractFromForwardRefExpression(
  expr: ts.Expression,
  name: string,
  sourceFile: ts.SourceFile,
): RawComponentInFile | null {
  // React.forwardRef(...) or forwardRef(...)
  if (!ts.isCallExpression(expr)) return null;

  const callee = expr.expression;
  const isForwardRef =
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'React' &&
      callee.name.text === 'forwardRef') ||
    (ts.isIdentifier(callee) && callee.text === 'forwardRef');

  if (!isForwardRef || expr.arguments.length < 1) return null;

  const arg = expr.arguments[0];

  // forwardRef((props, ref) => { ... })
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    return {
      name: ts.isFunctionExpression(arg) && arg.name ? arg.name.text : name,
      forwardRef: true,
      body: arg.body,
      parameters: arg.parameters,
      propsTypeName: extractPropsTypeName(arg.parameters),
    };
  }

  // forwardRef(InternalFoo) — reference to a named function
  if (ts.isIdentifier(arg)) {
    // Try to find the referenced function in the same file
    const referencedName = arg.text;
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === referencedName) {
        return {
          name: referencedName,
          forwardRef: true,
          body: stmt.body!,
          parameters: stmt.parameters,
          propsTypeName: extractPropsTypeName(stmt.parameters),
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default value extraction from destructuring
// ---------------------------------------------------------------------------

/**
 * Extract default values from the function parameters.
 * Handles: function Foo({ color = 'grey', size = 'normal', ...rest }: Props)
 */
export function extractDefaults(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  sourceFile: ts.SourceFile,
): Map<string, string> {
  const defaults = new Map<string, string>();

  for (const param of parameters) {
    if (ts.isObjectBindingPattern(param.name)) {
      for (const element of param.name.elements) {
        if (element.initializer && ts.isIdentifier(element.name)) {
          defaults.set(element.name.text, getNodeText(element.initializer, sourceFile));
        }
      }
    }
  }

  return defaults;
}

// ---------------------------------------------------------------------------
// Props type name extraction
// ---------------------------------------------------------------------------

function extractPropsTypeName(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
): string | undefined {
  if (parameters.length === 0) return undefined;
  const firstParam = parameters[0];

  // function Foo(props: BadgeProps) or function Foo({ ... }: BadgeProps)
  if (firstParam.type) {
    if (ts.isTypeReferenceNode(firstParam.type) && ts.isIdentifier(firstParam.type.typeName)) {
      return firstParam.type.typeName.text;
    }
    // Intersection types: InternalProps & InternalBaseComponentProps
    if (ts.isIntersectionTypeNode(firstParam.type)) {
      // Take the first type reference
      for (const member of firstParam.type.types) {
        if (ts.isTypeReferenceNode(member) && ts.isIdentifier(member.typeName)) {
          return member.typeName.text;
        }
      }
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function hasExportDefault(node: ts.Node): boolean {
  return isExported(node) && isDefault(node);
}
