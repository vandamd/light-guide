import { gunzipSync } from 'fflate';
import manifests from './system-images.json';
import { cachedRelease } from './release-cache.js';
import { sha256 } from './certificate.js';

export const systemImage = name => manifests[name];
const key = part => 'system-' + part.compressedSha256;
async function verified(part, compressed) {
  if (!(compressed instanceof Uint8Array) || compressed.length !== part.compressedSize || await sha256(compressed) !== part.compressedSha256) throw new Error('System download failed verification. Download the release again.');
  const raw = gunzipSync(compressed);
  if (raw.length !== part.size || await sha256(raw) !== part.sha256) throw new Error('System image chunk failed verification.');
  return raw;
}
export async function downloadSystem(name, status) {
  const image = manifests[name];
  for (let i = 0; i < image.parts.length; i++) {
    const part = image.parts[i];
    status(`Downloading ${name === 'stock' ? 'stock LightOS' : 'LineageOS'}: ${Math.round(i / image.parts.length * 100)}%`);
    let compressed = await cachedRelease('read', undefined, key(part));
    if (compressed) {
      try { await verified(part, compressed); continue; }
      catch { await cachedRelease('delete', undefined, key(part)); }
    }
    const start = part.compressedOffset, end = start + part.compressedSize - 1;
    const response = await fetch(image.url + '?sha256=' + image.compressedSha256, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: AbortSignal.timeout(120000),
    });
    if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${image.compressedSize}`) {
      await response.body?.cancel();
      throw new Error('System range download failed. Retry to resume.');
    }
    compressed = new Uint8Array(await response.arrayBuffer());
    await verified(part, compressed);
    await cachedRelease('write', compressed, key(part));
  }
}
export async function verifySystemCache(name, status) {
  for (const part of manifests[name].parts) {
    status('Verifying saved system image…');
    await readSystemChunk(part);
  }
}
export async function readSystemChunk(part) {
  const compressed = await cachedRelease('read', undefined, key(part));
  if (!compressed) throw new Error('The saved system download is incomplete. Download the release again.');
  return verified(part, compressed);
}
