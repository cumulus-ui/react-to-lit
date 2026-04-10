/**
 * JSX transform integration.
 *
 * Transforms all JSX in a source file to html`` tagged templates
 * using the TypeScript compiler API, then re-parses as plain TS.
 */
import ts from 'typescript';
import { jsxToLitTransformerFactory } from '../transforms/jsx-to-lit.js';

/**
 * Transform all JSX in a source file to Lit html`` tagged templates.
 * Returns a new SourceFile with no JSX syntax.
 */
export function transformJsxToLit(sourceFile: ts.SourceFile): ts.SourceFile {
  // Skip files that don't contain JSX
  if (!sourceFile.fileName.endsWith('.tsx') && !sourceFile.fileName.endsWith('.jsx')) {
    return sourceFile;
  }

  // Run the transformer
  const result = ts.transform(sourceFile, [jsxToLitTransformerFactory]);
  const transformed = result.transformed[0];

  // Print the transformed AST back to source text
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  });
  const printed = printer.printFile(transformed);

  result.dispose();

  // Re-parse as plain TS (not TSX) — should have no JSX syntax
  const newSourceFile = ts.createSourceFile(
    sourceFile.fileName.replace('.tsx', '.ts'),
    printed,
    ts.ScriptTarget.ES2019,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  return newSourceFile;
}
