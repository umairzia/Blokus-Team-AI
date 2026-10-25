import { defineConfig } from '@playwright/test';

// Browser tests with the in-memory database bridge: two (or more) separate
// browser contexts play through one shared fake Firebase in the test process.
// They run against the production build in dist/ served at the GitHub Pages
// base path. Run `npm run build` first (test:all does).
export default defineConfig({
  testDir: 'e2e/fake',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/fake',
  use: {
    baseURL: 'http://127.0.0.1:4173/Blokus-Team-AI/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'fake-backend' }],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/Blokus-Team-AI/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
