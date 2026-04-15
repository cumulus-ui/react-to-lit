/**
 * Pattern classifier for shared dependency modules.
 *
 * Given a DependencyGraph, classifies each shared module as:
 * - behavioral: state, events, DOM logic (preserve in Lit output)
 * - framework: ref forwarding, telemetry, boilerplate (eliminate in Lit)
 * - type-only: only types/interfaces/enums (import as type)
 *
 * Classification is heuristic-based — no hardcoded module names.
 * When ambiguous, behavioral wins (safer to preserve than eliminate).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DependencyGraph, DependencyNode } from './dependency-graph.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PatternClassification = 'behavioral' | 'framework' | 'type-only';

export interface ClassifiedModule {
  path: string;
  kind: DependencyNode['kind'];
  classification: PatternClassification;
  reason: string;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Classify every shared module in the graph as behavioral, framework,
 * or type-only by reading its source and applying generic heuristics.
 */
export function classifyPatterns(
  graph: DependencyGraph,
  sourceDir: string,
): Map<string, ClassifiedModule> {
  const result = new Map<string, ClassifiedModule>();
  const absSourceDir = path.resolve(sourceDir);

  for (const modulePath of graph.sharedModules) {
    const node = graph.nodes.get(modulePath);
    if (!node) continue;

    const absPath = path.join(absSourceDir, modulePath);
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf-8');
    } catch {
      result.set(modulePath, {
        path: modulePath,
        kind: node.kind,
        classification: 'behavioral',
        reason: 'Source not readable; defaulting to behavioral (safe)',
      });
      continue;
    }

    const { classification, reason } = classifySource(source, node);
    result.set(modulePath, { path: modulePath, kind: node.kind, classification, reason });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Core classification logic
// ---------------------------------------------------------------------------

interface ClassificationResult {
  classification: PatternClassification;
  reason: string;
}

function classifySource(source: string, node: DependencyNode): ClassificationResult {
  // Type-only: cheapest check, most definitive
  if (node.kind === 'type-only') {
    return { classification: 'type-only', reason: 'Exports only types/interfaces (dependency graph)' };
  }
  if (isSourceTypeOnly(source)) {
    return { classification: 'type-only', reason: 'No runtime code; only type/interface/enum exports' };
  }

  // Detect signals from source content
  const behavioral = detectBehavioralSignals(source);
  const framework = detectFrameworkSignals(source);

  // Behavioral takes priority when present (safer to preserve than eliminate)
  if (behavioral.score > 0) {
    return { classification: 'behavioral', reason: behavioral.reasons.join('; ') };
  }
  if (framework.score > 0) {
    return { classification: 'framework', reason: framework.reasons.join('; ') };
  }

  // Default: behavioral (safe — prefer preserving over eliminating)
  return { classification: 'behavioral', reason: 'No strong signals; defaulting to behavioral (safe)' };
}

// ---------------------------------------------------------------------------
// Type-only detection
// ---------------------------------------------------------------------------

function isSourceTypeOnly(source: string): boolean {
  const stripped = stripComments(source);

  // Must contain type-like declarations
  if (!/\b(?:type|interface|enum)\b/.test(stripped)) return false;

  // Must NOT contain runtime constructs
  return (
    !/\bfunction\s+\w+\s*[\(<]/.test(stripped) &&
    !/\bclass\s+\w+/.test(stripped) &&
    !/\b(?:const|let|var)\s+\w+\s*=/.test(stripped) &&
    !/\bexport\s+default\s+\w/.test(stripped)
  );
}

// ---------------------------------------------------------------------------
// Behavioral signal detection
// ---------------------------------------------------------------------------

interface SignalResult {
  score: number;
  reasons: string[];
}

function detectBehavioralSignals(source: string): SignalResult {
  const reasons: string[] = [];
  let score = 0;

  function add(points: number, reason: string) {
    score += points;
    reasons.push(reason);
  }

  // ── State management ────────────────────────────────────────────────
  if (/\buseState\s*[<(]/.test(source) || /React\.useState\s*[<(]/.test(source)) {
    add(3, 'state management (useState)');
  }
  if (/\buseReducer\s*[<(]/.test(source) || /React\.useReducer\s*[<(]/.test(source)) {
    add(3, 'state management (useReducer)');
  }

  // ── Event dispatch ──────────────────────────────────────────────────
  if (/\bnew\s+\w*Event\w*\s*[<(]/.test(source) || /\bclass\s+\w*Event\w*\b/.test(source)) {
    add(3, 'event creation/dispatch');
  }
  if (/\bdispatchEvent\s*\(/.test(source)) {
    add(3, 'DOM event dispatch');
  }
  if (/\bpreventDefault\s*\(/.test(source) || /\bstopPropagation\s*\(/.test(source)) {
    add(1, 'event control flow');
  }
  // Functions named fire*/dispatch*/emit*
  if (/\bfunction\s+(?:fire|dispatch|emit)\w*\s*[<(]/i.test(source) ||
      /\b(?:fire|dispatch|emit)\w*\s*=\s*(?:function|\()/i.test(source)) {
    add(2, 'event firing functions');
  }

  // ── DOM manipulation ────────────────────────────────────────────────
  if (/\bdocument\.(?:querySelector|getElementById|createElement|createTreeWalker)\s*\(/.test(source)) {
    add(2, 'DOM querying/creation');
  }
  if (/\.classList[.\[]/.test(source) ||
      /\.setAttribute\s*\(/.test(source) ||
      /\.removeAttribute\s*\(/.test(source)) {
    add(2, 'DOM attribute manipulation');
  }
  if (/\.scrollTo\s*\(/.test(source) || /\.scrollIntoView\s*\(/.test(source)) {
    add(2, 'scroll control');
  }
  if (/\.style\.\w+\s*=/.test(source)) {
    add(2, 'inline style manipulation');
  }

  // ── DOM observers ───────────────────────────────────────────────────
  if (/\bnew\s+(?:Intersection|Mutation|Resize)Observer\s*\(/.test(source)) {
    add(2, 'DOM observer');
  }

  // ── Timers / animation ─────────────────────────────────────────────
  if (/\brequestAnimationFrame\s*\(/.test(source) ||
      /\bsetTimeout\s*\(/.test(source) ||
      /\bsetInterval\s*\(/.test(source)) {
    add(1, 'timing/animation');
  }

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// Framework signal detection
// ---------------------------------------------------------------------------

function detectFrameworkSignals(source: string): SignalResult {
  const reasons: string[] = [];
  let score = 0;

  function add(points: number, reason: string) {
    score += points;
    reasons.push(reason);
  }

  // ── External package imports (framework infrastructure) ─────────────
  const externalPkgs = new Set<string>();
  for (const m of source.matchAll(/from\s+['"]([@\w][^'"]*)['"]/g)) {
    const pkg = m[1];
    if (/^react(?:$|\/|-dom)/.test(pkg)) continue;  // React itself
    if (pkg.startsWith('node:')) continue;            // Node builtins
    externalPkgs.add(pkg);
  }
  if (externalPkgs.size > 0) {
    const short = [...externalPkgs].map(p => {
      const segs = p.split('/');
      return segs[0].startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
    });
    add(3, `external package import (${[...new Set(short)].join(', ')})`);
  }

  // ── forwardRef without state management ─────────────────────────────
  if (/\bforwardRef\s*[<(]/.test(source)) {
    const hasState =
      /\buseState\s*[<(]/.test(source) || /React\.useState\s*[<(]/.test(source) ||
      /\buseReducer\s*[<(]/.test(source) || /React\.useReducer\s*[<(]/.test(source);
    if (!hasState) {
      add(2, 'forwardRef without state management');
    }
  }

  // ── Telemetry / metrics references ──────────────────────────────────
  if (/(?:Metrics|Telemetry|Metadata|Analytics)\w*\s*[=(]/.test(source) ||
      /\buse\w*(?:Metrics|Telemetry|Metadata|Analytics)\b/.test(source)) {
    add(1, 'telemetry/metrics infrastructure');
  }

  // ── Display name boilerplate ────────────────────────────────────────
  if (/\.displayName\s*=/.test(source)) {
    add(1, 'display name boilerplate');
  }

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');
}
