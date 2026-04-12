/**
 * Shared helpers for transforming all text fields in a ComponentIR.
 *
 * Many transforms (cleanup, events, clsx, identifiers, react-types)
 * need to apply a rewrite function to every text field in the IR.
 * This module provides a single entry point for that pattern, ensuring
 * new IR fields are never forgotten.
 */
import type { ComponentIR } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MapTextOptions {
  /** Also transform handler params and return types (default: false) */
  params?: boolean;
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------

/**
 * Apply `fn` to every code-text field in the IR, returning a new IR.
 *
 * Covers: handlers (.body), effects (.body, .cleanup), helpers (.source),
 *         bodyPreamble, publicMethods (.body), computedValues (.expression),
 *         state (.initialValue), refs (.initialValue),
 *         fileTypeDeclarations, fileConstants.
 *
 * When `options.params` is true, also transforms handler/method params
 * and handler returnType.
 */
export function mapIRText(
  ir: ComponentIR,
  fn: (text: string) => string,
  options: MapTextOptions = {},
): ComponentIR {
  return {
    ...ir,
    handlers: ir.handlers.map((h) => ({
      ...h,
      body: fn(h.body),
      ...(options.params ? { params: fn(h.params) } : {}),
      ...(options.params && h.returnType ? { returnType: fn(h.returnType) } : {}),
    })),
    effects: ir.effects.map((e) => ({
      ...e,
      body: fn(e.body),
      cleanup: e.cleanup ? fn(e.cleanup) : undefined,
    })),
    helpers: ir.helpers.map((h) => ({
      ...h,
      source: fn(h.source),
    })),
    bodyPreamble: ir.bodyPreamble.map(fn),
    publicMethods: ir.publicMethods.map((m) => ({
      ...m,
      body: fn(m.body),
      ...(options.params ? { params: fn(m.params) } : {}),
    })),
    computedValues: ir.computedValues.map((c) => ({
      ...c,
      expression: fn(c.expression),
      ...(options.params && c.type ? { type: fn(c.type) } : {}),
    })),
    state: ir.state.map((s) => ({
      ...s,
      initialValue: fn(s.initialValue),
    })),
    refs: ir.refs.map((r) => ({
      ...r,
      initialValue: fn(r.initialValue),
    })),
    fileTypeDeclarations: ir.fileTypeDeclarations.map(fn),
    fileConstants: ir.fileConstants.map(fn),
  };
}
