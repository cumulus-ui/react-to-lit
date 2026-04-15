/**
 * Compute generation order for components.
 *
 * Performs a topological sort on the dependency graph so that shared
 * sub-components are generated before the components that import them.
 * Handles cycles by breaking at the least-imported edge.
 */
import type { DependencyGraph, DependencyNode } from '../dependency-graph.js';

/**
 * Return component paths in topological order — dependencies first.
 *
 * Only component-kind nodes are included in the output. Shared modules
 * that are components appear before the components that reference them.
 */
export function computeGenerationOrder(graph: DependencyGraph): string[] {
  // Collect only component nodes
  const componentPaths = new Set<string>();
  for (const [p, node] of graph.nodes) {
    if (node.kind === 'component') {
      componentPaths.add(p);
    }
  }

  // Build adjacency: for each component, which other components does it depend on?
  const deps = new Map<string, Set<string>>();
  for (const p of componentPaths) {
    deps.set(p, new Set());
  }

  for (const p of componentPaths) {
    const node = graph.nodes.get(p)!;
    for (const imp of node.imports) {
      if (componentPaths.has(imp)) {
        deps.get(p)!.add(imp);
      }
    }
  }

  // Kahn's algorithm with cycle-breaking
  const inDegree = new Map<string, number>();
  for (const p of componentPaths) {
    inDegree.set(p, 0);
  }
  for (const [, targets] of deps) {
    for (const t of targets) {
      inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
    }
  }

  // Wait — inDegree counts how many nodes depend ON a node, but for
  // topological sort we need inDegree = how many dependencies a node has
  // that haven't been resolved yet. Let me redo this properly.
  //
  // Actually Kahn's: inDegree[v] = number of edges pointing INTO v.
  // An edge u→v means "u depends on v" (v must come first).
  // So inDegree[v] = number of nodes that depend on v... no.
  //
  // Let's define edges correctly:
  //   edge v → u means "v must be generated before u" (u depends on v).
  //   So if component A imports component B, edge B → A.
  //   inDegree[u] = number of prerequisites for u.

  // Rebuild: edges go from dependency TO dependent
  const forward = new Map<string, Set<string>>();
  const inDeg = new Map<string, number>();

  for (const p of componentPaths) {
    forward.set(p, new Set());
    inDeg.set(p, 0);
  }

  for (const [dependent, dependencies] of deps) {
    for (const dep of dependencies) {
      // dep must come before dependent → edge dep → dependent
      forward.get(dep)!.add(dependent);
      inDeg.set(dependent, (inDeg.get(dependent) ?? 0) + 1);
    }
  }

  const order: string[] = [];
  const queue: string[] = [];

  // Seed with nodes that have no prerequisites
  for (const [p, deg] of inDeg) {
    if (deg === 0) queue.push(p);
  }
  // Sort queue for deterministic output
  queue.sort();

  while (queue.length > 0) {
    // Always pick the alphabetically first to ensure determinism
    queue.sort();
    const current = queue.shift()!;
    order.push(current);

    for (const next of forward.get(current)!) {
      const newDeg = inDeg.get(next)! - 1;
      inDeg.set(next, newDeg);
      if (newDeg === 0) {
        queue.push(next);
      }
    }
  }

  // If we haven't placed all nodes, there's a cycle.
  // Break cycles by picking the node with the fewest importers (least-imported edge).
  if (order.length < componentPaths.size) {
    const remaining = new Set<string>();
    for (const p of componentPaths) {
      if (!order.includes(p)) remaining.add(p);
    }

    while (remaining.size > 0) {
      // Pick the node in the cycle with the lowest importedBy count
      let best: string | null = null;
      let bestScore = Infinity;

      for (const p of remaining) {
        const node = graph.nodes.get(p)!;
        if (node.importedBy < bestScore) {
          bestScore = node.importedBy;
          best = p;
        }
      }

      if (!best) break;

      // Force-emit this node, then propagate
      const breakQueue = [best];
      while (breakQueue.length > 0) {
        breakQueue.sort();
        const current = breakQueue.shift()!;
        if (!remaining.has(current)) continue;
        remaining.delete(current);
        order.push(current);

        for (const next of forward.get(current)!) {
          if (!remaining.has(next)) continue;
          const newDeg = inDeg.get(next)! - 1;
          inDeg.set(next, newDeg);
          if (newDeg <= 0) {
            breakQueue.push(next);
          }
        }
      }
    }
  }

  return order;
}
