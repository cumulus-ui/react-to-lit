/**
 * JSX → Lit tagged template transformer.
 *
 * A TypeScript TransformerFactory that converts all JSX nodes in a source file
 * into Lit html`` tagged template expressions. Uses recursive visitor pattern —
 * handles JSX in ANY expression context (map callbacks, ternaries, property
 * values, helper returns) automatically.
 *
 * Runs BEFORE IR extraction so all downstream code operates on JSX-free source.
 */
import ts from 'typescript';
import { REMOVE_ATTRS, REMOVE_ATTR_PREFIXES, shouldUnwrapComponent } from '../cloudscape-config.js';
import { getHtmlTagNames, isVoidElement } from '../standards.js';
import { toTagName, toLitEventName, classifyBinding, reactAttrToHtml } from '../naming.js';

// ---------------------------------------------------------------------------
// Configuration interface
// ---------------------------------------------------------------------------

/** Configuration for the JSX-to-Lit transformer. All fields are optional —
 *  omitting any field falls back to the Cloudscape defaults. */
export interface JsxToLitConfig {
  /** Attribute names to remove from JSX elements. */
  removeAttributes?: Set<string>;
  /** Attribute name prefixes to remove from JSX elements. */
  removeAttributePrefixes?: string[];
  /** Predicate that returns true for component names that should be unwrapped
   *  (children kept, wrapper element discarded). */
  shouldUnwrap?: (name: string) => boolean;
}

// ---------------------------------------------------------------------------
// Resolved (internal) config — all fields guaranteed present
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  removeAttrs: Set<string>;
  removeAttrPrefixes: string[];
  shouldUnwrap: (name: string) => boolean;
}

function resolveConfig(config?: JsxToLitConfig): ResolvedConfig {
  return {
    removeAttrs: config?.removeAttributes ?? REMOVE_ATTRS,
    removeAttrPrefixes: config?.removeAttributePrefixes ?? REMOVE_ATTR_PREFIXES,
    shouldUnwrap: config?.shouldUnwrap ?? shouldUnwrapComponent,
  };
}

// ---------------------------------------------------------------------------
// The transformer factory
// ---------------------------------------------------------------------------

/**
 * Create a TransformerFactory that converts JSX to Lit html`` tagged templates.
 *
 * Accepts optional config to override which attributes are removed and which
 * components are unwrapped. When config is omitted the Cloudscape defaults
 * from `cloudscape-config.ts` are used.
 */
export function createJsxToLitTransformerFactory(
  config?: JsxToLitConfig,
): ts.TransformerFactory<ts.SourceFile> {
  const resolved = resolveConfig(config);
  return (context: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (sourceFile) => {
      function visitor(node: ts.Node): ts.Node | ts.Node[] {
        // Transform JSX elements
        if (ts.isJsxElement(node)) {
          return convertJsxElement(node, visitor, context, resolved);
        }
        if (ts.isJsxSelfClosingElement(node)) {
          return convertSelfClosing(node, visitor, context, resolved);
        }
        if (ts.isJsxFragment(node)) {
          return convertFragment(node, visitor, context);
        }

        // Recurse into ALL other nodes
        return ts.visitEachChild(node, visitor, context);
      }

      return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
    };
  };
}

/**
 * Backward-compatible transformer factory that uses Cloudscape defaults.
 *
 * Can be passed directly to `ts.transform(sourceFile, [jsxToLitTransformerFactory])`.
 */
export function jsxToLitTransformerFactory(
  context: ts.TransformationContext,
): ts.Transformer<ts.SourceFile> {
  return createJsxToLitTransformerFactory()(context);
}

// ---------------------------------------------------------------------------
// JSX Element conversion
// ---------------------------------------------------------------------------

function convertJsxElement(
  node: ts.JsxElement,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
  cfg: ResolvedConfig,
): ts.Expression {
  const originalTag = getOriginalTagName(node.openingElement.tagName);

  // WithNativeAttributes: extract tag prop, use as element, keep other attrs
  if (originalTag === 'WithNativeAttributes') {
    return convertWithNativeAttributes(node, visitor, context, cfg);
  }

  // Unwrap components (keep children only)
  if (cfg.shouldUnwrap(originalTag)) {
    return convertChildrenToTemplate(node.children, visitor, context);
  }

  const tagName = resolveTagName(node.openingElement.tagName, cfg);
  const builder = new TemplateBuilder();

  // Opening tag
  builder.appendStatic(`<${tagName}`);

  // Attributes
  emitAttributes(node.openingElement.attributes, builder, visitor, context, cfg);

  builder.appendStatic('>');

  // Children
  emitChildren(node.children, builder, visitor, context);

  if (!isVoidElement(tagName)) {
    builder.appendStatic(`</${tagName}>`);
  }

  return builder.build();
}

