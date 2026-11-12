/* Telinha · vídeo junto: quem transmite cola um link do YouTube e o vídeo toca no palco de todo mundo, no mesmo
   ponto. Quem transmite controla pelo próprio player (play, pausa, pular); os outros acompanham. Gasta bem menos
   banda que mandar o vídeo pela transmissão da tela, e cada um ouve o som direto do YouTube.
   O player é o embed do YouTube (versão sem cookies), comandado por postMessage, sem carregar script de fora. */
'use strict';

const Together = (() => {
  const ORIGIN = 'https://www.youtube-nocookie.com';
  const PLAYING = 1, PAUSED = 2, ENDED = 0;
  const MAX_QUEUE = 20, MAX_PER_PERSON = 3;
  let queue = []; // { id, title, who, from, ok }: "ok" já aprovado por quem transmite
  let frame = null;
  let state = null; // { id, time, playing, at } (at = quando este app recebeu/definiu, no relógio daqui)
  let player = { time: 0, status: -1 }; // o que o player informou por último
  const isHost = () => !!host.stream;

  // Link (youtu.be, watch?v=, shorts, embed) ou o próprio ID de 11 caracteres
  const idOf = (url) => (String(url).match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/) || [])[1] || (/^[\w-]{11}$/.test(String(url).trim()) ? String(url).trim() : null);
  const expected = () => (state ? state.time + (state.playing ? (performance.now() - state.at) / 1000 : 0) : 0);

  function cmd(func, args = []) {
    frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), ORIGIN);
  }
  function mount() {
    const wrap = (isHost() ? $('preview') : $('remote')).closest('.videoWrap');
    if (!frame || frame.dataset.id !== state.id) {
      frame?.remove();
      frame = document.createElement('iframe');
      frame.className = 'ytFrame';
      frame.dataset.id = state.id;
      frame.title = 'Vídeo junto';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      // Botões para todos: no celular o vídeo só toca depois de um toque da pessoa. Quem assiste e pausar sozinho
      // volta a acompanhar em meio segundo (os comandos que valem são os de quem transmite)
      frame.src = `${ORIGIN}/embed/${state.id}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1`;
      player = { time: 0, status: -1 };
    }
    if (frame.parentElement !== wrap) wrap.append(frame);
  }
  function unmount() {
    frame?.remove();
    frame = null;
    state = null;
    render();
  }

  addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || !frame || e.source !== frame.contentWindow) return;
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d?.event === 'onReady') apply();
    if (d?.event !== 'infoDelivery' || !d.info) return;
    if (typeof d.info.currentTime === 'number') player.time = d.info.currentTime;
    if (typeof d.info.playerState === 'number') player.status = d.info.playerState;
  });

  // Quem assiste: segue o estado de quem transmite (pula se estiver mais de 1,5 s fora)
  function apply() {
    if (!state || !frame) return;
    if (Math.abs(player.time - expected()) > 1.5) cmd('seekTo', [expected(), true]);
    if (state.playing && player.status !== PLAYING) cmd('playVideo');
    if (!state.playing && player.status === PLAYING) cmd('pauseVideo');
  }

  // Quem transmite: o que fizer no player (pausa, play, pular) vai para a sala
  function broadcast() {
    const msg = state ? { t: 'yt', id: state.id, time: expected(), playing: state.playing } : { t: 'yt', id: null };
    for (const code of host.viewers.keys()) send(code, msg);
  }
  // O som do PC de quem transmite levaria o YouTube junto (atrasado, em eco por cima do player de cada um):
  // desligado enquanto houver vídeo junto, volta como estava ao parar
  let muted = null; // { track, was }
  function quietPc() {
    const a = isHost() ? host.audio : null;
    if (state && a && muted?.track !== a) {
      if (muted) muted.track.enabled = muted.was;
      muted = { track: a, was: a.enabled };
      a.enabled = false;
    } else if (!state && muted) {
      muted.track.enabled = muted.was;
      muted = null;
    }
  }
  let beat = 0;
  setInterval(() => {
    render();
    quietPc();
    if (!state || !frame) return;
    // Pede para o player mandar o tempo e o estado (infoDelivery) para cá, até ele responder: logo que a página
    // do player carrega ele ainda pode não estar pronto e ignora o pedido (a API oficial do YouTube faz igual)
    if (player.status === -1) frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), ORIGIN);
    if (!isHost()) return apply();
    if (player.status === -1) return; // o player ainda não respondeu
    const playing = player.status === PLAYING || player.status === 3; // 3 = carregando, conta como tocando
    const jumped = Math.abs(player.time - expected()) > 2;
    // Acabou: entra o próximo aprovado da fila
    if (player.status === ENDED && queue.some((q) => q.ok)) return playNext();
    if (playing !== state.playing || jumped || player.status === ENDED) {
      state = { ...state, time: player.time, playing: player.status !== ENDED && playing, at: performance.now() };
      broadcast();
    } else if (++beat % 10 === 0) {
      state = { ...state, time: player.time, at: performance.now() }; // a cada 5 s, acerta o tempo com o do player
      broadcast();
    }
  }, 500);

  function start(url) {
    const id = idOf(url);
    if (!id) return toast('Não reconheci esse link do YouTube.', true);
    if (!isHost()) return toast('Só quem está transmitindo pode tocar um vídeo para a sala.', true);
    state = { id, time: 0, playing: true, at: performance.now() };
    mount();
    broadcast();
    render();
  }
  // ------------------------------------------------------------ fila
  const shared = () => queue.map(({ id, title, who, ok }) => ({ id, title, who, ok }));
  function sendQueue() {
    for (const code of host.viewers.keys()) send(code, { t: 'yt-queue', items: shared() });
    renderQueue();
  }
  // O título vem do próprio YouTube; sem resposta, fica o ID
  async function titleOf(id) {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://youtu.be/${id}`)}`);
      if (!res.ok) return null;
      const { title } = await res.json();
      return typeof title === 'string' ? title.slice(0, 100) : null;
    } catch {
      return null;
    }
  }
  function addToQueue(id, who, from, ok) {
    if (queue.length >= MAX_QUEUE) return false;
    const item = { id, title: id, who, from, ok };
    queue.push(item);
    sendQueue();
    titleOf(id).then((title) => {
      if (!title || !queue.includes(item)) return;
      item.title = title;
      sendQueue();
    });
    return true;
  }
  function playItem(item) {
    queue = queue.filter((q) => q !== item);
    sendQueue();
    start(item.id);
  }
  function playNext() {
    const next = queue.find((q) => q.ok);
    if (next) playItem(next);
  }
  function row(item, buttons) {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'ytItem';
    const title = document.createElement('b');
    title.textContent = item.title;
    const sub = document.createElement('div');
    sub.className = 'muted small';
    sub.textContent = `${item.who}${item.ok ? '' : ' · esperando aprovar'}`;
    text.append(title, sub);
    li.append(text);
    for (const [label, action] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = label;
      b.addEventListener('click', action);
      li.append(b);
    }
    return li;
  }
  function renderQueue() {
    $('ytQueue').replaceChildren(...queue.map((item) => row(item, [
      ...(item.ok ? [['Tocar', () => playItem(item)]] : [['Aprovar', () => { item.ok = true; sendQueue(); }]]),
      ['Tirar', () => { queue = queue.filter((q) => q !== item); sendQueue(); }],
    ])));
  }
  let seen = []; // a fila que quem assiste recebe
  function renderSeen() {
    $('ytSuggestList').replaceChildren(...seen.map((item) => row(item, [])));
  }

  function stop() {
    if (!state) return;
    unmount();
    if (isHost()) broadcast();
  }

  function render() {
    $('ytBox').classList.toggle('hidden', !isHost());
    $('ytStop').classList.toggle('hidden', !state || !isHost());
    $('ytSuggestBox').classList.toggle('hidden', isHost() || watch.state !== 'watching');
    document.documentElement.classList.toggle('together', !!state);
  }
  $('ytPlay').addEventListener('click', () => { start($('ytUrl').value); $('ytUrl').value = ''; });
  $('ytAdd').addEventListener('click', () => {
    const id = idOf($('ytUrl').value);
    if (!id) return toast('Não reconheci esse link do YouTube.', true);
    if (!addToQueue(id, myName(), myCode, true)) return toast('A fila está cheia.', true);
    $('ytUrl').value = '';
  });
  $('ytSuggestForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = idOf($('ytSuggestUrl').value);
    if (!id) return toast('Não reconheci esse link do YouTube.', true);
    send(watch.code, { t: 'yt-suggest', id });
    $('ytSuggestUrl').value = '';
    toast('Sugestão enviada para quem transmite.');
  });
  $('ytUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ytPlay').click(); });
  $('ytStop').addEventListener('click', stop);

  return {
    start, stop, idOf, titleOf,
    // Só vale o que vem de quem eu estou assistindo
    onMessage(code, msg) {
      // Sugestão de quem assiste: entra esperando aprovação, com limite por pessoa
      if (msg.t === 'yt-suggest') {
        const id = idOf(msg.id);
        if (id && isHost() && host.viewers.has(code) && queue.filter((q) => q.from === code).length < MAX_PER_PERSON) addToQueue(id, friendName(code), code, false);
        return;
      }
      if (msg.t === 'yt-queue') {
        if (code !== watch.code || !Array.isArray(msg.items)) return;
        seen = msg.items.slice(0, MAX_QUEUE).map((q) => ({ title: String(q.title || '').slice(0, 100), who: String(q.who || '').slice(0, 24), ok: !!q.ok }));
        renderSeen();
        return;
      }
      if (msg.t !== 'yt' || code !== watch.code) return;
      if (!msg.id) return unmount();
      const id = idOf(msg.id);
      if (!id) return;
      state = { id, time: Number(msg.time) || 0, playing: !!msg.playing, at: performance.now() };
      mount();
      apply();
      render();
    },
    onViewerJoin(code) {
      if (!isHost()) return;
      if (state) send(code, { t: 'yt', id: state.id, time: expected(), playing: state.playing });
      if (queue.length) send(code, { t: 'yt-queue', items: shared() });
    },
    onStop() {
      unmount();
      queue = [];
      seen = [];
      renderQueue();
      renderSeen();
    },
    playNext,
    state: () => ({ ...state, player: { ...player }, expected: expected(), queue: shared(), seen }),
  };
})();
window.Together = Together;
