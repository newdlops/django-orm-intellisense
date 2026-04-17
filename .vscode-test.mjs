import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

const machineExtensionsDir = join(homedir(), '.vscode', 'extensions');

export default defineConfig({
  version: '1.115.0',
  files: 'out/test/**/*.test.js',
  env: {
    DJLS_E2E_BASE_PYTHON: process.env.DJLS_E2E_BASE_PYTHON,
  },
  launchArgs: [
    `--extensions-dir=${machineExtensionsDir}`,
    '--disable-extension=shamanu4.django-intellisense',
    '--disable-extension=github.copilot',
    '--disable-extension=github.copilot-chat',
  ],
});
