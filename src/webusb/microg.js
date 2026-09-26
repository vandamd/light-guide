import assets from './microg.json';
import { run, upload, quote } from './transport.js';
import { sha256 } from './certificate.js';

const text = bytes => new TextDecoder().decode(bytes).trim();
const cli = '/data/adb/modules/zygisk_vector/cli';
const rebootMarker = '/data/adb/light-guide-microg-reboot';
const check = (ok, message) => { if (!ok) throw new Error(message); };

async function transfer(adb, asset, status) {
  status('Downloading ' + asset.label + '…');
  const bytes = new Uint8Array(asset.size);
  let offset = 0;
  for (const url of asset.parts) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    check(response.ok, 'Could not download ' + asset.label + '. Retry setup.');
    const part = new Uint8Array(await response.arrayBuffer());
    check(offset + part.length <= bytes.length, 'Unexpected download size.');
    bytes.set(part, offset); offset += part.length;
  }
  check(offset === asset.size && await sha256(bytes) === asset.sha256, asset.label + ' download failed verification.');
  const path = '/data/local/tmp/light-guide-' + asset.id + (asset.kind === 'module' ? '.zip' : '.apk');
  status('Installing ' + asset.label + '…');
  await upload(adb, path, bytes);
  check(text(await run(adb, 'sha256sum ' + quote(path))).split(/\s+/)[0] === asset.sha256, asset.label + ' transfer failed verification.');
  return path;
}

// Returns the next setup part when a restart is needed.
export async function setupMicrog(adb, status) {
  const root = command => run(adb, command, 'kernel', 180000);
  const modules = JSON.parse(text(await root('/data/adb/ksud module list')));
  for (const id of ['zygisk_lsposed', 'zygisknext', 'rezygisk']) {
    check(!modules.some(module => module.id === id && module.enabled === 'true'), 'Disable the existing Xposed/Zygisk module before installing the microG setup: ' + id);
  }
  for (const asset of assets.filter(asset => asset.kind === 'apk')) {
    const paths = text(await run(adb, 'pm path ' + asset.id + ' || true'));
    const installed = paths.split('\n').find(path => path.endsWith('/base.apk'))?.slice(8);
    const matches = installed && text(await run(adb, 'sha256sum ' + quote(installed))).split(/\s+/)[0] === asset.sha256;
    const companion = asset.id === 'com.android.vending';
    if (matches) {
      if (!companion) continue;
      const details = text(await run(adb, 'dumpsys package ' + asset.id));
      if (details.includes('forceQueryable=true (override=true)')) continue;
      status('Making microG Companion visible to apps…');
    }
    const path = matches ? installed : await transfer(adb, asset, status);
    // GsfProxy targets SDK 23, below the Android 15+ installation minimum.
    const flags = companion ? ' --force-queryable' : asset.id === 'com.google.android.gsf' ? ' --bypass-low-target-sdk-block' : '';
    const result = text(await run(adb, 'pm install -r' + flags + ' ' + quote(path), false, 180000));
    check(result === 'Success', asset.label + ' installation failed: ' + result);
    if (!matches) await run(adb, 'rm -f ' + quote(path));
  }
  let restart = false;
  for (const asset of assets.filter(asset => asset.kind === 'module')) {
    const installed = modules.find(module => module.id === asset.id);
    if (installed?.versionCode !== asset.versionCode || installed.remove === 'true') {
      const path = await transfer(adb, asset, status);
      await root('/data/adb/ksud module install ' + quote(path));
      const updated = JSON.parse(text(await root('/data/adb/ksud module list'))).find(module => module.id === asset.id);
      check(updated?.versionCode === asset.versionCode, asset.label + ' installation was not confirmed.');
      await run(adb, 'rm -f ' + quote(path));
      restart = true;
    } else if (installed.enabled !== 'true') {
      await root('/data/adb/ksud module enable ' + asset.id);
      restart = true;
    } else if (installed.update === 'true') restart = true;
  }
  if (restart) return 2;

  status('Configuring microG signature spoofing…');
  const query = async command => {
    const result = JSON.parse(text(await root(cli + ' --json ' + command)));
    check(result.success, result.error || 'Vector could not configure signature spoofing.');
    return result.data;
  };
  const enabled = (await query('modules ls')).some(module => module.PACKAGE === 'inc.whew.android.fakegapps' && module.STATUS === 'enabled');
  if (!enabled) {
    await root('cat /proc/sys/kernel/random/boot_id > ' + rebootMarker);
    const result = await query('modules enable inc.whew.android.fakegapps');
    check(result.Enabled?.includes('inc.whew.android.fakegapps'), 'Could not enable FakeGApps.');
  }
  const scope = await query('scope ls inc.whew.android.fakegapps');
  const scoped = scope.length === 1 && scope[0].APP_PACKAGE === 'system' && scope[0].USER_ID === 0;
  if (!enabled || !scoped) {
    // Keep a reboot reminder on the device if USB disconnects before the restart.
    await root('cat /proc/sys/kernel/random/boot_id > ' + rebootMarker);
    if (!scoped) await query('scope set inc.whew.android.fakegapps system/0');
    return 3;
  }
  const currentBoot = text(await run(adb, 'cat /proc/sys/kernel/random/boot_id'));
  const configuredBoot = text(await root('if [ -f ' + rebootMarker + ' ]; then cat ' + rebootMarker + '; fi'));
  if (configuredBoot === currentBoot) return 3;
  await root('rm -f ' + rebootMarker);
  await root('am start -n ' + quote('com.google.android.gms/org.microg.gms.ui.SelfCheckFragment$AsActivity'));
  return false;
}
