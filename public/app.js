// RTC App client
// - JWT auth via /api/login + /api/register
// - Socket.io for signaling + chat/file/whiteboard relay
// - WebRTC mesh: one RTCPeerConnection per remote peer
// - Screen share: replaces video track via RTCRtpSender.replaceTrack
// - File transfer: WebRTC DataChannel (binary, chunked)
// - Whiteboard: <canvas>, strokes broadcast over Socket.io
// - Chat: AES-GCM via Web Crypto, key derived from shared passphrase (PBKDF2)

// =============== hosting banner (shown if Socket.io can't connect, e.g. on Vercel) ===============
function showHostingBanner(reason) {
  if (document.getElementById('host-banner')) return;
  const b = document.createElement('div');
  b.id = 'host-banner';
  b.innerHTML = `
    <strong>⚠️ Real-time features unavailable on this host.</strong>
    <span>This deployment can't sustain WebSocket connections (Socket.io error: ${String(reason || '').slice(0,80)}).
    Video calling, chat, file sharing and the whiteboard need a host with persistent WebSockets — e.g.
    <a href="https://render.com" target="_blank" rel="noopener">Render</a>,
    <a href="https://railway.app" target="_blank" rel="noopener">Railway</a>,
    or <a href="https://fly.io" target="_blank" rel="noopener">Fly.io</a>.
    The login UI here works, but in-room features won't.</span>
    <button onclick="this.parentElement.remove()">Dismiss</button>`;
  document.body.appendChild(b);
}

// =============== auth ===============
const authEl = document.getElementById('auth');
const lobbyEl = document.getElementById('lobby');
const appEl = document.getElementById('app');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const authSubmit = document.getElementById('auth-submit');
const authError = document.getElementById('auth-error');
const usernameEl = document.getElementById('username');
const passwordEl = document.getElementById('password');

let mode = 'login';
function setMode(m) {
  mode = m;
  tabLogin.classList.toggle('active', m === 'login');
  tabRegister.classList.toggle('active', m === 'register');
  authSubmit.textContent = m === 'login' ? 'Log in' : 'Create account';
}
tabLogin.onclick = () => setMode('login');
tabRegister.onclick = () => setMode('register');

let token = localStorage.getItem('rtc_token');
let me = localStorage.getItem('rtc_user');
if (token && me) showLobby();

