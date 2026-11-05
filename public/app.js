const $ = (id) => document.getElementById(id);
let roomCode = null, ownerKey = null, playerKey = null, player = null, eventSource = null;
let gameInfo = { leaderboard: [] };
let rotating = false;
let toastTimer = null;
let pendingAction = false;

function show(id, shouldShow) { $(id).classList.toggle('hidden', !shouldShow); }
function inviteLink(code = roomCode) { return `${location.origin}/?room=${encodeURIComponent(code)}`; }
function ownLink() { return `${inviteLink()}#host=${ownerKey}`; }
function hostStoreKey(code) { return `sayit-v2-host:${code}`; }
function playerStoreKey(code) { return `sayit-v2-player:${code}`; }
function setConnection(text, live = false, off = false) {
  $('connection-label').textContent = text.toUpperCase();
  $('connection').classList.toggle('live', live);
  $('connection').classList.toggle('off', off);
}
function notify(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  show('toast', true);
  toastTimer = setTimeout(() => show('toast', false), 2600);
}
async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
  } catch {
    const node = document.createElement('textarea');
    node.value = text; node.style.position = 'fixed'; node.style.opacity = '0';
    document.body.append(node); node.select();
    if (!document.execCommand('copy')) { node.remove(); notify('Select and copy the link from the box.'); return; }
    node.remove();
  }
  notify('Copied! Share it with your friends.');
}
async function api(path, method = 'GET', body = null) {
  const res = await fetch(path, {
    method,
    headers: body === null ? {} : { 'Content-Type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(payload.error || `Server error (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return payload;
}
function authBody() {
  if (!player || !playerKey) throw new Error('Please join the game first.');
  return { playerId: player.id, playerKey };
}
function modal(mode, detail = '') {
  const modes = {
    join: ['🎯', 'WELCOME TO THE GAME', "Who's playing?", 'Enter your name for the live leaderboard and get your own random Bingo card.'],
    closed: ['🔒', 'THIS ROUND IS OVER', 'The host started over.', 'Everyone was removed from this room. Ask your host for the new invitation link.'],
    fresh: ['🎉', 'NEW ROUND READY', 'Fresh link. Fresh game.', 'Everyone from the previous room has been removed. Share this new invitation to start playing again.'],
    error: ['⚠️', 'COULD NOT OPEN GAME', 'Room unavailable.', detail || 'Check your invitation link and try again.'],
  };
  const [icon, kicker, title, description] = modes[mode];
  $('modal-icon').textContent = icon;
  $('modal-kicker').textContent = kicker;
  $('modal-title').textContent = title;
  $('modal-copy').textContent = description;
  $('modal-error').textContent = '';
  show('join-form', mode === 'join');
  show('new-link-actions', mode === 'fresh');
  if (mode === 'fresh') $('new-link').value = inviteLink();
  show('overlay', true);
  if (mode === 'join') setTimeout(() => $('name-input').focus(), 50);
}
function closeModal() { show('overlay', false); }

function renderLeaderboard(entries = []) {
  gameInfo.leaderboard = entries;
  $('player-count').textContent = `${entries.length} PLAYER${entries.length === 1 ? '' : 'S'}`;
  const target = $('leaders');
  target.replaceChildren();
  if (!entries.length) {
    const p = document.createElement('p'); p.className = 'no-players';
    p.textContent = 'No players yet. Be the first!'; target.append(p); return;
  }
  for (const p of entries) {
    const row = document.createElement('div'); row.className = 'leader';
    const rank = document.createElement('div'); rank.className = 'rank'; rank.textContent = `#${p.rank}`;
    const center = document.createElement('div');
    const name = document.createElement('div'); name.className = 'leader-name';
    name.textContent = p.name + (p.id === player?.id ? ' (YOU)' : '');
    const detail = document.createElement('div'); detail.className = 'leader-details';
    detail.textContent = `${p.bingos} bingo${p.bingos === 1 ? '' : 's'} · ${p.marked} marked`;
    center.append(name, detail);
    const right = document.createElement('div'); right.className = 'leader-score';
    right.textContent = `${p.streak}/5`;
    const small = document.createElement('small'); small.textContent = 'IN A ROW';
    right.append(small);
    row.append(rank, center, right); target.append(row);
  }
}
function renderPlayer() {
  const board = $('board');
  board.replaceChildren();
  const words = player?.board || Array(25).fill('');
  const marks = player?.marks || Array(25).fill(false);
  const win = new Set(player?.stats?.winningCells || []);
  for (let i = 0; i < 25; i++) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'square' + (marks[i] ? ' marked' : '') + (win.has(i) ? ' win' : '');
    tile.textContent = words[i];
    tile.setAttribute('aria-pressed', marks[i] ? 'true' : 'false');
    tile.disabled = !player || pendingAction;
    tile.addEventListener('click', () => takeAction('toggle', { cell: i }));
    board.append(tile);
  }
  const stats = player?.stats || { streak: 0, marked: 0, bingos: 0 };
  $('stat-streak').innerHTML = `${stats.streak}<span>/5</span>`;
  $('stat-marked').textContent = stats.marked;
  $('stat-bingos').textContent = stats.bingos;
  $('progress-fill').style.width = `${stats.streak * 20}%`;
  show('bingo-banner', stats.bingos > 0);
  $('card-heading').textContent = player ? `${player.name.toUpperCase()}'S BINGO CARD` : 'YOUR BINGO CARD';
  $('shuffle-card').disabled = !player || pendingAction;
  $('clear-card').disabled = !player || pendingAction;
  renderLeaderboard(gameInfo.leaderboard);
}
function savePlayerSession(key) {
  if (player && key) {
    sessionStorage.setItem(playerStoreKey(roomCode), JSON.stringify({ id: player.id, key }));
  }
}
function setPlayer(data, key) {
  player = data.player;
  playerKey = key;
  savePlayerSession(key);
  renderLeaderboard(data.leaderboard);
  renderPlayer();
}
async function takeAction(action, extra = {}) {
  if (pendingAction || !player) return;
  if (action === 'shuffle' && player.stats?.marked > 0 &&
      !confirm('Randomise your card? All your marked squares and current Bingo progress will reset.')) return;
  if (action === 'clear' && player.stats?.marked > 0 && !confirm('Clear all your marked squares?')) return;
  pendingAction = true; renderPlayer();
  try {
    const data = await api(`/api/rooms/${roomCode}/${action}`, 'POST', { ...authBody(), ...extra });
    setPlayer(data, playerKey);
    if (action === 'shuffle') notify('Fresh random card! Good luck.');
    else if (action === 'clear') notify('Your card has been cleared.');
  } catch (e) {
    if (e.status === 410) closeRoom();
    else notify(e.message);
  } finally { pendingAction = false; renderPlayer(); }
}
function closeRoom() {
  eventSource?.close(); eventSource = null;
  player = null; playerKey = null;
  renderPlayer(); show('host-panel', false);
  setConnection('ROUND ENDED', false, true);
  modal('closed');
}
function connectLive(code) {
  eventSource?.close(); eventSource = null;
  eventSource = new EventSource(`/api/rooms/${code}/events`);
  eventSource.onopen = () => { if (roomCode === code) setConnection('LIVE LEADERBOARD', true); };
  eventSource.onmessage = (ev) => {
    if (roomCode !== code) return;
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'roomClosed') {
      if (!rotating) closeRoom();
    } else if (data.type === 'snapshot') {
      renderLeaderboard(data.leaderboard);
    }
  };
  eventSource.onerror = () => {
    if (roomCode !== code) return;
    setConnection('RECONNECTING…', false, true);
    // If the server rejected the SSE connection after a reset,
    // discover the closed status and stop retrying.
    api(`/api/rooms/${code}`).then((data) => {
      if (roomCode === code && data.status !== 'active' && !rotating) closeRoom();
    }).catch(() => {});
  };
}
async function enterRoom(code, { nameToJoin = null } = {}) {
  eventSource?.close(); eventSource = null;
  roomCode = code;
  ownerKey = localStorage.getItem(hostStoreKey(code)) || null;
  player = null; playerKey = null; gameInfo = { leaderboard: [] };
  const hash = new URLSearchParams(location.hash.slice(1)).get('host');
  if (hash && /^[A-Za-z0-9_-]{40,50}$/.test(hash)) {
    ownerKey = hash;
    localStorage.setItem(hostStoreKey(code), ownerKey);
  }
  history.replaceState(null, '', `/?room=${encodeURIComponent(code)}`);
  $('room-label').textContent = `ROOM · ${code.toUpperCase()}`;
  $('invite-url').value = inviteLink();
  show('landing', false); show('game-area', true); show('host-panel', !!ownerKey);
  renderPlayer(); setConnection('CONNECTING…');
  let data;
  try { data = await api(`/api/rooms/${code}`); }
  catch (e) { modal('error', e.message); return; }
  if (data.status !== 'active') { closeRoom(); return; }
  renderLeaderboard(data.leaderboard);
  connectLive(code);
  if (nameToJoin) {
    try { await join(nameToJoin); }
    catch (e) { notify(e.message); modal('join'); }
    return;
  }
  const sessionRaw = sessionStorage.getItem(playerStoreKey(code));
  if (sessionRaw) {
    try {
      const credentials = JSON.parse(sessionRaw);
      const result = await api(`/api/rooms/${code}/resume`, 'POST', {
        playerId: credentials.id, playerKey: credentials.key
      });
      setPlayer(result, credentials.key);
      closeModal();
      return;
    } catch {
      sessionStorage.removeItem(playerStoreKey(code));
    }
  }
  modal('join');
}
async function join(name) {
  const data = await api(`/api/rooms/${roomCode}/join`, 'POST', { name });
  setPlayer(data, data.playerKey);
  localStorage.setItem('sayit-v2-lastname', name);
  closeModal();
}
async function createRoom() {
  $('create-room').disabled = true;
  try {
    const data = await api('/api/rooms', 'POST', {});
    localStorage.setItem(hostStoreKey(data.code), data.ownerKey);
    await enterRoom(data.code);
  } catch (e) { notify(e.message); }
  finally { $('create-room').disabled = false; }
}
async function kickEveryone() {
  if (!ownerKey || !roomCode || rotating) return;
  if (!confirm('KICK EVERYONE AND START A NEW ROUND?\n\nEvery player will lose access to the old room. Their old link will stop working. All scores will reset and a NEW invitation will be generated.')) return;
  rotating = true;
  $('kick-all').disabled = true;
  try {
    const name = player?.name || null;
    const old = roomCode;
    const next = await api(`/api/rooms/${old}/rotate`, 'POST', { ownerKey });
    sessionStorage.removeItem(playerStoreKey(old));
    localStorage.removeItem(hostStoreKey(old));
    localStorage.setItem(hostStoreKey(next.code), next.ownerKey);
    await enterRoom(next.code, { nameToJoin: name });
    modal('fresh');
  } catch (e) {
    notify(e.message);
  } finally { rotating = false; $('kick-all').disabled = false; }
}

$('create-room').addEventListener('click', createRoom);
$('copy-invite').addEventListener('click', () => copyText(inviteLink()));
$('copy-new').addEventListener('click', () => copyText(inviteLink()));
$('copy-host').addEventListener('click', () => copyText(ownLink()));
$('back-to-game').addEventListener('click', closeModal);
$('shuffle-card').addEventListener('click', () => takeAction('shuffle'));
$('clear-card').addEventListener('click', () => takeAction('clear'));
$('kick-all').addEventListener('click', kickEveryone);
$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('join-form').querySelector('button');
  button.disabled = true;
  $('modal-error').textContent = '';
  try { await join($('name-input').value.trim()); }
  catch (err) { $('modal-error').textContent = err.message; }
  finally { button.disabled = false; }
});
$('name-input').value = localStorage.getItem('sayit-v2-lastname') || '';
const initialRoom = new URLSearchParams(location.search).get('room');
if (initialRoom) {
  enterRoom(initialRoom).catch((err) => modal('error', err.message));
} else {
  show('landing', true); show('game-area', false);
  setConnection('READY TO PLAY');
}
