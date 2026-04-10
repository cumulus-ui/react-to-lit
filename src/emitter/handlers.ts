/**
 * Event handler method emission.
 *
 * Produces class methods from HandlerIR entries.
 */
import type { HandlerIR, PublicMethodIR } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Private handler emission
// ---------------------------------------------------------------------------

export function emitHandlers(handlers: HandlerIR[]): string {
  const lines: string[] = [];

  for (const handler of handlers) {
    const returnType = handler.returnType ? `: ${handler.returnType}` : '';
    lines.push(`  private _${handler.name} = (${handler.params})${returnType} => ${handler.body};`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public method emission (from useImperativeHandle)
// ---------------------------------------------------------------------------

export function emitPublicMethods(methods: PublicMethodIR[]): string {
  const lines: string[] = [];

  for (const method of methods) {
    lines.push(`  ${method.name}(${method.params}): void ${method.body}`);
    lines.push('');
  }

  return lines.join('\n');
}
