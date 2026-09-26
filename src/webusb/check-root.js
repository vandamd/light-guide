import { setStatusMessage } from './status-message.js';
import { connectAdb, run } from './transport.js';

const tool = document.querySelector('[data-tool="check-root"]');
const button = tool.querySelector('button');
const status = tool.querySelector('[data-status]');
let busy = false;
const text = bytes => new TextDecoder().decode(bytes).trim();
const notify = (message, state = 'progress') => {
  setStatusMessage(status, message);
  status.setAttribute('role', state === 'error' ? 'alert' : 'status');
  status.dataset.state = state;
};

if (!navigator.usb || !window.isSecureContext) {
  notify('Use desktop Chrome or Edge over HTTPS or localhost.', 'error');
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
    if (text(await run(adb, 'getprop ro.product.model')) !== 'TLP301') {
      throw new Error('Only the Light Phone III (TLP301) is supported.');
    }
    notify('Checking root and Shell access…');
    if (text(await run(adb, 'id -u', true)) !== '0') {
      throw new Error('Shell does not have root access. Activate root in Prism and enable Shell in ReSukiSU, then retry.');
    }
    notify('Root and Shell access verified. Continue to Web Install.', 'success');
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    if (adb) await adb.close().catch(() => {});
    busy = false;
    button.setAttribute('aria-busy', 'false');
  }
});
