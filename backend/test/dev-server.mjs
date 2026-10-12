// A no-install local stand-in for `wrangler dev`: runs the Worker on Node 22+
// with a SQLite file as the database and serves ./public for the review page.
//
//   node --experimental-sqlite test/dev-server.mjs           (http://localhost:8787)
//
// Signs you in as DEV_ADMIN_EMAIL (default you@example.com, an admin) and skips
// the bot check. For real Cloudflare behaviour use `npx wrangler dev`.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const ADMIN = process.env.DEV_ADMIN_EMAIL || 'you@example.com';
const dbFile = process.env.DB_FILE || join(root, 'test', 'local.sqlite');

const db = new DatabaseSync(dbFile);
db.exec(readFileSync(join(root, 'schema.sql'), 'utf8'));
// DEV_LEAD_COMMUNITY=philly signs you in as that community's lead instead of an admin.
if (process.env.DEV_LEAD_COMMUNITY) {
  db.prepare("INSERT OR IGNORE INTO moderators (email, role, community_id, added_by) VALUES (?, 'lead', ?, 'dev')").run(ADMIN, process.env.DEV_LEAD_COMMUNITY);
} else {
  db.prepare("INSERT OR IGNORE INTO moderators (email, role, community_id, added_by) VALUES (?, 'admin', '', 'dev')").run(ADMIN);
}

const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  first: async () => db.prepare(sql).get(...args) ?? null,
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  _run: () => db.prepare(sql).run(...args),
});
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (list) => {
    db.exec('BEGIN');
    try { list.forEach((s) => s._run()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return [];
  },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const ASSETS = {
  async fetch(request) {
    let path = decodeURIComponent(new URL(request.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, 'public', path));
    if (!file.startsWith(join(root, 'public'))) return new Response('Not found', { status: 404 });
    if (existsSync(file) && statSync(file).isDirectory()) {
      return new Response(null, { status: 307, headers: { Location: path + '/' } });
    }
    if (!existsSync(file)) return new Response('Not found', { status: 404 });
    return new Response(readFileSync(file), { headers: { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' } });
  },
};

const env = {
  DB,
  ASSETS,
  ENVIRONMENT: 'development',
  DEV_ADMIN_EMAIL: ADMIN,
  AUTO_PUBLISH: process.env.AUTO_PUBLISH || 'false',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:8000,http://127.0.0.1:8000',
  IP_HASH_SALT: 'local',
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('CF-Connecting-IP', req.socket.remoteAddress || '');
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => {
  console.log(`API + review page on http://localhost:${PORT}  (review page: /admin/, signed in as ${ADMIN})`);
});
