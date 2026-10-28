/* global Peer, tuneSdp */
'use strict';

const $ = (id) => document.getElementById(id);
const RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] };
const ID_PREFIX = 'telinha-v2-';
// Sem 0/O, 1/I/L para o código ser fácil de ditar
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------- util

function toast(msg, bad = false) {
  if (bad) console.warn(msg);
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 4500);
}

function setStatus(text, kind = '') {
  const p = $('peerStatus');
  p.textContent = text;
  p.className = `pill ${kind}`;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

function storeJson(key, value) {
  if (value !== undefined) return store(key, JSON.stringify(value));
  try {
    return JSON.parse(store(key) || 'null');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- servidor do Telinha e ligação
//
// O servidor do Telinha (uma VM) faz a sinalização (apresenta os PCs) e tem um TURN, que retransmite o vídeo
// quando a ligação direta não fecha. Se ele estiver fora do ar, a sinalização usa o servidor público do PeerJS.
// Modo de ligação (Configurações): auto = direto quando dá, servidor quando não; direct = só direto;
// server = tudo retransmitido pelo servidor (iceTransportPolicy relay).
const SERVER = { host: '144-22-129-69.sslip.io', port: 443, secure: true, path: '/peerjs', key: 'peerjs' };
const NET_MODES = ['auto', 'direct', 'server'];
let netMode = NET_MODES.includes(store('telinha.netMode')) ? store('telinha.netMode') : 'auto';
const turn = { ice: null, until: 0, timer: null };

// Senha temporária do TURN (vale 6 h); pede outra antes de vencer
async function refreshTurn() {
  clearTimeout(turn.timer);
  try {
    // O servidor só entrega senha para um ID que está conectado nele agora
    const res = await fetch(`https://${SERVER.host}/turn?id=${encodeURIComponent(peerIdFor(myCode))}`, { cache: 'no-store' });
    const j = await res.json();
    if (!res.ok || !Array.isArray(j.urls)) throw new Error(j.error || res.status);
    turn.ice = { urls: j.urls, username: j.username, credential: j.credential };
    turn.until = Date.now() + (j.ttl - 600) * 1000;
    turn.timer = setTimeout(refreshTurn, Math.max(60_000, (j.ttl - 900) * 1000));
  } catch (err) {
    console.warn('TURN do servidor indisponível', err);
    turn.ice = null;
    turn.timer = setTimeout(refreshTurn, 60_000);
  }
  applyIce();
  renderNetMode();
  return !!turn.ice;
}

function iceConfig() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  if (netMode === 'direct') return { iceServers };
  if (turn.ice && Date.now() < turn.until) iceServers.push(turn.ice);
  const url = $('turnUrl').value.trim();
  if (url) iceServers.push({ urls: url, username: $('turnUser').value, credential: $('turnPass').value });
  // "Pelo servidor" promete esconder o IP: sem TURN a conexão falha em vez de ir direto
  return netMode === 'server' ? { iceServers, iceTransportPolicy: 'relay' } : { iceServers };
}

// O PeerJS lê a configuração a cada conexão nova; trocar aqui vale para as próximas
function applyIce() {
  if (net.peer?.options) net.peer.options.config = iceConfig();
}

// O que sugerir quando uma conexão de vídeo falha, conforme o modo de ligação
function failHint() {
  if (netMode === 'direct') return 'Com a ligação direta algumas redes não conectam: use a Automática nas Configurações.';
  if (netMode === 'server') return turn.ice ? 'A retransmissão do servidor não fechou: tente a Automática nas Configurações.' : 'O servidor do Telinha não respondeu: tente a Automática nas Configurações.';
  return 'A rede pode estar bloqueando: tente a ligação Pelo servidor nas Configurações.';
}

function renderNetMode() {
  for (const r of document.querySelectorAll('input[name="netMode"]')) r.checked = r.value === netMode;
  const p = $('netNow');
  if (!p) return;
  const sig = net.signal === 'own' ? 'Sinalização pelo servidor do Telinha.' : 'O servidor do Telinha não respondeu: sinalização pelo servidor público do PeerJS.';
  const relay = netMode === 'direct' ? '' : turn.ice ? ' Retransmissão disponível.'
    : netMode === 'server' ? ' Retransmissão indisponível agora: as conexões novas não abrem até ela voltar.' : ' Retransmissão do servidor indisponível agora; vai direto.';
  p.textContent = sig + relay;
  p.classList.toggle('bad', net.signal !== 'own' || (netMode !== 'direct' && !turn.ice));
}
for (const r of document.querySelectorAll('input[name="netMode"]')) {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    netMode = r.value;
    store('telinha.netMode', netMode);
    applyIce();
    renderNetMode();
    toast(host.stream || watch.code ? 'Ligação trocada: vale para quem conectar a partir de agora.' : 'Ligação trocada.');
  });
}
for (const id of ['turnUrl', 'turnUser', 'turnPass']) $(id).addEventListener('change', applyIce);

// ---------------------------------------------------------------- códigos de amigo

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// Aceita "abcd-efgh", "ABCD EFGH" etc.; devolve "ABCDEFGH" ou null
function normalizeCode(raw) {
  const c = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8 || [...c].some((ch) => !CODE_CHARS.includes(ch))) return null;
  return c;
}

const prettyCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const peerIdFor = (c) => ID_PREFIX + c.toLowerCase();
const codeOfPeer = (id) => (id && id.startsWith(ID_PREFIX) ? normalizeCode(id.slice(ID_PREFIX.length)) : null);

const myCode = normalizeCode(store('telinha.myCode')) || newCode();
store('telinha.myCode', myCode);
$('myCode').textContent = prettyCode(myCode);
$('liveCode').textContent = prettyCode(myCode);

const myName = () => $('myName').value.trim().slice(0, 24) || prettyCode(myCode);

let friends = (storeJson('telinha.friends') || []).filter((f) => normalizeCode(f.code));
const allowed = new Set(storeJson('telinha.allowed') || []);

// ---------------------------------------------------------------- identidade
//
// O servidor de sinalização não confere quem é dono de um código: qualquer um pode registrar o ID de alguém
// que está offline. Por isso cada app tem um par de chaves (ECDSA P-256) e prova quem é ao abrir um link,
// assinando um desafio do outro lado. A chave de cada código fica guardada na primeira vez (TOFU); depois,
// um link com esse código que não prova ter a mesma chave é derrubado.
const ID_ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };
const ident = { key: null, pub: null };
const knownKeys = storeJson('telinha.keys') || {}; // código -> { x, y }
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const idText = (nonce, signer, verifier) => new TextEncoder().encode(`telinha-id|${nonce}|${signer}|${verifier}`);

async function loadIdentity() {
  const saved = storeJson('telinha.identity');
  try {
    if (saved?.priv && saved?.pub) {
      ident.key = await crypto.subtle.importKey('jwk', saved.priv, ID_ALG, false, ['sign']);
      ident.pub = saved.pub;
      return;
    }
  } catch {}
  const kp = await crypto.subtle.generateKey(ID_ALG, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const { x, y } = await crypto.subtle.exportKey('jwk', kp.publicKey);
  storeJson('telinha.identity', { priv, pub: { x, y } });
  ident.key = kp.privateKey;
  ident.pub = { x, y };
}

async function proveIdentity(code, nonce) {
  if (!ident.key || typeof nonce !== 'string' || nonce.length > 64) return;
  const sig = await crypto.subtle.sign(SIGN_ALG, ident.key, idText(nonce, myCode, code));
  send(code, { t: 'id-proof', sig: b64(sig) });
}

async function checkIdentity(code, link, msg) {
  const pub = link.peerPub;
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }, ID_ALG, false, ['verify']);
    ok = await crypto.subtle.verify(SIGN_ALG, key, unb64(String(msg.sig)), idText(link.nonce, code, myCode));
  } catch {}
  const known = knownKeys[code];
  if (!ok || (known && (known.x !== pub.x || known.y !== pub.y))) return rejectIdentity(code, link);
  if (!known) {
    knownKeys[code] = { x: pub.x, y: pub.y };
    storeJson('telinha.keys', knownKeys);
  }
  link.verified = true;
  for (const m of link.queue.splice(0)) onMessage(code, m);
}

function rejectIdentity(code, link) {
  if (net.links.get(code) !== link) return;
  console.warn('identidade não confere', code);
  toast(`Alguém tentou se passar por ${friendName(code)}. A conexão foi recusada.`, true);
  link.conn.close();
}
const saveFriends = () => storeJson('telinha.friends', friends);
// Na lista e já aceito (pending = pedido enviado, esperando o outro aceitar)
const isFriend = (code) => friends.some((f) => f.code === code && !f.pending);
// Pedidos de amizade recebidos nesta sessão; quem pediu reenvia sempre que a conexão abre
const incoming = new Map(); // código -> { name }

// ---------------------------------------------------------------- estatísticas

