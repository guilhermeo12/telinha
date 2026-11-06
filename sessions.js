/* Telinha · sessão marcada: "sexta às 21h". Vai direto para os amigos, junto com o status de cada um, sem servidor:
   quem está online recebe na hora, os outros quando os dois se encontrarem online, e cada um guarda o que recebeu.
   Cinco minutos antes, o Telinha avisa. Só amigos recebem. */
'use strict';

const Sessions = (() => {
  const MAX_AHEAD = 90 * 24 * 3600 * 1000; // até 90 dias à frente
  const GONE_AFTER = 3600 * 1000; // some 1 h depois do horário
  const REMIND = 5 * 60 * 1000;
  const load = () => storeJson('telinha.sessions') || {};
  let all = load(); // código -> { at, title, name }
  let mine = storeJson('telinha.mySession'); // { at, title }

  const clean = (s) => {
    const at = Number(s?.at);
    if (!Number.isFinite(at) || at < Date.now() - GONE_AFTER || at > Date.now() + MAX_AHEAD) return null;
    return { at, title: String(s.title || '').slice(0, 60) };
  };
  const when = (at) => new Date(at).toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  // O que vai no status para este contato
  function outgoing(code) {
    if (!isFriend(code)) return undefined;
    return clean(mine) || undefined;
  }
  // O status de um amigo trouxe (ou deixou de trazer) a sessão dele
  function onStatus(code, msg) {
    if (!isFriend(code)) return;
    const next = clean(msg.next);
    const had = all[code];
    // "reminded" fica guardado para o aviso não repetir ao reabrir; horário novo avisa de novo
    if (next) all[code] = { ...next, name: String(msg.name || '').slice(0, 24), ...(had?.at === next.at && had.reminded && { reminded: true }) };
    else delete all[code];
    if (JSON.stringify(had) !== JSON.stringify(all[code])) {
      storeJson('telinha.sessions', all);
      render();
    }
  }

  function mark() {
    const at = new Date($('sessionAt').value).getTime();
    const title = $('sessionTitle').value.trim().slice(0, 60);
    if (!Number.isFinite(at)) return toast('Escolha o dia e a hora.', true);
    if (at <= Date.now()) return toast('Escolha um horário no futuro.', true);
    if (at > Date.now() + MAX_AHEAD) return toast('Dá para marcar até 90 dias à frente.', true);
    mine = { at, title };
    storeJson('telinha.mySession', mine);
    broadcastStatus();
    window.Share?.announceSession?.(mine, when(at));
    $('sessionAt').value = '';
    $('sessionTitle').value = '';
    toast('Sessão marcada. Seus amigos online já veem.');
    render();
  }
  function cancel() {
    mine = null;
    storeJson('telinha.mySession', null);
    broadcastStatus();
    render();
  }

  function render() {
    const list = $('sessionList');
    const items = [];
    if (clean(mine)) items.push({ ...mine, who: 'Você', own: true });
    for (const [code, s] of Object.entries(all)) if (clean(s) && isFriend(code)) items.push({ ...s, who: friendName(code) });
    items.sort((a, b) => a.at - b.at);
    list.replaceChildren(...items.map((s) => {
      const li = document.createElement('li');
      li.className = 'sessionItem';
      const text = document.createElement('div');
      const top = document.createElement('b');
      top.textContent = s.title ? `${s.who}: ${s.title}` : s.who;
      const date = document.createElement('div');
      date.className = 'muted small';
      date.textContent = when(s.at);
      text.append(top, date);
      li.append(text);
      if (s.own) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.type = 'button';
        b.textContent = 'Cancelar';
        b.addEventListener('click', cancel);
        li.append(b);
      }
      return li;
    }));
    $('sessionEmpty').classList.toggle('hidden', !!items.length);
  }

  // Limpa as que passaram e avisa 5 minutos antes (uma vez por sessão)
  function tick(now = Date.now()) {
    let changed = false;
    for (const [code, s] of Object.entries(all)) {
      if (!clean(s) || !isFriend(code)) {
        delete all[code];
        changed = true;
        continue;
      }
      if (s.at - now <= REMIND && s.at > now && !s.reminded) {
        s.reminded = true;
        changed = true;
        const text = `${friendName(code)} marcou para daqui a pouco${s.title ? `: ${s.title}` : ''}.`;
        toast(text);
        if ($('notifyLive').checked) window.telinha.notify?.({ title: 'Sessão no Telinha', body: text });
      }
    }
    if (changed) storeJson('telinha.sessions', all);
    if (mine && !clean(mine)) cancel();
    else if (changed) render();
  }

  $('sessionForm').addEventListener('submit', (e) => { e.preventDefault(); mark(); });
  setInterval(tick, 30000);
  tick();
  render();
  return { outgoing, onStatus, render, tick, state: () => ({ all, mine }) };
})();
window.Sessions = Sessions;
