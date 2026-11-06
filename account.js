/* Telinha · conta opcional com o Discord.
   Cada aparelho continua com o próprio código e a própria chave. Entrar com o Discord liga este aparelho à
   conta: o servidor devolve um atestado assinado ("o código X, com esta chave, é do usuário Y") e guarda a
   lista de amigos. Num aparelho novo os amigos aparecem sozinhos, e quem já conhece o Y aceita o aparelho
   novo sem perguntar. Sem entrar, nada muda. */
'use strict';

const Account = (() => {
  // Chave pública do servidor (a privada fica só na VM). Conferir o atestado aqui impede que alguém invente
  // "sou o Y" para entrar na lista dos amigos do Y
  const SERVER_PUB = { x: 'wCMK3wJeVzJAa628dkOMRjdMYDAbWysUJMm2-vF6R94', y: 'IwRPSD-SL6vfoL4HP2r-ho4uUDuWqpGM7C9VypWnP9k' };
  const api = { base: `https://${SERVER.host}`, pub: SERVER_PUB }; // os testes trocam por um servidor local
  let acct = storeJson('telinha.account'); // { d, name, token, att }
  let waiting = null; // login em andamento: { poll, timer }
  // A lista da conta só é trocada depois que este aparelho juntou a dela: senão um aparelho que acabou de abrir
  // mandaria só os amigos dele e os dos outros aparelhos sumiriam da conta
  let synced = false;
  // Amigos removidos (de qualquer jeito: pelo ×, recusa, o outro removeu) também vão para a conta; senão outro
  // aparelho, que ainda tem a pessoa, devolve ela. Removido = estava no último envio e não está mais
  let removed = new Set(storeJson('telinha.accountRemoved') || []);
  let devices = []; // aparelhos da conta (para tirar um perdido)
  let sent = new Set(storeJson('telinha.accountSent') || []);

  const signedText = (a) => new TextEncoder().encode(`telinha-acct|v1|${a.d}|${a.c}|${a.x}|${a.y}|${a.t}`);
  async function validAtt(a, code, pub) {
    if (!a || typeof a !== 'object' || !/^\d{15,22}$/.test(String(a.d)) || a.c !== code || a.x !== pub?.x || a.y !== pub?.y) return false;
    try {
      const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: api.pub.x, y: api.pub.y }, ID_ALG, false, ['verify']);
      return await crypto.subtle.verify(SIGN_ALG, key, unb64(String(a.sig)), signedText(a));
    } catch { return false; }
  }

  async function call(method, path, body) {
    const res = await fetch(`${api.base}${path}`, {
      method,
      headers: { ...(acct?.token && { Authorization: `Bearer ${acct.token}` }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    if (res.status === 401 && acct) forget('Sua conta do Discord saiu deste aparelho. Entre de novo se quiser.');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `servidor respondeu ${res.status}`);
    return res.json();
  }

  // ------------------------------------------------------------ entrar
  async function requestLogin(guilds) {
    const nonce = b64(crypto.getRandomValues(new Uint8Array(18)));
    const sig = b64(await crypto.subtle.sign(SIGN_ALG, ident.key, new TextEncoder().encode(`telinha-login|${nonce}|${myCode}`)));
    return call('POST', '/auth/start', { code: myCode, x: ident.pub.x, y: ident.pub.y, nonce, sig, guilds });
  }
  // TV: sem navegador, o link vira um QR para aprovar no celular. Devolve o link e já fica esperando a resposta
  async function startQr() {
    // Quem leu o QR anterior ainda pode estar confirmando no celular: continua perguntando por ele também
    const older = waiting?.poll;
    cancel();
    const { url, poll } = await requestLogin(false);
    if (!/^https:\/\/discord\.com\/oauth2\/authorize\?/.test(url)) throw new Error('endereço de login inesperado');
    waiting = { poll, older, until: Date.now() + 20 * 60_000 };
    check();
    return url;
  }
  // guilds: liga o "aparecer para quem está nos meus servidores" (o Discord pede essa permissão a mais)
  async function login(e, guilds = false) {
    if (waiting) return cancel();
    if (!net.peer?.open) return toast('Sem conexão com o servidor. Tente de novo em instantes.', true);
    const tab = document.documentElement.classList.contains('web') ? window.open('', '_blank') : null;
    if (tab) tab.opener = null;
    try {
      const { url, poll } = await requestLogin(guilds);
      if (!tab) await window.telinha.openLogin(url);
      else if (/^https:\/\/discord\.com\/oauth2\/authorize\?/.test(url)) tab.location.href = url;
      else throw new Error('endereço de login inesperado');
      waiting = { poll, until: Date.now() + 10 * 60_000 };
      render();
      check();
    } catch (err) {
      tab?.close();
      toast(`Não deu para entrar com o Discord: ${err.message}`, true);
    }
  }
  async function check() {
    if (!waiting) return;
    if (Date.now() > waiting.until) return cancel();
    let r = null;
    for (const poll of [waiting.poll, waiting.older]) {
      if (poll && !r?.token) try { r = await call('GET', `/auth/result?poll=${encodeURIComponent(poll)}`); } catch {}
      if (!waiting) return;
    }
    if (!r?.token) { waiting.timer = setTimeout(check, 2000); return; }
    waiting = null;
    return finish(r);
  }
  // Resposta do login (o Discord confirmou): guarda a conta, o nome e junta os amigos
  async function finish(r) {
    if (!(await validAtt(r.att, myCode, ident.pub))) return toast('O servidor mandou um atestado que não confere. Login cancelado.', true);
    acct = { d: r.d, name: r.name, token: r.token, att: r.att, discoverable: !!r.discoverable };
    storeJson('telinha.account', acct);
    if (!$('myName').value.trim() && r.name) {
      $('myName').value = r.name;
      $('myName').dispatchEvent(new Event('input'));
      $('myName').dispatchEvent(new Event('change'));
    }
    synced = true;
    devices = Array.isArray(r.devices) ? r.devices : [];
    merge(r.friends, r.removed);
    push();
    for (const [code, link] of net.links) if (link.verified) send(code, { t: 'acct', att: acct.att });
    toast(`Você entrou como ${r.name}.`);
    render();
    suggest();
  }
  function cancel() {
    clearTimeout(waiting?.timer);
    waiting = null;
    render();
  }

  // ------------------------------------------------------------ sair e apagar
  function forget(msg) {
    acct = null;
    synced = false;
    devices = [];
    removed = new Set();
    sent = new Set();
    storeJson('telinha.account', null);
    storeJson('telinha.accountRemoved', null);
    storeJson('telinha.accountSent', null);
    if (msg) toast(msg, true);
    render();
  }
  async function logout() {
    try { await call('DELETE', '/account/device'); } catch {}
    forget();
  }
  async function erase() {
    if (!confirm('Apagar do servidor a sua conta, os seus aparelhos e a sua lista de amigos? Os amigos continuam neste PC.')) return;
    try {
      await call('DELETE', '/account');
      forget();
      toast('Seus dados foram apagados do servidor.');
    } catch (err) { toast(`Não deu para apagar: ${err.message}`, true); }
  }

  // ------------------------------------------------------------ amigos
  // Amigos da conta que este aparelho ainda não tem entram como já aceitos (a amizade é da pessoa, não do aparelho)
  // Quem foi removido em outro aparelho sai daqui também
  function merge(list, gone) {
    if (Array.isArray(gone)) removed = new Set(gone.map(normalizeCode).filter(Boolean)); // a da conta vale (alguém pode ter readicionado)
    const before = friends.length;
    friends = friends.filter((f) => f.pending || !removed.has(f.code));
    let added = before - friends.length;
    for (const f of Array.isArray(list) ? list : []) {
      const code = normalizeCode(f.code);
      if (!code || code === myCode || removed.has(code) || friends.some((x) => x.code === code)) continue;
      friends.push({ code, name: String(f.name || '').slice(0, 24), ...(f.d && { d: String(f.d) }) });
      added++;
    }
    if (!added) return;
    saveFriends();
    renderFriends();
    connectFriends();
  }
  let pushTimer = 0;
  function push() {
    if (!acct || !synced) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      const list = friends.filter((f) => !f.pending).map((f) => ({ code: f.code, name: f.name || '', ...(f.d && { d: f.d }) }));
      const now = new Set(list.map((f) => f.code));
      for (const c of sent) if (!now.has(c)) removed.add(c);
      for (const c of now) removed.delete(c); // adicionou de novo
      sent = now;
      storeJson('telinha.accountSent', [...sent]);
      storeJson('telinha.accountRemoved', [...removed].slice(-500));
      call('PUT', '/account/friends', { friends: list, removed: [...removed].slice(-500) }).catch((err) => console.warn('conta: amigos', err.message));
    }, 2000);
  }

  // O outro lado mandou o atestado dele: confere e, se for um amigo meu por outro aparelho, aceita sem perguntar
  async function onAcct(code, link, msg) {
    if (!link.verified) { link.pendingAcct = msg; return; } // confere depois que a chave dele for provada
    if (!(await validAtt(msg.att, code, link.peerPub))) return;
    link.d = msg.att.d;
    const mine = friends.find((f) => f.code === code);
    if (mine && mine.d !== link.d) {
      mine.d = link.d;
      saveFriends();
    }
    adopt(code);
  }
  function adopt(code) {
    const link = net.links.get(code);
    if (!link?.d || friends.some((f) => f.code === code)) return false;
    const same = friends.find((f) => f.d === link.d && !f.pending);
    if (!same) return false;
    friends.push({ code, name: same.name, d: link.d });
    incoming.delete(code);
    saveFriends();
    send(code, { t: 'friend-accept', name: myName() });
    send(code, myStatus(code));
    renderFriends();
    return true;
  }
  // Link novo com a chave provada: mando o meu atestado e confiro o dele, se já tinha chegado
  function onVerified(code, link) {
    if (acct?.att) send(code, { t: 'acct', att: acct.att });
    if (link.pendingAcct) {
      const m = link.pendingAcct;
      link.pendingAcct = null;
      onAcct(code, link, m);
    }
  }

  // ------------------------------------------------------------ tela
  // ------------------------------------------------------------ sugestões pelos servidores do Discord
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  let people = [];
  async function suggest() {
    people = acct?.discoverable ? (await call('GET', '/account/suggestions').catch(() => ({ people: [] }))).people || [] : [];
    renderSuggest();
  }
  function renderSuggest() {
    // Quem já é amigo (por qualquer aparelho) ou já tem pedido não aparece
    const shown = people.filter((p) => !friends.some((f) => f.code === p.code || (f.d && f.d === p.d)) && p.code !== myCode);
    $('discordSuggest').classList.toggle('hidden', !shown.length);
    $('discordSuggestList').replaceChildren(...shown.map((p) => {
      const row = el('div', 'friend');
      const who = el('div', 'who');
      who.append(el('div', 'fname', p.name), el('div', 'fstatus', `${p.shared} servidor${p.shared > 1 ? 'es' : ''} em comum no Discord`));
      const b = el('button', 'btn primary', 'Adicionar');
      b.type = 'button';
      b.addEventListener('click', () => {
        $('friendCode').value = p.code;
        addFriend();
        renderSuggest();
      });
      row.append(el('span', 'fdot'), who, b);
      return row;
    }));
  }

  function render() {
    const on = !!acct;
    $('acctState').textContent = waiting ? 'Confirme no navegador: primeiro no Discord, depois o código deste aparelho…'
      : on ? `Conectado como ${acct.name} no Discord.` : 'Você não entrou com o Discord.';
    $('acctLogin').classList.toggle('hidden', on);
    $('acctLogin').textContent = waiting ? 'Cancelar' : 'Entrar com Discord';
    $('acctLogout').classList.toggle('hidden', !on);
    $('acctDelete').classList.toggle('hidden', !on);
    $('homeNameDiscord').classList.toggle('hidden', on || !!waiting);
    $('acctDiscoverRow').classList.toggle('hidden', !on);
    $('acctDiscoverNote').classList.toggle('hidden', !on);
    $('acctDiscover').checked = !!acct?.discoverable;
    // Aparelhos da conta: o perdido sai sem apagar o resto
    $('acctDevices').replaceChildren(...(on ? devices : []).map((dv) => {
      const li = document.createElement('li');
      li.textContent = `${prettyCode(dv.code)} · desde ${new Date(dv.at).toLocaleDateString('pt-BR')}`;
      if (dv.code === myCode) li.append(' · ', Object.assign(document.createElement('b'), { textContent: 'este aparelho' }));
      else {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Tirar da conta' });
        b.addEventListener('click', () => call('DELETE', `/account/device?code=${dv.code}`).then(refresh).catch((err) => toast(`Não deu: ${err.message}`, true)));
        li.append(b);
      }
      return li;
    }));
  }
  $('acctLogin').addEventListener('click', login);
  $('homeNameDiscord').addEventListener('click', login);
  $('acctLogout').addEventListener('click', logout);
  $('acctDelete').addEventListener('click', erase);
  $('acctDiscover').addEventListener('change', async (e) => {
    if (e.target.checked) {
      e.target.checked = false; // só fica marcado quando o Discord confirmar
      return login(null, true);
    }
    try {
      await call('DELETE', '/account/discoverable');
      acct.discoverable = false;
      storeJson('telinha.account', acct);
    } catch (err) { toast(`Não deu: ${err.message}`, true); }
    render();
    suggest();
  });
  render();

  // Ao abrir: atestado novo, os aparelhos e os amigos que entraram por outro aparelho
  function refresh() {
    if (!acct) return Promise.resolve();
    return call('GET', '/account').then(async (r) => {
      if (await validAtt(r.att, myCode, ident.pub)) acct.att = r.att;
      acct.name = r.name || acct.name;
      acct.discoverable = !!r.discoverable;
      storeJson('telinha.account', acct);
      synced = true;
      devices = Array.isArray(r.devices) ? r.devices : [];
      merge(r.friends, r.removed);
      push(); // amigos que este aparelho ganhou enquanto estava fora da conta
      render();
      suggest();
    }).catch((err) => console.warn('conta:', err.message));
  }
  if (acct) setTimeout(refresh, 3000);

  return { api, startQr, logout, finish, onAcct, onVerified, adopt, push, state: () => ({ ...acct, waiting: !!waiting }) };
})();
window.Account = Account;
