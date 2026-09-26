import { setStatusMessage } from './status-message.js';
import { registerUnlockRelease } from './install-session.js';
import { zipSync, strToU8 } from 'fflate';
import { connectAdb, run, upload, Fastboot, quote } from './transport.js';
import { inspectBackups, generateRecord, sha256 } from './certificate.js';
import { TARGETS } from './firmware.js';

const tool = document.querySelector('[data-tool="webusb"]');
const $ = id => tool.querySelector('#unlock-' + id);
const text = bytes => new TextDecoder().decode(bytes).trim();
const check = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const HASHES = {
  abl_a: 'f51fa45314960b3da6f4dfc68e4d2bbc6b821f6a3f6221f77352f4e50e7af98a',
  abl_b: '2a983666338dd04e6b2f8c4135c1cc8ae5a65457f9e557398d04774e7a282b30',
};
let adb, fastboot, backup, busy = false;
let phase = 'connect';
let serial, slot;
let fastbootReady = false;
let interacted = false;
const statusFields = [$('status'), $('fastboot-status')];
let statusStep = 0;
function status(message, state = 'progress') {
  clearMessages();
  const statusField = statusFields[statusStep];
  setStatusMessage(statusField, message);
  statusField.hidden = !interacted && state !== 'error';
  statusField.setAttribute('role', state === 'error' ? 'alert' : 'status');
  statusField.dataset.state = state;
}
const success = message => status(message, 'success');
function clearMessages() {
  for (const field of statusFields) {
    field.textContent = '';
    field.hidden = true;
  }
}
function render() {
  $('primary').textContent = phase === 'prepared' ? 'Retry unlock preparation' : 'Activate Fastboot';
  for (const field of statusFields) field.setAttribute('aria-busy', String(busy));
}
async function action(at, task) {
  if (busy) return;
  statusStep = at;
  interacted = true;
  clearMessages();
  busy = true; render();
  try { await task(); }
  catch (error) {
    if (fastboot && !fastboot.isConnected) fastbootReady = false;
    let message = error.message || String(error);
    if (phase === 'uncertain') message += ' Do not reboot or repeat the write. Keep Android running and save the error and backup. Get help verifying the partition before continuing.';
    status(message, 'error');
  } finally { busy = false; render(); }
}
const prop = async name => text(await run(adb, `getprop ${name}`));
const root = command => run(adb, command, true);
const partition = name => {
  check(['abl_a', 'abl_b', 'mfd', 'frp'].includes(name), 'Unexpected partition.');
  return root(`cat /dev/block/by-name/${name}`);
};
async function checkPhone(requireLocked = true) {
  check(await prop('ro.product.model') === 'TLP301', 'This tool supports only the Light Phone III (TLP301).');
  check(await prop('ro.build.version.incremental') === '00WW_1_440000', 'This firmware is not supported.');
  if (requireLocked) check(await prop('ro.boot.flash.locked') === '1', 'The bootloader is already unlocked.');
  check(await prop('ro.serialno') === serial, 'The connected phone does not match this session.');
  const activeSlot = await prop('ro.boot.slot_suffix');
  check(['_a', '_b'].includes(activeSlot), 'The phone did not report a valid active slot.');
  check(!slot || activeSlot === slot, 'The active slot changed. Start a new unlock session.');
  slot = activeSlot;
}
async function oemEnabled() {
  const value = await root('tail -c 1 /dev/block/by-name/frp');
  check(value.length === 1 && value[0] === 1, 'OEM unlocking is off. Keep Android running. Do not continue until OEM unlocking can be enabled.');
}
function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function connectPhone() {
  status('Select your phone.');
  const candidate = await connectAdb(status);
  slot = undefined;
  adb = candidate;
  serial = candidate.serial;
  let locked, customKernel;
  try {
    await checkPhone(false);
    customKernel = text(await run(adb, 'uname -r')) === TARGETS.custom.kernel;
    locked = await prop('ro.boot.flash.locked');
    check(['0', '1'].includes(locked), 'The phone returned an unknown lock state.');
  }
  catch (error) { await adb.close(); adb = undefined; throw error; }
  if (customKernel || locked === '0') {
    phase = 'complete';
    await candidate.close(); adb = undefined;
    success(customKernel ? 'Custom kernel detected. Continue to installation or Restore stock firmware; those flows check the real lock state in fastboot.' : 'Already unlocked. Continue to installation.');
    return;
  }
  phase = 'connected';
  const disconnected = error => {
    if (adb !== candidate) return;
    adb = undefined;
    if (['fastboot', 'prompt', 'complete'].includes(phase)) { render(); return; }
    if (['connected', 'prepared'].includes(phase)) { phase = 'connect'; backup = undefined; }
    status('Phone disconnected. Reconnect in Android before continuing.');
    render();
  };
  candidate.disconnected.then(() => disconnected(), disconnected);
  status('Connected.');
}

