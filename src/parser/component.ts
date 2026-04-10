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
import { getNodeText } from './program.js';

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

  // If internal.tsx exists, find the implementation there
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
    if (ts.isFunctionDeclaration(stmt) && hasExportDefault(stmt)) {
      const name = stmt.name?.text ?? 'Unknown';
      return {
        name,
        forwardRef: false,
        body: stmt.body!,
        parameters: stmt.parameters,
        propsTypeName: extractPropsTypeName(stmt.parameters),
      };
    }
  }

  // Strategy 2: const Foo = React.forwardRef<Ref, Props>((...) => { ... })
  // or: const Foo = React.forwardRef(function Foo(...) { ... })
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

  // Strategy 4: export default function(props) { ... } (unnamed)
  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (ts.isFunctionExpression(stmt.expression) || ts.isArrowFunction(stmt.expression)) {
        return {
          name: 'Unknown',
          forwardRef: false,
          body: ts.isBlock(stmt.expression.body)
            ? stmt.expression.body
            : stmt.expression.body,
          parameters: stmt.expression.parameters,
          propsTypeName: extractPropsTypeName(stmt.expression.parameters),
        };
      }
    }
  }

  // Strategy 5: Look for a function that matches the filename pattern
  const fileName = sourceFile.fileName.split('/').pop()?.replace(/\.(tsx?|jsx?)$/, '');
  if (fileName === 'internal') {
    // Find the last exported function or the default export
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const name = stmt.name.text;
        if (name.startsWith('Internal') || name === 'default') {
          return {
            name,
            forwardRef: false,
            body: stmt.body!,
            parameters: stmt.parameters,
            propsTypeName: extractPropsTypeName(stmt.parameters),
          };
        }
      }
    }

    // Check for: const InternalFoo = React.forwardRef(...)
    for (const stmt of sourceFile.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text.startsWith('Internal')) {
            const result = extractFromForwardRef(decl, sourceFile);
            if (result) return result;
          }
        }
      }
    }

    // Last resort: find any function with an export default at the bottom
    const defaultExport = sourceFile.statements.find(
      (s) => ts.isExportAssignment(s) && !s.isExportEquals,
    ) as ts.ExportAssignment | undefined;

    if (defaultExport && ts.isIdentifier(defaultExport.expression)) {
      const exportedName = defaultExport.expression.text;
      // Find the matching function declaration or variable
      for (const stmt of sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === exportedName) {
          return {
            name: exportedName,
            forwardRef: false,
            body: stmt.body!,
            parameters: stmt.parameters,
            propsTypeName: extractPropsTypeName(stmt.parameters),
          };
        }
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === exportedName) {
              const result = extractFromForwardRef(decl, sourceFile);
              if (result) return result;
            }
          }
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
  return extractFromForwardRefExpression(decl.initializer, name, sourceFile);
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
      body: ts.isBlock(arg.body) ? arg.body : arg.body,
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
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (!modifiers) return false;
  const hasExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const hasDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  return hasExport && hasDefault;
}
