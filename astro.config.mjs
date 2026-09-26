import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import systemRelease from './src/webusb/system-release.json';

export default defineConfig({
  redirects: {
    '/web-unlock': '/web-install#unlock',
    '/flashing': '/web-install#install',
    '/relock': '/restore-stock#relock-options',
  },
  integrations: [mdx()],
  vite: {
    server: {
      proxy: {
        '/files/systems/': {
          target: 'https://github.com',
          changeOrigin: true,
          followRedirects: true,
          rewrite: path => new URL(systemRelease.baseUrl).pathname + path.slice('/files/systems/'.length),
        },
      },
    },
    optimizeDeps: {
      include: ['@yume-chan/adb', '@yume-chan/adb-daemon-webusb', '@yume-chan/adb-credential-web', 'fflate'],
    },
  },
  markdown: { shikiConfig: { theme: 'github-dark' } },
});
