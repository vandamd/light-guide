import { open, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const sources = {
  lineage: { path: process.argv[2], sha256: '7b9ba62e8b48b6e40432be949ae0858a8971175c79502550e74691222d3889ff' },
  stock: { path: process.argv[3], sha256: 'd77a67343e42634c8cd4ea39258840d6a6adb7f218ed311febe0c9e7ebabb8c8' },
};
if (!sources.lineage.path || !sources.stock.path) throw new Error('Usage: bun scripts/package-system-images.mjs lineage.img stock-system.img');
const directory = new URL('../.release-assets/systems/', import.meta.url);
await mkdir(directory, { recursive: true });
const manifests = {};
for (const [name, source] of Object.entries(sources)) {
  const filename = name === 'lineage' ? 'lineageos.img.gz' : 'lightos-stock.img.gz';
  const handle = await open(source.path);
  const output = await open(new URL(filename, directory), 'w');
  try {
    const { size } = await handle.stat();
    if (size % 4096) throw new Error('System image must be block aligned');
    const hash = createHash('sha256');
    const compressedHash = createHash('sha256');
    const parts = [];
    let compressedOffset = 0;
    for (let offset = 0; offset < size; offset += 16 * 1024 * 1024) {
      const raw = Buffer.alloc(Math.min(16 * 1024 * 1024, size - offset));
      const { bytesRead } = await handle.read(raw, 0, raw.length, offset);
      if (bytesRead !== raw.length) throw new Error('Incomplete source image');
      hash.update(raw);
      const compressed = gzipSync(raw, { level: 6 });
      const digest = createHash('sha256').update(compressed).digest('hex');
      // Concatenated gzip members form one image and allow verified range downloads.
      await output.write(compressed);
      compressedHash.update(compressed);
      parts.push({ offset, size: raw.length, sha256: createHash('sha256').update(raw).digest('hex'), compressedOffset, compressedSize: compressed.length, compressedSha256: digest });
      compressedOffset += compressed.length;
    }
    if (hash.digest('hex') !== source.sha256) throw new Error(`${name} source checksum mismatch`);
    manifests[name] = { url: '/files/systems/' + filename, size, sha256: source.sha256, compressedSize: compressedOffset, compressedSha256: compressedHash.digest('hex'), parts };
    console.log(`${name}: ${parts.length} verified chunks, ${Math.round(parts.reduce((n, p) => n + p.compressedSize, 0) / 1024 / 1024)} MiB download`);
  } finally { await handle.close(); await output.close(); }
}
await writeFile(new URL('../src/webusb/system-images.json', import.meta.url), JSON.stringify(manifests, null, 2) + '\n');