async function prepareBackup() {
  status('Checking firmware and root access…');
  await checkPhone();
  check(text(await root('id -u')) === '0', 'Activate Prism root and grant Shell access in ReSukiSU.');
  const files = {};
  for (const name of ['abl_a', 'abl_b', 'mfd', 'frp']) {
    status(`Backing up ${name}…`);
    const data = await partition(name);
    const hash = await sha256(data);
    const deviceHash = text(await root(`sha256sum /dev/block/by-name/${name}`)).split(/\s+/)[0];
    check(hash === deviceHash, `${name} changed during backup. No partition was written. Retry the unlock.`);
    const expected = name === 'abl' + slot ? HASHES.abl_a : HASHES.abl_b;
    if (name.startsWith('abl_')) check(hash === expected, `Unsupported ${name} bootloader. No partition was written.`);
    files[`${name === 'mfd' || name === 'frp' ? name + '-original' : name}.img`] = data;
  }
  const frp = files['frp-original.img'];
  check(frp.length >= 4096 && [0, 1].includes(frp.at(-1)), 'Unexpected FRP backup.');
  files['hardware-id.bin'] = await root('dd if=/sys/bus/nvmem/devices/qfprom0/nvmem bs=4 skip=388 count=1');
  const { original, hardwareId } = inspectBackups(new Map(Object.entries(files)));
  check(Number(text(await root('cat /sys/devices/soc0/serial_number'))) === hardwareId, 'Hardware ID verification failed.');
  status('Generating and verifying the certificate…');
  const generated = await generateRecord(hardwareId, original);
  files['unlock-record.bin'] = generated.record;
  files['mfd-expected.img'] = generated.expected;
  const hashes = {};
  for (const [name, bytes] of Object.entries(files)) hashes[name] = await sha256(bytes);
  files['manifest.json'] = strToU8(JSON.stringify({ serial, slot, firmware: '00WW_1_440000', hardwareId, sha256: hashes }, null, 2));
  files['README.txt'] = strToU8('Light Phone III unlock backup\nKeep this archive private and safe. It contains device-specific partitions, not photos or app data.\nDo not flash mfd-expected.img: it is only for comparing the staged record.\n');
  backup = { original, hashes, ...generated, archive: zipSync(files), name: `light-unlock-${serial}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip` };
  phase = 'prepared';
  status('Backup ready. Save it to continue.');
}

$('primary').onclick = () => action(0, async () => {
  check(phase !== 'uncertain', 'Verify the previous partition write before continuing.');
  if (fastboot) {
    await fastboot.close();
    fastboot = undefined;
    fastbootReady = false;
  }
  if (phase === 'prepared') {
    await stageUnlock();
  } else {
    if (!adb) await connectPhone();
    if (phase === 'complete') return;
    await prepareBackup();
    download(backup.archive, backup.name);
    await stageUnlock();
  }
});

$('request').onclick = () => action(1, async () => {
  check(phase !== 'uncertain', 'Verify the previous partition write before continuing.');
  await connectFastboot();
  if (phase !== 'complete') await requestUnlock();
});