function convertSelfClosing(
  node: ts.JsxSelfClosingElement,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
  cfg: ResolvedConfig,
): ts.Expression {
  const tagName = resolveTagName(node.tagName, cfg);

  if (cfg.shouldUnwrap(getOriginalTagName(node.tagName))) {
    // Self-closing unwrap → nothing
    return ts.factory.createIdentifier('nothing');
  }

  const builder = new TemplateBuilder();

  builder.appendStatic(`<${tagName}`);
  emitAttributes(node.attributes, builder, visitor, context, cfg);
  if (isVoidElement(tagName)) {
    builder.appendStatic('>');
  } else {
    builder.appendStatic(`></${tagName}>`);
  }

  return builder.build();
}

function convertFragment(
  node: ts.JsxFragment,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.Expression {
  return convertChildrenToTemplate(node.children, visitor, context);
}

/**
 * Convert <WithNativeAttributes tag="span" className={...} ...>
 * Extract the tag prop value, use it as the element tag, keep className and other attrs.
 */
function convertWithNativeAttributes(
  node: ts.JsxElement,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
  cfg: ResolvedConfig,
): ts.Expression {
  const attrs = node.openingElement.attributes;
  let tagName = 'div'; // default

  // Find the tag prop
  for (const attr of attrs.properties) {
    if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === 'tag') {
      if (attr.initializer && ts.isStringLiteral(attr.initializer)) {
        tagName = attr.initializer.text;
      }
    }
  }

  const builder = new TemplateBuilder();
  builder.appendStatic(`<${tagName}`);

  // Emit non-WNA attributes (className, style, etc.)
  const wnaSkip = new Set(['tag', 'componentName', 'nativeAttributes', 'skipWarnings', 'ref', ...cfg.removeAttrs]);
  for (const attr of attrs.properties) {
    if (ts.isJsxAttribute(attr)) {
      const attrName = ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText();
      if (wnaSkip.has(attrName)) continue;
      emitAttribute(attr, builder, visitor, context, cfg);
    }
  }

  builder.appendStatic('>');
  emitChildren(node.children, builder, visitor, context);
  if (!isVoidElement(tagName)) {
    builder.appendStatic(`</${tagName}>`);
  }

  return builder.build();
}

function convertChildrenToTemplate(
  children: ts.NodeArray<ts.JsxChild>,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): ts.Expression {
  const builder = new TemplateBuilder();
  emitChildren(children, builder, visitor, context);
  if (builder.isEmpty()) {
    return ts.factory.createIdentifier('nothing');
  }
  return builder.build();
}

// ---------------------------------------------------------------------------
// Attribute emission
// ---------------------------------------------------------------------------

function emitAttributes(
  attributes: ts.JsxAttributes,
  builder: TemplateBuilder,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
  cfg: ResolvedConfig,
): void {
  for (const attr of attributes.properties) {
    if (ts.isJsxAttribute(attr)) {
      emitAttribute(attr, builder, visitor, context, cfg);
    } else if (ts.isJsxSpreadAttribute(attr)) {
      // Spread attributes — skip (no Lit equivalent)
      // Could be expanded to individual attrs if needed
    }
  }
}

function emitAttribute(
  attr: ts.JsxAttribute,
  builder: TemplateBuilder,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
  cfg: ResolvedConfig,
): void {
  const name = ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText();

  // Skip infrastructure attributes
  if (cfg.removeAttrs.has(name)) return;
  if (cfg.removeAttrPrefixes.some((p) => name.startsWith(p))) return;

  // Map attribute names
  const litName = mapAttributeName(name);
  if (!litName) return;

  // No value = boolean true: <input disabled />
  if (!attr.initializer) {
    builder.appendStatic(` ${litName}`);
    return;
  }

  // String literal: <div id="foo" />
  if (ts.isStringLiteral(attr.initializer)) {
    builder.appendStatic(` ${litName}="${attr.initializer.text}"`);
    return;
  }

  // Expression: <div className={expr} />
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    // Visit the expression to transform any nested JSX
    const visitedExpr = ts.visitNode(attr.initializer.expression, visitor) as ts.Expression;

    // Special handling for className → class with classMap
    if (name === 'className') {
      builder.appendStatic(` class=`);
      builder.addExpression(visitedExpr);
      return;
    }

    const kind = classifyBinding(litName);
    switch (kind) {
      case 'event': {
        const eventName = toLitEventName(name);
        builder.appendStatic(` @${eventName}=`);
        break;
      }
      case 'boolean':
        builder.appendStatic(` ?${litName}=`);
        break;
      case 'attribute':
        builder.appendStatic(` ${litName}=`);
        break;
      case 'property':
      default:
        builder.appendStatic(` .${litName}=`);
        break;
    }
    builder.addExpression(visitedExpr);
    return;
  }
}

