/* Telinha · música da sala: todo mundo adiciona links do YouTube na fila e a música toca para a sala inteira, sem ocupar
   o palco nem cortar o som do PC. Quem transmite manda: o player dele é o relógio, e cada um ouve direto do YouTube.
   O player fica sempre visível no canto (regra do YouTube: nada de player escondido, mínimo de 200 x 200). */
'use strict';

const Music = (() => {
  const ORIGIN = 'https://www.youtube-nocookie.com';
  const PLAYING = 1, ENDED = 0, LOADING = 3;
  const MAX_QUEUE = 50, MAX_PER_PERSON = 5;
  const TOUCH = matchMedia('(hover: none)').matches;
  let queue = []; // quem transmite: { key, id, title, who, from }
  let now = null; // quem transmite: o item tocando
  let nextKey = 1;
  let seen = { now: null, items: [] }; // quem assiste: a fila recebida
  let state = null; // { key, id, time, playing, at }
  let frame = null;
  let player = { time: 0, status: -1 };
  let listen = !TOUCH; // no celular o player cobriria o vídeo: só aparece se a pessoa pedir
  let excluding = false;
  let beat = 0;
  let pausedForVideo = false;

  const isHost = () => !!host.stream;
  const inRoom = () => isHost() || watch.state === 'watching';
  const expected = () => (state ? state.time + (state.playing ? (performance.now() - state.at) / 1000 : 0) : 0);
  const volume = () => {
    try { return Number(localStorage.getItem('telinha.musicVol') ?? 60); } catch { return 60; }
  };

  function cmd(func, args = []) {
    frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), ORIGIN);
  }

  function unmount() {
    frame?.remove();
    frame = null;
  }
  function mount() {
    if (!state || (!isHost() && !listen)) return unmount();
    if (frame?.dataset.key === String(state.key)) return undefined;
    unmount();
    frame = document.createElement('iframe');
    frame.className = 'musicFrame';
    frame.dataset.key = state.key;
    frame.title = 'Música da sala';
    frame.allow = 'autoplay; encrypted-media';
    frame.src = `${ORIGIN}/embed/${state.id}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1`;
    player = { time: 0, status: -1 };
    $('musicPlayer').append(frame);
    return undefined;
  }

  addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || !frame || e.source !== frame.contentWindow) return;
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d?.event === 'onReady') {
      cmd('setVolume', [volume()]);
      apply();
    }
    // Vídeo que não deixa tocar fora do YouTube: passa para o próximo em vez de travar a sala
    if (d?.event === 'onError' && isHost() && state) playNext();
    if (d?.event !== 'infoDelivery' || !d.info) return;
    if (typeof d.info.currentTime === 'number') player.time = d.info.currentTime;
    if (typeof d.info.playerState === 'number') player.status = d.info.playerState;
  });

  // Quem assiste segue o relógio de quem transmite
  function apply() {
    if (!state || !frame) return;
    if (Math.abs(player.time - expected()) > 1.5) cmd('seekTo', [expected(), true]);
    if (state.playing && player.status !== PLAYING) cmd('playVideo');
    if (!state.playing && player.status === PLAYING) cmd('pauseVideo');
  }

  const stateMsg = () => (state ? { t: 'music', key: state.key, id: state.id, time: expected(), playing: state.playing } : { t: 'music', id: null });
  const queueMsg = (code) => ({
    t: 'music-queue',
    now: now && { title: now.title, who: now.who, mine: now.from === code },
    items: queue.map(({ key, title, who, from }) => ({ key, title, who, mine: from === code })),
  });
  function broadcast() {
    for (const code of host.viewers.keys()) send(code, stateMsg());
  }
  function sendQueue() {
    for (const code of host.viewers.keys()) send(code, queueMsg(code));
    render();
  }

  function playNext() {
    now = queue.shift() || null;
    state = now && { key: now.key, id: now.id, time: 0, playing: true, at: performance.now() };
    mount();
    broadcast();
    sendQueue();
  }

  async function add(id, who, from) {
    if (queue.length >= MAX_QUEUE) return 'A fila está cheia.';
    if (from !== myCode && queue.filter((q) => q.from === from).length >= MAX_PER_PERSON) return `Limite de ${MAX_PER_PERSON} músicas na fila por pessoa.`;
    const item = { key: nextKey++, id, title: id, who, from };
    queue.push(item);
    if (!now) playNext();
    else sendQueue();
    const title = await window.Together.titleOf(id);
    if (title) {
      item.title = title;
      sendQueue();
    }
    return null;
  }

  function remove(key, code) {
    const item = queue.find((q) => q.key === key);
    if (!item || (code !== myCode && item.from !== code)) return;
    queue = queue.filter((q) => q !== item);
    sendQueue();
  }

  function clearAll() {
    queue = [];
    now = null;
    state = null;
    pausedForVideo = false;
    seen = { now: null, items: [] };
    unmount();
    render();
  }

  // O app captura o som do PC para a transmissão: sem isso a música iria junto, atrasada, em eco por cima do player de cada um
  function syncExclude() {
    const want = isHost() && !!state;
    if (want === excluding) return;
    excluding = want;
    window.telinha.audioExcludeSelf?.(want, 'music');
  }

  setInterval(() => {
    render();
    syncExclude();
    if (!state || !frame) return;
    if (player.status === -1) frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), ORIGIN);
    if (!isHost()) return apply();
    if (player.status === -1) return;
    if (player.status === ENDED) return playNext();
    // O Vídeo junto toca para a sala: dois sons ao mesmo tempo não dá. Quando ele para, a música volta.
    const video = !!window.Together?.state().id;
    if (video && player.status === PLAYING) {
      cmd('pauseVideo');
      pausedForVideo = true;
    } else if (!video && pausedForVideo) {
      pausedForVideo = false;
      cmd('playVideo');
    }
    const playing = player.status === PLAYING || player.status === LOADING;
    if (playing !== state.playing || Math.abs(player.time - expected()) > 2) {
      state = { ...state, time: player.time, playing, at: performance.now() };
      broadcast();
    } else if (++beat % 10 === 0) {
      state = { ...state, time: player.time, at: performance.now() };
      broadcast();
    }
  }, 500);

  // ---------------------------------------------------------------- tela
  function row(title, sub, onRemove) {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'ytItem';
    const b = document.createElement('b');
    b.textContent = title;
    const s = document.createElement('div');
    s.className = 'muted small';
    s.textContent = sub;
    text.append(b, s);
    li.append(text);
    if (onRemove) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Tirar';
      btn.addEventListener('click', onRemove);
      li.append(btn);
    }
    return li;
  }

  let shownQueue = '';
  function render() {
    $('music').classList.toggle('hidden', !inRoom() || TV);
    // Logo acima dos itens de baixo da barra lateral: a altura deles muda com o tema
    $('music').style.setProperty('--music-bottom', `${innerHeight - document.querySelector('.sideFoot').getBoundingClientRect().top + 8}px`);
    if (!inRoom() && !$('musicPanel').classList.contains('hidden')) $('musicPanel').classList.add('hidden');
    const hosting = isHost();
    const current = hosting ? now && { title: now.title, who: now.who, mine: true } : seen.now;
    const items = hosting ? queue.map((q) => ({ key: q.key, title: q.title, who: q.who, mine: true })) : seen.items;
    $('musicBtn').textContent = items.length ? `Música (${items.length})` : 'Música';
    $('musicPlayer').classList.toggle('hidden', !frame);
    $('musicListenRow').classList.toggle('hidden', hosting);
    $('musicVolRow').classList.toggle('hidden', TOUCH || !frame);
    // Só refaz a lista quando muda: refazer a cada 500 ms mataria um clique no meio
    const text = JSON.stringify([current, items, hosting]);
    if (text === shownQueue) return;
    shownQueue = text;
    $('musicNow').textContent = current ? `Tocando: ${current.title} · ${current.who}` : 'Nada tocando. Cole um link do YouTube para começar.';
    $('musicSkip').classList.toggle('hidden', !current?.mine);
    $('musicStop').classList.toggle('hidden', !hosting || !current);
    $('musicQueue').replaceChildren(...items.map((q) => row(q.title, q.who, q.mine ? () => {
      if (hosting) remove(q.key, myCode);
      else send(watch.code, { t: 'music-remove', key: q.key });
    } : null)));
  }

  $('musicBtn').addEventListener('click', () => $('musicPanel').classList.toggle('hidden'));
  $('musicForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = window.Together.idOf($('musicUrl').value);
    if (!id) return toast('Não reconheci esse link do YouTube.', true);
    $('musicUrl').value = '';
    if (!isHost()) return send(watch.code, { t: 'music-add', id });
    const problem = await add(id, myName(), myCode);
    if (problem) toast(problem, true);
    return undefined;
  });
  $('musicSkip').addEventListener('click', () => {
    if (isHost()) playNext();
    else send(watch.code, { t: 'music-skip' });
  });
  $('musicStop').addEventListener('click', () => {
    clearAll();
    broadcast();
    sendQueue();
  });
  $('musicListen').checked = listen;
  $('musicListen').addEventListener('change', () => {
    listen = $('musicListen').checked;
    mount();
    render();
  });
  $('musicVol').value = volume();
  $('musicVol').addEventListener('input', () => {
    try { localStorage.setItem('telinha.musicVol', $('musicVol').value); } catch {}
    cmd('setVolume', [Number($('musicVol').value)]);
  });

  return {
    onMessage(code, msg) {
      switch (msg.t) {
        case 'music-add': {
          if (!isHost() || !host.viewers.has(code)) return;
          const id = window.Together.idOf(msg.id);
          if (id) add(id, friendName(code), code).then((problem) => { if (problem) send(code, { t: 'music-no', reason: problem }); });
          return;
        }
        case 'music-remove':
          if (isHost() && host.viewers.has(code)) remove(msg.key, code);
          return;
        case 'music-skip':
          if (isHost() && now?.from === code) playNext();
          return;
        case 'music-no':
          if (code === watch.code) toast(String(msg.reason || '').slice(0, 120), true);
          return;
        case 'music-queue':
          // Quem transmite e assiste outra pessoa ao mesmo tempo segue a própria sala
          if (code !== watch.code || isHost() || !Array.isArray(msg.items)) return;
          seen = {
            now: msg.now ? { title: String(msg.now.title || '').slice(0, 100), who: String(msg.now.who || '').slice(0, 24), mine: msg.now.mine === true } : null,
            items: msg.items.slice(0, MAX_QUEUE).map((q) => ({ key: Number(q.key), title: String(q.title || '').slice(0, 100), who: String(q.who || '').slice(0, 24), mine: q.mine === true })),
          };
          render();
          return;
        case 'music': {
          if (code !== watch.code || isHost()) return;
          const id = msg.id && window.Together.idOf(msg.id);
          state = id ? { key: Number(msg.key) || 0, id, time: Number(msg.time) || 0, playing: !!msg.playing, at: performance.now() } : null;
          mount();
          apply();
          render();
          return;
        }
        default:
      }
    },
    onViewerJoin(code) {
      if (!isHost()) return;
      send(code, stateMsg());
      send(code, queueMsg(code));
    },
    onStop: clearAll,
    state: () => ({ ...state, player: { ...player }, excluding, queue: queue.map((q) => q.title), mounted: !!frame }),
  };
})();
window.Music = Music;
