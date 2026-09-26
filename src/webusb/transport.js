import { sparseChunk } from './sparse.js';
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';

const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder().decode(bytes);
export const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";

async function collect(stream, limit = 16 * 1024 * 1024) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('The phone returned more data than expected.');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function connectAdb(notify) {
  const device = await AdbDaemonWebUsbDeviceManager.BROWSER.requestDevice();
  if (!device) throw new Error('No phone selected.');
  let connection;
  try {
    connection = await device.connect();
    notify('Connecting… Accept the USB debugging prompt on your phone if it appears.');
    const adb = new Adb(await AdbDaemonTransport.authenticate({
      serial: device.serial, connection,
      credentialStore: new AdbWebCredentialStore('Light Guide'),
    }));
    // The transport can disconnect during the initial model checks, before the UI subscribes.
    void adb.disconnected.catch(() => {});
    if (!adb.subprocess.shellProtocol) { await adb.close(); throw new Error('This phone does not support the required ADB shell protocol.'); }
    return adb;
  } catch (error) {
    if (device.raw.opened) await device.raw.close().catch(() => {});
    if (error instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
      throw new Error('The USB connection is in use. Close other USB tools and run adb kill-server, then retry.');
    }
    throw new Error(`${error.message} Unplug and reconnect the phone, then try Connect phone again.`);
  }
}

export async function run(adb, command, root = false, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`The phone did not finish the command within ${timeout / 1000} seconds.`)), timeout);
  let process;
  try {
    process = await adb.subprocess.shellProtocol.spawn(root
      ? (root === 'kernel' ? ['su'] : ['/data/local/tmp/lp3-resukisu-ksud', 'debug', 'su'])
      : ['sh', '-c', quote(command)], controller.signal);
    const output = collect(process.stdout);
    const errors = collect(process.stderr, 1024 * 1024);
    const input = (async () => {
      const writer = process.stdin.getWriter();
      if (root) {
        // Keep binary stdout separate; explicitly report the nested shell's status.
        await writer.write(encode(`sh -c ${quote(command)}\ncode=$?; printf '\\nLIGHT_GUIDE_EXIT=%s\\n' "$code" >&2; exit "$code"\n`));
      }
      await writer.close();
    })();
    const [stdout, stderr, exitCode] = await Promise.all([output, errors, process.exited, input]);
    const errorText = decode(stderr);
    const marker = errorText.match(/\nLIGHT_GUIDE_EXIT=(\d+)\s*$/);
    if (exitCode !== 0 || (root && (!marker || marker[1] !== '0'))) {
      if (root && errorText.includes('ioctl failed: Operation not permitted')) {
        throw new Error('Shell root access was denied. In ReSukiSU, open Superuser and enable Shell.' + (root === 'kernel' ? ' Keep its profile on Default, then retry.' : ' Check that Prism shows Root Status: Active, then retry this step.'));
      }
      const detail = errorText.replace(/\nLIGHT_GUIDE_EXIT=\d+\s*$/, '').trim() || (!root ? decode(stdout).trim().slice(0, 2048) : '');
      const hint = root === 'kernel' ? 'Check Shell superuser access in ReSukiSU using the Default profile.' : root ? 'Check Prism root and Shell permission in ReSukiSU.' : '';
      throw new Error(detail || `Command failed (exit ${marker?.[1] ?? exitCode}). ${hint}`.trim());
    }
    return stdout;
  } catch (error) {
    if (process) await Promise.resolve(process.kill()).catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
}

export async function upload(adb, path, bytes) {
  const sync = await adb.sync();
  try {
    await sync.write({ filename: path, permission: 0o600,
      file: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    });
  } finally { await sync.dispose(); }
}