async function stageUnlock() {
  check(adb, 'Reconnect your phone in Android first.');
  check(backup && phase === 'prepared', 'Prepare the partition backup first.');
  status('Rechecking the phone and original partition…');
  await checkPhone();
  check(same(await partition('mfd'), backup.original), 'The original partition changed. Stop and inspect it before preparing again.');
  for (const name of Object.keys(HASHES)) check(text(await root(`sha256sum /dev/block/by-name/${name}`)).split(/\s+/)[0] === backup.hashes[name + '.img'], 'The bootloader changed. Stop here.');
  const path = '/data/local/tmp/light-guide-web-unlock.bin';
  await upload(adb, path, backup.record);
  check(same(await root(`cat ${quote(path)}`), backup.record), 'Record transfer did not match.');
  status('Enabling OEM unlocking…');
  await root('pm set-user-restriction --user 0 no_factory_reset 0');
  const setting = text(await root('service call oem_lock 4 i32 1'));
  check(!/Exception|Permission Denial|Error/i.test(setting), setting);
  await oemEnabled();
  // Block further actions if this write cannot be verified.
  phase = 'uncertain';
  status('Writing the certificate and verifying the whole partition…');
  await root(`dd if=${path} of=/dev/block/by-name/mfd bs=4096 seek=3 count=1 conv=notrunc,fsync`);
  check(same(await partition('mfd'), backup.expected), 'The partition readback did not match the expected image.');
  await oemEnabled();
  await rebootToFastboot();
}
async function rebootToFastboot() {
  status('Staging verified. Rebooting directly into fastboot…');
  // Keep the checked phone identity for the fastboot connection.
  phase = 'fastboot';
  const old = adb;
  try { await old.power.bootloader(); }
  catch (error) {
    // Reboot services can close the transport before the response reaches the browser.
    status('The reboot connection ended. If the phone is in fastboot, connect it in fastboot. Otherwise keep Android running and save this message for troubleshooting.');
  }
  adb = undefined;
  await old.close().catch(() => {});
  success('Prepared. Continue to unlock the bootloader.');
}

async function fastbootChecks() {
  check(fastboot?.isConnected, 'Phone disconnected. Select it again in fastboot.');
  status('Checking the fastboot serial…');
  const connectedSerial = (await fastboot.command('getvar:serialno')).trim();
  check(connectedSerial && connectedSerial === fastboot.device.serialNumber, 'The phone serial does not match its USB connection.');
  const activeSlot = (await fastboot.command('getvar:current-slot')).trim();
  check(['a', 'b'].includes(activeSlot), 'The phone did not report a valid active slot.');
  status('Checking the bootloader lock state…');
  const unlocked = (await fastboot.command('getvar:unlocked')).trim();
  if (unlocked === 'yes') {
    phase = 'complete'; fastbootReady = false;
    success('Already unlocked. Continue to installation.');
    return false;
  }
  check(unlocked === 'no', 'The bootloader returned an unknown lock state.');
  status('Checking OEM unlock ability…');
  const ability = await fastboot.command('flashing get_unlock_ability');
  status('Checking certificate permission…');
  const permissions = await fastboot.command('oem getpermissions');
  check(/get_unlock_ability:\s*1\b/.test(ability), `OEM unlocking is not enabled (${ability}). Do not request the unlock. Save this message and get help checking OEM permission before retrying.`);
  check(/permissions=flash\b/.test(permissions), `The certificate was not accepted (${permissions}). Do not request the unlock or repeat preparation. Keep your backup and get help checking the certificate.`);
  return true;
}
async function connectFastboot() {
  fastbootReady = false;
  if (fastboot) {
    const previous = fastboot;
    fastboot = undefined;
    await previous.close().catch(() => {});
  }
  if (adb) { await adb.close(); adb = undefined; }
  status('Select your phone in fastboot.');
  const candidate = await Fastboot.connect();
  fastboot = candidate;
  candidate.onDisconnect = () => {
    if (fastboot !== candidate) return;
    fastboot = undefined; fastbootReady = false;
    if (phase === 'fastboot') status('Phone disconnected. Select it again to continue.');
    render();
  };
  try {
    if (!await fastbootChecks()) return;
    check(candidate.isConnected, 'Phone disconnected. Select it again to continue.');
  }
  catch (error) { fastboot = undefined; await candidate.close().catch(() => {}); throw error; }
  phase = 'fastboot';
  fastbootReady = true;
  success('Unlock ability: 1\nPermissions: flash');
}
async function requestUnlock() {
  check(fastbootReady && fastboot, 'Select your phone in fastboot first.');
  fastbootReady = false;
  if (!await fastbootChecks()) return;
  phase = 'prompt';
  // Send no further commands while the phone's confirmation is open.
  await fastboot.command('flashing unlock');
  status('Press Volume Down once, then press the lock button on your phone. Your phone will reboot into LightOS.');
}
registerUnlockRelease(async () => {
  check(!busy && phase !== 'uncertain', 'Wait for the unlock operation and partition verification to finish.');
  if (fastboot) { await fastboot.close(); fastboot = undefined; }
  if (adb) { await adb.close(); adb = undefined; }
  fastbootReady = false;
  render();
});

if (!navigator.usb || !window.isSecureContext) {
  status('Open this page in desktop Chrome or Edge over HTTPS (or localhost).', 'error'); busy = true;
}
window.addEventListener('beforeunload', event => {
  if (busy || phase === 'uncertain') { event.preventDefault(); event.returnValue = ''; }
});
render();
