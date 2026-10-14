import { fileURLToPath } from 'node:url';
import { writeFixtureCache } from '../../tools/make-test-cache.ts';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/generated/cache', import.meta.url));

export default async function globalSetup(): Promise<void> {
  await writeFixtureCache(FIXTURE_DIR);
}
