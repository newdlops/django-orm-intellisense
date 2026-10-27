import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

const machineExtensionsDir = join(homedir(), '.vscode', 'extensions');
// Per-launch diagnostic control; does not change installed extension settings.
const extraDisabledExtensions = (process.env.DJLS_E2E_DISABLE_EXTENSIONS ?? '')
  .split(',').map(value => value.trim()).filter(value => /^[a-z0-9-]+\.[a-z0-9-]+$/i.test(value));
const rendererDebugPort = Number(process.env.DJLS_E2E_RENDERER_DEBUG_PORT ?? 0);
const forceRendererAccessibility = process.env.DJLS_E2E_ACCESSIBLE === '1';
const userDataDir = process.env.DJLS_E2E_USER_DATA_DIR;
const workspaceFile = process.env.DJLS_E2E_WORKSPACE;
if (userDataDir && !isAbsolute(userDataDir)) {
  throw new Error('DJLS_E2E_USER_DATA_DIR must be an absolute test-owned directory');
}
if (workspaceFile && !isAbsolute(workspaceFile)) {
  throw new Error('DJLS_E2E_WORKSPACE must be an absolute test-owned workspace path');
}
if (process.env.DJLS_E2E_RENDERER_DEBUG_PORT && (!Number.isInteger(rendererDebugPort) || rendererDebugPort < 1024 || rendererDebugPort > 65535)) {
  throw new Error('DJLS_E2E_RENDERER_DEBUG_PORT must be a TCP port between 1024 and 65535');
}

export default defineConfig({
  version: '1.115.0',
  workspaceFolder: workspaceFile,
  useInstallation: process.env.DJLS_E2E_VSCODE_EXECUTABLE
    ? { fromPath: process.env.DJLS_E2E_VSCODE_EXECUTABLE }
    : undefined,
  files: 'out/test/**/*.test.js',
  env: {
    DJLS_E2E_BASE_PYTHON: process.env.DJLS_E2E_BASE_PYTHON,
    DJLS_E2E_DJANGO_MAJOR: process.env.DJLS_E2E_DJANGO_MAJOR,
    DJLS_E2E_VISUAL_HOLD_MS: process.env.DJLS_E2E_VISUAL_HOLD_MS,
    DJLS_E2E_NATIVE_INPUT: process.env.DJLS_E2E_NATIVE_INPUT,
    DJLS_E2E_DISABLE_EXTENSIONS: process.env.DJLS_E2E_DISABLE_EXTENSIONS,
    DJLS_E2E_RENDERER_DEBUG_PORT: process.env.DJLS_E2E_RENDERER_DEBUG_PORT,
  },
  launchArgs: [
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    `--extensions-dir=${machineExtensionsDir}`,
    '--disable-extension=shamanu4.django-intellisense',
    '--disable-extension=github.copilot',
    '--disable-extension=github.copilot-chat',
    ...extraDisabledExtensions.map(id => `--disable-extension=${id}`),
    ...(forceRendererAccessibility ? ['--force-renderer-accessibility'] : []),
    // Keep frame-based renderer assertions running when the test window is occluded.
    ...(rendererDebugPort ? ['--disable-backgrounding-occluded-windows',
      `--remote-debugging-port=${rendererDebugPort}`, '--remote-debugging-address=127.0.0.1'] : []),
  ],
});
