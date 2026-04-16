/// <reference lib="dom" />
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Pure-JS shims for the handful of non-React helpers that Cloudscape
// utilities import from @cloudscape-design/component-toolkit.
// The toolkit itself has React as a peer dep and ships CJS, so we
// re-implement the ~6 tiny functions here for use in the Lit output.

// ---------------------------------------------------------------------------
// warnOnce
// ---------------------------------------------------------------------------
const warned = new Set<string>();

export function warnOnce(component: string, message: string): void {
  const key = `[${component}] ${message}`;
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  console.warn(key);
}

/** @internal — exposed only for tests to reset state between runs. */
export function _resetWarnOnce(): void {
  warned.clear();
}

// ---------------------------------------------------------------------------
// getIsRtl
// ---------------------------------------------------------------------------
export function getIsRtl(element: Element): boolean {
  const style =
    typeof getComputedStyle === 'function' ? getComputedStyle(element) : undefined;
  return style?.direction === 'rtl';
}

// ---------------------------------------------------------------------------
// findUpUntil
// ---------------------------------------------------------------------------
export function findUpUntil(
  node: HTMLElement,
  predicate: (element: HTMLElement) => boolean,
): HTMLElement | null {
  let current: HTMLElement | null = node;
  while (current && !predicate(current)) {
    current = current.parentElement;
  }
  return current;
}

// ---------------------------------------------------------------------------
// nodeContains
// ---------------------------------------------------------------------------
export function nodeContains(
  parent: Node | null,
  child: Node | null,
): boolean {
  if (parent === null || child === null) {
    return false;
  }
  // Walk up from child through shadow roots to handle Shadow DOM
  let current: Node | null = child;
  while (current) {
    if (parent.contains(current)) {
      return true;
    }
    // Cross shadow boundary
    current =
      (current.getRootNode() as ShadowRoot).host ?? null;
  }
  return false;
}

// ---------------------------------------------------------------------------
// getLogicalBoundingClientRect
// ---------------------------------------------------------------------------
export interface LogicalDOMRect {
  blockSize: number;
  inlineSize: number;
  insetBlockStart: number;
  insetBlockEnd: number;
  insetInlineStart: number;
  insetInlineEnd: number;
}

export function getLogicalBoundingClientRect(element: Element): LogicalDOMRect {
  const rect = element.getBoundingClientRect();
  const isRtl = getIsRtl(element);

  return {
    blockSize: rect.height,
    inlineSize: rect.width,
    insetBlockStart: rect.top,
    insetBlockEnd: rect.bottom,
    insetInlineStart: isRtl ? window.innerWidth - rect.right : rect.left,
    insetInlineEnd: isRtl ? window.innerWidth - rect.left : rect.right,
  };
}

// ---------------------------------------------------------------------------
// KeyCode
// ---------------------------------------------------------------------------
export enum KeyCode {
  pageUp = 33,
  pageDown = 34,
  end = 35,
  home = 36,
  backspace = 8,
  space = 32,
  down = 40,
  left = 37,
  right = 39,
  up = 38,
  escape = 27,
  enter = 13,
  tab = 9,
}