// Lê estatísticas de um RTCPeerConnection e calcula taxas desde a última leitura
async function readStats(pc, prev, direction) {
  const report = await pc.getStats();
  const out = { route: '?' };
  const byId = new Map();
  report.forEach((r) => byId.set(r.id, r));
  const now = performance.now();

  report.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) {
      const pair = byId.get(r.selectedCandidatePairId);
      if (pair) {
        const local = byId.get(pair.localCandidateId);
        const remote = byId.get(pair.remoteCandidateId);
        const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
        out.relay = relay;
        out.route = relay ? 'pelo servidor' : 'P2P direto';
        if (pair.currentRoundTripTime != null) out.rtt = Math.round(pair.currentRoundTripTime * 1000);
      }
    }
    const isVideo = r.kind === 'video';
    if (direction === 'out' && r.type === 'outbound-rtp' && isVideo) {
      out.bytes = r.bytesSent;
      out.fps = r.framesPerSecond;
      out.w = r.frameWidth;
      out.h = r.frameHeight;
      out.impl = r.encoderImplementation;
      out.hw = r.powerEfficientEncoder;
      out.limit = r.qualityLimitationReason;
      out.codec = byId.get(r.codecId)?.mimeType;
      out.fmtp = byId.get(r.codecId)?.sdpFmtpLine;
      out.frames = r.framesEncoded;
      out.workTime = r.totalEncodeTime;
    }
    if (direction === 'out' && r.type === 'remote-inbound-rtp' && isVideo) {
      out.loss = r.fractionLost;
    }
    if (direction === 'in' && r.type === 'inbound-rtp' && isVideo) {
      out.bytes = r.bytesReceived;
      out.fps = r.framesPerSecond;
      out.w = r.frameWidth;
      out.h = r.frameHeight;
      out.impl = r.decoderImplementation;
      out.hw = r.powerEfficientDecoder;
      out.lost = r.packetsLost;
      out.dropped = r.framesDropped;
      out.codec = byId.get(r.codecId)?.mimeType;
      out.fmtp = byId.get(r.codecId)?.sdpFmtpLine;
      out.frames = r.framesDecoded;
      out.workTime = r.totalDecodeTime;
      if (r.jitterBufferEmittedCount) out.buffer = Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000);
    }
  });

  if (prev && out.bytes != null && prev.bytes != null) {
    out.mbps = ((out.bytes - prev.bytes) * 8) / ((now - prev.t) * 1000);
  }
  // Tempo médio que o encoder/decoder levou por quadro no último segundo
  if (prev && out.frames > prev.frames && out.workTime != null && prev.workTime != null) {
    out.msPerFrame = ((out.workTime - prev.workTime) * 1000) / (out.frames - prev.frames);
  }
  out.t = now;
  return out;
}

function formatStats(s) {
  const parts = [];
  if (s.w) parts.push(`${s.w}x${s.h}`);
  if (s.fps != null) parts.push(`${Math.round(s.fps)} fps`);
  if (s.mbps != null) parts.push(`${s.mbps.toFixed(1)} Mbps`);
  if (s.codec) parts.push(s.codec.replace('video/', ''));
  if (s.latency != null) parts.push(`latência ~${s.latency} ms`);
  const line1 = parts.join(' · ');
  const extra = [];
  if (s.impl) extra.push(`${s.impl} (${s.hw ? 'hardware' : 'CPU'})`);
  else if (s.msPerFrame != null) extra.push(s.msPerFrame < 2 ? 'decoder provavelmente de hardware' : 'decoder provavelmente na CPU');
  if (s.msPerFrame != null) extra.push(`${s.msPerFrame.toFixed(1)} ms/quadro`);
  extra.push(s.route);
  if (s.rtt != null) extra.push(`ping ${s.rtt} ms`);
  if (s.buffer != null) extra.push(`buffer ${s.buffer} ms`);
  if (s.loss != null) extra.push(`perda ${(s.loss * 100).toFixed(1)}%`);
  if (s.lost != null) extra.push(`pacotes perdidos ${s.lost}`);
  if (s.dropped != null) extra.push(`quadros descartados ${s.dropped}`);
  if (s.limit && s.limit !== 'none') extra.push(`limitado por: ${{ cpu: 'CPU', bandwidth: 'rede', other: 'outro' }[s.limit] || s.limit}`);
  return `${line1}\n${extra.join(' · ')}`;
}

// ---------------------------------------------------------------- diagnóstico

async function codecSupport() {
  const label = (i) => (!i ? '?' : !i.supported ? 'não suportado' : i.powerEfficient ? 'hardware' : 'CPU');
  const lines = [];
  for (const [name, type] of [['H.264', 'video/H264'], ['AV1', 'video/AV1'], ['VP9', 'video/VP9']]) {
    const video = { contentType: type, width: 1920, height: 1080, bitrate: 10_000_000, framerate: 60 };
    const enc = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video }).catch(() => null);
    const dec = await navigator.mediaCapabilities.decodingInfo({ type: 'webrtc', video }).catch(() => null);
    lines.push(`  ${name.padEnd(6)} codificar: ${label(enc).padEnd(14)} decodificar: ${label(dec)}`);
  }
  return lines.join('\n');
}

function statsDetail(s) {
  if (!s) return '  (sem dados ainda)';
  return [
    `  codec negociado: ${s.codec || '?'} ${s.fmtp ? `[${s.fmtp}]` : ''}`,
    s.impl
      ? `  implementação:   ${s.impl} (${s.hw ? 'hardware' : 'CPU'})`
      : '  implementação:   oculta pelo Chromium (ele só mostra para quem está capturando a tela); use o tempo/quadro',
    `  tempo/quadro:    ${s.msPerFrame != null ? `${s.msPerFrame.toFixed(2)} ms` : '?'}`,
    `  latência:        ${s.latency != null ? `~${s.latency} ms (captura até a tela do espectador)` : '?'}`,
    `  ${formatStats(s).replace('\n', '\n  ')}`,
  ].join('\n');
}

async function buildDiagnostics() {
  const info = await window.telinha.diagInfo();
  const out = [
    `Telinha ${info.appVersion} — diagnóstico ${new Date().toLocaleString('pt-BR')}`,
    `Electron ${info.versions.electron} · Chromium ${info.versions.chrome} · ${info.os}`,
    `GPU: ${info.gpus.join(' | ') || '?'}`,
    `Código: ${prettyCode(myCode)} · servidor: ${net.peer?.open ? 'conectado' : 'desconectado'} (${net.signal === 'own' ? 'do Telinha' : 'público do PeerJS, reserva'}) · amigos online: ${[...net.links.keys()].filter(isFriend).length}/${friends.length}`,
    `Ligação: ${{ auto: 'automática', direct: 'direta (P2P)', server: 'pelo servidor' }[netMode]} · TURN do Telinha: ${turn.ice ? 'disponível' : 'indisponível'}`,
    '',
    'Estimativa do Chromium para esta máquina (1080p60; pode errar, a prova real são as estatísticas abaixo):',
    await codecSupport(),
  ];
  if (host.viewers.size) {
    out.push('', 'Transmitindo para:');
    for (const v of host.viewers.values()) out.push(`- ${v.name}`, statsDetail(v.stats));
  }
  if (watch.call) out.push('', `Assistindo ${friendName(watch.code)}:`, statsDetail(watch.stats));
  return out.join('\n');
}

// ---------------------------------------------------------------- abas

// ---------------------------------------------------------------- navegação (barra lateral)

const VIEW_IDS = { friends: 'friendsView', requests: 'requestsView', settings: 'themes' };

function go(view) {
  const id = VIEW_IDS[view] || view;
  document.querySelectorAll('.navItem').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  refreshUI();
}

document.querySelectorAll('.navItem[data-view]').forEach((n) => n.addEventListener('click', () => go(n.dataset.view)));
document.addEventListener('click', (e) => {
  const target = e.target.closest?.('[data-go]');
  if (target) go(target.dataset.go);
});

// O Início, os Pedidos e os contadores da barra lateral se redesenham juntos (home.js), uma vez por quadro
function refreshUI() {
  if (refreshUI.queued) return;
  refreshUI.queued = true;
  requestAnimationFrame(() => {
    refreshUI.queued = false;
    window.renderHome?.();
  });
}

// ---------------------------------------------------------------- configurações salvas

const saved = ['res', 'fps', 'mbps', 'codec', 'hint', 'audio', 'roomMode', 'allowPoint', 'quality', 'turnUrl', 'turnUser', 'turnPass', 'myName', 'lowLatency', 'vol', 'discordPresence', 'discordAppId', 'discordWebhook'];
for (const id of saved) {
  const el = $(id);
  const v = store(`telinha.${id}`);
  if (v != null) {
    if (el.type === 'checkbox') el.checked = v === '1';
    else el.value = v;
    // Opção salva que não existe mais nesta versão: volta para o padrão
    if (el.tagName === 'SELECT' && el.selectedIndex < 0) el.value = el.querySelector('option[selected]')?.value ?? el.options[0].value;
  }
  el.addEventListener('change', () => store(`telinha.${id}`, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value));
}

// ================================================================ REDE (PeerJS)
//
// Cada app fica sempre conectado ao servidor com o ID = código de amigo.
// Para cada amigo online existe um canal de dados P2P ("link") usado para presença,
// status ao vivo e pedidos para assistir. O vídeo vai numa chamada de mídia separada.

