// Runs the standalone build the way the container image does. next build leaves the static assets
// and public/ outside .next/standalone, so they are copied in first.
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = resolve(root, '.next/standalone');

cpSync(resolve(root, '.next/static'), resolve(standalone, '.next/static'), { recursive: true });
if (existsSync(resolve(root, 'public'))) cpSync(resolve(root, 'public'), resolve(standalone, 'public'), { recursive: true });

// server.js changes its working directory to its own folder, so every path it gets must be absolute.
const env = { ...process.env };
if (env.NETATLAS_CLUSTERS_FILE) env.NETATLAS_CLUSTERS_FILE = resolve(env.NETATLAS_CLUSTERS_FILE);

const server = spawn(process.execPath, [resolve(standalone, 'server.js')], { env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.kill(signal));
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