function mapAttributeName(name: string): string | null {
  return reactAttrToHtml(name);
}

// ---------------------------------------------------------------------------
// Children emission
// ---------------------------------------------------------------------------

function emitChildren(
  children: ts.NodeArray<ts.JsxChild>,
  builder: TemplateBuilder,
  visitor: ts.Visitor,
  context: ts.TransformationContext,
): void {
  for (const child of children) {
    if (ts.isJsxText(child)) {
      const text = child.text;
      if (text.trim()) {
        builder.appendStatic(text);
      }
    } else if (ts.isJsxExpression(child)) {
      if (child.expression) {
        // Check if this is a {children} expression → <slot></slot>
        if (ts.isIdentifier(child.expression) && child.expression.text === 'children') {
          builder.appendStatic('<slot></slot>');
          continue;
        }
        // Visit the expression — transforms any nested JSX
        const visited = ts.visitNode(child.expression, visitor) as ts.Expression;
        builder.addExpression(visited);
      }
    } else if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      const visited = ts.visitNode(child, visitor) as ts.Expression;
      builder.addExpression(visited);
    }
  }
}

// ---------------------------------------------------------------------------
// Tag name resolution
// ---------------------------------------------------------------------------

function resolveTagName(tagName: ts.JsxTagNameExpression, cfg: ResolvedConfig): string {
  const original = getOriginalTagName(tagName);

  // Native HTML tag (from DOM spec)
  if (getHtmlTagNames().has(original)) return original;

  // React builtins and wrappers to unwrap
  if (cfg.shouldUnwrap(original)) return '__unwrap__';

  // PascalCase component → el-kebab-name
  if (/^[A-Z]/.test(original)) return toTagName(original);

  // Lowercase (already a custom element tag) — pass through
  return original;
}

function getOriginalTagName(tagName: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tagName)) return tagName.text;
  if (ts.isPropertyAccessExpression(tagName)) {
    const obj = tagName.expression.getText();
    const prop = tagName.name.text;
    if (obj === 'React' && prop === 'Fragment') return 'Fragment';
    // Return full name (e.g., "ButtonContext.Provider") so shouldUnwrapComponent
    // can match both explicit entries and the *.Provider/*.Consumer pattern
    return `${obj}.${prop}`;
  }
  return tagName.getText();
}

// ---------------------------------------------------------------------------
// Template builder — assembles quasis[] and expressions[]
// ---------------------------------------------------------------------------

class TemplateBuilder {
  private quasis: string[] = [''];
  private expressions: ts.Expression[] = [];

  appendStatic(text: string): void {
    this.quasis[this.quasis.length - 1] += text;
  }

  addExpression(expr: ts.Expression): void {
    this.expressions.push(expr);
    this.quasis.push('');
  }

  isEmpty(): boolean {
    return this.quasis.length === 1 && this.quasis[0].trim() === '' && this.expressions.length === 0;
  }

  build(): ts.TaggedTemplateExpression {
    // Build TemplateExpression: html`quasi0${expr0}quasi1${expr1}quasi2`
    const head = ts.factory.createTemplateHead(this.quasis[0], this.quasis[0]);

    if (this.expressions.length === 0) {
      // No expressions — use NoSubstitutionTemplateLiteral
      const template = ts.factory.createNoSubstitutionTemplateLiteral(
        this.quasis[0],
        this.quasis[0],
      );
      return ts.factory.createTaggedTemplateExpression(
        ts.factory.createIdentifier('html'),
        undefined,
        template,
      );
    }

    const spans: ts.TemplateSpan[] = [];
    for (let i = 0; i < this.expressions.length; i++) {
      const isLast = i === this.expressions.length - 1;
      const literal = isLast
        ? ts.factory.createTemplateTail(this.quasis[i + 1], this.quasis[i + 1])
        : ts.factory.createTemplateMiddle(this.quasis[i + 1], this.quasis[i + 1]);
      spans.push(ts.factory.createTemplateSpan(this.expressions[i], literal));
    }

    const template = ts.factory.createTemplateExpression(head, spans);
    return ts.factory.createTaggedTemplateExpression(
      ts.factory.createIdentifier('html'),
      undefined,
      template,
    );
  }
}