const net = {
  peer: null,
  signal: 'own', // 'own' = servidor do Telinha; 'cloud' = servidor público do PeerJS (reserva)
  links: new Map(), // código -> { conn, outgoing, info: { name, live, mode } }
  attempts: new Map(), // código -> conexão de saída ainda não aberta
};

function send(code, msg) {
  const link = net.links.get(code);
  if (link?.conn.open) link.conn.send(msg);
}

// Sala privada: miniatura e detalhes (desde quando, quantos assistem, qualidade) só para quem está assistindo;
// os outros amigos veem só "ao vivo · sala privada"
const seesRoom = (code) => $('roomMode').value === 'public' || host.viewers.has(code);

function myStatus(code) {
  const base = { t: 'status', name: myName(), live: !!host.stream, mode: $('roomMode').value };
  if (host.stream && !seesRoom(code)) return { ...base, hidden: true };
  const cfg = hostSettings();
  const v = host.stream?.getVideoTracks()[0]?.getSettings() || {};
  return {
    ...base, since: host.since, watchers: host.viewers.size, codec: cfg.codec,
    res: v.height ? `${v.height}p${Math.round(v.frameRate || cfg.fps)}` : null,
  };
}

function broadcastStatus() {
  for (const code of net.links.keys()) send(code, myStatus(code));
}

function friendName(code) {
  return net.links.get(code)?.info.name || friends.find((f) => f.code === code)?.name || prettyCode(code);
}

function startNet() {
  const own = net.signal === 'own';
  const peer = new Peer(peerIdFor(myCode), { ...(own ? SERVER : {}), config: iceConfig(), debug: 1 });
  net.peer = peer;
  setStatus('Conectando…');
  // O servidor do Telinha não respondeu: usa o público do PeerJS até o app abrir de novo
  // Reserva só na abertura: depois de conectar, uma queda da sinalização só reconecta (o watchdog abaixo) e as
  // transmissões e chamadas P2P já abertas continuam. Destruir o peer aqui derrubaria todas.
  let opened = false;
  const fallback = () => {
    if (net.peer !== peer || peer.open || opened || !own) return;
    console.warn('servidor do Telinha fora do ar; usando o servidor público do PeerJS');
    net.signal = 'cloud';
    net.peer = null;
    peer.destroy();
    startNet();
  };
  const fallbackTimer = own ? setTimeout(fallback, 8000) : null;

  peer.on('open', () => {
    opened = true;
    clearTimeout(fallbackTimer);
    if (own && !(turn.ice && Date.now() < turn.until)) refreshTurn();
    renderNetMode();
    setStatus(host.stream ? 'Ao vivo' : 'Online', 'ok');
    connectFriends();
  });
  peer.on('connection', (conn) => setupLink(conn, false));
  peer.on('call', onIncomingCall);
  peer.on('disconnected', () => {
    // Perdeu só o servidor; os links e transmissões P2P continuam. O watchdog reconecta.
    if (net.peer === peer) setStatus('Reconectando…', 'bad');
  });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') {
      // Amigo offline: a mensagem traz o ID que não respondeu
      const code = codeOfPeer((err.message.match(/telinha-v2-[a-z0-9]+/) || [])[0]);
      if (code) {
        net.attempts.get(code)?.close();
        net.attempts.delete(code);
        window.Share?.onUnavailable(code);
        if (watch.code === code && !watch.call) {
          toast(`${friendName(code)} está offline.`, true);
          leave(false);
        }
      }
      return;
    }
    if (err.type === 'unavailable-id') {
      // Normalmente é a sessão anterior que o servidor ainda não esqueceu (some em até ~1 min)
      setStatus('Aguardando servidor…', 'bad');
      if (net.peer === peer) net.peer = null;
      peer.destroy();
      return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      if (own && !peer.open) return fallback();
      setStatus('Sem servidor', 'bad');
      return;
    }
    console.warn('peer error', err.type, err.message);
  });
}

// Na reserva (PeerJS público): de 5 em 5 min vê se o servidor do Telinha voltou e volta para ele quando
// ninguém está transmitindo nem assistindo (trocar de servidor derruba os links, que reabrem sozinhos)
setInterval(async () => {
  if (net.signal !== 'cloud' || host.stream || watch.code) return;
  try {
    const res = await fetch(`https://${SERVER.host}/health`, { cache: 'no-store' });
    if (!res.ok || net.signal !== 'cloud' || host.stream || watch.code) return;
  } catch {
    return;
  }
  net.signal = 'own';
  const old = net.peer;
  net.peer = null;
  old?.destroy();
  startNet();
}, 5 * 60 * 1000);

// Mantém a conexão com o servidor viva e tenta alcançar amigos offline de tempos em tempos
setInterval(() => {
  const peer = net.peer;
  if (!peer || peer.destroyed) startNet();
  else if (peer.disconnected) peer.reconnect();
}, 5000);
setInterval(() => connectFriends(), 15000);

function connectFriends() {
  if (!net.peer?.open) return;
  for (const f of friends) {
    if (net.links.has(f.code) || net.attempts.has(f.code) || f.code === myCode) continue;
    const conn = net.peer.connect(peerIdFor(f.code), { reliable: true, metadata: { code: myCode } });
    net.attempts.set(f.code, conn);
    setupLink(conn, true);
  }
}

function setupLink(conn, outgoing) {
  const code = outgoing ? codeOfPeer(conn.peer) : normalizeCode(conn.metadata?.code);
  // O código declarado tem que bater com o ID de quem conectou (o servidor garante o ID)
  if (!code || peerIdFor(code) !== conn.peer || code === myCode) {
    conn.close();
    return;
  }
  conn.on('open', () => {
    if (outgoing) net.attempts.delete(code);
    const existing = net.links.get(code);
    if (existing && existing.conn !== conn && existing.conn.open) {
      // Os dois lados conectaram ao mesmo tempo: fica a conexão iniciada pelo menor código
      const initiator = (o) => (o ? myCode : code);
      if (initiator(outgoing) > initiator(existing.outgoing)) {
        conn.close();
        return;
      }
      existing.replaced = true;
      existing.conn.close();
    }
    const link = { conn, outgoing, info: existing?.info || {}, nonce: b64(crypto.getRandomValues(new Uint8Array(18))), verified: false, queue: [] };
    net.links.set(code, link);
    conn.send({ t: 'id', pub: ident.pub, nonce: link.nonce });
    // Código que já provou ter uma chave: sem a prova em 10 s, é outra pessoa usando o código
    if (knownKeys[code]) setTimeout(() => { if (!link.verified) rejectIdentity(code, link); }, 10000);
    conn.send({ ...myStatus(code), t: 'hello' });
    if (friends.some((f) => f.code === code)) conn.send({ t: 'friend-request', name: myName() });
    if (host.thumb && seesRoom(code)) conn.send({ t: 'thumb', data: host.thumb });
    conn.send({ t: 'ping', ts: performance.now() });
    renderFriends();
    window.Share?.onLinkOpen(code);
  });
  conn.on('data', (msg) => {
    if (net.links.get(code)?.conn === conn) onMessage(code, msg);
  });
  conn.on('close', () => {
    if (outgoing && net.attempts.get(code) === conn) net.attempts.delete(code);
    const link = net.links.get(code);
    if (!link || link.conn !== conn) return;
    net.links.delete(code);
    onLinkClosed(code);
  });
  conn.on('error', (err) => console.warn('link', code, err));
}

function onLinkClosed(code) {
  removeViewer(code);
  dropPrompt(code);
  if (watch.code === code) {
    if (!backgrounded(code)) toast(`${friendName(code)} desconectou.`);
    leave(false);
  }
  renderFriends();
}

