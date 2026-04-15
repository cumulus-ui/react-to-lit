import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildDependencyGraph, type DependencyGraph, type DependencyNode } from '../src/dependency-graph.js';

const CLOUDSCAPE_SRC = path.resolve('vendor/cloudscape-source/src');

describe('buildDependencyGraph', () => {
  let graph: DependencyGraph;

  // Build graph once for all tests — it's read-only
  it('builds a graph from Cloudscape source', () => {
    graph = buildDependencyGraph(CLOUDSCAPE_SRC);
    expect(graph.nodes.size).toBeGreaterThan(100);
  });

  // ---------------------------------------------------------------------------
  // Node existence
  // ---------------------------------------------------------------------------

  it('includes button/internal.tsx', () => {
    expect(graph.nodes.has('button/internal.tsx')).toBe(true);
  });

  it('includes button/index.tsx', () => {
    expect(graph.nodes.has('button/index.tsx')).toBe(true);
  });

  it('includes internal hooks', () => {
    expect(graph.nodes.has('internal/hooks/use-base-component/index.ts')).toBe(true);
    expect(graph.nodes.has('internal/hooks/use-controllable/index.ts')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Import edges
  // ---------------------------------------------------------------------------

  it('button/internal.tsx imports internal/events/index.ts', () => {
    const button = graph.nodes.get('button/internal.tsx')!;
    expect(button.imports).toContain('internal/events/index.ts');
  });

  it('button/internal.tsx imports icon/internal.tsx', () => {
    const button = graph.nodes.get('button/internal.tsx')!;
    expect(button.imports).toContain('icon/internal.tsx');
  });

  it('button/internal.tsx imports button/interfaces.ts', () => {
    const button = graph.nodes.get('button/internal.tsx')!;
    expect(button.imports).toContain('button/interfaces.ts');
  });

  it('button/index.tsx imports button/internal.tsx', () => {
    const idx = graph.nodes.get('button/index.tsx')!;
    expect(idx.imports).toContain('button/internal.tsx');
  });

  // ---------------------------------------------------------------------------
  // Module classification
  // ---------------------------------------------------------------------------

  it('classifies button/internal.tsx as component', () => {
    expect(graph.nodes.get('button/internal.tsx')!.kind).toBe('component');
  });

  it('classifies button/index.tsx as component', () => {
    expect(graph.nodes.get('button/index.tsx')!.kind).toBe('component');
  });

  it('classifies use-base-component as hook', () => {
    expect(graph.nodes.get('internal/hooks/use-base-component/index.ts')!.kind).toBe('hook');
  });

  it('classifies use-controllable as hook', () => {
    expect(graph.nodes.get('internal/hooks/use-controllable/index.ts')!.kind).toBe('hook');
  });

  it('classifies internal/events/index.ts as utility', () => {
    // events/index.ts exports functions (fireCancelableEvent, etc.) — not a hook/component/context
    expect(graph.nodes.get('internal/events/index.ts')!.kind).toBe('utility');
  });

  it('classifies internal/context/button-context.ts as context', () => {
    expect(graph.nodes.get('internal/context/button-context.ts')!.kind).toBe('context');
  });

  // ---------------------------------------------------------------------------
  // importedBy counts
  // ---------------------------------------------------------------------------

  it('internal/events has importedBy > 1', () => {
    const events = graph.nodes.get('internal/events/index.ts')!;
    expect(events.importedBy).toBeGreaterThan(1);
  });

  it('use-base-component has high importedBy', () => {
    const hook = graph.nodes.get('internal/hooks/use-base-component/index.ts')!;
    expect(hook.importedBy).toBeGreaterThan(5);
  });

  // ---------------------------------------------------------------------------
  // Shared modules
  // ---------------------------------------------------------------------------

  it('sharedModules includes internal/events', () => {
    expect(graph.sharedModules).toContain('internal/events/index.ts');
  });

  it('sharedModules contains multiple entries', () => {
    expect(graph.sharedModules.length).toBeGreaterThan(5);
  });

  it('sharedModules is sorted', () => {
    const sorted = [...graph.sharedModules].sort();
    expect(graph.sharedModules).toEqual(sorted);
  });

  // ---------------------------------------------------------------------------
  // Type-only classification
  // ---------------------------------------------------------------------------

  it('classifies files exporting only types as type-only', () => {
    // Look for at least one type-only module in the graph
    const typeOnlyNodes = [...graph.nodes.values()].filter(n => n.kind === 'type-only');
    expect(typeOnlyNodes.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('does not include self-imports', () => {
    for (const [relPath, node] of graph.nodes) {
      expect(node.imports).not.toContain(relPath);
    }
  });

  it('all import targets are known nodes or external', () => {
    for (const [, node] of graph.nodes) {
      for (const imp of node.imports) {
        expect(graph.nodes.has(imp)).toBe(true);
      }
    }
  });
});
