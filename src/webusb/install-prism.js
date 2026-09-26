import { setStatusMessage } from './status-message.js';
import { connectAdb, quote, run, upload } from './transport.js';

const APK_HASH = '748f19acbcece4b1b10675205c4c43ab9426c17c9e10b16745e28fb108143c76';
const APK_SIZE = 30744392;
const APK_PATH = '/data/local/tmp/light-guide-prism.apk';
const tool = document.querySelector('[data-tool="install-prism"]');
const button = tool.querySelector('#install');
const status = tool.querySelector('[data-status]');
let busy = false;
const text = bytes => new TextDecoder().decode(bytes).trim();
const notify = (message, state = 'progress') => {
  setStatusMessage(status, message);
  status.setAttribute('role', state === 'error' ? 'alert' : 'status');
  status.dataset.state = state;
};

if (!navigator.usb) {
  notify('Open this page in desktop Chrome or Edge to install Prism.', 'error');
}

button.addEventListener('click', async () => {
  if (busy) return;
  if (!navigator.usb || !window.isSecureContext) {
    notify('Use desktop Chrome or Edge over HTTPS or localhost.', 'error');
    return;
  }
  busy = true;
  button.setAttribute('aria-busy', 'true');
  notify('Select your phone.');
  let adb;
  let staged = false;
  try {
    adb = await connectAdb(notify);
    notify('Checking your phone…');
    if (text(await run(adb, 'getprop ro.product.model')) !== 'TLP301') {
      throw new Error('This tool supports only the Light Phone III (TLP301).');
    }
    notify('Downloading the Prism debug build…');
    // Cloudflare limits individual static assets to 25 MiB. Reassemble the debug APK locally.
    const parts = await Promise.all([1, 2].map(async part => {
      const response = await fetch(`/files/prism-debug-748f19acbcec.part${part}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('Could not download Prism. Try again.');
      return new Uint8Array(await response.arrayBuffer());
    }));
    if (parts.reduce((size, part) => size + part.length, 0) !== APK_SIZE) {
      throw new Error('The Prism download is incomplete. Refresh this page and try again.');
    }
    const apk = new Uint8Array(APK_SIZE);
    apk.set(parts[0]);
    apk.set(parts[1], parts[0].length);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', apk)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== APK_HASH) throw new Error('The Prism download failed verification. Nothing was installed.');
    notify('Copying Prism to your phone…');
    staged = true;
    await upload(adb, APK_PATH, apk);
    const transferred = text(await run(adb, `sha256sum ${quote(APK_PATH)}`)).split(/\s+/)[0];
    if (transferred !== APK_HASH) throw new Error('The copied APK failed verification. Nothing was installed.');
    notify('Installing Prism…');
    const result = text(await run(adb, `pm install -r ${quote(APK_PATH)} 2>&1 || true`));
    if (!/^Success$/m.test(result)) throw new Error(result || 'Android did not confirm the installation.');
    notify('Opening Prism…');
    try {
      const launch = text(await run(adb, 'am start -W -n com.vandam.prism/.PrismActivity 2>&1 || true'));
      if (!/^Status: ok$/m.test(launch)) throw new Error('Prism did not open.');
      notify('Prism installed and opened. Continue to Start Shizuku below.', 'success');
    } catch {
      notify('Prism installed. Open it on your phone, then continue to Start Shizuku below.', 'success');
    }
  } catch (reason) {
    notify(reason.message, 'error');
  } finally {
    if (adb) {
      if (staged) await run(adb, `rm -f ${quote(APK_PATH)}`).catch(() => {});
      await adb.close().catch(() => {});
    }
    busy = false;
    button.setAttribute('aria-busy', 'false');
  }
});