function onMessage(code, msg) {
  if (!msg || typeof msg !== 'object') return;
  const link = net.links.get(code);
  // Código com chave conhecida: até provar a identidade, o resto (hello, join, chat…) espera numa fila
  if (knownKeys[code] && !link.verified && msg.t !== 'id' && msg.t !== 'id-proof') {
    if (link.queue.length < 50) link.queue.push(msg);
    return;
  }
  switch (msg.t) {
    case 'id':
      if (msg.pub && typeof msg.pub.x === 'string' && typeof msg.pub.y === 'string') {
        link.peerPub = { x: msg.pub.x.slice(0, 64), y: msg.pub.y.slice(0, 64) };
        proveIdentity(code, msg.nonce);
      }
      break;
    case 'id-proof':
      if (link.peerPub && !link.verified) checkIdentity(code, link, msg);
      break;
    case 'hello':
    case 'status': {
      const wasLive = link.info.live;
      link.info = {
        ...link.info,
        name: String(msg.name || '').slice(0, 24), live: !!msg.live, mode: msg.mode === 'public' ? 'public' : 'private',
        since: Number(msg.since) || null, watchers: Number(msg.watchers) || 0,
        codec: ['H264', 'AV1', 'VP9'].includes(msg.codec) ? msg.codec : null,
        res: /^\d{3,4}p\d{2,3}$/.test(msg.res || '') ? msg.res : null,
      };
      if (!link.info.live || msg.hidden) delete link.info.thumb;
      if (!wasLive && link.info.live && isFriend(code) && msg.t === 'status') toast(`${link.info.name || prettyCode(code)} começou a transmitir.`);
      if (watch.code === code && !link.info.live) {
        toast(`${friendName(code)} parou de transmitir.`);
        leave(false);
      }
      renderFriends();
      break;
    }
    case 'join':
      handleJoinRequest(code);
      break;
    case 'leave':
      dropPrompt(code);
      removeViewer(code);
      break;
    case 'join-pending':
      if (watch.code === code) {
        watch.state = 'pending';
        setStatus('Aguardando aprovação…');
        renderFriends();
      }
      break;
    case 'join-denied':
      if (watch.code === code) {
        toast(msg.reason || 'Acesso negado.', true);
        leave(false);
      }
      break;
    case 'kicked':
      if (watch.code === code) {
        toast(`${friendName(code)} te removeu da transmissão.`, true);
        leave(false);
      }
      break;
    case 'thumb':
      // Quadro atual de quem está ao vivo, para a telinha do Início (JPEG pequeno)
      if (typeof msg.data === 'string' && msg.data.startsWith('data:image/jpeg;base64,') && msg.data.length < 250000) {
        link.info.thumb = msg.data;
        refreshUI();
      }
      break;
    case 'ping':
      send(code, { t: 'pong', ts: msg.ts });
      break;
    case 'pong':
      if (typeof msg.ts === 'number') link.rtt = Math.max(0, Math.round(performance.now() - msg.ts));
      break;
    case 'friend-request': {
      const name = String(msg.name || '').slice(0, 24) || prettyCode(code);
      const mine = friends.find((f) => f.code === code);
      if (mine) {
        // Já está na minha lista (ou os dois se adicionaram ao mesmo tempo): aceita sem perguntar
        if (mine.pending) {
          mine.pending = false;
          saveFriends();
          toast(`Você e ${name} agora são amigos.`);
        }
        send(code, { t: 'friend-accept', name: myName() });
        renderFriends();
      } else if (!incoming.has(code)) {
        incoming.set(code, { name });
        toast(`${name} quer ser seu amigo.`);
        window.telinha.attention();
        renderFriends();
      }
      break;
    }
    case 'friend-accept': {
      const mine = friends.find((f) => f.code === code);
      if (mine?.pending) {
        mine.pending = false;
        if (msg.name) mine.name = String(msg.name).slice(0, 24);
        saveFriends();
        toast(`${friendName(code)} aceitou seu pedido de amizade.`);
        renderFriends();
      }
      break;
    }
    case 'friend-deny': {
      const mine = friends.find((f) => f.code === code);
      if (mine?.pending) {
        friends = friends.filter((f) => f.code !== code);
        saveFriends();
        toast(`${friendName(code)} recusou seu pedido de amizade.`, true);
        renderFriends();
      }
      break;
    }
    case 'friend-remove':
      friends = friends.filter((f) => f.code !== code);
      incoming.delete(code);
      saveFriends();
      renderFriends();
      break;
    case 'quality': {
      const v = host.viewers.get(code);
      if (!v || !(msg.q in QUALITY)) break;
      v.quality = msg.q;
      tuneSenders(v.call.peerConnection, msg.q, v.stats?.relay);
      if (v.el) v.el.querySelector('.name').textContent = `${v.name}${msg.q === 'auto' ? '' : msg.q === 'eco' ? ' · economia de dados' : ' · qualidade mínima'}`;
      break;
    }
    case 'vstats': {
      // Latência medida no espectador, mostrada para quem transmite
      const v = host.viewers.get(code);
      if (v && typeof msg.latency === 'number') v.latency = Math.round(msg.latency);
      break;
    }
    default:
      // Chat, reações e apontar: room.js; câmera e voz: voice.js; desenho: draw.js
      window.Room?.onMessage(code, msg);
      window.Voice?.onMessage(code, msg);
      window.Draw?.onMessage(code, msg);
      window.Stickers?.onMessage(code, msg);
      window.Present?.onMessage(code, msg);
      break;
  }
}

// ---------------------------------------------------------------- amigos (UI)

function answerFriend(code, accept) {
  const req = incoming.get(code);
  if (!req) return;
  incoming.delete(code);
  if (accept) {
    if (!friends.some((f) => f.code === code)) friends.push({ code, name: req.name });
    saveFriends();
    send(code, { t: 'friend-accept', name: myName() });
    toast(`Você e ${req.name} agora são amigos.`);
  } else {
    send(code, { t: 'friend-deny' });
  }
  renderFriends();
}

function renderRequests() {
  const box = $('friendRequests');
  box.innerHTML = '';
  if (!incoming.size) box.innerHTML = '<div class="emptyLine">Nenhum pedido de amizade.</div>';
  for (const [code, req] of incoming) {
    const row = document.createElement('div');
    row.className = 'request';
    const text = document.createElement('div');
    text.className = 'who';
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = `${req.name} quer ser seu amigo`;
    const sub = document.createElement('div');
    sub.className = 'fstatus';
    sub.textContent = prettyCode(code);
    text.append(name, sub);
    const deny = document.createElement('button');
    deny.className = 'btn';
    deny.textContent = 'Recusar';
    deny.addEventListener('click', () => answerFriend(code, false));
    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = 'Aceitar';
    ok.addEventListener('click', () => answerFriend(code, true));
    row.append(text, deny, ok);
    box.append(row);
  }
  refreshUI();
}

function renderFriends() {
  renderRequests();
  const list = $('friends');
  list.innerHTML = '';
  let liveCount = 0;
  if (!friends.length) {
    list.innerHTML = `<div class="muted small">Nenhum amigo ainda. Mande seu código (${prettyCode(myCode)}) e adicione o deles.</div>`;
  }
  for (const f of friends) {
    const link = net.links.get(f.code);
    const live = !!link?.info.live;
    if (live) liveCount++;
    if (link?.info.name && link.info.name !== f.name) {
      f.name = link.info.name;
      saveFriends();
    }
    const row = document.createElement('div');
    row.className = 'friend';
    const dot = document.createElement('span');
    dot.className = `fdot ${live ? 'live' : link ? 'online' : ''}`;
    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = f.name || prettyCode(f.code);
    const status = document.createElement('div');
    status.className = 'fstatus';
    status.textContent = f.pending
      ? `Pedido enviado · ${link ? 'esperando aceitar' : 'entrega quando ficar online'}`
      : !link ? `Offline · ${prettyCode(f.code)}` : live ? `Ao vivo · sala ${link.info.mode === 'public' ? 'pública' : 'privada'}` : 'Online';
    if (f.pending) row.classList.add('pending');
    who.append(name, status);

    const action = document.createElement('button');
    action.className = 'btn';
    if (watch.code === f.code) {
      action.textContent = watch.state === 'pending' ? 'Cancelar' : 'Sair';
      action.classList.add('danger');
      action.addEventListener('click', () => leave(true));
    } else {
      action.textContent = 'Assistir';
      action.classList.add('primary');
      action.disabled = !live || f.pending;
      action.addEventListener('click', () => requestWatch(f.code));
    }
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = 'Remover amigo';
    remove.textContent = '×';
    remove.title = f.pending ? 'Cancelar pedido' : 'Remover amigo';
    remove.addEventListener('click', () => {
      send(f.code, { t: 'friend-remove' });
      friends = friends.filter((x) => x.code !== f.code);
      saveFriends();
      renderFriends();
    });
    row.append(dot, who, action, remove);
    list.append(row);
  }
  $('liveBadge').textContent = liveCount;
  $('liveBadge').classList.toggle('hidden', !liveCount);
  refreshUI();
}

function addFriend() {
  const code = normalizeCode($('friendCode').value);
  if (!code) {
    toast('Código inválido. Ele tem 8 letras/números, tipo ABCD-EFGH.', true);
    return;
  }
  if (code === myCode) {
    toast('Esse é o seu próprio código.', true);
    return;
  }
  if (incoming.has(code)) {
    // Ele já tinha pedido: adicionar de volta é aceitar
    answerFriend(code, true);
  } else if (!friends.some((f) => f.code === code)) {
    friends.push({ code, name: net.links.get(code)?.info.name || '', pending: true });
    saveFriends();
    send(code, { t: 'friend-request', name: myName() });
    toast('Pedido de amizade enviado.');
  }
  $('friendCode').value = '';
  renderFriends();
  connectFriends();
}

