import { setStatusMessage } from './status-message.js';
import { releaseUnlockConnection } from './install-session.js';
import { unzip } from 'fflate';
import release from './release.json';
import bootProperties from './boot-properties.sh?raw';
import { cachedRelease } from './release-cache.js';
import { downloadSystem, verifySystemCache, readSystemChunk, systemImage } from './system-images.js';
import { connectAdb, run, upload, Fastboot, quote } from './transport.js';
import { sha256 } from './certificate.js';
import { setupMicrog } from './microg.js';
import { FILES, MANAGER, unchangedPartitions, RELEASE_SLOTS, TARGETS, LINEAGE_VERSION } from './firmware.js';

const tool = document.querySelector('[data-tool="web-flash"]');
const restoring = tool.dataset.target === 'stock';
let target = restoring ? 'stock' : 'custom';
const $ = id => tool.querySelector('#' + id);
const check = (ok, message) => { if (!ok) throw new Error(message); };
const text = bytes => new TextDecoder().decode(bytes).trim();
const installPhases = ['start', 'checked', 'fastboot', 'system-fastboot', 'writing-system', 'boot-fastboot', 'writing-boot', 'flashed', 'recovery-fastboot'];
let phase = 'start', serial, slot, sourceOs, adb, fastboot, busy = false, step = 1, files;
let interacted = false;
const expected = () => TARGETS[target];
const needsSystem = () => target === 'lineage' || sourceOs === 'lineage';
const systemName = () => target === 'lineage' ? 'lineage' : 'stock';
const bootPropertiesPath = '/data/adb/service.d/light-guide-boot-properties.sh';
function status(message, at = step, state = 'progress') {
  for (const field of tool.querySelectorAll('[id^="status-"]')) field.hidden = true;
  const field = $('status-' + at);
  setStatusMessage(field, message);
  field.hidden = !interacted && state !== 'error';
  field.setAttribute('role', state === 'error' ? 'alert' : 'status');
  field.dataset.state = state;
}
const success = message => status(message, step, 'success');
function render() {
  const flashPart = {
    'system-fastboot': 2, 'writing-system': 2,
    'boot-fastboot': 3, 'writing-boot': 3, flashed: 3,
    'recovery-fastboot': 4, recovery: 4, 'confirm-boot': 4, verified: 4,
  }[phase] || 1;
  for (const part of [2, 3, 4]) $('flash-part-' + part).hidden = !needsSystem() || part > flashPart;
  for (const radio of tool.querySelectorAll('input[name="release"]')) {
    radio.disabled = busy;
    radio.checked = radio.value === target;
  }
  if (restoring) {
    $('status-6').setAttribute('aria-busy', String(busy && step === 6));
    $('status-7').setAttribute('aria-busy', String(busy && step === 7));
  }
  for (const at of [1, 2, 3, 5]) $('status-' + at).setAttribute('aria-busy', String(busy && at === step));
}
async function action(at, task) {
  if (busy) {
    status('An operation is still running. Please wait, then retry.', at, 'error');
    return;
  }
  interacted = true; step = at; busy = true; render();
  try {
    check(navigator.usb && window.isSecureContext, 'Use desktop Chrome or Edge over HTTPS or localhost.');
    await task();
  }
  catch (error) {
    let message = error.message || String(error);
    if (['writing-system', 'writing-boot'].includes(phase)) message += ' Keep the phone in fastboot and retry this step. Do not boot or relock a partial installation.';
    status(message, at, 'error');
  } finally { busy = false; render(); }
}
const prop = async name => text(await run(adb, 'getprop ' + name));
async function closeAdb() { if (adb) { const previous = adb; adb = undefined; await previous.close().catch(() => {}); } }
async function closeFastboot() { if (fastboot) { const previous = fastboot; fastboot = undefined; await previous.close().catch(() => {}); } }
async function runningOs() {
  const version = await prop('ro.lineage.version');
  if (version) {
    check(version === LINEAGE_VERSION, 'This LineageOS version is not supported.');
    check(await prop('ro.vendor.build.version.incremental') === '00WW_1_440000', 'The vendor firmware does not match the tested release.');
    return 'lineage';
  }
  check(await prop('ro.build.version.incremental') === '00WW_1_440000', 'This LightOS firmware is not supported.');
  return 'lightos';
}
async function connect() {
  await releaseUnlockConnection(); await closeFastboot(); await closeAdb();
  adb = await connectAdb(status);
  const candidate = adb;
  const disconnected = () => { if (adb === candidate) { adb = undefined; render(); } };
  candidate.disconnected.then(disconnected, disconnected);
  try {
    check(await prop('ro.product.vendor.model') === 'TLP301', 'Only TLP301 is supported.');
    await runningOs();
    const dsu = await prop('ro.gsid.image_running');
    check(!['1', 'true'].includes(dsu), 'Exit the temporary DSU installation before using this installer.');
    const suffix = await prop('ro.boot.slot_suffix');
    check(['_a', '_b'].includes(suffix), 'The phone did not report a valid active slot.');
    const activeSlot = suffix.slice(1);
    check(RELEASE_SLOTS.includes(activeSlot), 'The active slot is unsupported.');
    slot = activeSlot;
    check(await prop('ro.serialno') === candidate.serial, 'The phone serial does not match.');
    serial = candidate.serial;
  } catch (error) { await closeAdb(); throw error; }
}
async function partitions(requireTarget = false) {
  const os = await runningOs();
  const kernel = text(await run(adb, 'uname -r'));
  check(Object.values(TARGETS).some(t => t.kernel === kernel), 'This kernel has not been validated.');
  const root = kernel === TARGETS.custom.kernel ? 'kernel' : true;
  check(text(await run(adb, 'id -u', root)) === '0', 'Grant Shell superuser access, then retry.');
  const paths = { ...unchangedPartitions(slot), [`/dev/block/by-name/boot_${slot}`]: null, [`/dev/block/by-name/vbmeta_${slot}`]: null };
  // The GSI's raw system hash changes after boot; all other partition hashes remain pinned.
  if (os === 'lineage') delete paths[`/dev/block/mapper/system_${slot}`];
  const hashes = {};
  for (const [path, wanted] of Object.entries(paths)) {
    status('Checking ' + path.split('/').pop() + '…');
    const hash = text(await run(adb, 'sha256sum ' + path, root)).split(/\s+/)[0];
    if (wanted) check(hash === wanted, 'The installed ' + path.split('/').pop() + ' does not match the tested firmware. Nothing further will be written.');
    hashes[path] = hash;
  }
  const boot = hashes[`/dev/block/by-name/boot_${slot}`];
  const vbmeta = hashes[`/dev/block/by-name/vbmeta_${slot}`];
  const matches = image => boot === FILES[image.boot].sha256 && vbmeta === FILES[image.vbmeta].sha256;
  let supported;
  if (requireTarget) {
    supported = matches(expected());
  } else {
    const current = os === 'lineage' ? [TARGETS.lineage] : [TARGETS.stock, TARGETS.custom];
    supported = current.some(matches);
  }
  check(supported, 'The boot/vbmeta pair does not match a supported installation.');
}
async function checkBoot(locked = false) {
  check(await prop('sys.boot_completed') === '1', 'Android is still starting. Retry once it is ready.');
  check(await runningOs() === (target === 'lineage' ? 'lineage' : 'lightos'), 'The selected operating system is not running.');
  check(text(await run(adb, 'uname -r')) === expected().kernel, 'The expected kernel is not running.');
  // Both custom options can spoof these properties. Fastboot checks the real state before writes.
  if (target !== 'stock') {
    check(!locked, 'Do not relock custom firmware.');
    if (target === 'custom') check(await prop('ro.boot.vbmeta.digest') === expected().digest, 'The verification digest does not match the selected firmware.');
    return;
  }
  check(await prop('ro.boot.flash.locked') === (locked ? '1' : '0'), locked ? 'The phone is not locked yet.' : 'The bootloader must be unlocked.');
  check(await prop('ro.boot.vbmeta.device_state') === (locked ? 'locked' : 'unlocked'), 'Unexpected bootloader state.');
  if (locked) check(await prop('ro.boot.verifiedbootstate') === 'green', 'Stock verified boot is not green.');
  check(await prop('ro.boot.vbmeta.digest') === expected().digest, 'The verification digest does not match the selected firmware.');
}
async function fastbootChecks(userspace) {
  check(fastboot?.isConnected, 'Select the phone in fastboot again.');
  const state = async command => (await fastboot.command(command)).trim();
  check(await state('getvar:serialno') === serial, 'Select the same phone.');
  check(await state('getvar:unlocked') === 'yes', 'The bootloader must be unlocked.');
  check(await state('getvar:current-slot') === slot, 'The active slot changed. Stop before flashing.');
  check(await state('getvar:is-userspace') === (userspace ? 'yes' : 'no'), userspace ? 'Select the phone in fastbootd, not bootloader fastboot.' : 'Select bootloader fastboot, not fastbootd.');
  if (userspace) check(await state('getvar:snapshot-update-status') === 'none', 'An OTA snapshot is active. Stop before flashing.');
}
async function selectFastboot(userspace = false) {
  const device = await Fastboot.requestDevice();
  await closeFastboot();
  fastboot = await Fastboot.connect(serial, device);
  const candidate = fastboot;
  candidate.onDisconnect = () => { if (fastboot === candidate) { fastboot = undefined; render(); } };
  try { await fastbootChecks(userspace); }
  catch (error) { await closeFastboot(); throw error; }
}
async function rebootAdb(next) {
  phase = next;
  const previous = adb; adb = undefined;
  try { await previous.power.bootloader(); }
  catch { status('Select the phone once it reaches fastboot.'); }
  finally { await previous.close().catch(() => {}); }
}
async function rebootFastboot(command, next) {
  // Track only the active transfer across USB mode changes.
  const previous = phase;
  phase = next;
  try { await fastboot.command(command); }
  catch (error) {
    if (error.code === 'FASTBOOT_REJECTED') phase = previous;
    throw error;
  } finally { await closeFastboot(); }
}
async function loadRelease(bytes) {
  check(bytes.length === release.size && await sha256(bytes) === release.sha256, 'This ZIP does not match the supported release. Download it again.');
  const loaded = await new Promise((resolve, reject) => unzip(bytes, (error, entries) => error ? reject(error) : resolve(entries)));
  check(Object.keys(loaded).length === Object.keys(FILES).length, 'Unexpected release contents.');
  for (const [name, spec] of Object.entries(FILES)) {
    check(loaded[name]?.length === spec.size && await sha256(loaded[name]) === spec.sha256, 'Release verification failed: ' + name);
  }
  files = loaded;
}
$('download').onclick = () => action(1, async () => {
  if (!files) await loadCachedRelease();
  if (!files) {
    const bytes = new Uint8Array(release.size); let offset = 0;
    for (const url of release.parts) {
      status('Downloading boot images: ' + Math.round(offset / release.size * 100) + '%');
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      check(response.ok, 'Release download failed. Try again.');
      const part = new Uint8Array(await response.arrayBuffer());
      check(offset + part.length <= bytes.length, 'Unexpected release download size.');
      bytes.set(part, offset); offset += part.length;
    }
    check(offset === release.size, 'The release download is incomplete.');
    await loadRelease(bytes);
    await cachedRelease('write', bytes);
  }
  if (target !== 'custom' || needsSystem()) await downloadSystem(systemName(), status);
  success('Release saved in your browser. Ready to install.');
});
for (const radio of tool.querySelectorAll('input[name="release"]')) radio.onchange = () => {
  if (busy) return;
  if (['writing-system', 'writing-boot', 'boot-fastboot', 'flashed', 'recovery-fastboot'].includes(phase)) {
    status('Finish the current flash before changing the release.', 1, 'error');
    render();
    return;
  }
  target = radio.value; phase = 'start'; sourceOs = undefined;
  for (const button of tool.querySelectorAll('[id^="configure-part-"]')) button.hidden = true;
  for (const field of tool.querySelectorAll('[id^="status-"]')) field.hidden = true;
  render();
};
async function flashSystem() {
  const image = systemImage(systemName());
  await fastbootChecks(true);
  check((await fastboot.command('getvar:is-logical:system_' + slot)).trim() === 'yes', 'The system partition is not logical.');
  const max = Number((await fastboot.command('getvar:max-download-size')).trim());
  check(Number.isSafeInteger(max) && max >= 16 * 1024 * 1024 + 64, 'The fastbootd download buffer is too small.');
  phase = 'writing-system';
  await fastboot.command(`resize-logical-partition:system_${slot}:${image.size}`);
  check(Number((await fastboot.command('getvar:partition-size:system_' + slot)).trim()) === image.size, 'System partition resize did not match.');
  for (const part of image.parts) {
    const bytes = await readSystemChunk(part);
    await fastboot.flashSystemChunk('system_' + slot, bytes, part.offset, image.size, fraction => status('Writing system: ' + Math.round((part.offset + fraction * part.size) / image.size * 100) + '%'));
  }
  await rebootFastboot('reboot-bootloader', 'boot-fastboot');
  status('System installed. When bootloader fastboot appears, select Part 3 and choose your phone.');
}
async function flashBoot() {
  await fastbootChecks(false);
  const spec = expected();
  const max = Number((await fastboot.command('getvar:max-download-size')).trim());
  check(Number.isSafeInteger(max) && max >= FILES[spec.boot].size, 'The bootloader download buffer is too small.');
  const images = [[`boot_${slot}`, spec.boot], [`vbmeta_${slot}`, spec.vbmeta]];
  for (const [partition, name] of images) check(Number((await fastboot.command('getvar:partition-size:' + partition)).trim()) === FILES[name].size, 'Unexpected partition size for ' + partition);
  phase = 'writing-boot';
  for (const [partition, name] of images) await fastboot.flash(partition, files[name], fraction => status('Writing ' + partition + ': ' + Math.round(fraction * 100) + '%'));
  if (target === 'custom') await fastboot.flash('avb_custom_key', files['owner-key.avbpubkey']);
  else await fastboot.command('erase:avb_custom_key');
  phase = 'flashed';
}
async function prepareInstallation() {
  lockChecked = false;
  await connect(); sourceOs = await runningOs();
  const stockKernel = text(await run(adb, 'uname -r')) === TARGETS.stock.kernel;
  if (stockKernel) check(await prop('ro.boot.flash.locked') === '0', 'Unlock the bootloader first.');
  await partitions();
  if (restoring) await run(adb, 'rm -f ' + bootPropertiesPath, stockKernel ? true : 'kernel');
  if (needsSystem()) await downloadSystem(systemName(), status);
  phase = 'checked'; await rebootAdb('fastboot');
  success('Select the phone in bootloader fastboot.');
}
$('enter-fastboot').onclick = () => action(3, async () => {
  check(!['writing-system', 'writing-boot', 'boot-fastboot', 'flashed', 'recovery-fastboot'].includes(phase), 'Finish the current flash before starting another firmware check.');
  await prepareInstallation();
});
$('install-release').onclick = () => action(2, async () => {
  lockChecked = false;
  check(serial && slot && sourceOs && installPhases.includes(phase), 'The firmware has not been verified in this session. Return to Android and use Enter fastboot to check it before flashing.');
  check(!['start', 'checked'].includes(phase), 'Enter fastboot using the step above first.');
  await selectFastboot(['system-fastboot', 'writing-system', 'recovery-fastboot'].includes(phase));
  if (!files) await loadCachedRelease();
  check(files, 'Download the release first.');
  if (needsSystem()) await verifySystemCache(systemName(), status);
  if (['system-fastboot', 'writing-system'].includes(phase)) {
    await flashSystem();
  } else if (phase === 'recovery-fastboot') {
    await rebootFastboot('reboot-recovery', 'recovery');
    success('Flashing complete. In recovery, choose Wipe data/factory reset, confirm, then Reboot system now.\n\nFinish Android setup, enable USB debugging and continue with the setup step below.');
  } else {
    if (phase === 'fastboot' && needsSystem()) {
      await rebootFastboot('reboot-fastboot', 'system-fastboot');
      status('When fastbootd appears, select Part 2 and choose your phone.');
      return;
    }
    if (phase !== 'flashed') await flashBoot();
    if (needsSystem()) {
      await rebootFastboot('reboot-fastboot', 'recovery-fastboot');
      status('Boot images installed. When fastbootd appears, select Part 4 and choose your phone to open recovery.');
    } else {
      await rebootFastboot('reboot', 'boot');
      success('Installed. Once LightOS starts, continue with the setup step below.');
    }
  }
});
for (const part of [2, 3, 4]) $('flash-part-' + part).onclick = $('install-release').onclick;
const layouts = {
  'Pixart_pat9126ja.kl': 'key 19 BRIGHTNESS_UP\nkey 20 BRIGHTNESS_DOWN\n',
  'gpio-keys.kl': 'key 27 RIGHT_BRACKET\nkey 66 F8\nkey 80 NUMPAD_2\nkey 102 HOME\nkey 115 VOLUME_UP\n',
};
async function configureLineage() {
  const directory = '/data/system/devices/keylayout';
  await run(adb, 'wm density 320');
  await run(adb, 'mkdir -p ' + directory, 'kernel');
  for (const [name, content] of Object.entries(layouts)) {
    await run(adb, `printf %s ${quote(content)} > ${directory}/${name}`, 'kernel');
    check(text(await run(adb, 'cat ' + directory + '/' + name, 'kernel')) === content.trim(), 'Button layout readback failed.');
  }
  await run(adb, `chown system:system /data/system/devices ${directory} ${directory}/*.kl && chmod 755 /data/system/devices ${directory} && chmod 644 ${directory}/*.kl && restorecon -RF /data/system/devices`, 'kernel');
}
function showSetupPart(part) {
  for (let number = 2; number <= part; number++) $('configure-part-' + number).hidden = false;
}
$('configure').onclick = () => action(5, async () => {
  const withMicrog = target !== 'stock';
  await connect();
  const locked = restoring && await prop('ro.boot.flash.locked') === '1';
  await checkBoot(locked);
  if (locked) {
    success('Stock LightOS is locked with green verified boot.');
    await closeAdb();
    return;
  }
  if (target !== 'stock') {
    if (target === 'lineage') await run(adb, 'wm density 320');
    const installed = text(await run(adb, 'dumpsys package com.resukisu.resukisu'));
    const version = Number(installed.match(/\bversionCode=(\d+)/)?.[1] ?? 0);
    if (version < MANAGER.versionCode) {
      if (!files) await loadCachedRelease();
      check(files, 'Download the release to install ReSukiSU.');
      const path = '/data/local/tmp/light-guide-resukisu.apk';
      await upload(adb, path, files[MANAGER.filename]);
      check(text(await run(adb, 'sha256sum ' + path)).split(/\s+/)[0] === FILES[MANAGER.filename].sha256, 'APK transfer failed verification.');
      check(text(await run(adb, 'pm install -r ' + path)) === 'Success', 'Android did not confirm installation.');
      await run(adb, 'rm -f ' + path);
    }
    try {
      check(text(await run(adb, 'id -u', 'kernel')) === '0', 'Shell root access is required.');
    } catch {
      await run(adb, 'am start -n com.resukisu.resukisu/.ui.MainActivity');
      if (target === 'lineage') showSetupPart(2);
      status('In ReSukiSU, open Superuser and grant Shell access using Default. Then select ' + (target === 'lineage' ? 'Part 2.' : 'Set up and verify ReSukiSU again.'));
      return;
    }
  }
  await partitions(true);
  if (target === 'custom') {
    await run(adb, `mkdir -p /data/adb/service.d && printf %s ${quote(bootProperties)} > ${bootPropertiesPath} && chown root:root ${bootPropertiesPath} && chmod 700 ${bootPropertiesPath}`, 'kernel');
    check(text(await run(adb, 'cat ' + bootPropertiesPath, 'kernel')) === bootProperties.trim(), 'Boot-property script readback failed.');
    await run(adb, 'sh ' + bootPropertiesPath, 'kernel');
    check(await prop('ro.boot.flash.locked') === '1' && await prop('ro.boot.vbmeta.device_state') === 'locked' && await prop('ro.boot.verifiedbootstate') === 'green', 'Bootloader property spoofing did not apply.');
  }
  if (target === 'lineage') {
    check(/^CONFIG_KSU_SUSFS=y$/m.test(text(await run(adb, 'zcat /proc/config.gz', 'kernel'))), 'SUSFS is not enabled in the running kernel.');
    check(text(await run(adb, 'getenforce')) === 'Enforcing', 'SELinux must be enforcing.');
    const input = text(await run(adb, 'dumpsys input'));
    const density = text(await run(adb, 'wm density'));
    const configured = Object.keys(layouts).every(name => input.includes('/data/system/devices/keylayout/' + name)) && density.includes('Override density: 320');
    if (!configured) {
      await configureLineage(); phase = 'confirm-boot';
      showSetupPart(3);
      const previous = adb; adb = undefined;
      try { await previous.power.reboot(); } finally { await previous.close().catch(() => {}); }
      status('Display and button fixes applied. Once Android restarts, select Part 3.');
      return;
    }
  }
  const nextPart = withMicrog ? await setupMicrog(adb, status) : false;
  if (nextPart) {
    const part = nextPart + (target === 'lineage' ? 2 : 0);
    showSetupPart(part);
    const previous = adb; adb = undefined;
    try { await previous.power.reboot(); } finally { await previous.close().catch(() => {}); }
    status(`microG setup needs a restart. Once Android starts, select Part ${part}.`);
    return;
  }
  if (target !== 'stock') {
    const installed = text(await run(adb, 'pm list packages')).split('\n');
    for (const [name, label] of [['com.vandam.prism', 'Prism'], ['moe.shizuku.privileged.api', 'Shizuku']]) {
      if (!installed.includes('package:' + name)) continue;
      status('Removing ' + label + '…');
      check(text(await run(adb, 'pm uninstall ' + name)) === 'Success', 'Could not remove ' + label + '. Retry this step.');
    }
  }
  const paragraphs = [
    expected().label + ' verified. Installation complete.',
    'The bootloader remains unlocked.' + (target === 'custom' ? ' Android reports locked/green for app compatibility.' : ''),
  ];
  if (withMicrog) paragraphs.push('microG Self-Check is open: confirm the signature checks and choose the permissions you need.');
  phase = 'verified';
  success(paragraphs.join('\n\n'));
});
for (const button of tool.querySelectorAll('[id^="configure-part-"]')) button.onclick = $('configure').onclick;
let lockChecked = false;
if (restoring) {
  $('lock').onclick = () => action(6, async () => {
    lockChecked = false;
    await connect();
    const locked = await prop('ro.boot.flash.locked') === '1';
    await checkBoot(locked);
    if (locked) { success('Stock LightOS is already locked with green verified boot.'); return; }
    await partitions(true);
    lockChecked = true;
    await rebootAdb('lock-fastboot');
    success('Stock verified. Select the same phone in the next step to request the lock.');
  });
  $('confirm-lock').onclick = () => action(7, async () => {
    check(lockChecked, 'Check stock and enter fastboot first. Relocking requires verified stock partitions.');
    await selectFastboot();
    await fastboot.command('erase:avb_custom_key');
    await fastboot.command('flashing lock');
    lockChecked = false;
    status('Press Volume Down once, then the lock button. Your phone will reset and restart into LightOS.');
    await closeFastboot();
  });
}
window.addEventListener('beforeunload', event => {
  if (busy || ['writing-system', 'writing-boot', 'boot-fastboot', 'flashed', 'recovery-fastboot'].includes(phase)) {
    event.preventDefault(); event.returnValue = '';
  }
});
render();
async function loadCachedRelease() {
  const bytes = await cachedRelease('read');
  if (bytes) await loadRelease(bytes);
}
