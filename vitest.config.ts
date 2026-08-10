import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Render-heavy tests (full-page PNG encodes) can exceed the 5s default on
    // slower machines; the work is CPU-bound, not hung.
    testTimeout: 30_000,
    env: {
      PXPIPE_PROFILE: '',
      PXPIPE_MODELS: '',
      HTTP_PROXY: '',
      http_proxy: '',
      HTTPS_PROXY: '',
      https_proxy: '',
      ALL_PROXY: '',
      all_proxy: '',
      NODE_EXTRA_CA_CERTS: '',
      SSL_CERT_FILE: '',
      CURL_CA_BUNDLE: '',
      REQUESTS_CA_BUNDLE: '',
    },
  },
});
