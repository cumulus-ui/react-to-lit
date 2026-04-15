import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { PackageAnalyzer } from '../src/package-analyzer.js';
import { discoverComponents } from '../src/config.js';
import { buildRenderManifest, type ManifestComponent } from '../src/host-display.js';

const PACKAGE = '@cloudscape-design/components';
const SOURCE_ROOT = path.resolve('vendor/cloudscape-source/src');
const TMP_ROOT = path.resolve('test/.tmp-host-display');

let analyzer: PackageAnalyzer;
let allComponents: ManifestComponent[];

beforeAll(() => {
  analyzer = new PackageAnalyzer(PACKAGE);
  allComponents = discoverComponents(PACKAGE);
});

function manifestFor(name: string) {
  const comp = allComponents.find(c => c.name === name);
  if (!comp) throw new Error(`Component ${name} not found`);
  return buildRenderManifest([comp], analyzer, SOURCE_ROOT)[name];
}

describe('buildRenderManifest', () => {
  it('Badge: no skip, no context, no portal, empty props', () => {
    const entry = manifestFor('Badge');
    expect(entry.props).toEqual({});
    expect(entry.skip).toBeUndefined();
    expect(entry.context).toBeUndefined();
    expect(entry.portal).toBeUndefined();
  });

  it('FileInput: required props from generateDummyProps', () => {
    const entry = manifestFor('FileInput');
    expect(entry.props.value).toEqual([]);
    expect(entry.props.onChange).toBe('__NOOP_FN__');
  });

  it('SplitPanel: detects throwing context hook with provider info', () => {
    const entry = manifestFor('SplitPanel');
    expect(entry.context).toBeDefined();
    expect(entry.context!.providerName).toBe('SplitPanelContextProvider');
    expect(entry.context!.providerImport).toContain('split-panel-context');
    expect(entry.context!.mockValue).toEqual({});
  });

  it('Modal: detects Portal import', () => {
    const entry = manifestFor('Modal');
    expect(entry.portal).toBe(true);
  });

  it('AnnotationContext: detected as provider-only (skip)', () => {
    const entry = manifestFor('AnnotationContext');
    expect(entry.skip).toBe(true);
    expect(entry.reason).toBe('provider-only');
  });
});

describe('buildRenderManifest with synthetic sources', () => {
  const syntheticDir = path.join(TMP_ROOT, 'fake-comp');
  const contextDir = path.join(TMP_ROOT, 'fake-context');

  beforeAll(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
    mkdirSync(syntheticDir, { recursive: true });
    mkdirSync(contextDir, { recursive: true });
  });

  it('detects context from synthetic source with useXxxContext + throw', () => {
    writeFileSync(path.join(contextDir, 'my-context.ts'), [
      'import { useContext } from "react";',
      'import React from "react";',
      'const Ctx = React.createContext<{ foo: string } | null>(null);',
      'export const MyContextProvider = Ctx.Provider;',
      'export function useMyContext() {',
      '  const ctx = useContext(Ctx);',
      '  if (!ctx) { throw new Error("missing"); }',
      '  return ctx;',
      '}',
    ].join('\n'));

    writeFileSync(path.join(syntheticDir, 'index.tsx'), [
      'import React from "react";',
      'import { useMyContext } from "../fake-context/my-context";',
      'import styles from "./styles.css.js";',
      'export default function FakeComp() {',
      '  const ctx = useMyContext();',
      '  return <div>{ctx.foo}</div>;',
      '}',
    ].join('\n'));

    const comp: ManifestComponent = { name: 'FakeComp', dir: 'fake-comp' };
    const manifest = buildRenderManifest([comp], analyzer, TMP_ROOT);
    expect(manifest.FakeComp.context).toBeDefined();
    expect(manifest.FakeComp.context!.providerName).toBe('MyContextProvider');
    expect(manifest.FakeComp.context!.providerImport).toContain('my-context');
  });

  it('detects portal from synthetic source importing createPortal', () => {
    const portalDir = path.join(TMP_ROOT, 'portal-comp');
    mkdirSync(portalDir, { recursive: true });

    writeFileSync(path.join(portalDir, 'index.tsx'), [
      'import React from "react";',
      'import { createPortal } from "react-dom";',
      'import styles from "./styles.css.js";',
      'export default function PortalComp() {',
      '  return createPortal(<div>hi</div>, document.body);',
      '}',
    ].join('\n'));

    const comp: ManifestComponent = { name: 'PortalComp', dir: 'portal-comp' };
    const manifest = buildRenderManifest([comp], analyzer, TMP_ROOT);
    expect(manifest.PortalComp.portal).toBe(true);
  });

  it('detects provider-only from synthetic source with no HTML and no styles', () => {
    const providerDir = path.join(TMP_ROOT, 'provider-comp');
    mkdirSync(providerDir, { recursive: true });

    writeFileSync(path.join(providerDir, 'index.tsx'), [
      'import React from "react";',
      'const Ctx = React.createContext({});',
      'export default function SomeProvider({ children }: { children: React.ReactNode }) {',
      '  return <Ctx.Provider value={{}}>{children}</Ctx.Provider>;',
      '}',
    ].join('\n'));

    const comp: ManifestComponent = { name: 'SomeProvider', dir: 'provider-comp' };
    const manifest = buildRenderManifest([comp], analyzer, TMP_ROOT);
    expect(manifest.SomeProvider.skip).toBe(true);
    expect(manifest.SomeProvider.reason).toBe('provider-only');
  });
});