$('addFriend').addEventListener('click', addFriend);
$('friendCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFriend(); });
$('myCodeBtn').addEventListener('click', async () => {
  await window.telinha.copy(prettyCode(myCode));
  toast('Seu código foi copiado. Mande para seus amigos.');
});
$('myName').addEventListener('change', broadcastStatus);

// ================================================================ TRANSMITIR

const host = {
  stream: null,
  sourceId: null,
  viewers: new Map(), // código -> { call, name, el, stats, latency }
  statsTimer: null,
  thumbTimer: null,
  since: null,
  thumb: null,
  upload: [], // { t, v } Mbps somados, um por segundo
  events: [], // { t, label } quem entrou, para anotar no gráfico
};

function hostSettings() {
  return {
    res: Number($('res').value),
    fps: Number($('fps').value),
    mbps: Number($('mbps').value),
    codec: $('codec').value,
    hint: $('hint').value,
  };
}

function updateMbpsLabel() {
  $('mbpsLabel').textContent = `${$('mbps').value} Mbps`;
  updateUploadEstimate();
}

function updateUploadEstimate() {
  const n = host.viewers.size;
  const mbps = Number($('mbps').value);
  $('uploadEst').textContent = n ? `Upload necessário: ~${Math.ceil(n * mbps * 1.1)} Mbps` : `~${Math.ceil(mbps * 1.1)} Mbps de upload por espectador`;
}
updateMbpsLabel();

function updateLiveBox() {
  $('liveBox').classList.toggle('hidden', !host.stream);
  $('liveMode').textContent = $('roomMode').value === 'public' ? 'Sala pública: entra quem tiver seu código' : 'Sala privada: você aprova cada pessoa';
}

$('roomMode').addEventListener('change', () => {
  updateLiveBox();
  broadcastStatus();
});

// ---- seletor de fonte

// onPick: o que fazer com a fonte escolhida (padrão: fonte de quem abre a sala)
async function openPicker(onPick) {
  // Site: quem mostra as telas é o navegador, na hora de começar (ou de trocar, se já estiver ao vivo)
  if (webHost && typeof onPick !== 'function') {
    host.sourceId = 'web';
    $('sourceName').textContent = 'Você escolhe na janela do navegador';
    if (host.stream && window.Present?.presenting()) switchSource();
    return;
  }
  const grid = $('sourceGrid');
  grid.innerHTML = '<div class="muted">Carregando…</div>';
  $('picker').classList.remove('hidden');
  const sources = await window.telinha.sources();
  grid.innerHTML = '';
  sources.sort((a, b) => Number(b.screen) - Number(a.screen));
  for (const s of sources) {
    const btn = document.createElement('button');
    btn.className = 'source';
    const img = document.createElement('img');
    img.src = s.thumb;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = s.screen ? 'Tela inteira' : 'Janela';
    const name = document.createElement('span');
    name.textContent = s.name;
    name.title = s.name;
    btn.append(img, tag, name);
    btn.addEventListener('click', () => {
      $('picker').classList.add('hidden');
      $('sourceName').textContent = `${s.screen ? 'Tela' : 'Janela'}: ${s.name}`;
      if (typeof onPick === 'function') return onPick(s);
      host.sourceId = s.id;
      if (host.stream && window.Present?.presenting()) switchSource();
    });
    grid.append(btn);
  }
}

$('pickSource').addEventListener('click', () => openPicker());
$('closePicker').addEventListener('click', () => $('picker').classList.add('hidden'));

// ---- captura

function videoConstraints(cfg) {
  const c = { frameRate: { ideal: cfg.fps, max: cfg.fps } };
  if (RES[cfg.res]) {
    c.width = { max: RES[cfg.res][0] };
    c.height = { max: RES[cfg.res][1] };
  }
  return c;
}

// ---- som do PC (audiocap.exe -> AudioWorklet -> faixa de áudio)
//
// A faixa de áudio existe sempre que há transmissão (em silêncio quando o som está desligado),
// assim dá para ligar/desligar o som ao vivo sem renegociar com cada espectador.

const pcAudio = { ctx: null, node: null, track: null, on: false };

window.telinha.onPcm((data) => {
  if (!pcAudio.node || !pcAudio.on) return;
  const pcm = new Int16Array(data.byteLength / 2);
  new Uint8Array(pcm.buffer).set(data);
  pcAudio.node.port.postMessage(pcm, [pcm.buffer]);
});

function describeAudioMode(mode) {
  if (mode === 'reiniciando') return 'Captura do som reiniciando…';
  // Alguém da sala está de microfone ligado: a captura tira o Telinha (as vozes) em vez do Discord
  if (window.Voice?.excludingSelf()) {
    return mode.startsWith('process-loopback')
      ? 'Som do PC sem as vozes da sala. O som do Discord vai junto: não fique na call de voz do Discord ao mesmo tempo.'
      : 'Som do PC com tudo: as vozes da sala voltam como eco. Desligue "Enviar som do PC" enquanto conversam.';
  }
  if (mode.startsWith('process-loopback sem')) return 'Som do PC sem o Discord.';
  if (mode.startsWith('process-loopback')) return 'Som do PC (Discord fechado; se abrir, ele é retirado sozinho).';
  return 'Som do PC com tudo, inclusive o Discord: este Windows não permite separar.';
}

window.telinha.onAudioMode((mode) => {
  if (!pcAudio.on) return;
  $('audioMode').textContent = describeAudioMode(mode);
});

async function createAudioTrack() {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  node.connect(dest); // de propósito NÃO conecta em ctx.destination: não toca nos seus alto-falantes
  await ctx.resume();
  Object.assign(pcAudio, { ctx, node, track: dest.stream.getAudioTracks()[0] });
  return pcAudio.track;
}

async function setPcAudio(on) {
  if (!on) {
    pcAudio.on = false;
    window.telinha.audioStop();
    $('audioMode').textContent = 'Som desligado.';
    return;
  }
  const res = await window.telinha.audioStart();
  if (!res.ok) {
    pcAudio.on = false;
    $('audioMode').textContent = 'Não deu pra capturar o som do PC.';
    toast(`Não deu pra capturar o som do PC (${res.error}).`, true);
    return;
  }
  pcAudio.on = true;
  $('audioMode').textContent = describeAudioMode(res.mode);
}

function destroyAudio() {
  pcAudio.on = false;
  window.telinha.audioStop();
  if (pcAudio.ctx) pcAudio.ctx.close();
  Object.assign(pcAudio, { ctx: null, node: null, track: null });
}

// Som mudo para a chamada quando o site transmite sem áudio: um só, reaproveitado (cada AudioContext pesa)
let silence = null;
function silentTrack() {
  silence ||= new AudioContext().createMediaStreamDestination();
  return silence.stream.getAudioTracks()[0].clone(); // cópia: parar a transmissão desliga só ela
}

// Site no PC: a tela (e o som, se marcar "Compartilhar áudio") vêm da janela de escolha do navegador
const webHost = document.documentElement.classList.contains('web');
if (webHost) $('audioMode').textContent = 'Marque "Compartilhar áudio" ao escolher. Uma aba manda só o som dela, sem eco do Discord.';
addEventListener('beforeunload', (e) => { if (webHost && host.stream) e.preventDefault(); }); // fechar a aba encerra a sala

$('audio').addEventListener('change', () => {
  if (!host.stream) return;
  if (webHost) host.audio.enabled = $('audio').checked;
  else setPcAudio($('audio').checked);
});

async function capture(cfg, withAudio = false) {
  await window.telinha.choose(host.sourceId);
  const ask = (audio) => navigator.mediaDevices.getDisplayMedia({ video: videoConstraints(cfg), audio, systemAudio: 'include' });
  // Som que o navegador não conseguiu abrir: transmite só a tela em vez de não transmitir
  const stream = withAudio ? await ask(true).catch((err) => (/audio/i.test(err.message) ? ask(false) : Promise.reject(err))) : await ask(false);
  const v = stream.getVideoTracks()[0];
  v.contentHint = cfg.hint;
  try { await v.applyConstraints(videoConstraints(cfg)); } catch (err) { console.warn(err); }
  v.addEventListener('ended', () => {
    // A janela capturada foi fechada: quem abriu a sala para de apresentar, a sala continua
    window.Present?.ownEnded(v);
  });
  return stream;
}

async function switchSource() {
  try {
    const captured = await capture(hostSettings());
    window.Present.switchOwn(captured.getVideoTracks()[0]);
    toast('Fonte trocada.');
  } catch (err) {
    toast(`Não foi possível trocar a fonte: ${err.message}`, true);
  }
}

// ---- parâmetros do encoder

// Qualidade pedida por quem assiste (economia de dados no celular): o transmissor reduz só para aquela
// pessoa, com scaleResolutionDownBy, sem mexer no vídeo dos outros
const QUALITY = {
  auto: null,
  eco: { height: 720, fps: 30, mbps: 3 },
  low: { height: 480, fps: 30, mbps: 1.2 },
};

// Pelo servidor o vídeo divide a banda da VM com todo mundo (e o TURN corta acima de 25 Mbps)
const RELAY_MBPS = 20;

async function tuneSenders(pc, quality, relay = false) {
  const cfg = hostSettings();
  const q = QUALITY[quality] || null;
  // A tela de um espectador chega pela rede e não informa a altura: usa a do quadro que está chegando
  const srcHeight = host.stream?.getVideoTracks()[0]?.getSettings().height || $('preview').videoHeight || 1080;
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) continue;
    const e = p.encodings[0];
    if (sender.track.kind === 'video') {
      e.maxBitrate = Math.min(cfg.mbps, q ? q.mbps : Infinity, relay ? RELAY_MBPS : Infinity) * 1_000_000;
      e.maxFramerate = Math.min(cfg.fps, q ? q.fps : Infinity);
      e.scaleResolutionDownBy = q ? Math.max(1, srcHeight / q.height) : 1;
      e.priority = 'high';
      e.networkPriority = 'high';
      p.degradationPreference = cfg.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    } else {
      e.maxBitrate = 256_000;
      e.priority = 'high';
      e.networkPriority = 'high';
    }
    try {
      await sender.setParameters(p);
    } catch (err) {
      console.warn('setParameters falhou', err);
    }
  }
}

