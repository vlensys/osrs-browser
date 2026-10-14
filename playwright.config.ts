import { defineConfig, devices } from '@playwright/test';

const port = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 120_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}/`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Headless Chromium has no GPU; force the SwiftShader WebGL path so WebGL2 is available everywhere.
        launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true } },
      },
    },
  ],
  webServer: {
    command: `npm run preview`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
