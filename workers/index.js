import release from '../src/webusb/system-release.json';
import images from '../src/webusb/system-images.json';

const paths = new Map(Object.values(images).map(image => [image.url, image]));

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/files/systems/')) return env.ASSETS.fetch(request);
    const image = paths.get(pathname);
    if (!image) return new Response('System image not found.', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const range = request.headers.get('Range');
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) >= image.compressedSize) {
        return new Response('Invalid range.', { status: 416 });
      }
    }
    const url = release.baseUrl + pathname.slice('/files/systems/'.length);
    const response = await fetch(url, {
      method: request.method,
      headers: range ? { Range: range } : {},
      redirect: 'follow',
    });
    if (!response.ok) return new Response('System download unavailable. Retry later.', { status: 502 });
    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges']) {
      if (response.headers.has(name)) headers.set(name, response.headers.get(name));
    }
    return new Response(response.body, { status: response.status, headers });
  },
};