async function applyLiveSettings() {
  if (!host.stream) return;
  const cfg = hostSettings();
  const v = host.stream.getVideoTracks()[0];
  v.contentHint = cfg.hint;
  try { await v.applyConstraints(videoConstraints(cfg)); } catch (err) { console.warn(err); }
  for (const viewer of host.viewers.values()) tuneSenders(viewer.call.peerConnection, viewer.quality, viewer.stats?.relay);
}

$('mbps').addEventListener('input', updateMbpsLabel);
for (const id of ['res', 'fps', 'mbps', 'hint']) $(id).addEventListener('change', applyLiveSettings);
// O "i" fica no título que abre e fecha a seção: clicar nele não fecha
for (const tip of document.querySelectorAll('.infoTip')) tip.addEventListener('click', (e) => e.preventDefault());

// Placa de vídeo (Configurações): qual está processando agora e qual vale ao reabrir
(async () => {
  if (!window.telinha.gpuPref) return;
  let gpu = await window.telinha.gpuPref();
  let enc = await window.telinha.encoderPref();
  const info = await window.telinha.diagInfo().catch(() => ({ gpus: [] }));
  const active = (info.gpus || []).find((g) => g.includes('(ativa)'))?.replace(/ \(ativa\).*$/, '') || 'desconhecida';
  $('gpuPref').value = gpu.saved;
  $('encoderPref').value = enc.saved;
  const show = () => {
    const pending = gpu.saved !== gpu.running || enc.saved !== enc.running;
    $('gpuNow').textContent = pending ? `Em uso agora: ${active}. A escolha nova vale ao reabrir.` : `Em uso agora: ${active}.`;
    $('gpuRelaunch').classList.toggle('hidden', !pending);
  };
  show();
  $('gpuPref').addEventListener('change', async () => { gpu = await window.telinha.gpuPref($('gpuPref').value); show(); });
  $('encoderPref').addEventListener('change', async () => { enc = await window.telinha.encoderPref($('encoderPref').value); show(); });
  $('gpuRelaunch').addEventListener('click', () => {
    if ((host.stream || watch.call) && !confirm('Reabrir agora encerra a transmissão. Continuar?')) return;
    window.telinha.relaunch();
  });
})();

// AV1 pela placa ou na CPU neste PC? (main.js liga o codificador D3D12 na próxima abertura se precisar)
const av1Check = (async () => {
  if (!window.telinha.av1Hw) return null;
  const info = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: 'video/AV1', width: 1920, height: 1080, framerate: 60, bitrate: 12e6 } }).catch(() => null);
  if (!info?.supported) return null;
  const res = await window.telinha.av1Hw(!!info.powerEfficient);
  const opt = [...$('codec').options].find((o) => o.value === 'AV1');
  if (res !== 'ok' && opt) {
    opt.textContent = res === 'restart' ? 'AV1 (na CPU agora; reabra o Telinha para tentar pela placa)' : 'AV1 (na CPU neste PC: prefira H.264)';
  }
  return res;
})();

$('codec').addEventListener('change', () => {
  if (host.stream) toast('O codec novo vale para quem entrar a partir de agora.');
});

// ---- pedidos para assistir

const prompts = []; // fila de { code, name } esperando você aceitar

function handleJoinRequest(code) {
  if (!host.stream) {
    send(code, { t: 'join-denied', reason: `${myName()} não está transmitindo agora.` });
    return;
  }
  if (host.viewers.has(code)) return;
  if ($('roomMode').value === 'public' || (allowed.has(code) && net.links.get(code)?.verified)) {
    acceptViewer(code);
    return;
  }
  if (prompts.some((p) => p.code === code)) return;
  send(code, { t: 'join-pending' });
  prompts.push({ code, name: friendName(code) });
  window.telinha.attention();
  showPrompt();
}

function showPrompt() {
  const p = prompts[0];
  if (!p) {
    $('prompt').classList.add('hidden');
    refreshUI();
    return;
  }
  $('promptTitle').textContent = `${p.name} quer assistir`;
  $('promptSub').textContent = isFriend(p.code)
    ? `Está na sua lista de amigos · ${prettyCode(p.code)}`
    : `Não está na sua lista de amigos · código ${prettyCode(p.code)}`;
  $('promptRemember').checked = false;
  $('prompt').classList.remove('hidden');
  refreshUI();
}

function dropPrompt(code) {
  const i = prompts.findIndex((p) => p.code === code);
  if (i < 0) return;
  prompts.splice(i, 1);
  if (i === 0) showPrompt();
}

function answerJoin(code, accept, remember = false) {
  const i = prompts.findIndex((p) => p.code === code);
  if (i < 0) return;
  prompts.splice(i, 1);
  if (accept) {
    if (remember) {
      allowed.add(code);
      storeJson('telinha.allowed', [...allowed]);
    }
    acceptViewer(code);
  } else {
    send(code, { t: 'join-denied', reason: `${myName()} recusou o pedido.` });
  }
  showPrompt();
}

function answerPrompt(accept) {
  if (prompts[0]) answerJoin(prompts[0].code, accept, $('promptRemember').checked);
}

$('promptAccept').addEventListener('click', () => answerPrompt(true));
$('promptDeny').addEventListener('click', () => answerPrompt(false));

// ---- espectadores

function renderViewers() {
  refreshUI();
  broadcastStatus(); // o número de espectadores aparece na telinha dos amigos
  const list = $('viewers');
  $('viewerCount').textContent = host.viewers.size;
  updateUploadEstimate();
  if (!host.viewers.size) {
    list.innerHTML = '<div class="muted small">Ninguém conectado ainda</div>';
    return;
  }
  list.innerHTML = '';
  for (const [code, v] of host.viewers) {
    if (!v.el) {
      v.el = document.createElement('div');
      v.el.className = 'viewer';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = v.name;
      const kick = document.createElement('button');
      kick.className = 'btn';
      kick.textContent = 'Remover';
      kick.addEventListener('click', () => {
        send(code, { t: 'kicked' });
        removeViewer(code);
      });
      const stats = document.createElement('div');
      stats.className = 'stats';
      stats.textContent = 'Conectando…';
      v.el.append(name, kick, stats);
    }
    list.append(v.el);
  }
}

function removeViewer(code) {
  const v = host.viewers.get(code);
  if (!v) return;
  host.viewers.delete(code);
  try { v.call.close(); } catch {}
  window.Voice?.onViewerLeave(code);
  window.Present?.onViewerLeave(code);
  renderViewers();
}

function acceptViewer(code) {
  if (!host.stream || host.viewers.has(code) || !net.peer?.open) return;
  const cfg = hostSettings();
  const meta = { codec: cfg.codec, kbps: cfg.mbps * 1000 };
  const call = net.peer.call(peerIdFor(code), host.stream, { // host.stream: o que a sala está recebendo agora (Present)
    metadata: meta,
    sdpTransform: (sdp) => tuneSdp(sdp, meta),
  });
  const name = friendName(code);
  host.viewers.set(code, { call, name, el: null, stats: null, latency: null });
  sendThumb(code);

  const pc = call.peerConnection;
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') tuneSenders(pc, host.viewers.get(code)?.quality);
    if (pc.connectionState === 'failed') {
      toast(`Conexão de vídeo com ${name} falhou. ${failHint()}`, true);
      removeViewer(code);
    }
  });
  call.on('close', () => {
    if (host.viewers.get(code)?.call === call) removeViewer(code);
  });
  call.on('error', () => {
    if (host.viewers.get(code)?.call === call) removeViewer(code);
  });
  toast(`${name} entrou.`);
  host.events.push({ t: Date.now(), label: `${name} entrou` });
  window.Room?.onViewerJoin(code);
  window.Voice?.onViewerJoin(code);
  window.Draw?.onViewerJoin(code);
  window.Present?.onViewerJoin(code);
  renderViewers();
}

async function hostStatsTick() {
  for (const v of host.viewers.values()) {
    const pc = v.call.peerConnection;
    if (!pc || pc.connectionState !== 'connected') continue;
    try {
      const wasRelay = !!v.stats?.relay;
      v.stats = await readStats(pc, v.stats, 'out');
      // A ligação passou a ir (ou deixou de ir) pelo servidor: ajusta o teto de bitrate
      if (!!v.stats.relay !== wasRelay) tuneSenders(pc, v.quality, v.stats.relay);
      v.stats.latency = v.latency;
      if (v.el) v.el.querySelector('.stats').textContent = formatStats(v.stats);
    } catch {}
  }
  // Upload total (soma dos espectadores), um ponto por segundo, 10 minutos guardados
  let total = 0;
  for (const v of host.viewers.values()) total += v.stats?.mbps || 0;
  host.upload.push({ t: Date.now(), v: +total.toFixed(1) });
  if (host.upload.length > 600) host.upload.shift();
  refreshUI();
}

