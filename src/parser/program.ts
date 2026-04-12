/**
 * TypeScript program loader for parsing React TSX source files.
 *
 * Provides lightweight utilities for parsing individual TSX/TS files
 * without needing to install the full Cloudscape dependency tree.
 */
import ts from 'typescript';
import fs from 'node:fs';

/**
 * Parse a single TSX/TS file without creating a full program.
 * Useful for quick parsing when type resolution isn't needed.
 */
export function parseFile(filePath: string): ts.SourceFile {
  const content = fs.readFileSync(filePath, 'utf-8');
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.ES2019,
    /* setParentNodes */ true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Get the source text of a node.
 */
export function getNodeText(node: ts.Node, sourceFile?: ts.SourceFile): string {
  const sf = sourceFile ?? node.getSourceFile();
  return sf.text.slice(node.getStart(sf), node.getEnd());
}