// Only expose the partitions and image sizes used by these releases.
const COMMANDS = new Set([
  'getvar:serialno', 'getvar:unlocked', 'getvar:current-slot', 'getvar:is-userspace',
  'getvar:max-download-size', 'getvar:snapshot-update-status',
  'getvar:partition-size:boot_a', 'getvar:partition-size:boot_b',
  'getvar:partition-size:vbmeta_a', 'getvar:partition-size:vbmeta_b',
  'getvar:partition-size:system_a', 'getvar:partition-size:system_b',
  'getvar:is-logical:system_a', 'getvar:is-logical:system_b',
  'flashing get_unlock_ability', 'oem getpermissions', 'flashing unlock', 'flashing lock',
  'reboot', 'reboot-fastboot', 'reboot-bootloader', 'reboot-recovery', 'erase:avb_custom_key',
]);
for (const slot of ['a', 'b']) {
  for (const size of [1521192960, 2733260800]) COMMANDS.add(`resize-logical-partition:system_${slot}:${size}`);
}
export class Fastboot {
  constructor(device, interfaceNumber, input, output) {
    Object.assign(this, { device, interfaceNumber, input, output });
    this.connected = true;
    this.handleDisconnect = event => {
      if (event.device !== device) return;
      this.connected = false;
      navigator.usb.removeEventListener('disconnect', this.handleDisconnect);
      this.onDisconnect?.();
    };
    navigator.usb.addEventListener('disconnect', this.handleDisconnect);
  }
  get isConnected() { return this.connected && this.device.opened; }
  static requestDevice() {
    return navigator.usb.requestDevice({ filters: [{ classCode: 255, subclassCode: 66, protocolCode: 3 }] });
  }
  static async connect(serial, device) {
    device ??= await Fastboot.requestDevice();
    if (serial && device.serialNumber !== serial) throw new Error('Select the same phone used to start this session.');
    try {
      await device.open();
      // Match fastboot.js: reset stale USB endpoint state before claiming fastboot.
      // This resets the USB connection, not the phone or its bootloader session.
      try { await device.reset(); } catch { /* Some platforms do not support USB reset. */ }
      const configuration = device.configurations.find(config => config.interfaces.some(iface => iface.alternates.some(alt => alt.interfaceClass === 255 && alt.interfaceSubclass === 66 && alt.interfaceProtocol === 3)));
      if (!configuration) throw new Error('No fastboot interface found.');
      if (device.configuration?.configurationValue !== configuration.configurationValue) await device.selectConfiguration(configuration.configurationValue);
      const iface = configuration.interfaces.find(iface => iface.alternates.some(alt => alt.interfaceClass === 255 && alt.interfaceSubclass === 66 && alt.interfaceProtocol === 3));
      const alt = iface.alternates.find(alt => alt.interfaceClass === 255 && alt.interfaceSubclass === 66 && alt.interfaceProtocol === 3);
      await device.claimInterface(iface.interfaceNumber);
      if (iface.alternate.alternateSetting !== alt.alternateSetting) {
        await device.selectAlternateInterface(iface.interfaceNumber, alt.alternateSetting);
      }
      const input = alt.endpoints.find(ep => ep.type === 'bulk' && ep.direction === 'in');
      const output = alt.endpoints.find(ep => ep.type === 'bulk' && ep.direction === 'out');
      if (!input || !output) throw new Error('Fastboot USB endpoints are missing.');
      return new Fastboot(device, iface.interfaceNumber, input.endpointNumber, output.endpointNumber);
    } catch (error) { await device.close().catch(() => {}); throw error; }
  }
  async transaction(task, timeout = 15000) {
    if (!this.isConnected) throw new Error('Phone disconnected. Select the device again.');
    if (this.busy) throw new Error('A fastboot operation is already running.');
    this.busy = true;
    let timer;
    try {
      return await Promise.race([task(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fastboot timed out. Keep the phone in fastboot and reconnect.')), timeout);
      })]);
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    } finally { clearTimeout(timer); this.busy = false; }
  }
  async send(bytes) {
    const sent = await this.device.transferOut(this.output, bytes);
    if (sent.status !== 'ok' || sent.bytesWritten !== bytes.byteLength) throw new Error('Fastboot USB write was incomplete.');
  }
  async response(expected = 'OKAY') {
    const messages = [];
    for (let i = 0; i < 100; i++) {
      const received = await this.device.transferIn(this.input, 64);
      if (received.status !== 'ok' || !received.data) throw new Error('Fastboot USB read failed.');
      const packet = decode(received.data).replace(/\0+$/, '');
      const status = packet.slice(0, 4), text = packet.slice(4);
      if (status === 'FAIL') {
        const error = new Error(text || 'The bootloader rejected the command.');
        error.code = 'FASTBOOT_REJECTED';
        throw error;
      }
      if (status === expected) return [...messages, text].join('\n').trim();
      if (status === 'INFO' || status === 'TEXT') { if (expected === 'OKAY') messages.push(text); }
      else throw new Error('Unexpected fastboot response.');
    }
    throw new Error('Too many fastboot responses.');
  }
  async command(command) {
    if (!COMMANDS.has(command)) throw new Error('Unsupported fastboot command.');
    return this.transaction(async () => {
      await this.send(encode(command));
      return this.response();
    });
  }
  async flash(partition, bytes, progress = () => {}) {
    const sizes = { boot_a: 100663296, boot_b: 100663296, vbmeta_a: 65536, vbmeta_b: 65536, avb_custom_key: 1032 };
    if (!(bytes instanceof Uint8Array) || bytes.length !== sizes[partition]) throw new Error('Unsupported image or partition size.');
    return this.#writeImage(partition, bytes, progress);
  }
  async flashSystemChunk(partition, bytes, offset, total, progress) {
    if (!['system_a', 'system_b'].includes(partition) || ![1521192960, 2733260800].includes(total) || bytes.length > 16 * 1024 * 1024) throw new Error('Unsupported system image.');
    return this.#writeImage(partition, sparseChunk(bytes, offset, total), progress);
  }
  async #writeImage(partition, bytes, progress = () => {}) {
    return this.transaction(async () => {
      const size = bytes.length.toString(16).padStart(8, '0');
      await this.send(encode('download:' + size));
      if (await this.response('DATA') !== size) throw new Error('The bootloader requested an unexpected image size.');
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        await this.send(bytes.subarray(offset, offset + 1024 * 1024));
        progress(Math.min(offset + 1024 * 1024, bytes.length) / bytes.length);
      }
      await this.response();
      await this.send(encode('flash:' + partition));
      await this.response();
    }, 120000);
  }
  async close() {
    this.connected = false;
    navigator.usb.removeEventListener('disconnect', this.handleDisconnect);
    if (this.device.opened) await this.device.close();
  }
}
