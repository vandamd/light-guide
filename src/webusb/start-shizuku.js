import { setStatusMessage } from './status-message.js';
import { connectAdb, quote, run } from './transport.js';

const tool = document.querySelector('[data-tool="start-shizuku"]');
const button = tool.querySelector('#start');
const status = tool.querySelector('[data-status]');
let busy = false;
const text = bytes => new TextDecoder().decode(bytes).trim();
const notify = (message, state = 'progress') => {
  setStatusMessage(status, message);
  status.setAttribute('role', state === 'error' ? 'alert' : 'status');
  status.dataset.state = state;
};

if (!navigator.usb) {
  notify('Open this page in desktop Chrome or Edge to start Shizuku.', 'error');
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
  try {
    adb = await connectAdb(notify);
    notify('Checking Shizuku…');
    if (text(await run(adb, 'getprop ro.product.model')) !== 'TLP301') {
      throw new Error('This tool supports only the Light Phone III (TLP301).');
    }
    const paths = text(await run(adb, 'pm path moe.shizuku.privileged.api 2>/dev/null || true'));
    const apk = paths.split('\n').find(path => path.startsWith('package:') && path.endsWith('/base.apk'))?.slice(8);
    if (!apk) throw new Error('Install Shizuku through Prism first, then try again.');
    if (!text(await run(adb, 'pidof shizuku_server || true'))) {
      const starter = apk.slice(0, apk.lastIndexOf('/')) + '/lib/arm64/libshizuku.so';
      const available = text(await run(adb, `if [ -x ${quote(starter)} ]; then echo yes; fi`));
      if (available !== 'yes') throw new Error('The Shizuku starter was not found. Update Shizuku through Prism and try again.');
      notify('Starting Shizuku…');
      const output = text(await run(adb, `${quote(starter)} ${quote('--apk=' + apk)} 2>&1 || true`));
      if (!output.includes('shizuku_starter exit with 0')) {
        throw new Error(output || 'Shizuku could not start. Open Shizuku on your phone for details.');
      }
      const pid = text(await run(adb, 'for attempt in 1 2 3 4 5; do pidof shizuku_server && exit 0; sleep 1; done; exit 0'));
      if (!pid) throw new Error('Shizuku stopped after starting. Open Shizuku on your phone for details.');
    }
    notify('Shizuku is running. Return to Prism and allow access when asked.', 'success');
  } catch (reason) {
    notify(reason.message, 'error');
  } finally {
    if (adb) await adb.close().catch(() => {});
    busy = false;
    button.setAttribute('aria-busy', 'false');
  }
});
