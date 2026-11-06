#!/usr/bin/env node
// Zero-configuration local PostgreSQL for development on a machine where PostgreSQL is installed
// (Windows installer or Linux/macOS packages). It runs a private cluster inside ./.localdb (git-ignored)
// on port 54329 with trust authentication, so no password is needed:
//   node scripts/local-db.mjs start | stop | status | reset
// Then set DATABASE_URL="postgresql://postgres@127.0.0.1:54329/sajilo_yatra?schema=public&connect_timeout=5".
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PORT = process.env.LOCAL_DB_PORT || '54329';
const DB = 'sajilo_yatra';
const root = resolve('.localdb');
const data = join(root, 'pg');
const log = join(root, 'postgres.log');
const exe = process.platform === 'win32' ? '.exe' : '';

/** Major version the existing cluster was created with, so the matching binaries are used. */
function clusterVersion() {
  try {
    return readFileSync(join(data, 'PG_VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

function findBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const want = clusterVersion();
  const candidates = [];
  for (const base of ['C:/Program Files/PostgreSQL', 'C:/Program Files (x86)/PostgreSQL']) {
    if (!existsSync(base)) continue;
    for (const v of readdirSync(base).sort((a, b) => Number(b) - Number(a))) candidates.push({ v, dir: join(base, v, 'bin') });
  }
  for (const v of ['18', '17', '16', '15'])
    for (const dir of [`/usr/lib/postgresql/${v}/bin`, `/opt/homebrew/opt/postgresql@${v}/bin`, `/usr/local/opt/postgresql@${v}/bin`])
      candidates.push({ v, dir });
  candidates.push({ v: '', dir: '' });
  const ordered = want ? [...candidates.filter((c) => c.v === want), ...candidates.filter((c) => c.v !== want)] : candidates;
  for (const c of ordered) {
    const pgctl = c.dir ? join(c.dir, 'pg_ctl' + exe) : 'pg_ctl' + exe;
    if (c.dir && !existsSync(pgctl)) continue;
    const probe = spawnSync(pgctl, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    const major = probe.stdout.match(/\b(\d+)\./)?.[1];
    if (want && major !== want) continue;
    return c.dir;
  }
  throw new Error(
    want
      ? `The cluster in ${data} needs PostgreSQL ${want} binaries. Install that version, set PG_BIN, or run "node scripts/local-db.mjs reset" to recreate it.`
      : 'PostgreSQL binaries not found. Install PostgreSQL 15+ or set PG_BIN to its bin directory.',
  );
}

const bin = findBin();
const tool = (name) => (bin ? join(bin, name + exe) : name + exe);
// pg_ctl hands its standard streams to the PostgreSQL daemon, which would keep this process (and any
// shell waiting on it) alive forever on Windows; so pg_ctl never gets our streams and we print the log.
const pgctl = (args) => spawnSync(tool('pg_ctl'), ['-D', data, ...args], { stdio: 'ignore', windowsHide: true }).status ?? 1;
const psql = (sql, db = 'postgres') =>
  execFileSync(tool('psql'), ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', '-d', db, '-tAc', sql], { encoding: 'utf8', windowsHide: true }).trim();
const logTail = () => {
  try {
    return readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
  } catch {
    return '(no log yet)';
  }
};

function start() {
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(data, 'PG_VERSION'))) {
    console.log('Initialising a new cluster in ' + data);
    const init = spawnSync(tool('initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore', windowsHide: true });
    if (init.status !== 0) throw new Error('initdb failed (exit ' + init.status + ').');
  }
  if (pgctl(['status']) !== 0) {
    const code = pgctl(['-o', `-p ${PORT} -c listen_addresses=127.0.0.1`, '-l', log, '-w', 'start']);
    if (code !== 0) throw new Error('pg_ctl start failed (exit ' + code + '). Last log lines:\n' + logTail());
    console.log('Cluster started on port ' + PORT + '.');
  } else console.log('Cluster already running on port ' + PORT + '.');
  if (psql(`SELECT 1 FROM pg_database WHERE datname='${DB}'`) !== '1') {
    psql(`CREATE DATABASE ${DB}`);
    console.log('Created database ' + DB);
  }
  psql('CREATE EXTENSION IF NOT EXISTS btree_gist', DB);
  console.log(`Ready: postgresql://postgres@127.0.0.1:${PORT}/${DB}?schema=public&connect_timeout=5`);
  console.log('Next: npm run db:setup   (migrations + seed)');
}

const cmd = process.argv[2];
if (cmd === 'start') start();
else if (cmd === 'stop') {
  const code = pgctl(['-m', 'fast', 'stop']);
  console.log(code === 0 ? 'Cluster stopped.' : 'Cluster was not running.');
} else if (cmd === 'status') {
  const code = pgctl(['status']);
  console.log(code === 0 ? 'Cluster running on port ' + PORT + '.' : 'Cluster not running.');
  process.exit(code);
} else if (cmd === 'reset') {
  pgctl(['-m', 'fast', 'stop']);
  rmSync(data, { recursive: true, force: true });
  start();
} else {
  console.log('usage: node scripts/local-db.mjs start | stop | status | reset');
  process.exit(2);
}
