import { createServer, type ServerResponse } from 'node:http';
import { open, readdir, stat, readFile, lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DashboardState } from './dashboard-state.js';

const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.css', ['app.css', 'text/css; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/data.js', ['data.js', 'text/javascript; charset=utf-8']]]);
const MAX_INITIAL_BYTES = 4 * 1024 * 1024;
const MAX_LINE = 512 * 1024;
const LOG_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}(?:-\d+)?\.log$/u;
export interface DashboardServerOptions { port?: number; logDirectory?: string; pollMs?: number; assetsDirectory?: URL }

/** Read-only loopback monitor. Starting it cannot start Discord or an AI request. */
export async function startDashboardServer(options: DashboardServerOptions = {}) {
  const state = new DashboardState();
  const clients = new Set<ServerResponse>();
  const directory = resolve(options.logDirectory ?? 'logs');
  const assetDirectory = options.assetsDirectory ?? new URL('../web/dashboard/', import.meta.url);
  let current = '', position = 0, line = '', decoder = new StringDecoder('utf8'), reading = false, closed = false;
  let skipPartialLine = false, notice = '', origin = '';
  const snapshot = () => ({ ...state.snapshot(), notice });
  const send = (response: ServerResponse) => {
    if (response.writableLength > 2 * 1024 * 1024) { response.destroy(); clients.delete(response); return; }
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  };
  const refresh = async () => {
    if (reading || closed) return;
    reading = true;
    let changed = false;
    const previousNotice = notice;
    try {
      const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && LOG_NAME.test(entry.name))
        .map(entry => entry.name).sort().reverse();
      const latest = files[0];
      if (!latest) { notice = '실행 로그를 기다리고 있습니다. 봇을 실행하고 Discord에서 /start를 입력하세요.'; return; }
      const path = join(directory, latest), info = await stat(path);
      if (path !== current || info.size < position) {
        current = path; position = Math.max(0, info.size - MAX_INITIAL_BYTES);
        skipPartialLine = position > 0; line = ''; decoder = new StringDecoder('utf8');
        state.reset(basename(path)); changed = true;
      }
      notice = '';
      if (info.size > position) {
        const handle = await open(path, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(info.size - position, 1024 * 1024));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          position += bytesRead;
          const parts = (line + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
          line = parts.pop() ?? '';
          for (const part of parts) {
            if (skipPartialLine) { skipPartialLine = false; continue; }
            if (part.length > MAX_LINE) continue;
            try { changed = state.apply(JSON.parse(part)) || changed; } catch { /* An incomplete/corrupt log row does not stop the monitor. */ }
          }
          if (line.length > MAX_LINE) { line = ''; skipPartialLine = true; }
        } finally { await handle.close(); }
      }
    } catch (error) {
      notice = error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? '실행 로그를 기다리고 있습니다. 봇을 실행하고 Discord에서 /start를 입력하세요.'
        : '로그를 읽을 수 없습니다. logs 폴더의 파일과 권한을 확인하세요.';
    } finally {
      reading = false;
      if (changed || notice !== previousNotice) for (const response of clients) send(response);
    }
  };
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!['GET', 'HEAD'].includes(request.method ?? '') || request.headers.host !== origin.replace('http://', '')
      && request.headers.host !== origin.replace('http://127.0.0.1', 'localhost')
      || request.headers.origin && request.headers.origin !== origin && request.headers.origin !== origin.replace('127.0.0.1', 'localhost')) {
      response.writeHead(403).end('Forbidden'); return;
    }
    let path: string, url: URL;
    try { url = new URL(request.url ?? '/', origin); path = url.pathname; }
    catch { response.writeHead(400).end('Bad request'); return; }
    if (path === '/events' && request.method === 'GET') {
      if (clients.size >= 12) { response.writeHead(503).end('Too many viewers'); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      response.on('error', () => clients.delete(response));
      response.write('retry: 1500\n\n'); clients.add(response); send(response);
      response.on('close', () => clients.delete(response)); return;
    }
    if (path === '/api/snapshot') { response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(snapshot())); return; }
    if (path === '/api/logs') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && LOG_NAME.test(entry.name))
          .map(entry => entry.name).sort().reverse().slice(0, 1000);
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ files }));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') response.end(JSON.stringify({ files: [] }));
        else response.writeHead(500).end(JSON.stringify({ error: '로그 목록을 읽을 수 없습니다.' }));
      }
      return;
    }
    if (path === '/api/log') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      const name = url.searchParams.get('name') ?? '';
      if (!LOG_NAME.test(name)) { response.writeHead(400).end(JSON.stringify({ error: '올바른 로그 파일을 선택하세요.' })); return; }
      try {
        const selectedPath = join(directory, name), info = await lstat(selectedPath);
        if (!info.isFile() || info.isSymbolicLink()) { response.writeHead(404).end(JSON.stringify({ error: '로그 파일을 찾을 수 없습니다.' })); return; }
        const selected = new DashboardState(); selected.reset(name);
        const handle = await open(selectedPath, 'r');
        let skipped = 0;
        try {
          const start = Math.max(0, info.size - MAX_INITIAL_BYTES), buffer = Buffer.alloc(Math.min(info.size, MAX_INITIAL_BYTES));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
          const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
          if (start > 0) lines.shift();
          lines.pop(); // An unfinished trailing row is not yet a complete log record.
          for (const line of lines) {
            if (!line.trim()) continue;
            if (line.length > MAX_LINE) { skipped++; continue; }
            try { selected.apply(JSON.parse(line)); } catch { skipped++; }
          }
        } finally { await handle.close(); }
        const messages = [info.size > MAX_INITIAL_BYTES ? '큰 로그의 마지막 4MB를 읽었습니다.' : '', skipped ? `읽을 수 없는 로그 행 ${skipped}개를 건너뛰었습니다.` : ''].filter(Boolean);
        const result = { ...selected.snapshot(), notice: messages.join(' ') };
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(result));
      } catch (error) {
        const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
        response.writeHead(missing ? 404 : 500).end(JSON.stringify({ error: missing ? '로그 파일을 찾을 수 없습니다.' : '선택한 로그를 읽을 수 없습니다.' }));
      }
      return;
    }
    const asset = assets.get(path);
    if (!asset) { response.writeHead(404).end('Not found'); return; }
    try {
      const data = await readFile(new URL(asset[0]!, assetDirectory));
      response.setHeader('Content-Type', asset[1]!); response.end(request.method === 'HEAD' ? undefined : data);
    } catch { response.writeHead(500).end('Dashboard assets unavailable'); }
  });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(options.port ?? 3210, '127.0.0.1', () => { server.off('error', fail); done(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Dashboard listen failed');
  origin = `http://127.0.0.1:${address.port}`;
  await refresh();
  const timer = setInterval(() => { void refresh(); }, options.pollMs ?? 250);
  const heartbeat = setInterval(() => { for (const response of clients) response.write(': heartbeat\n\n'); }, 10_000);
  return { url: origin, state, refresh, async close() {
    closed = true; clearInterval(timer); clearInterval(heartbeat);
    for (const response of clients) response.end(); clients.clear();
    await new Promise<void>((done) => server.close(() => done()));
  } };
}
