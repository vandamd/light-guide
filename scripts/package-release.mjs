import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { FILES } from '../src/webusb/firmware.js';

const folder = process.argv[2];
if (!folder) throw new Error('Usage: bun scripts/package-release.mjs /path/to/flashing-folder');
const entries = {};
for (const [name, expected] of Object.entries(FILES)) {
  const bytes = await readFile(`${folder}/${name}`);
  if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error(`Release file failed verification: ${name}`);
  }
  entries[name] = bytes;
}
const bytes = zipSync(entries, { level: 6, mtime: new Date('2026-09-26T00:00:00Z') });
const hash = createHash('sha256').update(bytes).digest('hex');
const name = 'lightos-resukisu-susfs-00WW_1_440000-preview1';
const directory = new URL('../public/files/releases/', import.meta.url);
await mkdir(directory, { recursive: true });
const parts = [];
// Cloudflare static assets have a 25 MiB per-file limit.
for (let offset = 0; offset < bytes.length; offset += 24 * 1024 * 1024) {
  const part = `${name}-${hash.slice(0, 12)}.part${parts.length + 1}`;
  await writeFile(new URL(part, directory), bytes.subarray(offset, offset + 24 * 1024 * 1024));
  parts.push('/files/releases/' + part);
}
await writeFile(new URL('../src/webusb/release.json', import.meta.url), JSON.stringify({ name, size: bytes.length, sha256: hash, parts }, null, 2) + '\n');
console.log(`Packaged ${Math.round(bytes.length / 1024 / 1024)} MiB in ${parts.length} parts. No private key included.`);
