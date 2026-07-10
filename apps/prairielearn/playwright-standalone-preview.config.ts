import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './src/tests/e2e',
  testMatch: 'standalonePreview.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  workers: 1,
});