// Miniatura da transmissão para a telinha dos amigos: um JPEG de 320x180 a cada 8 s
const thumbCanvas = document.createElement('canvas');
thumbCanvas.width = 320;
thumbCanvas.height = 180;
function sendThumb(to) {
  const v = $('preview');
  if (!host.stream || v.readyState < 2 || !v.videoWidth) return;
  const ctx = thumbCanvas.getContext('2d');
  const scale = Math.max(320 / v.videoWidth, 180 / v.videoHeight);
  const w = v.videoWidth * scale, h = v.videoHeight * scale;
  ctx.drawImage(v, (320 - w) / 2, (180 - h) / 2, w, h);
  host.thumb = thumbCanvas.toDataURL('image/jpeg', 0.7);
  const msg = { t: 'thumb', data: host.thumb };
  if (to) send(to, msg);
  else for (const code of net.links.keys()) if (seesRoom(code)) send(code, msg);
}

// ---- iniciar / parar

async function startHost() {
  if (!host.sourceId && webHost) host.sourceId = 'web';
  if (!host.sourceId) {
    await openPicker();
    toast('Escolha o que transmitir primeiro.');
    return;
  }
  if (!net.peer?.open) {
    toast('Ainda conectando ao servidor, tente em alguns segundos.', true);
    return;
  }
  const cfg = hostSettings();
  $('startHost').disabled = true;
  let stream;
  try {
    stream = await capture(cfg, webHost && $('audio').checked);
  } catch (err) {
    $('startHost').disabled = false;
    toast(`Não foi possível capturar: ${err.message}`, true);
    return;
  }
  if (webHost) {
    // O som marcado na janela do navegador; sem ele, um som mudo (a chamada sempre leva uma faixa de áudio)
    const shared = stream.getAudioTracks()[0];
    host.audio = shared || silentTrack();
    if (!shared) stream.addTrack(host.audio);
    $('audioMode').textContent = shared ? 'Som: o que você marcou para compartilhar no navegador.'
      : $('audio').checked ? 'Sem som: marque "Compartilhar áudio" ao escolher a tela.' : 'Som desligado.';
  } else {
    host.audio = await createAudioTrack();
    stream.addTrack(host.audio);
  }
  host.stream = stream;
  window.Present?.hostStarted(stream.getVideoTracks()[0]);
  if (!webHost && $('audio').checked) await setPcAudio(true);
  else if (!webHost) $('audioMode').textContent = 'Som desligado.';

  $('preview').srcObject = host.stream;
  $('previewEmpty').classList.add('hidden');
  $('startHost').classList.add('hidden');
  $('startHost').disabled = false;
  $('stopHost').classList.remove('hidden');
  host.since = Date.now();
  host.upload = [];
  host.events = [];
  setStatus('Ao vivo', 'ok');
  updateLiveBox();
  broadcastStatus();
  host.statsTimer = setInterval(hostStatsTick, 1000);
  host.thumbTimer = setInterval(() => sendThumb(), 8000);
  setTimeout(() => sendThumb(), 1500);
  refreshUI();
  window.Voice?.onHostStart();
  window.Share?.onLive(true);
}

function stopHost() {
  clearInterval(host.statsTimer);
  clearInterval(host.thumbTimer);
  host.since = null;
  host.thumb = null;
  window.Room?.onHostStop();
  window.Voice?.onStop();
  window.Draw?.onStop();
  window.Present?.reset();
  for (const code of [...host.viewers.keys()]) removeViewer(code);
  while (prompts.length) send(prompts.shift().code, { t: 'join-denied', reason: 'A transmissão terminou.' });
  showPrompt();
  if (host.stream) host.stream.getTracks().forEach((t) => t.stop());
  host.stream = null;
  host.audio = null;
  destroyAudio();
  $('preview').srcObject = null;
  $('previewEmpty').classList.remove('hidden');
  $('startHost').classList.remove('hidden');
  $('startHost').disabled = false;
  $('stopHost').classList.add('hidden');
  setStatus(net.peer?.open ? 'Online' : 'Sem servidor', net.peer?.open ? 'ok' : 'bad');
  updateLiveBox();
  broadcastStatus();
  window.Share?.onLive(false);
}

$('startHost').addEventListener('click', startHost);
$('stopHost').addEventListener('click', stopHost);

// ================================================================ ASSISTIR

// state: 'asking' (pedido enviado), 'pending' (esperando aprovação), 'watching'
const watch = { code: null, state: null, call: null, stats: null, timer: null, latencies: [] };

function applyLowLatency() {
  if (!watch.call?.peerConnection) return;
  const low = $('lowLatency').checked;
  for (const r of watch.call.peerConnection.getReceivers()) {
    // 0 = mostrar cada quadro assim que chega; null = deixa o WebRTC escolher
    if ('jitterBufferTarget' in r) r.jitterBufferTarget = low ? 0 : null;
    if ('playoutDelayHint' in r) r.playoutDelayHint = low ? 0 : null;
  }
}

// Latência de ponta a ponta: o Chromium informa, para cada quadro recebido, quando ele foi
// capturado no PC de quem transmite (já convertido para o relógio local via RTCP)
function trackLatency(video, call) {
  const onFrame = (_now, meta) => {
    if (watch.call !== call) return;
    if (meta.captureTime != null && meta.expectedDisplayTime != null) {
      watch.latencies.push(meta.expectedDisplayTime - meta.captureTime);
      if (watch.latencies.length > 120) watch.latencies.shift();
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

function medianLatency() {
  if (watch.latencies.length < 10) return null;
  const s = [...watch.latencies].sort((a, b) => a - b);
  return Math.round(s[s.length >> 1]);
}

function requestWatch(code) {
  if (watch.code) leave(true);
  if (!net.links.has(code)) {
    toast(`${friendName(code)} está offline.`, true);
    return;
  }
  rejoin = null;
  Object.assign(watch, { code, state: 'asking', latencies: [] });
  send(code, { t: 'join' });
  setStatus('Entrando…');
  $('remoteEmpty').textContent = `Entrando na transmissão de ${friendName(code)}…`;
  renderFriends();
}

function onIncomingCall(call) {
  // Câmera e voz de alguém da sala: voice.js
  if (call.metadata?.kind === 'cam') return window.Voice ? window.Voice.onIncoming(call) : call.close();
  // Tela de quem assiste e vai apresentar para a sala: present.js
  if (call.metadata?.kind === 'present') return window.Present && host.stream ? window.Present.onIncoming(call) : call.close();
  const code = codeOfPeer(call.peer);
  if (!code || code !== watch.code || watch.call) {
    call.close();
    return;
  }
  watch.call = call;
  watch.state = 'watching';
  const meta = call.metadata || { codec: 'H264', kbps: 12000 };
  call.answer(undefined, { sdpTransform: (sdp) => tuneSdp(sdp, meta) });
  call.on('stream', (stream) => {
    const video = $('remote');
    video.srcObject = stream;
    video.volume = Number($('vol').value) / 100;
    // Navegadores que bloqueiam som automático (Safari no iPhone): começa mudo e mostra "Tocar som"
    video.muted = false;
    video.play().catch((err) => {
      // Só o bloqueio de som do navegador; um "play interrompido" por troca de fonte não é motivo
      if (err?.name !== 'NotAllowedError') return;
      video.muted = true;
      video.play().catch(() => {});
      $('unmuteBtn').classList.remove('hidden');
    });
    $('remoteEmpty').classList.add('hidden');
    $('fullscreen').classList.remove('hidden');
    applyLowLatency();
    trackLatency(video, call);
    send(code, { t: 'quality', q: $('quality').value });
    setStatus(`Assistindo ${friendName(code)}`, 'ok');
    go('watch');
    renderFriends();
    keepAwake();
    window.Voice?.onWatchStart();
  });
  call.on('close', () => {
    if (watch.call !== call) return;
    if (!backgrounded(code)) toast(`A transmissão de ${friendName(code)} terminou.`);
    leave(false);
  });
  call.peerConnection.addEventListener('connectionstatechange', () => {
    if (watch.call !== call || call.peerConnection.connectionState !== 'failed') return;
    if (!backgrounded(code)) toast(`A conexão de vídeo falhou. ${failHint()}`, true);
    leave(true);
  });
  clearInterval(watch.timer);
  watch.timer = setInterval(async () => {
    const pc = watch.call?.peerConnection;
    if (!pc || pc.connectionState !== 'connected') return;
    try {
      watch.stats = await readStats(pc, watch.stats, 'in');
      watch.stats.latency = medianLatency();
      $('remoteStats').textContent = formatStats(watch.stats);
      if (watch.stats.latency != null) send(code, { t: 'vstats', latency: watch.stats.latency });
    } catch {}
  }, 1000);
}

// Celular: ao trocar de app (Discord, WhatsApp…) o sistema pausa a página e a conexão cai.
// Se a queda vem com a página escondida, ou logo depois de voltar, entra de novo sozinho ao voltar.
let shownAt = 0;
let rejoin = null;
function backgrounded(code) {
  if (!document.hidden && Date.now() - shownAt > 30000) return false;
  rejoin = { code, until: Date.now() + 60000 };
  setStatus('Voltando para a transmissão…');
  return true;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) shownAt = Date.now(); });
setInterval(() => {
  if (!rejoin || document.hidden || watch.code) return;
  if (Date.now() > rejoin.until) {
    rejoin = null;
    setStatus(net.peer?.open ? 'Online' : 'Sem servidor', net.peer?.open ? 'ok' : 'bad');
    return;
  }
  const link = net.links.get(rejoin.code);
  if (!link || (knownKeys[rejoin.code] && !link.verified)) return; // espera o link voltar
  const { code } = rejoin;
  rejoin = null;
  requestWatch(code);
}, 1000);

// Assistindo: a tela do celular não apaga (o vídeo mudo não segura a tela acesa sozinho)
let wakeLock = null;
async function keepAwake() {
  if (watch.state !== 'watching' || document.hidden || wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {} // bateria fraca ou navegador sem suporte: segue sem
}
document.addEventListener('visibilitychange', keepAwake); // o sistema solta a trava quando a página some
$('homeBackWatch').addEventListener('click', () => go('watch'));

// notify = avisar quem transmite que saímos (falso quando foi ele que encerrou)
function leave(notify) {
  if (!watch.code) return;
  if (notify) send(watch.code, { t: 'leave' });
  clearInterval(watch.timer);
  window.Room?.onLeave();
  window.Voice?.onStop();
  window.Draw?.onStop();
  window.Present?.onLeave();
  try { watch.call?.close(); } catch {}
  wakeLock?.release().catch(() => {});
  Object.assign(watch, { code: null, state: null, call: null, stats: null, timer: null, latencies: [] });
  $('remote').srcObject = null;
  $('remoteEmpty').textContent = 'Adicione seus amigos pelo código e clique em Assistir quando eles estiverem ao vivo';
  $('remoteEmpty').classList.remove('hidden');
  $('remoteStats').textContent = '';
  $('fullscreen').classList.add('hidden');
  $('unmuteBtn').classList.add('hidden');
  if (document.fullscreenElement) document.exitFullscreen();
  if (!rejoin) setStatus(host.stream ? 'Ao vivo' : net.peer?.open ? 'Online' : 'Sem servidor', net.peer?.open ? 'ok' : 'bad');
  renderFriends();
}

// Tela de toque: tocar no vídeo mostra as reações e o botão de tela cheia por 3,5 s (tocar de novo esconde)
let controlsTimer = null;
function showControls(on) {
  clearTimeout(controlsTimer);
  $('watchWrap').classList.toggle('controls', on);
  if (on) controlsTimer = setTimeout(() => { if (!$('watchWrap').contains(document.activeElement)) showControls(false); }, 3500);
}
$('watchWrap').addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || window.Draw?.mode || $('watchWrap').classList.contains('pointing')) return;
  if (e.target.closest('.reactBar, .fsBtn, .unmuteBtn')) return showControls(true); // mexendo nos controles: continua visível
  showControls(!$('watchWrap').classList.contains('controls'));
});
// Em tela cheia (ou deitado com o vídeo cobrindo a tela) o botão vira "Sair da tela cheia"
function fsLabel() {
  $('fullscreen').textContent = document.fullscreenElement || document.documentElement.classList.contains('immersive') ? 'Sair da tela cheia' : 'Tela cheia';
}
document.addEventListener('fullscreenchange', fsLabel);

