/**
 * TypeScript program loader for parsing React TSX source files.
 *
 * Creates a minimal TypeScript program with enough configuration
 * to parse TSX files and resolve types across a component directory,
 * without needing to install the full Cloudscape dependency tree.
 */
import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Create a TypeScript program that can parse TSX files in a component directory.
 *
 * @param componentDir - Absolute path to a component directory (e.g. .../src/badge)
 * @param sourceRoot - Absolute path to the source root (e.g. .../src/)
 */
export function createProgram(
  componentDir: string,
  sourceRoot?: string,
): ts.Program {
  const root = sourceRoot ?? path.resolve(componentDir, '..');

  // Collect all .ts/.tsx files in the component directory
  const entryFiles = collectTsFiles(componentDir);

  // Also include files in internal/ that are commonly referenced
  const internalDir = path.join(root, 'internal');
  if (fs.existsSync(internalDir)) {
    entryFiles.push(...collectTsFiles(internalDir));
  }

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.ES2015,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    jsx: ts.JsxEmit.React,
    lib: ['lib.es2021.d.ts', 'lib.dom.d.ts'],
    esModuleInterop: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    // Allow unresolved modules — we don't have all deps installed
    noResolve: false,
    types: [],
    baseUrl: root,
  };

  const host = ts.createCompilerHost(compilerOptions);

  // Override module resolution to gracefully handle missing external modules
  const originalResolve = host.resolveModuleNames?.bind(host);
  host.resolveModuleNames = (
    moduleNames: string[],
    containingFile: string,
    _reusedNames: string[] | undefined,
    _redirectedReference: ts.ResolvedProjectReference | undefined,
    options: ts.CompilerOptions,
  ) => {
    return moduleNames.map((moduleName) => {
      // Try standard resolution first
      const result = ts.resolveModuleName(moduleName, containingFile, options, host);
      if (result.resolvedModule) {
        return result.resolvedModule;
      }
      // For unresolved modules (external deps), return undefined gracefully
      return undefined;
    });
  };

  return ts.createProgram(entryFiles, compilerOptions, host);
}

/**
 * Get a source file from the program.
 */
export function getSourceFile(
  program: ts.Program,
  filePath: string,
): ts.SourceFile | undefined {
  return program.getSourceFile(filePath);
}

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
 * Recursively collect all .ts and .tsx files in a directory.
 */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip test directories and node_modules
      if (
        entry.name === '__tests__' ||
        entry.name === '__integ__' ||
        entry.name === '__a11y__' ||
        entry.name === '__motion__' ||
        entry.name === 'node_modules' ||
        entry.name === 'test-classes' ||
        entry.name === 'analytics-metadata'
      ) {
        continue;
      }
      files.push(...collectTsFiles(fullPath));
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Get the source text of a node.
 */
export function getNodeText(node: ts.Node, sourceFile?: ts.SourceFile): string {
  const sf = sourceFile ?? node.getSourceFile();
  return sf.text.slice(node.getStart(sf), node.getEnd());
}
