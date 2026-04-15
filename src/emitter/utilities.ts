/**
 * Utility emitter — generates web-standard utility modules from React behavioral utilities.
 *
 * Reads a React utility source file, strips React-specific imports and type references,
 * and replaces them with web-standard equivalents. For the MVP, this produces a copy
 * with React imports removed and type stubs for unresolved references.
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// React → Web-standard type replacements
// ---------------------------------------------------------------------------

const TYPE_REPLACEMENTS: Array<[RegExp, string]> = [
  // React.SyntheticEvent<T> → Event
  [/React\.SyntheticEvent(?:<[^>]*>)?/g, 'Event'],
  // React.MouseEvent<T> → MouseEvent
  [/React\.MouseEvent(?:<[^>]*>)?/g, 'MouseEvent'],
  // React.KeyboardEvent<T> → KeyboardEvent
  [/React\.KeyboardEvent(?:<[^>]*>)?/g, 'KeyboardEvent'],
  // React.FocusEvent<T> → FocusEvent
  [/React\.FocusEvent(?:<[^>]*>)?/g, 'FocusEvent'],
  // React.ChangeEvent<T> → Event
  [/React\.ChangeEvent(?:<[^>]*>)?/g, 'Event'],
  // React.FormEvent<T> → Event
  [/React\.FormEvent(?:<[^>]*>)?/g, 'Event'],
  // React.DragEvent<T> → DragEvent
  [/React\.DragEvent(?:<[^>]*>)?/g, 'DragEvent'],
  // React.TouchEvent<T> → TouchEvent
  [/React\.TouchEvent(?:<[^>]*>)?/g, 'TouchEvent'],
  // React.ClipboardEvent<T> → ClipboardEvent
  [/React\.ClipboardEvent(?:<[^>]*>)?/g, 'ClipboardEvent'],
  // React.SetStateAction<T> → T
  [/React\.SetStateAction<([^>]+)>/g, '$1'],
  // React.RefObject<T> → { current: T | null }
  [/React\.RefObject<([^>]+)>/g, '{ current: $1 | null }'],
  // React.MutableRefObject<T> → { current: T }
  [/React\.MutableRefObject<([^>]+)>/g, '{ current: $1 }'],
  // Catch-all: remaining React.* references
  [/React\.(\w+)/g, '$1'],
];

// Patterns that identify React import lines
const REACT_IMPORT_PATTERNS = [
  /^import\s+\*\s+as\s+React\s+from\s+['"]react['"];?\s*$/,
  /^import\s+React(?:\s*,\s*\{[^}]*\})?\s+from\s+['"]react['"];?\s*$/,
  /^import\s+\{[^}]*\}\s+from\s+['"]react['"];?\s*$/,
  /^import\s+type\s+\{[^}]*\}\s+from\s+['"]react['"];?\s*$/,
  /^import\s+type\s+React\s+from\s+['"]react['"];?\s*$/,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit a web-standard utility module from a React behavioral utility source file.
 *
 * @param modulePath - Path to the utility source file (absolute or relative to sourceDir)
 * @param sourceDir - Root source directory for resolving relative paths
 * @returns Generated TypeScript source string with React dependencies removed
 */
export function emitUtility(modulePath: string, sourceDir: string): string {
  const absPath = path.isAbsolute(modulePath)
    ? modulePath
    : path.join(path.resolve(sourceDir), modulePath);

  let source: string;
  try {
    source = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return `// Could not read source: ${modulePath}\nexport {};\n`;
  }

  return transformUtilitySource(source);
}

// ---------------------------------------------------------------------------
// Transformation pipeline
// ---------------------------------------------------------------------------

function transformUtilitySource(source: string): string {
  let result = stripReactImports(source);
  result = replaceReactTypes(result);
  result = stripEmptyExportDefault(result);
  return result;
}

function stripReactImports(source: string): string {
  const lines = source.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    return !REACT_IMPORT_PATTERNS.some(pattern => pattern.test(trimmed));
  });
  return filtered.join('\n');
}

function replaceReactTypes(source: string): string {
  let result = source;
  for (const [pattern, replacement] of TYPE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function stripEmptyExportDefault(source: string): string {
  return source.replace(/^export\s+default\s+undefined;?\s*$/gm, '');
}
