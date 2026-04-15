/**
 * Context classifier — finds all React.createContext calls in a source directory,
 * analyzes each context's value type and usage, and classifies each as
 * behavioral, framework, or strip.
 *
 * Classification is based on VALUE TYPE analysis, not name matching.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextClassification {
  /** Context variable name (e.g., 'FormFieldContext') */
  name: string;
  /** Where it's defined */
  filePath: string;
  /** The TypeScript type parameter text */
  valueType: string;
  /** Classification result */
  classification: 'behavioral' | 'framework' | 'strip';
  /** Why this classification */
  reason: string;
  /** Files that call useContext with this context */
  consumers: string[];
  /** Number of consumer files */
  consumerCount: number;
}

interface RawContextHit {
  name: string;
  filePath: string;
  valueType: string;
  /** Full text of the type definition (interface body), if resolved */
  typeBody: string;
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, __tests__, dist, build
      if (['node_modules', '__tests__', 'dist', 'build', '.git'].includes(entry.name)) continue;
      results.push(...walkDir(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// createContext extraction
// ---------------------------------------------------------------------------

/**
 * Regex patterns to find createContext calls:
 *  1. `const X = createContext<Type>(...)` — direct import
 *  2. `const X = React.createContext<Type>(...)` — namespace import
 *  3. `const X = something.createContext<Type>(React, 'name')` — plugin shared contexts
 */
const CREATE_CONTEXT_PATTERNS = [
  // Direct: const Foo = createContext<Bar>(...)
  /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:\w+\.)*createContext<([^>]+)>\s*\(/g,
  // Without type param: const Foo = createContext(defaultValue)
  /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:\w+\.)*createContext\s*\(/g,
];

/**
 * Regex to find useContext(ContextName) calls.
 */
const USE_CONTEXT_PATTERN = /useContext\s*\(\s*(\w+)/g;

function extractContextDefinitions(filePath: string, content: string): RawContextHit[] {
  const hits: RawContextHit[] = [];
  const seen = new Set<string>();

  // Pattern 1: with explicit type parameter
  const typedPattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:[\w.]+\.)?createContext<([^>]+)>\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = typedPattern.exec(content)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const valueType = match[2].trim();
    const typeBody = resolveTypeBody(content, valueType);
    hits.push({ name, filePath, valueType, typeBody });
  }

  // Pattern 2: without type parameter (inferred from default value)
  const untypedPattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:[\w.]+\.)?createContext\s*\(([^)]*)\)/g;
  while ((match = untypedPattern.exec(content)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const defaultVal = match[2].trim();
    const valueType = inferTypeFromDefault(defaultVal);
    hits.push({ name, filePath, valueType, typeBody: '' });
  }

  return hits;
}

/**
 * Try to find the interface/type body in the same file for a given type name.
 */
function resolveTypeBody(content: string, typeName: string): string {
  // Strip generics, unions, nullability for lookup
  const baseName = typeName.replace(/\s*\|.*$/, '').replace(/\s*\?.*$/, '').trim();

  // Try interface
  const ifacePattern = new RegExp(
    `(?:export\\s+)?interface\\s+${escapeRegex(baseName)}[^{]*\\{([\\s\\S]*?)\\n\\}`,
    'm'
  );
  const ifaceMatch = ifacePattern.exec(content);
  if (ifaceMatch) return ifaceMatch[1];

  // Try type alias
  const typePattern = new RegExp(
    `(?:export\\s+)?type\\s+${escapeRegex(baseName)}\\s*=\\s*([^;]+)`,
    'm'
  );
  const typeMatch = typePattern.exec(content);
  if (typeMatch) return typeMatch[1];

  return '';
}

function inferTypeFromDefault(defaultVal: string): string {
  if (defaultVal === 'undefined' || defaultVal === 'null') return 'unknown';
  if (/^['"]/.test(defaultVal)) return 'string';
  if (/^(true|false)$/.test(defaultVal)) return 'boolean';
  if (/^\d+$/.test(defaultVal)) return 'number';
  if (/^\{/.test(defaultVal)) return 'object (inferred)';
  return 'unknown';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Consumer discovery
// ---------------------------------------------------------------------------

function findConsumers(
  contextName: string,
  allFiles: Map<string, string>,
  definitionFile: string
): string[] {
  const consumers: string[] = [];
  for (const [filePath, content] of allFiles) {
    // Skip test files
    if (filePath.includes('__tests__') || filePath.includes('.test.')) continue;
    // Check for useContext(contextName)
    const pattern = new RegExp(`useContext\\s*\\(\\s*${escapeRegex(contextName)}\\b`);
    if (pattern.test(content)) {
      consumers.push(filePath);
    }
  }
  return consumers;
}

// ---------------------------------------------------------------------------
// Classification engine — based on VALUE TYPE, not name
// ---------------------------------------------------------------------------

function classifyContext(hit: RawContextHit): { classification: 'behavioral' | 'framework' | 'strip'; reason: string } {
  const { valueType, typeBody, name } = hit;
  const combined = `${valueType}\n${typeBody}`;

  // --- FRAMEWORK indicators ---

  // Ref types are React-specific infrastructure
  if (/\bRef(?:Object)?</.test(combined) || /\bMutableRefObject</.test(combined)) {
    // If the type is MOSTLY refs, it's framework
    const refCount = (combined.match(/(?:Ref(?:Object)?|MutableRefObject)<[^>]+>/g) || []).length;
    const totalFields = (combined.match(/\w+\s*[?:]?\s*:/g) || []).length;
    if (refCount > 0 && (totalFields === 0 || refCount / totalFields >= 0.3)) {
      return { classification: 'framework', reason: `Type contains RefObject/MutableRefObject fields (${refCount}/${totalFields} fields are refs)` };
    }
  }

  // Analytics/telemetry/funnel tracking
  if (/funnel|analytics|telemetry|tracking|metric/i.test(combined)) {
    return { classification: 'framework', reason: 'Type relates to analytics/funnel/telemetry tracking infrastructure' };
  }

  // Dispatch from useReducer
  if (/\bDispatch\b/.test(valueType)) {
    return { classification: 'framework', reason: 'Type is a React Dispatch (useReducer infrastructure)' };
  }

  // Error boundary infrastructure
  if (/errorBoundary|renderFallback|ErrorInfo/i.test(combined)) {
    return { classification: 'framework', reason: 'Type relates to React error boundary infrastructure' };
  }

  // --- STRIP indicators ---

  // Split panel layout coordination
  if (/splitPanel|SplitPanel/i.test(combined) && /offset|position|size|resize/i.test(combined)) {
    return { classification: 'strip', reason: 'Type provides split panel layout coordination (container-specific)' };
  }

  // App layout internals — massive layout state objects
  if (/drawer|navigation.*click|toolbar|splitPanel.*position/i.test(combined) &&
      (combined.match(/\w+\s*[?:]?\s*:/g) || []).length > 15) {
    return { classification: 'strip', reason: 'Type is a large app layout internal state object (container-specific coordination)' };
  }

  // Dynamic overlap — layout-specific callback
  if (/overlapHeight|dynamicOverlap/i.test(combined)) {
    return { classification: 'strip', reason: 'Type provides layout overlap coordination (container-specific)' };
  }

  // Active drawers — layout-specific state
  if (/activeDrawer|ActiveDrawer/i.test(combined) && /Array|ReadonlyArray/.test(valueType)) {
    return { classification: 'strip', reason: 'Type tracks active drawer IDs (app layout container state)' };
  }

  // Sticky header — container-specific scroll coordination
  if (/isStuck|isStuckAtBottom|stickyHeader/i.test(combined)) {
    return { classification: 'strip', reason: 'Type provides sticky header scroll state (container-specific)' };
  }

  // Column widths — table-internal layout coordination
  if (/columnWidth|getColumnStyles|updateColumn/i.test(combined)) {
    return { classification: 'strip', reason: 'Type provides column width coordination (table container internals)' };
  }

  // --- BEHAVIORAL indicators ---

  // Simple primitive or union type
  if (/^(string|boolean|number)(\s*\|\s*(string|boolean|number|undefined|null))*$/.test(valueType.trim())) {
    return { classification: 'behavioral', reason: `Type is a simple primitive: ${valueType}` };
  }

  // String literal union
  if (/^['"]/.test(valueType) || /^['"][^'"]+['"]\s*\|/.test(valueType)) {
    return { classification: 'behavioral', reason: `Type is a string literal union: ${valueType}` };
  }

  // string | undefined
  if (/^string\s*\|\s*undefined$/.test(valueType.trim())) {
    return { classification: 'behavioral', reason: 'Type is string | undefined — simple behavioral data' };
  }

  // Interface with mostly string/boolean/number fields → behavioral
  if (typeBody) {
    const fields = typeBody.match(/(\w+)\s*[?]?\s*:\s*([^;]+)/g) || [];
    const totalFieldCount = fields.length;
    if (totalFieldCount > 0) {
      let behavioralFieldCount = 0;
      for (const field of fields) {
        const fieldType = field.replace(/^\w+\s*[?]?\s*:\s*/, '').trim();
        if (/^(string|boolean|number|undefined|null)(\s*\|\s*(string|boolean|number|undefined|null))*$/.test(fieldType)) {
          behavioralFieldCount++;
        }
        // Callback with rendering impact (onChange, onSubmit, etc.)
        if (/^(\([^)]*\)\s*=>|Function)/.test(fieldType) && /label|description|error|warning|invalid|variant|control/i.test(typeBody)) {
          behavioralFieldCount++;
        }
      }
      const ratio = behavioralFieldCount / totalFieldCount;
      if (ratio >= 0.5) {
        return { classification: 'behavioral', reason: `Interface has ${behavioralFieldCount}/${totalFieldCount} behavioral fields (primitives/rendering-relevant)` };
      }
    }
  }

  // Rendering-relevant field names in the type body
  if (/\b(label|description|error|warning|invalid|variant|disabled|controlId|ariaLabel|ariaDescribedby|defaultVariant)\b/i.test(combined)) {
    return { classification: 'behavioral', reason: 'Type contains rendering-relevant fields (label, description, error, variant, etc.)' };
  }

  // I18n/locale — behavioral (affects rendered text)
  if (/\bi18n|locale|format\b/i.test(combined) && !/analytics|funnel/i.test(combined)) {
    return { classification: 'behavioral', reason: 'Type provides i18n/locale formatting (affects rendered content)' };
  }

  // Icon provider — behavioral (affects rendered icons)
  if (/\bicons?\b/i.test(valueType) && /Icon/i.test(valueType)) {
    return { classification: 'behavioral', reason: 'Type provides icon definitions (affects rendered content)' };
  }

  // Simple boolean context
  if (valueType === 'boolean') {
    return { classification: 'behavioral', reason: 'Type is a simple boolean — behavioral flag' };
  }

  // Hotspot/annotation context — behavioral (tutorial UI)
  if (/hotspot|annotation|tutorial/i.test(combined)) {
    return { classification: 'behavioral', reason: 'Type provides hotspot/annotation/tutorial data (affects rendered UI)' };
  }

  // Container header context — behavioral (isInContainer flag)
  if (/isInContainer|isInline/i.test(combined)) {
    return { classification: 'behavioral', reason: 'Type provides container presence flag (affects component rendering)' };
  }

  // View/router state — behavioral (controls what's displayed)
  if (/\bview\b.*\bstate\b|\bstate\b.*\bview\b/i.test(combined) || /RouteState|ViewContext/i.test(combined)) {
    return { classification: 'behavioral', reason: 'Type provides view/routing state (controls rendered content)' };
  }

  // Collection preferences metadata — behavioral (table display config)
  if (/stripedRows|hiddenColumns|stickyColumns|contentDensity/i.test(combined)) {
    return { classification: 'behavioral', reason: 'Type provides collection display preferences (affects rendered table)' };
  }

  // Dropdown position — behavioral
  if (/position.*top|bottom|left|right/i.test(combined) && (combined.match(/\w+\s*[?:]?\s*:/g) || []).length <= 3) {
    return { classification: 'behavioral', reason: 'Type provides position data for rendering' };
  }

  // Token inline context — behavioral
  if (/isInlineToken/i.test(combined)) {
    return { classification: 'behavioral', reason: 'Type provides inline token display flag (affects rendering)' };
  }

  // Collection label context — behavioral (accessibility labeling)
  if (/assignId|labellingInterface/i.test(combined)) {
    return { classification: 'behavioral', reason: 'Type provides accessibility labeling coordination' };
  }

  // Modal context with MutableRefObject — framework
  if (/isInModal/i.test(combined) && /MutableRefObject/.test(combined)) {
    return { classification: 'framework', reason: 'Type mixes behavioral flag with MutableRefObject (framework infrastructure)' };
  }

  // Breadcrumbs slot context — strip (toolbar wiring)
  if (/isInToolbar|BreadcrumbsSlot/i.test(combined)) {
    return { classification: 'strip', reason: 'Type provides toolbar slot wiring (container-specific)' };
  }

  // Default: when ambiguous, behavioral is safer (preserve > strip)
  return { classification: 'behavioral', reason: `Ambiguous type "${valueType}" — defaulting to behavioral (preserve is safer)` };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function classifyContexts(sourceDir: string): ContextClassification[] {
  const resolvedDir = path.resolve(sourceDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Source directory not found: ${resolvedDir}`);
  }

  // Step 1: Read all files
  const filePaths = walkDir(resolvedDir);
  const fileContents = new Map<string, string>();
  for (const fp of filePaths) {
    fileContents.set(fp, fs.readFileSync(fp, 'utf-8'));
  }

  // Step 2: Find all createContext calls
  const rawHits: RawContextHit[] = [];
  for (const [fp, content] of fileContents) {
    rawHits.push(...extractContextDefinitions(fp, content));
  }

  // Step 3: Classify each and find consumers
  const results: ContextClassification[] = [];
  for (const hit of rawHits) {
    const { classification, reason } = classifyContext(hit);
    const consumers = findConsumers(hit.name, fileContents, hit.filePath);
    results.push({
      name: hit.name,
      filePath: hit.filePath,
      valueType: hit.valueType,
      classification,
      reason,
      consumers,
      consumerCount: consumers.length,
    });
  }

  return results;
}