authSubmit.onclick = async () => {
  authError.textContent = '';
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) { authError.textContent = 'Enter username + password'; return; }
  try {
    const r = await fetch(`/api/${mode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'failed');
    token = data.token; me = data.username;
    localStorage.setItem('rtc_token', token);
    localStorage.setItem('rtc_user', me);
    showLobby();
  } catch (e) { authError.textContent = e.message; }
};

document.getElementById('logout').onclick = () => {
  localStorage.removeItem('rtc_token'); localStorage.removeItem('rtc_user');
  token = null; me = null;
  lobbyEl.classList.add('hidden'); authEl.classList.remove('hidden');
};

function showLobby() {
  document.getElementById('who').textContent = me;
  authEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
}

// =============== room + media ===============
const roomEl = document.getElementById('room');
const passphraseEl = document.getElementById('passphrase');
const joinBtn = document.getElementById('join');
const roomLabel = document.getElementById('room-label');
const videosEl = document.getElementById('videos');

let socket = null;
let localStream = null;
let screenStream = null;
let roomName = null;
let cryptoKey = null;
const peers = new Map(); // socketId -> { pc, username, video, dc, file: {receiver state} }

const ICE = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]};

joinBtn.onclick = async () => {
  const room = roomEl.value.trim() || 'lobby';
  const pass = passphraseEl.value || 'default-room-key';
  roomName = room;
  cryptoKey = await deriveKey(pass, room);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    alert('Camera/mic permission denied or unavailable: ' + e.message);
    return;
  }

  lobbyEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  roomLabel.textContent = room;
  addVideoTile('self', me + ' (you)', localStream, true);

  socket = io({ auth: { token }, reconnectionAttempts: 3, timeout: 8000 });
  socket.on('connect_error', (e) => {
    showHostingBanner(e.message);
  });

  socket.on('connect', () => {
    socket.emit('join-room', { room });
  });

  socket.on('room-peers', async ({ peers: existing, strokes }) => {
    // We just joined: initiate connection to each existing peer.
    for (const p of existing) {
      await ensurePeer(p.id, p.username, /*initiator*/ true);
    }
    // Replay whiteboard history.
    if (strokes && strokes.length) for (const s of strokes) drawRemoteStroke(s);
  });

  socket.on('peer-joined', ({ id, username }) => {
    addSys(`${username} joined`);
    // We do NOT initiate; the joiner initiates to us. Just be ready.
    ensurePeer(id, username, /*initiator*/ false);
  });

  socket.on('peer-left', ({ id, username }) => {
    addSys(`${username} left`);
    const p = peers.get(id);
    if (p) {
      if (p.pc) p.pc.close();
      removeVideoTile(id);
      peers.delete(id);
    }
  });

  socket.on('signal', async ({ from, username, data }) => {
    const p = await ensurePeer(from, username, false);
    if (data.sdp) {
      await p.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        socket.emit('signal', { to: from, data: { sdp: p.pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await p.pc.addIceCandidate(data.candidate); } catch (e) { console.warn('ICE add failed', e); }
    }
  });

  socket.on('chat', async ({ username, iv, ct }) => {
    try {
      const text = await decryptText(iv, ct);
      addChat(username, text);
    } catch {
      addChat(username, '[unable to decrypt — wrong passphrase?]', true);
    }
  });

  socket.on('stroke', drawRemoteStroke);
  socket.on('clear-board', () => clearBoard(false));

  socket.on('file-chunk', handleFileChunkRelay);
};

// =============== WebRTC peers ===============
async function ensurePeer(id, username, initiator) {
  let p = peers.get(id);
  if (p) return p;

  const pc = new RTCPeerConnection(ICE);
  p = { pc, username, video: null, dc: null, fileRecv: null };
  peers.set(id, p);

  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    const [stream] = e.streams;
    if (!p.video) p.video = addVideoTile(id, username, stream, false);
    else { const v = p.video.querySelector('video'); if (v.srcObject !== stream) v.srcObject = stream; }
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      // tile cleanup handled on peer-left
    }
  };

  if (initiator) {
    // Initiator owns the DataChannel.
    p.dc = pc.createDataChannel('files', { ordered: true });
    setupDataChannel(p);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
  } else {
    pc.ondatachannel = (e) => { p.dc = e.channel; setupDataChannel(p); };
  }
  return p;
}

// =============== UI: video tiles ===============
function addVideoTile(id, label, stream, muted) {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.dataset.id = id;
  const v = document.createElement('video');
  v.autoplay = true; v.playsInline = true; v.muted = !!muted; v.srcObject = stream;
  const tag = document.createElement('div');
  tag.className = 'label'; tag.textContent = label;
  tile.append(v, tag);
  videosEl.appendChild(tile);
  return tile;
}
function removeVideoTile(id) {
  const t = videosEl.querySelector(`.video-tile[data-id="${CSS.escape(id)}"]`);
  if (t) t.remove();
}

// =============== media controls ===============
document.getElementById('btn-mic').onclick = () => {
  const t = localStream.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
};
document.getElementById('btn-cam').onclick = () => {
  const t = localStream.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
};
document.getElementById('btn-screen').onclick = async () => {
  if (screenStream) {
    for (const tr of screenStream.getTracks()) tr.stop();
    screenStream = null;
    await replaceVideoTrack(localStream.getVideoTracks()[0]);
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.onended = async () => {
      screenStream = null;
      await replaceVideoTrack(localStream.getVideoTracks()[0]);
    };
    await replaceVideoTrack(screenTrack);
  } catch (e) { console.warn('screen share canceled', e); }
};

async function replaceVideoTrack(newTrack) {
  // Update outgoing senders.
  for (const { pc } of peers.values()) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
  }
  // Update self-preview.
  const selfTile = videosEl.querySelector('.video-tile[data-id="self"] video');
  if (selfTile) {
    const ms = new MediaStream();
    ms.addTrack(newTrack);
    const a = localStream.getAudioTracks()[0]; if (a) ms.addTrack(a);
    selfTile.srcObject = ms;
  }
}

document.getElementById('btn-leave').onclick = () => location.reload();

// =============== chat (E2E AES-GCM) ===============
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('rtc-' + salt), iterations: 100000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function encryptText(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(text));
  return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) };
}
async function decryptText(iv, ct) {
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) }, cryptoKey, new Uint8Array(ct)
  );
  return new TextDecoder().decode(buf);
}

chatForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  const payload = await encryptText(text);
  socket.emit('chat', payload);
  addChat(me + ' (you)', text);
};

function addChat(from, text, isSys = false) {
  const div = document.createElement('div');
  div.className = 'msg';
  if (isSys) { div.classList.add('sys'); div.textContent = `${from}: ${text}`; }
  else {
    const f = document.createElement('span'); f.className = 'from'; f.textContent = from + ':';
    div.append(f, document.createTextNode(' ' + text));
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
function addSys(text) { addChat('•', text, true); }

// =============== files (WebRTC DataChannel + socket fallback) ===============
const fileInput = document.getElementById('file-input');
const sendFileBtn = document.getElementById('send-file');
const fileLog = document.getElementById('file-log');
const CHUNK = 64 * 1024;

function setupDataChannel(p) {
  const dc = p.dc;
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => console.log('datachannel open with', p.username);
  dc.onmessage = (e) => receiveFileMessage(p, e.data);
}

sendFileBtn.onclick = async () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (peers.size === 0) { addFileItem(`No peers in room to send to.`); return; }

  const meta = { kind: 'file-meta', name: file.name, size: file.size, type: file.type, id: Math.random().toString(36).slice(2) };
  const metaStr = JSON.stringify(meta);

  for (const [id, p] of peers) {
    if (p.dc && p.dc.readyState === 'open') {
      p.dc.send(metaStr);
    } else {
      socket.emit('file-chunk', { to: id, kind: 'meta', meta });
    }
  }

  const buf = await file.arrayBuffer();
  let offset = 0;
  let seq = 0;
  while (offset < buf.byteLength) {
    const slice = buf.slice(offset, offset + CHUNK);
    for (const [id, p] of peers) {
      if (p.dc && p.dc.readyState === 'open') {
        // simple backpressure
        while (p.dc.bufferedAmount > 8 * CHUNK) await new Promise((r) => setTimeout(r, 5));
        p.dc.send(slice);
      } else {
        socket.emit('file-chunk', { to: id, kind: 'chunk', id: meta.id, seq, data: Array.from(new Uint8Array(slice)) });
      }
    }
    offset += CHUNK;
    seq++;
  }
  const endStr = JSON.stringify({ kind: 'file-end', id: meta.id });
  for (const [id, p] of peers) {
    if (p.dc && p.dc.readyState === 'open') p.dc.send(endStr);
    else socket.emit('file-chunk', { to: id, kind: 'end', id: meta.id });
  }
  addFileItem(`Sent "${file.name}" (${formatBytes(file.size)}) to ${peers.size} peer(s).`);
};

function receiveFileMessage(p, data) {
  if (typeof data === 'string') {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.kind === 'file-meta') {
      p.fileRecv = { name: msg.name, size: msg.size, type: msg.type, chunks: [] };
    } else if (msg.kind === 'file-end' && p.fileRecv) {
      finalizeReceivedFile(p);
    }
  } else if (p.fileRecv) {
    p.fileRecv.chunks.push(data);
  }
}

function finalizeReceivedFile(p) {
  const r = p.fileRecv;
  const blob = new Blob(r.chunks, { type: r.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  addFileItem(`From <b>${escapeHtml(p.username)}</b>: <a href="${url}" download="${escapeHtml(r.name)}">${escapeHtml(r.name)}</a> (${formatBytes(r.size)})`, true);
  p.fileRecv = null;
}

// Socket-based fallback for peers without an open DataChannel.
const socketFileRecv = new Map(); // fromId -> { name, size, type, chunks: [] }
function handleFileChunkRelay({ from, username, kind, meta, id, seq, data }) {
  if (kind === 'meta') {
    socketFileRecv.set(from, { username, name: meta.name, size: meta.size, type: meta.type, chunks: [] });
  } else if (kind === 'chunk') {
    const r = socketFileRecv.get(from);
    if (r) r.chunks.push(new Uint8Array(data));
  } else if (kind === 'end') {
    const r = socketFileRecv.get(from); if (!r) return;
    const blob = new Blob(r.chunks, { type: r.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    addFileItem(`From <b>${escapeHtml(r.username)}</b>: <a href="${url}" download="${escapeHtml(r.name)}">${escapeHtml(r.name)}</a> (${formatBytes(r.size)})`, true);
    socketFileRecv.delete(from);
  }
}

function addFileItem(html, asHtml = false) {
  const d = document.createElement('div'); d.className = 'item';
  if (asHtml) d.innerHTML = html; else d.textContent = html;
  fileLog.prepend(d);
}
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// =============== whiteboard ===============
const boardWrap = document.getElementById('board-wrap');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const colorEl = document.getElementById('board-color');
const sizeEl = document.getElementById('board-size');

document.getElementById('btn-board').onclick = () => {
  boardWrap.classList.toggle('hidden');
  if (!boardWrap.classList.contains('hidden')) sizeCanvas();
};
document.getElementById('board-close').onclick = () => boardWrap.classList.add('hidden');
document.getElementById('board-clear').onclick = () => { clearBoard(true); };

function sizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    // preserve existing drawing
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width || rect.width; tmp.height = canvas.height || rect.height;
    tmp.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = rect.width; canvas.height = rect.height;
    ctx.drawImage(tmp, 0, 0);
  }
}
window.addEventListener('resize', () => { if (!boardWrap.classList.contains('hidden')) sizeCanvas(); });

let drawing = false, last = null;
canvas.addEventListener('pointerdown', (e) => {
  drawing = true; last = ptr(e); canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const p = ptr(e);
  const stroke = { x1: last.x, y1: last.y, x2: p.x, y2: p.y, color: colorEl.value, size: +sizeEl.value };
  drawStroke(stroke);
  socket?.emit('stroke', stroke);
  last = p;
});
canvas.addEventListener('pointerup', () => { drawing = false; last = null; });

function ptr(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}
function drawStroke(s) {
  ctx.strokeStyle = s.color; ctx.lineWidth = s.size; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(s.x1 * canvas.width, s.y1 * canvas.height);
  ctx.lineTo(s.x2 * canvas.width, s.y2 * canvas.height);
  ctx.stroke();
}
function drawRemoteStroke(s) { drawStroke(s); }
function clearBoard(broadcast) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (broadcast) socket?.emit('clear-board');
}
