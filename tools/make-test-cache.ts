/** Writes the original test-world cache to tests/fixtures/generated/cache (or the directory given). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildFixtureCache } from './fixture/content.ts';

export async function writeFixtureCache(dir: string): Promise<string> {
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  const { dat2, indexes } = await buildFixtureCache();
  writeFileSync(join(out, 'main_file_cache.dat2'), dat2);
  for (const [archive, data] of indexes) writeFileSync(join(out, `main_file_cache.idx${archive}`), data);
  return out;
}

const isMain = typeof process !== 'undefined' && process.argv[1] && /make-test-cache\.ts$/.test(process.argv[1]);
if (isMain) {
  const dir = process.argv[2] ?? join('tests', 'fixtures', 'generated', 'cache');
  writeFixtureCache(dir).then((out) => console.log(`fixture cache written to ${out}`));
}
