/**
 * Shared helpers for transforming all text fields in a ComponentIR.
 *
 * Many transforms (cleanup, events, clsx, identifiers, react-types)
 * need to apply a rewrite function to every text field in the IR.
 * This module provides a single entry point for that pattern, ensuring
 * new IR fields are never forgotten.
 */
import type { ComponentIR } from './types.js';
import { walkTemplate } from '../template-walker.js';

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
    controllers: ir.controllers.map((c) => ({
      ...c,
      constructorArgs: fn(c.constructorArgs),
    })),
    fileTypeDeclarations: ir.fileTypeDeclarations.map(fn),
    fileConstants: ir.fileConstants.map(fn),
  };
}

// ---------------------------------------------------------------------------
// IR text collection — for reference-checking (imports, code scanning)
// ---------------------------------------------------------------------------

/**
 * Collect all code text from the IR into a single string.
 *
 * Used for reference-checking: determining whether a name (import, type,
 * function) appears anywhere in the generated output. Includes code bodies,
 * type annotations, template expressions, and constant declarations.
 */
export function collectIRText(ir: ComponentIR): string {
  const parts: string[] = [];

  for (const h of ir.handlers) {
    parts.push(h.body);
    if (h.params) parts.push(h.params);
    if (h.returnType) parts.push(h.returnType);
  }
  for (const e of ir.effects) {
    parts.push(e.body);
    if (e.cleanup) parts.push(e.cleanup);
  }
  for (const h of ir.helpers) parts.push(h.source);
  for (const m of ir.publicMethods) {
    parts.push(m.body);
    if (m.params) parts.push(m.params);
  }
  for (const c of ir.computedValues) {
    parts.push(c.expression);
    if (c.type) parts.push(c.type);
  }
  for (const s of ir.state) {
    parts.push(s.initialValue);
    if (s.type) parts.push(s.type);
  }
  for (const r of ir.refs) {
    parts.push(r.initialValue);
    if (r.type) parts.push(r.type);
  }
  for (const c of ir.controllers) parts.push(c.constructorArgs);
  for (const p of ir.props) parts.push(p.type);
  parts.push(...ir.bodyPreamble);
  parts.push(...ir.fileConstants);
  parts.push(...ir.fileTypeDeclarations);

  // Template expressions
  walkTemplate(ir.template, {
    expression: (expr) => { parts.push(expr); return expr; },
    attributeExpression: (expr) => { parts.push(expr); return expr; },
    conditionExpression: (expr) => { parts.push(expr); return expr; },
    loopIterable: (expr) => { parts.push(expr); return expr; },
  });

  return parts.join('\n');
}
