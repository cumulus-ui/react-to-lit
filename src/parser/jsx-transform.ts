/**
 * JSX transform integration.
 *
 * Transforms all JSX in a source file to html`` tagged templates
 * using the TypeScript compiler API, then re-parses as plain TS.
 */
import ts from 'typescript';
import { jsxToLitTransformerFactory, createJsxToLitTransformerFactory, type JsxToLitConfig } from '../transforms/jsx-to-lit.js';
import { fixTaggedTemplatePrinting } from '../naming.js';

/**
 * Transform all JSX in a source file to Lit html`` tagged templates.
 * Returns a new SourceFile with no JSX syntax.
 *
 * When `config` is omitted the Cloudscape defaults are used.
 */
export function transformJsxToLit(sourceFile: ts.SourceFile, config?: JsxToLitConfig): ts.SourceFile {
  // Skip files that don't contain JSX
  if (!sourceFile.fileName.endsWith('.tsx') && !sourceFile.fileName.endsWith('.jsx')) {
    return sourceFile;
  }

  // Run the transformer — use custom factory when config is provided
  const factory = config ? createJsxToLitTransformerFactory(config) : jsxToLitTransformerFactory;
  const result = ts.transform(sourceFile, [factory]);
  const transformed = result.transformed[0];

  // Print the transformed AST back to source text
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  });
  let printed = printer.printFile(transformed);

  // The TS printer inserts a space between the tag and the backtick
  // (e.g. `html \`...\``). Remove it so we emit `html\`...\``.
  printed = fixTaggedTemplatePrinting(printed);

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

/**
 * Convert a single JSX expression string to Lit html`` tagged template text.
 *
 * Wraps the expression in a temp file, runs the JSX-to-Lit transformer,
 * then extracts the converted expression. Used by parser/jsx.ts (inline
 * JSX in expression bodies) and transforms/identifiers.ts (residual JSX).
 */
export function convertJsxExpression(exprText: string): string {
  const wrapper = `const __jsxExpr = ${exprText};`;
  const tempFile = ts.createSourceFile(
    '__jsx_inline.tsx', wrapper, ts.ScriptTarget.ES2019, true, ts.ScriptKind.TSX,
  );

  const result = ts.transform(tempFile, [jsxToLitTransformerFactory]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  let printed = printer.printFile(result.transformed[0]);
  printed = fixTaggedTemplatePrinting(printed);
  result.dispose();

  const declPrefix = 'const __jsxExpr = ';
  const declStart = printed.indexOf(declPrefix);
  if (declStart > -1) {
    const valueStart = declStart + declPrefix.length;
    let depth = 0;
    let inTemplate = false;
    for (let i = valueStart; i < printed.length; i++) {
      const ch = printed[i];
      if (ch === '`') { inTemplate = !inTemplate; continue; }
      if (inTemplate) continue;
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      if (ch === ')' || ch === '}' || ch === ']') depth--;
      if (ch === ';' && depth <= 0) return printed.slice(valueStart, i).trim();
    }
    return printed.slice(valueStart).trim();
  }

  return exprText;
}
