import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TMP_DIR = path.resolve('test/.tmp-cli-host-display');
const HOST_DISPLAY_FILE = path.join(TMP_DIR, 'host-display.json');
const OUTPUT_DIR = path.join(TMP_DIR, 'output');

describe('CLI --host-display flag', () => {
  beforeAll(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('Badge gets display: inline-block from host display map', () => {
    const hostDisplayMap = { Badge: 'inline-block', Alert: 'block' };
    writeFileSync(HOST_DISPLAY_FILE, JSON.stringify(hostDisplayMap));

    const result = execSync(
      `npx tsx src/cli.ts` +
        ` --package @cloudscape-design/components` +
        ` --source vendor/cloudscape-source/src` +
        ` --output ${OUTPUT_DIR}` +
        ` --component Badge` +
        ` --host-display ${HOST_DISPLAY_FILE}` +
        ` --dry-run`,
      { encoding: 'utf-8', timeout: 60_000 },
    );

    expect(result).toContain('display: inline-block');
    expect(result).not.toContain('display: block');
  });

  it('component without host display entry defaults to block', () => {
    const hostDisplayMap = { SomeOtherComponent: 'inline-flex' };
    writeFileSync(HOST_DISPLAY_FILE, JSON.stringify(hostDisplayMap));

    const result = execSync(
      `npx tsx src/cli.ts` +
        ` --package @cloudscape-design/components` +
        ` --source vendor/cloudscape-source/src` +
        ` --output ${OUTPUT_DIR}` +
        ` --component Badge` +
        ` --host-display ${HOST_DISPLAY_FILE}` +
        ` --dry-run`,
      { encoding: 'utf-8', timeout: 60_000 },
    );

    expect(result).toContain('display: block');
  });

  it('null value in map leaves hostDisplay unset (falls back to block)', () => {
    const hostDisplayMap = { Badge: null };
    writeFileSync(HOST_DISPLAY_FILE, JSON.stringify(hostDisplayMap));

    const result = execSync(
      `npx tsx src/cli.ts` +
        ` --package @cloudscape-design/components` +
        ` --source vendor/cloudscape-source/src` +
        ` --output ${OUTPUT_DIR}` +
        ` --component Badge` +
        ` --host-display ${HOST_DISPLAY_FILE}` +
        ` --dry-run`,
      { encoding: 'utf-8', timeout: 60_000 },
    );

    expect(result).toContain('display: block');
  });

  it('works without --host-display flag (no error)', () => {
    const result = execSync(
      `npx tsx src/cli.ts` +
        ` --package @cloudscape-design/components` +
        ` --source vendor/cloudscape-source/src` +
        ` --output ${OUTPUT_DIR}` +
        ` --component Badge` +
        ` --dry-run`,
      { encoding: 'utf-8', timeout: 60_000 },
    );

    expect(result).toContain('display: block');
  });

  it('writes correct display to file output', () => {
    const hostDisplayMap = { Badge: 'inline-block' };
    writeFileSync(HOST_DISPLAY_FILE, JSON.stringify(hostDisplayMap));

    const compOutputDir = path.join(TMP_DIR, 'file-output');

    execSync(
      `npx tsx src/cli.ts` +
        ` --package @cloudscape-design/components` +
        ` --source vendor/cloudscape-source/src` +
        ` --output ${compOutputDir}` +
        ` --component Badge` +
        ` --host-display ${HOST_DISPLAY_FILE}`,
      { encoding: 'utf-8', timeout: 60_000 },
    );

    const outputFile = path.join(compOutputDir, 'badge', 'internal.ts');
    const content = readFileSync(outputFile, 'utf-8');
    expect(content).toContain('display: inline-block');
    expect(content).not.toContain('display: block');
  });
});
