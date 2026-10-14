/**
 * One-click cache download from the OpenRS2 archive (https://archive.openrs2.org), which serves CORS-enabled
 * caches. Only runs when the player asks for it; nothing from Jagex is hosted by this project.
 */

export const OPENRS2 = 'https://archive.openrs2.org';

export interface OpenRs2Cache {
  id: number;
  game: string;
  environment: string;
  language: string;
  builds: { major: number; minor: number | null }[];
  timestamp: string | null;
  indexes: number | null;
  valid_indexes: number | null;
  groups: number | null;
  valid_groups: number | null;
  keys: number | null;
  valid_keys: number | null;
  size: number | null;
  disk_store_valid?: boolean | null;
  hidden?: boolean;
}

/** The newest live OSRS cache whose disk store and every index/group are complete. */
export function pickLatestCache(list: OpenRs2Cache[]): OpenRs2Cache | null {
  const usable = list.filter(
    (c) =>
      c.game === 'oldschool' &&
      c.environment === 'live' &&
      c.language === 'en' &&
      !c.hidden &&
      c.disk_store_valid !== false &&
      c.timestamp !== null &&
      c.indexes !== null &&
      c.indexes > 0 &&
      c.valid_indexes === c.indexes &&
      c.groups !== null &&
      c.valid_groups === c.groups &&
      // Pre-2025 builds encrypt map scenery: only accept those if (nearly) all keys are known.
      (!c.keys || (c.valid_keys ?? 0) >= c.keys * 0.9),
  );
  usable.sort((a, b) => (a.timestamp! < b.timestamp! ? 1 : a.timestamp! > b.timestamp! ? -1 : b.id - a.id));
  return usable[0] ?? null;
}

export type DownloadProgress = (message: string, fraction: number) => void;

async function fetchWithProgress(url: string, label: string, progress: DownloadProgress): Promise<Blob> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error(`${label}: HTTP ${res.status}`);
  // OpenRS2 streams without Content-Length (and its listing's "size" isn't the zip size), so the total is
  // often unknown: then report megabytes and ease the bar towards full instead of inventing a total.
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const now = performance.now();
    if (now - lastReport > 150) {
      lastReport = now;
      const mb = (n: number) => (n / 1_048_576).toFixed(0);
      progress(
        total ? `${label}: ${mb(received)} / ${mb(total)} MB` : `${label}: ${mb(received)} MB`,
        total ? received / total : 1 - Math.exp(-received / 150_000_000),
      );
    }
  }
  // Blob parts must be ArrayBuffer-backed views; the reader always yields those.
  return new Blob(chunks as Uint8Array<ArrayBuffer>[]);
}

/** Downloads the latest cache (plus XTEA keys when that build needs them) as files ready for importCache(). */
export async function downloadLatestCache(progress: DownloadProgress): Promise<{ files: File[]; cache: OpenRs2Cache }> {
  progress('Finding the latest cache on OpenRS2…', 0);
  const listRes = await fetch(`${OPENRS2}/caches.json`, { mode: 'cors', credentials: 'omit' });
  if (!listRes.ok) throw new Error(`OpenRS2 cache list: HTTP ${listRes.status}`);
  const cache = pickLatestCache((await listRes.json()) as OpenRs2Cache[]);
  if (!cache) throw new Error('OpenRS2 has no complete live Old School cache right now. Try importing one manually.');
  const build = cache.builds.map((b) => b.major).join('/') || '?';
  const base = `${OPENRS2}/caches/runescape/${cache.id}`;
  const zip = await fetchWithProgress(`${base}/disk.zip`, `Downloading build ${build}`, (m, f) => progress(m, f * 0.9));
  const files = [new File([zip], 'disk.zip', { type: 'application/zip' })];
  if (cache.keys) {
    const keys = await fetchWithProgress(`${base}/keys.json`, 'Downloading map keys', (m) => progress(m, 0.9));
    files.push(new File([keys], 'keys.json', { type: 'application/json' }));
  }
  return { files, cache };
}
