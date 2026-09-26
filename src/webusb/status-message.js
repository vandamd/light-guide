export function setStatusMessage(element, message) {
  const parts = message.split('adb kill-server');
  element.replaceChildren(parts[0]);
  for (const part of parts.slice(1)) {
    const code = document.createElement('code');
    code.textContent = 'adb kill-server';
    element.append(code, part);
  }
}
