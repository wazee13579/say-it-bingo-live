import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

test('random Bingo cards, authoritative score, live events, and host-only rotation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sayit-test-'));
  const server = createApp({ stateFile: join(dir, 'state.json') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  t.after(async () => {
    controllers.forEach((c) => c.abort());
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  async function api(path, method = 'GET', data = null, expected = 200) {
    const r = await fetch(base + path, {
      method,
      headers: data === null ? {} : { 'Content-Type': 'application/json' },
      body: data === null ? undefined : JSON.stringify(data),
    });
    const json = await r.json();
    assert.equal(r.status, expected, `${path} ${JSON.stringify(json)}`);
    return json;
  }
  const { code, ownerKey } = await api('/api/rooms', 'POST', {}, 201);
  assert.match(code, /^[A-Za-z0-9_-]{12}$/);
  const room = `/api/rooms/${code}`;
  const alice = await api(`${room}/join`, 'POST', { name: 'Alice' }, 201);
  const bob = await api(`${room}/join`, 'POST', { name: 'Bob' }, 201);
  assert.equal(alice.player.board.length, 25);
  assert.equal(new Set(alice.player.board).size, 10);
  assert.equal(new Set(bob.player.board).size, 10);
  assert.notDeepEqual(alice.player.board, bob.player.board);
  assert.equal((await api(room)).leaderboard.length, 2);
  const creds = { playerId: alice.player.id, playerKey: alice.playerKey };

  // Stream is public and sends the initial leaderboard immediately.
  const ctrl = new AbortController(); controllers.push(ctrl);
  const streamRes = await fetch(base + `${room}/events`, { signal: ctrl.signal });
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get('content-type'), /text\/event-stream/);
  const reader = streamRes.body.getReader();
  let sse = await reader.read();
  assert.match(new TextDecoder().decode(sse.value), /"type":"snapshot"/);
  ctrl.abort();

  let current = await api(`${room}/toggle`, 'POST', { ...creds, cell: 0 });
  assert.equal(current.player.stats.marked, 1);
  assert.equal(current.player.marks[0], true);
  current = await api(`${room}/shuffle`, 'POST', creds);
  assert.equal(current.player.stats.marked, 0);
  assert.notDeepEqual(current.player.board, alice.player.board);
  assert.equal(current.player.board.length, 25);
  // Five consecutive marks on the first row should yield Bingo.
  for (const cell of [0, 1, 2, 3, 4]) {
    current = await api(`${room}/toggle`, 'POST', { ...creds, cell });
  }
  assert.equal(current.player.stats.streak, 5);
  assert.ok(current.player.stats.bingos >= 1);
  assert.equal(current.leaderboard[0].name, 'Alice');
  assert.equal(current.leaderboard[0].streak, 5);
  const bobResume = await api(`${room}/resume`, 'POST', { playerId: bob.player.id, playerKey: bob.playerKey });
  assert.equal(bobResume.player.stats.marked, 0);
  await api(`${room}/rotate`, 'POST', { ownerKey: 'invalid' }, 403);
  await api(`${room}/rotate`, 'POST', {}, 403);
  assert.equal((await api(room)).status, 'active');

  const next = await api(`${room}/rotate`, 'POST', { ownerKey }, 201);
  assert.notEqual(next.code, code);
  assert.notEqual(next.ownerKey, ownerKey);
  const old = await api(room);
  assert.equal(old.status, 'closed');
  assert.equal(old.leaderboard.length, 0);
  await api(`${room}/join`, 'POST', { name: 'Intruder' }, 410);
  await api(`${room}/resume`, 'POST', creds, 410);
  await api(`${room}/rotate`, 'POST', { ownerKey }, 410);
  assert.deepEqual((await api(`/api/rooms/${next.code}`)).leaderboard, []);
  const charlie = await api(`/api/rooms/${next.code}/join`, 'POST', { name: 'Charlie' }, 201);
  assert.equal(charlie.player.stats.marked, 0);
});

test('players and rooms persist when the server restarts using the same data file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sayit-persist-'));
  const stateFile = join(dir, 'state.json');
  const server1 = createApp({ stateFile });
  await new Promise((resolve) => server1.listen(0, '127.0.0.1', resolve));
  const b1 = `http://127.0.0.1:${server1.address().port}`;
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(r.ok);
    return r.json();
  }
  const room = await post(b1 + '/api/rooms', {});
  const player = await post(b1 + '/api/rooms/' + room.code + '/join', { name: 'Persisted Player' });
  await post(b1 + '/api/rooms/' + room.code + '/toggle', { playerId: player.player.id, playerKey: player.playerKey, cell: 10 });
  await new Promise((resolve) => server1.close(resolve));
  const server2 = createApp({ stateFile });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  try {
    const b2 = `http://127.0.0.1:${server2.address().port}`;
    const resumed = await post(b2 + '/api/rooms/' + room.code + '/resume', { playerId: player.player.id, playerKey: player.playerKey });
    assert.equal(resumed.player.name, 'Persisted Player');
    assert.equal(resumed.player.stats.marked, 1);
    assert.equal(resumed.player.marks[10], true);
  } finally {
    await new Promise((resolve) => server2.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editable sayings file controls new cards and samples 25 unique sayings', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'sayit-words-'));
  const sayingsFile = join(dir, 'custom-sayings.txt');
  writeFileSync(sayingsFile, Array.from({ length: 30 }, (_, i) => `SAYING ${i + 1}`).join('\n') + '\n');
  const server = createApp({ stateFile: join(dir, 'state.json'), sayingsFile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, payload) => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      assert.equal(res.status, path === '/api/rooms' || path.endsWith('/join') ? 201 : 200);
      return res.json();
    };
    const room = await post('/api/rooms', {});
    const path = '/api/rooms/' + room.code;
    const joined = await post(path + '/join', { name: 'Tester' });
    assert.equal(joined.player.board.length, 25);
    assert.equal(new Set(joined.player.board).size, 25);
    assert.ok(joined.player.board.every((word) => /^SAYING \d+$/.test(word)));
    const changed = await post(path + '/shuffle', { playerId: joined.player.id, playerKey: joined.playerKey });
    assert.equal(new Set(changed.player.board).size, 25);
    assert.notDeepEqual(changed.player.board, joined.player.board);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
