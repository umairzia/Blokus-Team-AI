import { defineConfig } from '@playwright/test';

// The production code with the real Firebase SDK, against the local Auth and
// Realtime Database emulators (a demo- project). Uses the build in
// dist-emulator/ (`npm run build:emulator`). Run through
// `npm run test:e2e:emulator`, which starts the emulators.
export default defineConfig({
  testDir: 'e2e/emulator',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/emulator',
  use: {
    baseURL: 'http://127.0.0.1:4174/Blokus-Team-AI/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'emulator' }],
  webServer: {
    command: 'npx vite preview --outDir dist-emulator --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174/Blokus-Team-AI/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