function toggleFullscreen() {
  const video = $('remote');
  // Celular deitado: o botão sai do vídeo em tela inteira (para ver os menus) e volta para ele
  if (landscape.matches && !document.fullscreenElement) {
    immersiveOff = !immersiveOff;
    return immersive();
  }
  if (document.fullscreenElement) document.exitFullscreen();
  // No iPhone só o próprio vídeo entra em tela cheia
  else if ($('watchWrap').requestFullscreen) $('watchWrap').requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
  else video.webkitEnterFullscreen?.();
}

$('quality').addEventListener('change', () => {
  if (watch.state === 'watching') send(watch.code, { t: 'quality', q: $('quality').value });
});
// Primeira vez num celular com dados móveis ou "economia de dados" ligada: começa em economia
if (store('telinha.quality') == null) {
  const c = navigator.connection;
  if (c && (c.saveData || c.type === 'cellular' || /(^|-)2g|3g/.test(c.effectiveType || ''))) $('quality').value = 'eco';
}

// Picture-in-picture: a transmissão continua numa janelinha enquanto você usa outra coisa
function togglePip() {
  const video = $('remote');
  if (document.pictureInPictureElement) return document.exitPictureInPicture().catch(() => {});
  if (video.requestPictureInPicture) return video.requestPictureInPicture().catch((err) => toast(`Picture-in-picture indisponível: ${err.message}`, true));
  // Safari antigo
  if (video.webkitSupportsPresentationMode?.('picture-in-picture')) video.webkitSetPresentationMode('picture-in-picture');
  return null;
}
$('pipBtn').addEventListener('click', togglePip);
$('remote').setAttribute('autopictureinpicture', ''); // iPhone: entra sozinho em PiP ao sair do app
// Chrome (Android e PC): ao trocar de app com o vídeo tocando, abre o popout sozinho e a conexão continua
try { navigator.mediaSession?.setActionHandler('enterpictureinpicture', () => { if (watch.state === 'watching') togglePip(); }); } catch {}

// Celular deitado assistindo: o vídeo ocupa a tela inteira (sem precisar da API de tela cheia)
const landscape = matchMedia('(orientation: landscape) and (max-height: 520px)');
let immersiveOff = false; // tocou em "Sair da tela cheia" deitado; vale até virar o celular de novo
function immersive() {
  document.documentElement.classList.toggle('immersive', !immersiveOff && landscape.matches && watch.state === 'watching' && $('watch').classList.contains('active'));
  fsLabel();
}
landscape.addEventListener('change', () => { immersiveOff = false; immersive(); });
setInterval(immersive, 1000);

$('unmuteBtn').addEventListener('click', () => {
  const video = $('remote');
  video.muted = false;
  video.play().catch(() => {});
  window.Voice?.unmuteAll();
  $('unmuteBtn').classList.add('hidden');
});
$('copyWebLink').addEventListener('click', async () => {
  await window.telinha.copy($('webLink').textContent);
  toast('Link copiado. Abra no celular e adicione seus amigos pelo código.');
});

$('vol').addEventListener('input', () => {
  $('volLabel').textContent = `${$('vol').value}%`;
  $('remote').volume = Number($('vol').value) / 100;
});
$('volLabel').textContent = `${$('vol').value}%`;
$('lowLatency').addEventListener('change', applyLowLatency);
$('remote').addEventListener('dblclick', toggleFullscreen);
$('fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 's' || e.key === 'S') $('remoteStats').classList.toggle('hidden');
  if ((e.key === 'f' || e.key === 'F') && $('watch').classList.contains('active')) toggleFullscreen();
});

// ---------------------------------------------------------------- modal de diagnóstico

$('diagBtn').addEventListener('click', async () => {
  $('diagText').textContent = 'Coletando…';
  $('diag').classList.remove('hidden');
  $('diagText').textContent = await buildDiagnostics();
});
$('diagRefresh').addEventListener('click', async () => { $('diagText').textContent = await buildDiagnostics(); });
$('diagCopy').addEventListener('click', async () => {
  await window.telinha.copy($('diagText').textContent);
  toast('Diagnóstico copiado.');
});
$('diagInternals').addEventListener('click', () => window.telinha.openInternals());
$('diagClose').addEventListener('click', () => $('diag').classList.add('hidden'));

// ---------------------------------------------------------------- atualização automática

window.telinha.onUpdate((info) => {
  $('updateBar').classList.remove('hidden');
  if (info.state === 'downloading') {
    $('updateText').textContent = `Baixando a versão ${info.version}… ${info.percent ?? 0}%`;
    $('updateNow').classList.add('hidden');
  } else if (info.state === 'ready') {
    $('updateText').textContent = `Versão ${info.version} pronta. Ela é instalada quando você fechar o Telinha, ou agora:`;
    $('updateNow').classList.remove('hidden');
  }
});

$('updateNow').addEventListener('click', () => {
  if ((host.stream || watch.call) && !confirm('Atualizar agora encerra a transmissão. Continuar?')) return;
  window.telinha.updateInstall();
});

// ---------------------------------------------------------------- início

// Ping até cada amigo (mostrado na telinha do Início) e miniatura para quem acabou de conectar
setInterval(() => {
  for (const code of net.links.keys()) send(code, { t: 'ping', ts: performance.now() });
}, 10000);

window.telinha.diagInfo().then((info) => { $('appVersion').textContent = `Versão ${info.appVersion}`; });
// Sem nome escolhido, o topo mostra "Seu código" em cima do código (e não o código duas vezes)
const accLabel = () => $('myName').value.trim().slice(0, 24) || 'Seu código';
$('accName').textContent = accLabel();
for (const ev of ['input', 'change']) $('myName').addEventListener(ev, () => { $('accName').textContent = accLabel(); refreshUI(); });
$('copyMyCode').addEventListener('click', () => $('myCodeBtn').click());

renderFriends();
// A chave de identidade vem antes da primeira conexão (o link já abre pedindo a prova)
loadIdentity().catch((err) => console.warn('identidade', err)).then(startNet);
