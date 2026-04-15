import type { ContextClassification } from '../context-classifier.js';

export function emitContextDefinition(ctx: ContextClassification): string {
  if (ctx.classification !== 'behavioral') return '';

  const contextName = camelCase(ctx.name);
  const typeName = ctx.name.endsWith('Value') ? ctx.name : `${ctx.name}Value`;

  const lines: string[] = [];
  lines.push(`import { createContext } from '@lit/context';`);
  lines.push('');

  if (ctx.valueType && ctx.valueType !== 'unknown') {
    lines.push(`export type ${typeName} = ${ctx.valueType};`);
    lines.push('');
    lines.push(`export const ${contextName} = createContext<${typeName}>('${kebabCase(ctx.name)}');`);
  } else {
    lines.push(`export const ${contextName} = createContext<unknown>('${kebabCase(ctx.name)}');`);
  }

  lines.push('');
  return lines.join('\n');
}

export function emitAllContexts(contexts: ContextClassification[]): Map<string, string> {
  const output = new Map<string, string>();
  for (const ctx of contexts) {
    const content = emitContextDefinition(ctx);
    if (content) {
      output.set(`${kebabCase(ctx.name)}.ts`, content);
    }
  }
  return output;
}

function camelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function kebabCase(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}
