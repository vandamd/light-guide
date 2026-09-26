const REQUIRED_FILES = ['mfd-original.img', 'hardware-id.bin'];
const encoder = new TextEncoder();
const join = (...parts) => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
};
const bytes = (...values) => Uint8Array.from(values);
const require = (condition, message) => { if (!condition) throw new Error(message); };

async function sha256(data) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
}

function inspectBackups(files) {
  for (const name of REQUIRED_FILES) require(files.has(name), `Missing backup: ${name}.`);
  const original = files.get('mfd-original.img');
  require(original.length === 0x20000, 'The mfd backup must be exactly 128 KiB.');
  const empty = new Uint8Array(4096);
  const header = new DataView(empty.buffer);
  header.setUint32(0, 0x43655274, true);
  header.setUint32(0x914, 0x54724563, true);
  require(empty.every((value, i) => original[0x3000 + i] === value),
    'The authorisation area is not empty or has an unknown layout. Do not overwrite it.');
  const fuse = files.get('hardware-id.bin');
  require(fuse.length === 4, 'The hardware fuse backup must contain exactly four bytes.');
  const hardwareId = new DataView(fuse.buffer, fuse.byteOffset, 4).getUint32(0, true);
  return { original, hardwareId };
}

// Minimal DER encoding for the fixed X.509 certificate structure used here.
function der(tag, value) {
  let length = value.length;
  const encoded = [];
  if (length < 128) encoded.push(length);
  else {
    while (length) { encoded.unshift(length & 255); length >>>= 8; }
    encoded.unshift(0x80 | encoded.length);
  }
  return join(bytes(tag, ...encoded), value);
}
const sequence = (...parts) => der(0x30, join(...parts));
const algorithm = () => sequence(der(6, bytes(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 0x0b)), der(5, bytes()));
function time(date) {
  return der(0x18, encoder.encode(date.toISOString().replace(/[-:]/g, '').replace('T', '').replace(/\.\d+Z$/, 'Z')));
}

async function generateRecord(hardwareId, original) {
  require(Number.isInteger(hardwareId) && hardwareId >= 0 && hardwareId <= 0xffffffff, 'Invalid hardware ID.');
  require(original.length === 0x20000, 'Invalid mfd size.');
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: bytes(1, 0, 1), hash: 'SHA-256' }, false, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0] & 0x7f) | 1;
  const name = sequence(der(0x31, sequence(der(6, bytes(0x55, 4, 3)),
    der(0x0c, encoder.encode('Light Guide local authorisation')))));
  const now = Date.now();
  const tbs = sequence(der(0xa0, der(2, bytes(2))), der(2, serial), algorithm(), name,
    sequence(time(new Date(now - 86400000)), time(new Date(now + 30 * 86400000))), name, spki);
  const sign = async data => new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, data));
  const certificateSignature = await sign(tbs);
  const certificate = sequence(tbs, algorithm(), der(3, join(bytes(0), certificateSignature)));
  const message = encoder.encode(hardwareId.toString(16).toUpperCase().padStart(8, '0'));
  const signature = await sign(message);
  require(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, signature, message), 'Signature verification failed.');
  require(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, certificateSignature, tbs), 'Certificate signature verification failed.');
  require(certificate.length <= 0x800 && signature.length === 256, 'Generated record exceeds its allocated space.');
  const record = new Uint8Array(4096);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x43655274, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  record.set(signature, 0xc);
  view.setUint32(0x10c, signature.length, true);
  record.set(certificate, 0x110);
  view.setUint32(0x910, certificate.length, true);
  view.setUint32(0x914, 0x54724563, true);
  const expected = original.slice();
  expected.set(record, 0x3000);
  return { record, expected, recordHash: await sha256(record), expectedHash: await sha256(expected),
    originalHash: await sha256(original) };
}
export { inspectBackups, generateRecord, sha256 };
