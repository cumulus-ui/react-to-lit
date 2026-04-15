import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { buildDependencyGraph, type DependencyGraph } from '../src/dependency-graph.js';
import { analyzeHooks, analyzeSubComponents, type HookAnalysis, type SubComponentAnalysis } from '../src/shared-pattern-analyzer.js';

const CLOUDSCAPE_SRC = path.resolve('vendor/cloudscape-source/src');

describe('shared-pattern-analyzer', () => {
  let graph: DependencyGraph;
  let hookResults: Map<string, HookAnalysis>;
  let subComponentResults: Map<string, SubComponentAnalysis>;

  beforeAll(() => {
    graph = buildDependencyGraph(CLOUDSCAPE_SRC);
    hookResults = analyzeHooks(graph, CLOUDSCAPE_SRC);
    subComponentResults = analyzeSubComponents(graph, CLOUDSCAPE_SRC);
  }, 30_000);

  describe('analyzeHooks', () => {
    it('returns results for all hook nodes in the graph', () => {
      const hookNodes = [...graph.nodes.values()].filter(n => n.kind === 'hook');
      expect(hookResults.size).toBe(hookNodes.length);
    });

    it('classifies useControllable as controller (has state + lifecycle)', () => {
      const analysis = hookResults.get('internal/hooks/use-controllable/index.ts');
      expect(analysis).toBeDefined();
      expect(analysis!.litShape).toBe('controller');
      expect(analysis!.hasState).toBe(true);
      expect(analysis!.hasLifecycle).toBe(true);
    });

    it('classifies useBaseComponent as utility (delegates to other hooks)', () => {
      const analysis = hookResults.get('internal/hooks/use-base-component/index.ts');
      expect(analysis).toBeDefined();
      // useBaseComponent delegates to useVisualRefresh, useComponentMetrics, etc.
      // Without hardcoding names, static analysis sees mixed hook delegation → utility
      expect(analysis!.litShape).toBe('utility');
      expect(analysis!.hasState).toBe(false);
      expect(analysis!.hasLifecycle).toBe(false);
    });

    it('classifies forward-focus as eliminate (useImperativeHandle only)', () => {
      const analysis = hookResults.get('internal/hooks/forward-focus/index.ts');
      expect(analysis).toBeDefined();
      expect(analysis!.litShape).toBe('eliminate');
    });

    it('classifies usePrevious as controller (has ref + lifecycle)', () => {
      const analysis = hookResults.get('internal/hooks/use-previous/index.ts');
      expect(analysis).toBeDefined();
      expect(analysis!.litShape).toBe('controller');
      expect(analysis!.hasLifecycle).toBe(true);
      expect(analysis!.hasRef).toBe(true);
    });

    it('classifies useHasRendered as controller (has state + lifecycle)', () => {
      const analysis = hookResults.get('internal/hooks/use-has-rendered/index.ts');
      expect(analysis).toBeDefined();
      expect(analysis!.litShape).toBe('controller');
      expect(analysis!.hasState).toBe(true);
      expect(analysis!.hasLifecycle).toBe(true);
    });

    it('classifies useDateCache as eliminate (ref-only)', () => {
      const analysis = hookResults.get('internal/hooks/use-date-cache/index.ts');
      expect(analysis).toBeDefined();
      expect(analysis!.litShape).toBe('eliminate');
      expect(analysis!.hasRef).toBe(true);
    });

    it('every hook has a non-empty reason', () => {
      for (const [, analysis] of hookResults) {
        expect(analysis.reason.length).toBeGreaterThan(0);
      }
    });

    it('litShape is always one of the valid values', () => {
      const validShapes = new Set(['controller', 'utility', 'eliminate']);
      for (const [, analysis] of hookResults) {
        expect(validShapes.has(analysis.litShape)).toBe(true);
      }
    });

    it('produces a mix of shapes (not all the same)', () => {
      const shapes = new Set([...hookResults.values()].map(a => a.litShape));
      expect(shapes.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe('analyzeSubComponents', () => {
    it('returns results for shared component modules', () => {
      expect(subComponentResults.size).toBeGreaterThan(0);
    });

    it('detects icon/internal.tsx as template-child', () => {
      const analysis = subComponentResults.get('icon/internal.tsx');
      expect(analysis).toBeDefined();
      expect(analysis!.embeddingPattern).toBe('template-child');
      expect(analysis!.importedByCount).toBeGreaterThan(5);
    });

    it('all sub-components have importedByCount >= 2', () => {
      for (const [, analysis] of subComponentResults) {
        expect(analysis.importedByCount).toBeGreaterThanOrEqual(2);
      }
    });

    it('importedBy array length matches importedByCount', () => {
      for (const [, analysis] of subComponentResults) {
        expect(analysis.importedBy.length).toBe(analysis.importedByCount);
      }
    });

    it('embeddingPattern is always a valid value', () => {
      const validPatterns = new Set(['template-child', 'ref-target', 'context-provider', 'unknown']);
      for (const [, analysis] of subComponentResults) {
        expect(validPatterns.has(analysis.embeddingPattern)).toBe(true);
      }
    });

    it('importedBy arrays are sorted', () => {
      for (const [, analysis] of subComponentResults) {
        const sorted = [...analysis.importedBy].sort();
        expect(analysis.importedBy).toEqual(sorted);
      }
    });

    it('only includes component-kind modules (not hooks or utilities)', () => {
      for (const [relPath] of subComponentResults) {
        const node = graph.nodes.get(relPath);
        expect(node).toBeDefined();
        expect(node!.kind).toBe('component');
      }
    });
  });
});
