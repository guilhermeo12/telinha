/* global $, net, friends, incoming, prompts, host, watch, friendName, prettyCode, myCode, myName, isFriend,
   answerJoin, answerFriend, requestWatch, leave, send, saveFriends, renderFriends, Charts, medianLatency */
/* Telinha · Início, Pedidos, Amigos e os contadores da barra lateral. Tudo é desenhado a partir do estado
   de app.js (amigos, canais, pedidos, transmissão) sempre que ele muda (refreshUI). */
'use strict';

(() => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clock = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dec1 = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function minutesSince(t) {
    const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  const names = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} e ${list.at(-1)}`);

  // Cada pessoa tem um tom só dela (identidade, não dado), estável a partir do código
  function hueOf(code) {
    let x = 7;
    for (const ch of code) x = (x * 31 + ch.charCodeAt(0)) % 360;
    return x;
  }
  function avatar(name, code) {
    const a = el('span', 'avatar', (name || '?').trim()[0]?.toUpperCase() || '?');
    a.style.setProperty('--h', hueOf(code || name));
    return a;
  }
  function btn(label, cls, onClick) {
    const b = el('button', `btn ${cls || ''}`.trim(), label);
    b.addEventListener('click', onClick);
    return b;
  }

  // Lista com chave: reaproveita os nós (a miniatura não recarrega a cada segundo) e só cria/remove o que mudou
  function keyed(container, items, key, create, update) {
    const old = new Map([...container.children].filter((c) => c.dataset.key).map((c) => [c.dataset.key, c]));
    container.querySelectorAll(':scope > :not([data-key])').forEach((n) => n.remove());
    let prev = null;
    for (const item of items) {
      const k = key(item);
      let node = old.get(k);
      if (!node) {
        node = create(item);
        node.dataset.key = k;
      }
      old.delete(k);
      update(node, item);
      if (node.previousElementSibling !== prev || node.parentNode !== container) {
        if (prev) prev.after(node);
        else container.prepend(node);
      }
      prev = node;
    }
    for (const n of old.values()) n.remove();
  }
  function emptyLine(container, text) {
    container.querySelectorAll('[data-key]').forEach((n) => n.remove());
    let e = container.querySelector(':scope > .emptyLine');
    if (!e) container.append(e = el('div', 'emptyLine'));
    e.textContent = text;
  }

  const confirmed = () => friends.filter((f) => !f.pending);
  const liveFriends = () => confirmed().filter((f) => net.links.get(f.code)?.info.live);

  // ---------------------------------------------------------------- ao vivo agora: uma telinha por amigo
  function renderLive() {
    const live = liveFriends();
    $('homeLiveCount').textContent = live.length || '';
    if (!live.length) {
      emptyLine($('homeLive'), confirmed().length
        ? 'Nenhum amigo ao vivo agora. Quando alguém começar, aparece aqui com a telinha da transmissão.'
        : 'Adicione amigos pelo código (na aba Amigos). Quando eles transmitirem, aparecem aqui.');
      return;
    }
    $('homeLive').querySelector(':scope > .emptyLine')?.remove();
    keyed($('homeLive'), live, (f) => f.code, (f) => {
      const s = el('article', 'tile');
      const frame = el('div', 'frame');
      frame.append(el('img'), el('span', 'noThumb', 'A prévia chega em alguns segundos'), el('span', 'liveTag'));
      const row = el('div', 'screenRow');
      const who = el('div', 'who');
      who.append(el('div', 'screenName'), el('div', 'screenSub'));
      row.append(avatar(f.name, f.code), who, el('span', 'actSlot'));
      const slot = el('div', 'slot');
      slot.append(el('span', 'slotTime'), el('span', 'slotOn'));
      s.append(slot, frame, row, el('div', 'tech'));
      frame.addEventListener('dblclick', () => requestWatch(f.code));
      return s;
    }, (s, f) => {
      const info = net.links.get(f.code)?.info || {};
      const img = s.querySelector('img');
      if (info.thumb && img.getAttribute('src') !== info.thumb) img.src = info.thumb;
      img.alt = `Quadro atual da transmissão de ${friendName(f.code)}`;
      img.classList.toggle('hidden', !info.thumb);
      s.querySelector('.noThumb').classList.toggle('hidden', !!info.thumb);
      s.querySelector('.liveTag').textContent = info.since ? `Ao vivo · ${minutesSince(info.since)}` : 'Ao vivo';
      s.querySelector('.slotTime').textContent = info.since ? clock(info.since) : '—';
      s.querySelector('.slotOn').textContent = info.since ? `no ar há ${minutesSince(info.since)}` : 'no ar';
      s.querySelector('.screenName').textContent = friendName(f.code);
      s.querySelector('.screenSub').textContent = `Sala ${info.mode === 'public' ? 'pública' : 'privada'} · ${info.watchers ? `${info.watchers} assistindo` : 'ninguém assistindo'}`;
      const slot = s.querySelector('.actSlot');
      const mine = watch.code === f.code;
      const label = mine ? (watch.state === 'watching' ? 'Assistindo' : 'Cancelar') : info.mode === 'public' ? 'Assistir' : 'Pedir para assistir';
      if (slot.dataset.label !== label) {
        slot.dataset.label = label;
        slot.replaceChildren(btn(label, mine ? 'danger' : f === liveFriends()[0] ? 'primary' : '', () => {
          if (!mine) requestWatch(f.code);
          else if (watch.state === 'watching') window.go('watch');
          else leave(true);
        }));
      }
      const tech = s.querySelector('.tech');
      tech.replaceChildren(
        ...[info.res && el('b', null, info.res), info.codec && el('span', null, info.codec.replace('H264', 'H.264')),
          net.links.get(f.code)?.rtt != null && el('span', null, `ping ${net.links.get(f.code).rtt} ms`)].filter(Boolean),
      );
    });
  }

  // ---------------------------------------------------------------- outros amigos
  function stateOf(f) {
    const link = net.links.get(f.code);
    if (f.pending) return link ? 'Pedido enviado · esperando aceitar' : 'Pedido enviado · entrega quando ficar online';
    if (host.viewers.has(f.code)) return 'Assistindo você';
    if (!link) return 'Offline';
    return 'Online';
  }
  function renderOthers() {
    const others = friends.filter((f) => !net.links.get(f.code)?.info.live);
    $('homeOthersCount').textContent = others.length || '';
    if (!others.length) {
      emptyLine($('homeOthers'), friends.length ? 'Todos os seus amigos estão ao vivo.' : 'Nenhum amigo ainda.');
      return;
    }
    $('homeOthers').querySelector(':scope > .emptyLine')?.remove();
    // Online primeiro, depois quem está na sua sala, depois offline; no máximo 6
    const rank = (f) => (host.viewers.has(f.code) ? 0 : net.links.has(f.code) ? 1 : f.pending ? 2 : 3);
    const list = [...others].sort((a, b) => rank(a) - rank(b)).slice(0, 6);
    keyed($('homeOthers'), list, (f) => f.code, (f) => {
      const li = el('li');
      const who = el('div', 'who');
      who.append(el('div', 'name'), el('div', 'state'));
      li.append(avatar(f.name, f.code), who, el('span', 'code'), el('span', 'act'));
      return li;
    }, (li, f) => {
      li.querySelector('.name').textContent = friendName(f.code);
      li.querySelector('.state').textContent = stateOf(f);
      li.querySelector('.code').textContent = prettyCode(f.code);
      li.querySelector('.act').replaceChildren(host.viewers.has(f.code) ? el('span', 'tag', 'Na sua sala') : '');
      li.classList.toggle('offline', !net.links.has(f.code));
    });
  }

  // ---------------------------------------------------------------- pedidos (assistir e amizade)
  function requestItems() {
    return [
      ...prompts.map((p) => ({ kind: 'join', code: p.code, name: p.name })),
      ...[...incoming].map(([code, r]) => ({ kind: 'friend', code, name: r.name })),
    ];
  }
  function requestRow(r, withRemember) {
    const li = el('li', 'reqRow');
    const who = el('div', 'who');
    who.append(el('div', 'name', r.name),
      el('div', 'state', r.kind === 'join'
        ? `Quer assistir você · ${isFriend(r.code) ? 'amigo' : `código ${prettyCode(r.code)}`}`
        : `Quer ser seu amigo · ${prettyCode(r.code)}`));
    const actions = el('div', 'actions');
    if (r.kind === 'join') {
      if (withRemember) actions.append(btn('Sempre permitir', '', () => answerJoin(r.code, true, true)));
      actions.append(btn('Recusar', '', () => answerJoin(r.code, false)), btn('Aceitar', 'primary', () => answerJoin(r.code, true)));
    } else {
      actions.append(btn('Recusar', '', () => answerFriend(r.code, false)), btn('Aceitar', 'primary', () => answerFriend(r.code, true)));
    }
    li.append(avatar(r.name, r.code), who, actions);
    return li;
  }
  function renderRequestsCard() {
    const items = requestItems();
    $('homeReqCount').textContent = items.length || '';
    keyed($('homeRequests'), items.slice(0, 3), (r) => `${r.kind}:${r.code}`, (r) => requestRow(r, false), () => {});
    const web = document.documentElement.classList.contains('web');
    if (!items.length) emptyLine($('homeRequests'), host.stream || web ? 'Nada esperando você.' : 'Nada esperando você. Pedidos para assistir aparecem quando você está ao vivo em sala privada.');
    else $('homeRequests').querySelector(':scope > .emptyLine')?.remove();
  }
  function renderRequestsView() {
    const joins = requestItems().filter((r) => r.kind === 'join');
    $('joinReqCount').textContent = joins.length || '';
    $('friendReqCount').textContent = incoming.size || '';
    keyed($('joinRequests'), joins, (r) => r.code, (r) => requestRow(r, true), () => {});
    if (!joins.length) emptyLine($('joinRequests'), host.stream
      ? ($('roomMode').value === 'public' ? 'Sua sala é pública: quem tem seu código entra direto.' : 'Ninguém pediu para assistir.')
      : 'Você não está transmitindo. Os pedidos para assistir aparecem aqui quando estiver ao vivo em sala privada.');
    else $('joinRequests').querySelector(':scope > .emptyLine')?.remove();

    const sent = friends.filter((f) => f.pending);
    keyed($('sentRequests'), sent, (f) => f.code, (f) => {
      const li = el('li', 'reqRow');
      const who = el('div', 'who');
      who.append(el('div', 'name', f.name || prettyCode(f.code)), el('div', 'state'));
      li.append(avatar(f.name || f.code, f.code), who, el('div', 'actions'));
      li.querySelector('.actions').append(btn('Cancelar', '', () => {
        send(f.code, { t: 'friend-remove' });
        friends = friends.filter((x) => x.code !== f.code);
        saveFriends();
        renderFriends();
      }));
      return li;
    }, (li, f) => { li.querySelector('.state').textContent = stateOf(f); });
    if (!sent.length) emptyLine($('sentRequests'), 'Nenhum pedido enviado esperando resposta.');
    else $('sentRequests').querySelector(':scope > .emptyLine')?.remove();

    const total = joins.length + incoming.size;
    $('requestsFinding').textContent = total ? `${total} ${total === 1 ? 'pedido esperando' : 'pedidos esperando'} você.` : 'Nada esperando você agora.';
  }

  // ---------------------------------------------------------------- sua transmissão
  let chartKey = '';
  function uploadPerMinute() {
    // Média por minuto dos últimos 10 minutos; os eventos (quem entrou) viram anotações no minuto certo
    const byMin = new Map();
    for (const p of host.upload) {
      const m = Math.floor(p.t / 60000);
      const e = byMin.get(m) || { s: 0, n: 0 };
      e.s += p.v;
      e.n++;
      byMin.set(m, e);
    }
    const mins = [...byMin.keys()].sort((a, b) => a - b).slice(-11);
    return {
      labels: mins.map((m) => clock(m * 60000)),
      values: mins.map((m) => +(byMin.get(m).s / byMin.get(m).n).toFixed(1)),
      annotations: host.events
        .map((e) => ({ at: mins.indexOf(Math.floor(e.t / 60000)), label: e.label, short: e.label.split(' ')[0] }))
        .filter((a) => a.at >= 0)
        .filter((a, i, arr) => arr.findIndex((b) => b.at === a.at) === i),
    };
  }
  function renderMine() {
    const box = $('homeMine');
    $('homeMineAction').textContent = host.stream ? 'Ver transmissão' : 'Transmitir';
    if (!host.stream) {
      chartKey = '';
      box.replaceChildren(el('div', 'emptyLine', 'Você não está transmitindo. Escolha uma tela ou janela e comece; seus amigos veem você no Início deles.'));
      return;
    }
    if (!box.querySelector('.kpis')) {
      box.replaceChildren(el('p', 'meta mineMeta'), el('div', 'kpis'),
        Object.assign(el('div', 'chartHead'), {}), el('div', 'chart'), el('ul', 'people mineViewers'));
      box.querySelector('.chartHead').append(el('h3', null, 'Upload nos últimos 10 min'), el('span', 'meta', 'Mbps'));
    }
    const cfg = { res: $('res').value, fps: $('fps').value, codec: $('codec').value };
    const v = host.stream.getVideoTracks()[0]?.getSettings() || {};
    box.querySelector('.mineMeta').textContent =
      `Ao vivo desde ${clock(host.since)} · sala ${$('roomMode').value === 'public' ? 'pública' : 'privada'} · ${v.height || cfg.res}p${cfg.fps} ${cfg.codec.replace('H264', 'H.264')}`;
    const latencies = [...host.viewers.values()].map((x) => x.latency).filter((x) => x != null);
    const upNow = host.upload.at(-1)?.v ?? 0;
    const kpis = [
      ['Assistindo', String(host.viewers.size), ''],
      ['Upload agora', dec1(upNow), 'Mbps'],
      ['Latência', latencies.length ? String(Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)) : '—', latencies.length ? 'ms' : ''],
    ];
    box.querySelector('.kpis').replaceChildren(...kpis.map(([label, value, unit]) => {
      const k = el('div', 'kpi');
      const val = el('div', 'value', value);
      if (unit) val.append(el('span', 'unit', unit));
      k.append(el('div', 'label', label), val);
      return k;
    }));

    const data = uploadPerMinute();
    const chart = box.querySelector('.chart');
    const key = `${data.labels.join()}|${data.values.join()}|${data.annotations.length}|${document.documentElement.dataset.theme}`;
    if (data.values.length < 2) {
      chartKey = '';
      chart.replaceChildren(el('div', 'emptyLine', 'O gráfico aparece depois do primeiro minuto ao vivo.'));
    } else if (key !== chartKey) {
      chartKey = key;
      chart.replaceChildren();
      Charts.line(chart, {
        labels: data.labels,
        series: [{ name: 'Upload', values: data.values }],
        height: 160,
        format: (x) => `${dec1(x)} Mbps`,
        tickFormat: (x) => String(x),
        annotations: data.annotations,
      });
    }

    const viewers = [...host.viewers.entries()];
    keyed(box.querySelector('.mineViewers'), viewers, ([code]) => code, ([code, vw]) => {
      const li = el('li');
      const who = el('div', 'who');
      who.append(el('div', 'name', vw.name), el('div', 'state'));
      const figs = el('div', 'figs');
      figs.append(el('div', 'fig'), el('div', 'sub'));
      li.append(avatar(vw.name, code), who, figs);
      li.dataset.since = Date.now();
      return li;
    }, (li, [, vw]) => {
      li.querySelector('.state').textContent = `${vw.stats?.route || 'conectando'} · desde ${clock(+li.dataset.since)}`;
      li.querySelector('.fig').textContent = vw.stats?.mbps != null ? `${dec1(vw.stats.mbps)} Mbps` : '—';
      li.querySelector('.sub').textContent = vw.latency != null ? `${vw.latency} ms de latência` : 'medindo latência';
    });
    if (!viewers.length) emptyLine(box.querySelector('.mineViewers'), $('roomMode').value === 'public'
      ? 'Ninguém assistindo ainda. Sala pública: quem tem seu código entra direto.'
      : 'Ninguém assistindo ainda. Os pedidos para entrar aparecem em Pedidos.');
  }

  // ---------------------------------------------------------------- título, contadores, assistir
  function renderFinding() {
    const live = liveFriends().map((f) => friendName(f.code));
    const parts = [];
    parts.push(live.length ? `${names(live)} ${live.length === 1 ? 'está' : 'estão'} ao vivo.` : 'Nenhum amigo ao vivo agora.');
    if (prompts.length) parts.push(`${names(prompts.map((p) => p.name))} ${prompts.length === 1 ? 'quer' : 'querem'} assistir você.`);
    if (incoming.size) parts.push(`${names([...incoming.values()].map((r) => r.name))} ${incoming.size === 1 ? 'mandou' : 'mandaram'} pedido de amizade.`);
    if (host.stream) parts.push(`Você está ao vivo há ${minutesSince(host.since)}.`);
    if (watch.code && watch.state !== 'watching') parts.push(`Você pediu para assistir ${friendName(watch.code)}; esperando aprovação.`);
    else if (watch.state === 'watching') parts.push(`Você está assistindo ${friendName(watch.code)}.`);
    $('homeFinding').textContent = parts.join(' ');
    $('homeBackWatch').classList.toggle('hidden', watch.state !== 'watching');
    // Revista: o título vira saudação, como a abertura de uma revista
    if (document.documentElement.dataset.theme === 'editorial') {
      const h = new Date().getHours();
      const hello = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
      const name = $('myName').value.trim();
      $('homeTitle').textContent = `${hello}${name ? `, ${name}` : ''}.`;
    } else {
      $('homeTitle').textContent = 'Início';
    }
    document.documentElement.classList.toggle('isLive', !!host.stream);
    $('homeStamp').textContent = `Atualizado às ${clock(Date.now())}`;
  }
  function renderBadges() {
    const pending = prompts.length + incoming.size;
    $('requestBadge').textContent = pending;
    $('requestBadge').classList.toggle('hidden', !pending);
    $('hostBadge').classList.toggle('hidden', !host.stream);
    const online = confirmed().filter((f) => net.links.has(f.code)).length;
    $('friendsFinding').textContent = `${confirmed().length} ${confirmed().length === 1 ? 'amigo' : 'amigos'} · ${online} online · ${liveFriends().length} ao vivo. Seu código: ${prettyCode(myCode)}`;
  }
  function renderWatchWho() {
    $('watch').classList.toggle('watching', watch.state === 'watching');
    const box = $('watchWho');
    if (!watch.code) {
      box.replaceChildren(el('div', 'emptyLine', 'Você não está assistindo ninguém.'),
        Object.assign(btn('Ver quem está ao vivo', 'wide', () => window.go('home'))));
      return;
    }
    const info = net.links.get(watch.code)?.info || {};
    const who = el('div', 'who');
    who.append(el('div', 'name', friendName(watch.code)),
      el('div', 'state', watch.state === 'watching' ? `Ao vivo${info.since ? ` há ${minutesSince(info.since)}` : ''}` : watch.state === 'pending' ? 'Esperando aprovação' : 'Entrando…'));
    const row = el('div', 'watchRow');
    row.append(avatar(friendName(watch.code), watch.code), who);
    box.replaceChildren(row, btn(watch.state === 'watching' ? 'Sair da transmissão' : 'Cancelar', 'danger wide', () => leave(true)));
  }

  window.renderHome = function renderHome() {
    try {
      renderBadges();
      renderFinding();
      renderLive();
      renderOthers();
      renderRequestsCard();
      renderRequestsView();
      renderMine();
      renderWatchWho();
    } catch (err) {
      console.warn('renderHome', err);
    }
  };
  window.addEventListener('resize', () => { chartKey = ''; window.renderHome(); });
  setInterval(window.renderHome, 15000); // "há N min" e o carimbo de hora andam sozinhos
  window.renderHome();
})();
