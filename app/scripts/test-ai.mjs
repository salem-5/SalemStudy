/**
 * Run the Salem AI runtime's own tests.
 *
 * They need an interpreter with smolagents, which means the app's managed
 * virtualenv (built by AI settings → Install). WA_PYTHON overrides it, which
 * is how you run them against a scratch environment.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_ID = 'net.serverside.webassign-desk';
const candidates = [
  process.env.WA_PYTHON,
  join(homedir(), 'Library', 'Application Support', APP_ID, 'python', 'venv', 'bin', 'python3'),
  join(homedir(), '.local', 'share', APP_ID, 'python', 'venv', 'bin', 'python3'),
  join(process.env.APPDATA ?? '', APP_ID, 'python', 'venv', 'Scripts', 'python.exe'),
].filter(Boolean);

const python = candidates.find((p) => existsSync(p));
if (!python) {
  console.error('No Salem Python environment found. Open AI settings → Install, or set WA_PYTHON.');
  process.exit(1);
}

const check = spawnSync(python, ['-c', 'import smolagents'], { stdio: 'ignore' });
if (check.status !== 0) {
  console.error(`${python} has no smolagents. Open AI settings → Install, or set WA_PYTHON to an environment that has it.`);
  process.exit(1);
}

const run = spawnSync(python, ['-W', 'ignore::ResourceWarning', '-m', 'unittest', 'discover', '-s', 'src-tauri/python/tests', '-v'], {
  stdio: 'inherit',
});
process.exit(run.status ?? 1);
