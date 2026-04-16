/**
 * SSR Smoke Test — renders each Cloudscape Lit component in a Node SSR context
 * using @lit-labs/ssr and reports which ones pass vs crash.
 *
 * Run: npx vitest run test/ssr/
 */

// DOM shim MUST be installed before any Lit imports
import '@lit-labs/ssr/lib/install-global-dom-shim.js';

import { describe, it, expect, afterAll } from 'vitest';
import { render } from '@lit-labs/ssr';
import { collectResult } from '@lit-labs/ssr/lib/render-result.js';
import { html, unsafeStatic } from 'lit/static-html.js';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const COMPONENTS_SRC = path.resolve(import.meta.dirname, '../../../components/src');

const COMPONENT_DIRS = [
  'alert',
  'anchor-navigation',
  'annotation-context',
  'app-layout',
  'app-layout-toolbar',
  'area-chart',
  'attribute-editor',
  'autosuggest',
  'badge',
  'bar-chart',
  'box',
  'breadcrumb-group',
  'button',
  'button-dropdown',
  'button-group',
  'calendar',
  'cards',
  'checkbox',
  'code-editor',
  'code-view',
  'collection-preferences',
  'column-layout',
  'container',
  'content-layout',
  'copy-to-clipboard',
  'date-input',
  'date-picker',
  'date-range-picker',
  'drawer',
  'dropdown',
  'error-boundary',
  'expandable-section',
  'file-dropzone',
  'file-input',
  'file-token-group',
  'file-upload',
  'flashbar',
  'form',
  'form-field',
  'grid',
  'header',
  'help-panel',
  'hotspot',
  'icon',
  'icon-provider',
  'input',
  'item-card',
  'key-value-pairs',
  'line-chart',
  'link',
  'list',
  'live-region',
  'mixed-line-bar-chart',
  'modal',
  'multiselect',
  'navigable-group',
  'pagination',
  'panel-layout',
  'pie-chart',
  'popover',
  'progress-bar',
  'prompt-input',
  'property-filter',
  'radio-button',
  'radio-group',
  's3-resource-selector',
  'segmented-control',
  'select',
  'side-navigation',
  'slider',
  'space-between',
  'spinner',
  'split-panel',
  'status-indicator',
  'steps',
  'table',
  'tabs',
  'tag-editor',
  'text-content',
  'text-filter',
  'textarea',
  'tiles',
  'time-input',
  'toggle',
  'toggle-button',
  'token',
  'token-group',
  'tooltip',
  'top-navigation',
  'tree-view',
  'tutorial-panel',
  'wizard',
];

type ResultStatus = 'PASS' | 'IMPORT_FAIL' | 'RENDER_FAIL';

interface ComponentResult {
  name: string;
  tag: string;
  status: ResultStatus;
  error?: string;
  errorType?: string;
}

const results: ComponentResult[] = [];

describe('SSR smoke test', () => {
  for (const name of COMPONENT_DIRS) {
    const tag = `cs-${name}`;
    const srcPath = path.join(COMPONENTS_SRC, name, 'index.ts');

    it(`${tag}`, async () => {
      let importOk = false;
      try {
        await import(srcPath);
        importOk = true;
      } catch (e: any) {
        results.push({
          name,
          tag,
          status: 'IMPORT_FAIL',
          error: e.message?.slice(0, 200),
          errorType: e.constructor?.name || 'Unknown',
        });
        expect.soft(false, `IMPORT_FAIL: ${e.message?.slice(0, 120)}`).toBe(true);
        return;
      }

      try {
        const tagStatic = unsafeStatic(tag);
        const template = html`<${tagStatic}>SSR test</${tagStatic}>`;
        const ssrResult = render(template);
        const output = await collectResult(ssrResult);
        results.push({ name, tag, status: 'PASS' });
        expect(output).toBeTruthy();
      } catch (e: any) {
        results.push({
          name,
          tag,
          status: 'RENDER_FAIL',
          error: e.message?.slice(0, 200),
          errorType: e.constructor?.name || 'Unknown',
        });
        expect.soft(false, `RENDER_FAIL: ${e.message?.slice(0, 120)}`).toBe(true);
      }
    });
  }

  afterAll(() => {
    const pass = results.filter((r) => r.status === 'PASS');
    const importFail = results.filter((r) => r.status === 'IMPORT_FAIL');
    const renderFail = results.filter((r) => r.status === 'RENDER_FAIL');

    const summary = [
      '',
      `═══ SSR Baseline: ${pass.length}/${results.length} pass ═══`,
      '',
      `PASS (${pass.length}): ${pass.map((r) => r.name).join(', ')}`,
      '',
      `IMPORT_FAIL (${importFail.length}): ${importFail.map((r) => r.name).join(', ')}`,
      ...importFail.map((r) => `  ${r.name}: [${r.errorType}] ${r.error}`),
      '',
      `RENDER_FAIL (${renderFail.length}): ${renderFail.map((r) => r.name).join(', ')}`,
      ...renderFail.map((r) => `  ${r.name}: [${r.errorType}] ${r.error}`),
      '',
    ];

    console.log(summary.join('\n'));

    const evidence = {
      timestamp: new Date().toISOString(),
      total: results.length,
      pass: pass.length,
      importFail: importFail.length,
      renderFail: renderFail.length,
      results: results.map((r) => ({
        name: r.name,
        tag: r.tag,
        status: r.status,
        ...(r.error && { error: r.error }),
        ...(r.errorType && { errorType: r.errorType }),
      })),
    };

    const evidenceDir = path.resolve(import.meta.dirname, '../../.sisyphus/evidence');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      path.join(evidenceDir, 'ssr-baseline.json'),
      JSON.stringify(evidence, null, 2)
    );
  });
});
