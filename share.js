/* Telinha · convites e Discord. Um link https abre o app (ou o site) já entrando na transmissão; o status
   do Discord mostra um botão "Assistir" para quem está na call; um webhook avisa no canal quando você entra
   no ar e muda a mensagem quando você sai. */
'use strict';

const Share = (() => {
  const WEB = 'https://guilhermeo12.github.io/telinha/';
  const ICON = `${WEB}icons/icon-512.png`;
  const isWeb = document.documentElement.classList.contains('web');
  const phone = /Android|iPhone|iPad/i.test(navigator.userAgent) || matchMedia('(max-width: 760px)').matches;
  const inviteLink = (code = myCode) => `${WEB}?assistir=${prettyCode(code)}`;
  // Link de amizade: quem clica já manda o pedido (o outro lado ainda aceita)
  const friendLink = () => `${WEB}?amigo=${prettyCode(myCode)}`;

  // ---------------------------------------------------------------- entrar por convite
  let pending = null; // { code, timer }

  function joinInvite(raw) {
    const code = normalizeCode(raw);
    if (!code || code === myCode) return;
    go('watch');
    if (watch.code === code && watch.state) return;
    if (net.links.has(code)) {
      requestWatch(code);
      return;
    }
    clearTimeout(pending?.timer);
    pending = { code, timer: setTimeout(() => fail('Não achei essa transmissão. Ela pode ter acabado.'), 20000) };
    $('remoteEmpty').textContent = `Procurando a transmissão de ${prettyCode(code)}…`;
    setStatus('Procurando…');
    connectWhenReady(code);
  }

  function connectWhenReady(code) {
    if (pending?.code !== code) return;
    if (net.links.has(code)) return onLinkOpen(code);
    if (!net.peer?.open) return setTimeout(() => connectWhenReady(code), 400);
    if (net.attempts.has(code)) return;
    const conn = net.peer.connect(peerIdFor(code), { reliable: true, metadata: { code: myCode } });
    net.attempts.set(code, conn);
    setupLink(conn, true);
  }

  function fail(msg) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
    $('remoteEmpty').textContent = 'Escolha um amigo ao vivo no Início e clique em Assistir';
    setStatus(net.peer?.open ? 'Online' : 'Sem servidor', net.peer?.open ? 'ok' : 'bad');
    toast(msg, true);
  }

  function onLinkOpen(code) {
    if (pending?.code !== code) return;
    clearTimeout(pending.timer);
    pending = null;
    requestWatch(code);
  }

  function onUnavailable(code) {
    if (pending?.code === code) fail('Essa pessoa não está online agora.');
  }

  function befriend(raw) {
    const code = normalizeCode(raw);
    if (!code || code === myCode) return;
    go('friends');
    $('friendCode').value = code;
    addFriend();
  }

  // No navegador do PC o convite pergunta: abrir no app instalado ou ficar aqui mesmo
  function askWhere(raw, friend) {
    const code = normalizeCode(raw);
    if (!code) return;
    const modal = $('inviteModal');
    $('inviteTitle').textContent = friend ? 'Convite de amizade de' : 'Convite para assistir';
    $('inviteWho').textContent = prettyCode(code);
    $('inviteText').textContent = friend
      ? 'Tem o Telinha instalado neste PC? Ele abre já mandando o pedido de amizade. Se não, dá para adicionar aqui no navegador.'
      : 'Tem o Telinha instalado neste PC? Ele abre já entrando na transmissão. Se não, dá para assistir aqui no navegador.';
    $('inviteHere').textContent = friend ? 'Adicionar no navegador' : 'Assistir no navegador';
    modal.classList.remove('hidden');
    $('inviteApp').onclick = () => {
      location.href = `telinha://${friend ? 'amigo' : 'assistir'}/${prettyCode(code)}`;
      $('inviteAppHint').classList.remove('hidden');
    };
    $('inviteHere').onclick = () => {
      modal.classList.add('hidden');
      (friend ? befriend : joinInvite)(code);
    };
  }

  // "amigo/ABCD-EFGH" = link de amizade; só o código = convite para assistir
  function openInvite(raw, ask) {
    const friend = String(raw).startsWith('amigo/');
    const code = friend ? String(raw).slice(6) : raw;
    if (ask) askWhere(code, friend);
    else (friend ? befriend : joinInvite)(code);
  }
  (async () => {
    const raw = await window.telinha.takeInvite?.();
    if (isWeb && raw) history.replaceState(null, '', location.pathname);
    if (raw) openInvite(raw, isWeb && !phone);
  })();
  window.telinha.onInvite?.((raw) => openInvite(raw, false));

  // ---------------------------------------------------------------- copiar o convite
  async function copyInvite() {
    await window.telinha.copy(inviteLink());
    toast('Convite copiado. Cole na call ou no chat do Discord: quem clicar já entra.');
  }
  $('copyInvite').addEventListener('click', copyInvite);
  async function copyFriendLink() {
    await window.telinha.copy(friendLink());
    toast('Link de amizade copiado. Quem clicar já te manda o pedido.');
  }

  // ---------------------------------------------------------------- status do Discord
  // Application "Telinha" no Discord; o campo só serve para quem quiser usar um app próprio
  const APP_ID = '1564418586448232681';
  const appId = () => $('discordAppId').value.trim() || APP_ID;
  const presenceOn = () => $('discordPresence').checked && /^\d{15,22}$/.test(appId());

  function activity() {
    if (host.stream) {
      return {
        details: 'Transmitindo a tela',
        state: $('roomMode').value === 'public' ? 'Sala pública' : 'Sala privada: peça para entrar',
        timestamps: { start: host.since || Date.now() },
        assets: { large_image: ICON, large_text: 'Telinha' },
        buttons: [{ label: 'Assistir', url: inviteLink() }],
        instance: false,
      };
    }
    if (watch.code && watch.state === 'watching') {
      return {
        details: `Assistindo ${friendName(watch.code)}`.slice(0, 120),
        state: 'no Telinha',
        assets: { large_image: ICON, large_text: 'Telinha' },
        buttons: [{ label: 'Assistir também', url: inviteLink(watch.code) }],
        instance: false,
      };
    }
    return null;
  }

  let lastSent = '';
  function updatePresence() {
    if (isWeb) return;
    const act = presenceOn() ? activity() : null;
    // O Discord limita a ~5 mudanças a cada 20 s; só manda quando algo mudou de verdade
    const key = JSON.stringify([presenceOn() ? appId() : '', act && { ...act, timestamps: undefined }]);
    if (key === lastSent) return;
    lastSent = key;
    window.telinha.discordPresence(presenceOn() ? appId() : '', act);
  }

  const STATUS = {
    off: 'Desligado.',
    on: 'Aparecendo no seu perfil do Discord.',
    'no-discord': 'Não achei o Discord aberto neste PC. Tento de novo sozinho.',
    'bad-id': 'O Discord recusou esse ID. Confira o Application ID.',
    error: 'O Discord deu um erro ao mostrar o status.',
  };
  window.telinha.onDiscordStatus?.(({ status, detail }) => {
    $('discordStatus').textContent = status === 'off' ? idleText() : STATUS[status] || status;
    $('discordStatus').title = detail || '';
    $('discordStatus').classList.toggle('bad', ['no-discord', 'bad-id', 'error'].includes(status));
  });
  const idleText = () => {
    if ($('discordPresence').checked && !presenceOn()) return 'Esse ID não parece um Application ID (só números).';
    return presenceOn() ? 'Pronto: aparece quando você transmitir ou assistir.' : STATUS.off;
  };
  for (const id of ['discordPresence', 'discordAppId', 'roomMode']) {
    $(id).addEventListener('change', () => {
      lastSent = '';
      if (!activity() || !presenceOn()) $('discordStatus').textContent = idleText();
      updatePresence();
    });
  }
  setInterval(updatePresence, 3000);
  $('discordStatus').textContent = idleText();

  // ---------------------------------------------------------------- aviso no canal
  let post = null; // { id, url, since }
  const hook = () => $('discordWebhook').value.trim();
  // Nada de @everyone ou menções vindas do nome
  const safe = (s) => String(s).replace(/@/g, '@​').replace(/[*_`~|>]/g, '').slice(0, 60);

  function liveBody() {
    const name = safe(myName());
    const mode = $('roomMode').value === 'public' ? 'Sala pública: é só clicar.' : `Sala privada: ${name} aprova quem entra.`;
    return {
      username: 'Telinha',
      avatar_url: ICON,
      allowed_mentions: { parse: [] },
      content: `🔴 **${name}** está ao vivo no Telinha`,
      embeds: [{
        title: `Assistir ${name}`,
        url: inviteLink(),
        description: `Abre no app Telinha ou no navegador (celular também).\n${mode}`,
        color: 0x5eb8ff,
        timestamp: new Date(host.since || Date.now()).toISOString(),
      }],
    };
  }

  async function announce() {
    if (isWeb || !hook()) return;
    const res = await window.telinha.discordWebhook({ url: hook(), body: liveBody() });
    if (res.ok) post = { id: res.id, url: hook(), since: host.since };
    else toast(`Aviso no Discord falhou: ${res.error}`, true);
  }

  async function announceEnd() {
    if (!post) return;
    const { id, url, since } = post;
    post = null;
    const min = Math.max(1, Math.round((Date.now() - since) / 60000));
    await window.telinha.discordWebhook({
      url, messageId: id,
      body: { allowed_mentions: { parse: [] }, content: `⚫ **${safe(myName())}** transmitiu no Telinha por ${min} min. A transmissão terminou.`, embeds: [] },
    });
  }

  $('discordTest').addEventListener('click', async () => {
    if (!hook()) return toast('Cole a URL do webhook primeiro.', true);
    const res = await window.telinha.discordWebhook({
      url: hook(),
      body: { username: 'Telinha', avatar_url: ICON, allowed_mentions: { parse: [] }, content: `✅ Teste do Telinha: os avisos de **${safe(myName())}** vão aparecer aqui.` },
    });
    toast(res.ok ? 'Mensagem de teste enviada para o canal.' : `Não deu: ${res.error}`, !res.ok);
  });

  // Sessão marcada: avisa no canal, se houver webhook
  async function announceSession(session, when) {
    if (!hook()) return;
    const res = await window.telinha.discordWebhook({
      url: hook(),
      body: { username: 'Telinha', avatar_url: ICON, allowed_mentions: { parse: [] }, content: `📅 **${safe(myName())}** marcou uma sessão: ${when}${session.title ? ` · ${safe(session.title)}` : ''}\n${inviteLink()}` },
    });
    if (!res.ok) toast(`Não deu para avisar no canal: ${res.error}`, true);
  }

  // Chamado pelo app.js quando a transmissão começa ou para
  function onLive(live) {
    if (live) announce();
    else announceEnd();
    lastSent = '';
    updatePresence();
  }

  return { joinInvite, onLinkOpen, onUnavailable, onLive, inviteLink, updatePresence, friendLink, copyFriendLink, openInvite, announceSession };
})();
window.Share = Share;
