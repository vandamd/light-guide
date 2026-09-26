// Android sparse format: skip preceding blocks, write this chunk, skip the remainder.
export function sparseChunk(bytes, offset, total) {
  const block = 4096;
  if (!(bytes instanceof Uint8Array) || !bytes.length || [offset, total, bytes.length].some(n => !Number.isSafeInteger(n) || n < 0 || n % block) || offset + bytes.length > total) {
    throw new Error('Invalid system image chunk.');
  }
  const before = offset / block, after = (total - offset - bytes.length) / block;
  const count = 1 + Number(before > 0) + Number(after > 0);
  const result = new Uint8Array(28 + count * 12 + bytes.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, 0xed26ff3a, true);
  view.setUint16(4, 1, true);
  view.setUint16(8, 28, true);
  view.setUint16(10, 12, true);
  view.setUint32(12, block, true);
  view.setUint32(16, total / block, true);
  view.setUint32(20, count, true);
  let cursor = 28;
  function chunk(type, blocks, data) {
    view.setUint16(cursor, type, true);
    view.setUint32(cursor + 4, blocks, true);
    view.setUint32(cursor + 8, 12 + (data?.length ?? 0), true);
    cursor += 12;
    if (data) { result.set(data, cursor); cursor += data.length; }
  }
  if (before) chunk(0xcac3, before);
  chunk(0xcac1, bytes.length / block, bytes);
  if (after) chunk(0xcac3, after);
  return result;
}
