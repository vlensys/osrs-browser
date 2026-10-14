import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../../tools/fixture/zip-writer.ts';
import { writeFixtureCache } from '../../tools/make-test-cache.ts';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/generated/cache', import.meta.url));
export const FIXTURE_ZIP = fileURLToPath(new URL('../fixtures/generated/disk.zip', import.meta.url));

export default async function globalSetup(): Promise<void> {
  await writeFixtureCache(FIXTURE_DIR);
  // Same layout as an OpenRS2 disk.zip (cache/main_file_cache.*), served by a mocked archive in the e2e suite.
  const entries = readdirSync(FIXTURE_DIR).map((name) => ({ name: `cache/${name}`, data: readFileSync(join(FIXTURE_DIR, name)), deflate: true }));
  writeFileSync(FIXTURE_ZIP, new Uint8Array(await (await buildZip(entries)).arrayBuffer()));
}
