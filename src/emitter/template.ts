/**
 * Template emission.
 *
 * Converts TemplateNodeIR into Lit html`` tagged template strings.
 */
import type {
  TemplateNodeIR,
  AttributeIR,
  DynamicValueIR,
} from '../ir/types.js';
import type { ImportCollector } from './imports.js';

// ---------------------------------------------------------------------------
// Main emission
// ---------------------------------------------------------------------------

export function emitRenderMethod(
  template: TemplateNodeIR,
  collector: ImportCollector,
): string {
  const lines: string[] = [];
  lines.push('  override render() {');
  lines.push(`    return ${emitNode(template, collector, 4)};`);
  lines.push('  }');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Node emission (recursive)
// ---------------------------------------------------------------------------

function emitNode(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  // Handle conditional wrapping
  if (node.condition) {
    return emitConditional(node, collector, indent);
  }

  // Handle loop wrapping
  if (node.loop) {
    return emitLoop(node, collector, indent);
  }

  switch (node.kind) {
    case 'element':
      return emitElement(node, collector, indent);
    case 'component':
      return emitComponent(node, collector, indent);
    case 'fragment':
      return emitFragment(node, collector, indent);
    case 'text':
      return JSON.stringify(node.expression ?? '');
    case 'expression':
      return `\${${node.expression}}`;
    case 'slot':
      return emitSlot(node);
    default:
      return `/* unknown node kind: ${node.kind} */`;
  }
}

// ---------------------------------------------------------------------------
// Element emission
// ---------------------------------------------------------------------------

function emitElement(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  const tag = node.tag!;
  const attrs = emitAttributes(node.attributes, collector);
  const attrStr = attrs ? ' ' + attrs : '';

  if (node.children.length === 0) {
    return `html\`<${tag}${attrStr}></${tag}>\``;
  }

  const pad = ' '.repeat(indent);
  const childStr = node.children
    .map((child) => `${pad}  ${emitNode(child, collector, indent + 2)}`)
    .join('\n');

  return `html\`\n${pad}<${tag}${attrStr}>\n${childStr}\n${pad}</${tag}>\n${pad}\``;
}

// ---------------------------------------------------------------------------
// Component emission
// ---------------------------------------------------------------------------

function emitComponent(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  // Components will be resolved to custom element tags by the transform phase.
  // For now, emit as-is with the component tag name.
  const tag = node.tag!;
  const attrs = emitAttributes(node.attributes, collector);
  const attrStr = attrs ? ' ' + attrs : '';

  if (node.children.length === 0) {
    return `html\`<${tag}${attrStr}></${tag}>\``;
  }

  const pad = ' '.repeat(indent);
  const childStr = node.children
    .map((child) => `${pad}  ${emitNode(child, collector, indent + 2)}`)
    .join('\n');

  return `html\`\n${pad}<${tag}${attrStr}>\n${childStr}\n${pad}</${tag}>\n${pad}\``;
}

// ---------------------------------------------------------------------------
// Fragment emission
// ---------------------------------------------------------------------------

function emitFragment(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  if (node.children.length === 0) {
    return `html\`\``;
  }

  if (node.children.length === 1) {
    return emitNode(node.children[0], collector, indent);
  }

  const pad = ' '.repeat(indent);
  const childStr = node.children
    .map((child) => `${pad}  ${emitNode(child, collector, indent + 2)}`)
    .join('\n');

  return `html\`\n${childStr}\n${pad}\``;
}

// ---------------------------------------------------------------------------
// Slot emission
// ---------------------------------------------------------------------------

function emitSlot(node: TemplateNodeIR): string {
  const nameAttr = node.attributes.find((a) => a.name === 'name');
  if (nameAttr && typeof nameAttr.value === 'string') {
    return `html\`<slot name="${nameAttr.value}"></slot>\``;
  }
  return `html\`<slot></slot>\``;
}

// ---------------------------------------------------------------------------
// Conditional emission
// ---------------------------------------------------------------------------

function emitConditional(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  collector.addLit('nothing');

  // Make a copy without the condition to emit the node itself
  const innerNode = { ...node, condition: undefined };
  const consequent = emitNode(innerNode, collector, indent);

  if (node.condition!.kind === 'and') {
    return `\${${node.condition!.expression} ? ${consequent} : nothing}`;
  }

  // Ternary
  const alternate = node.condition!.alternate
    ? emitNode(node.condition!.alternate, collector, indent)
    : 'nothing';

  return `\${${node.condition!.expression}\n      ? ${consequent}\n      : ${alternate}}`;
}

// ---------------------------------------------------------------------------
// Loop emission
// ---------------------------------------------------------------------------

function emitLoop(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  const { iterable, variable, index } = node.loop!;
  const params = index ? `${variable}, ${index}` : variable;

  // Make a copy without the loop to emit the node itself
  const innerNode = { ...node, loop: undefined };
  const body = emitNode(innerNode, collector, indent + 2);

  return `\${${iterable}.map((${params}) => ${body})}`;
}

// ---------------------------------------------------------------------------
// Attribute emission
// ---------------------------------------------------------------------------

function emitAttributes(
  attributes: AttributeIR[],
  collector: ImportCollector,
): string {
  const parts: string[] = [];

  for (const attr of attributes) {
    const emitted = emitAttribute(attr, collector);
    if (emitted) parts.push(emitted);
  }

  return parts.join(' ');
}

function emitAttribute(
  attr: AttributeIR,
  collector: ImportCollector,
): string | null {
  switch (attr.kind) {
    case 'static':
      return `${attr.name}="${attr.value}"`;

    case 'property':
      return `.${attr.name}=\${${getExpression(attr.value)}}`;

    case 'boolean':
      return `?${attr.name}=\${${getExpression(attr.value)}}`;

    case 'event': {
      // Convert React event name to Lit: onClick → @click
      const litEventName = reactEventToLit(attr.name);
      return `${litEventName}=\${${getExpression(attr.value)}}`;
    }

    case 'classMap': {
      collector.addDirective('lit/directives/class-map.js', 'classMap');
      // The expression is the raw clsx call — will be transformed in Phase 3
      return `class=\${classMap(${getExpression(attr.value)})}`;
    }

    case 'spread':
      // Spreads need to be handled differently in Lit
      return `/* spread: ${getExpression(attr.value)} */`;

    default:
      return `${attr.name}=\${${getExpression(attr.value)}}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getExpression(value: string | DynamicValueIR): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return value.expression;
}

/**
 * Convert React event handler name to Lit event binding.
 * onClick → @click, onKeyDown → @keydown, onFocus → @focus
 */
function reactEventToLit(name: string): string {
  if (!name.startsWith('on')) return `@${name}`;
  // Remove 'on' prefix and lowercase
  const eventName = name.slice(2).toLowerCase();
  return `@${eventName}`;
}
