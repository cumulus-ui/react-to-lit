/**
 * Template emission.
 *
 * Converts TemplateNodeIR into a Lit html`` tagged template string.
 * Uses a single html`` at the render() level; children are emitted
 * as raw template content (not nested html`` calls).
 */
import type {
  TemplateNodeIR,
  AttributeIR,
  DynamicValueIR,
} from '../ir/types.js';
import type { ImportCollector } from './imports.js';
import { toLitEventName } from '../naming.js';

// ---------------------------------------------------------------------------
// Main emission
// ---------------------------------------------------------------------------

export function emitRenderMethod(
  template: TemplateNodeIR,
  collector: ImportCollector,
): string {
  const lines: string[] = [];
  lines.push('  override render() {');

  // If the template is a single expression containing html`...` (from JSX transformer),
  // emit it directly without wrapping in another html``
  if (template.kind === 'expression' && template.expression?.startsWith('html')) {
    lines.push(`    return ${template.expression};`);
  } else {
    const body = emitNodeInline(template, collector, 4);
    lines.push(`    return html\`\n${body}\n    \`;`);
  }

  lines.push('  }');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Inline node emission (no wrapping html``)
// ---------------------------------------------------------------------------

/**
 * Emit a node as inline template content (within a parent html``).
 * Children are recursively emitted inline.
 */
function emitNodeInline(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  const pad = ' '.repeat(indent);

  // Handle conditional wrapping
  if (node.condition) {
    return emitConditionalInline(node, collector, indent);
  }

  // Handle loop wrapping
  if (node.loop) {
    return emitLoopInline(node, collector, indent);
  }

  switch (node.kind) {
    case 'element':
    case 'component':
      return emitElementInline(node, collector, indent);
    case 'fragment':
      return emitFragmentInline(node, collector, indent);
    case 'text':
      return `${pad}${node.expression ?? ''}`;
    case 'expression':
      return `${pad}\${${node.expression}}`;
    case 'slot':
      return emitSlotInline(node, indent);
    default:
      return `${pad}/* unknown node kind: ${node.kind} */`;
  }
}

// ---------------------------------------------------------------------------
// Element emission (inline)
// ---------------------------------------------------------------------------

function emitElementInline(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  const pad = ' '.repeat(indent);
  const tag = node.tag ?? 'div';
  const attrs = emitAttributes(node.attributes, collector);
  const attrStr = attrs ? ' ' + attrs : '';

  if (node.children.length === 0) {
    return `${pad}<${tag}${attrStr}></${tag}>`;
  }

  const childStr = node.children
    .map((child) => emitNodeInline(child, collector, indent + 2))
    .join('\n');

  return `${pad}<${tag}${attrStr}>\n${childStr}\n${pad}</${tag}>`;
}

// ---------------------------------------------------------------------------
// Fragment emission (inline)
// ---------------------------------------------------------------------------

function emitFragmentInline(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  if (node.children.length === 0) return '';

  return node.children
    .map((child) => emitNodeInline(child, collector, indent))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Slot emission (inline)
// ---------------------------------------------------------------------------

function emitSlotInline(node: TemplateNodeIR, indent: number): string {
  const pad = ' '.repeat(indent);
  const nameAttr = node.attributes.find((a) => a.name === 'name');
  if (nameAttr && typeof nameAttr.value === 'string') {
    return `${pad}<slot name="${nameAttr.value}"></slot>`;
  }
  return `${pad}<slot></slot>`;
}

// ---------------------------------------------------------------------------
// Conditional emission (inline)
// ---------------------------------------------------------------------------

function emitConditionalInline(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  const pad = ' '.repeat(indent);
  const condition = node.condition!;
  collector.addLit('nothing');

  // Make a copy without the condition to emit the inner node
  const innerNode = { ...node, condition: undefined };
  const consequent = emitNodeInline(innerNode, collector, indent + 2);

  if (condition.kind === 'and') {
    return `${pad}\${${condition.expression}\n${pad}  ? html\`\n${consequent}\n${pad}  \`\n${pad}  : nothing}`;
  }

  // Ternary
  const alternate = condition.alternate
    ? emitNodeInline(condition.alternate, collector, indent + 2)
    : `${' '.repeat(indent + 2)}nothing`;

  const altIsSimple = !condition.alternate;
  const altContent = altIsSimple
    ? 'nothing'
    : `html\`\n${alternate}\n${pad}  \``;

  return `${pad}\${${condition.expression}\n${pad}  ? html\`\n${consequent}\n${pad}  \`\n${pad}  : ${altContent}}`;
}

// ---------------------------------------------------------------------------
// Loop emission (inline)
// ---------------------------------------------------------------------------

function emitLoopInline(
  node: TemplateNodeIR,
  collector: ImportCollector,
  indent: number,
): string {
  const pad = ' '.repeat(indent);
  const loop = node.loop!;
  const params = loop.index ? `${loop.variable}, ${loop.index}` : loop.variable;

  const innerNode = { ...node, loop: undefined };
  const body = emitNodeInline(innerNode, collector, indent + 2);

  // When the loop has a preamble (variable declarations from the .map callback body),
  // emit a block-body arrow to preserve local scope.
  if (loop.preamble && loop.preamble.length > 0) {
    const innerPad = ' '.repeat(indent + 2);
    const preambleCode = loop.preamble.map(s => `${innerPad}${s}`).join('\n');
    return `${pad}\${${loop.iterable}.map((${params}) => {\n${preambleCode}\n${innerPad}return html\`\n${body}\n${innerPad}\`;\n${pad}})}`;
  }

  return `${pad}\${${loop.iterable}.map((${params}) => html\`\n${body}\n${pad}\`)}`;
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

    case 'attribute':
      return `${attr.name}=\${${getExpression(attr.value)}}`;

    case 'boolean':
      return `?${attr.name}=\${${getExpression(attr.value)}}`;

    case 'event': {
      const litEventName = `@${toLitEventName(attr.name)}`;
      return `${litEventName}=\${${getExpression(attr.value)}}`;
    }

    case 'classMap': {
      const expr = getExpression(attr.value);
      // If the expression is already a classMap() call, use it directly.
      if (expr.startsWith('classMap(')) {
        collector.addDirective('lit/directives/class-map.js', 'classMap');
        return `class=\${${expr}}`;
      }
      // If the expression is a string literal or template literal (not an object),
      // emit as a plain class attribute — classMap only works with objects.
      if (/^['"`]/.test(expr) || expr === "''" || expr === '""') {
        return `class=${expr}`;
      }
      // If the expression contains html`` template literals, it's not a classMap-
      // compatible object — emit as a plain class binding to avoid TS2345.
      if (expr.includes('html`')) {
        return `class=\${${expr}}`;
      }
      collector.addDirective('lit/directives/class-map.js', 'classMap');
      return `class=\${classMap(${expr})}`;
    }

    case 'styleMap': {
      collector.addDirective('lit/directives/style-map.js', 'styleMap');
      const expr = getExpression(attr.value);
      if (expr.startsWith('styleMap(')) {
        return `style=\${${expr}}`;
      }
      return `style=\${styleMap(${expr})}`;
    }

    case 'spread':
      // Spreads are not directly supported in Lit — emit as comment
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
