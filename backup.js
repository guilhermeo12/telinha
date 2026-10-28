/* global $, toast, StickerDB, MiniZip */
/* Telinha · backup dos seus dados num .zip: código de amigo, chave de identidade, amigos, quem pode entrar sem
   perguntar, configurações e as suas figurinhas. Serve para trocar de PC ou formatar sem perder nada: com a
   mesma chave, os amigos continuam reconhecendo você. Fica de fora o que é segredo de outro serviço (webhook do
   Discord e senha do TURN próprio). */
'use strict';

const Backup = (() => {
  const DATA = 'telinha-dados.json';
  const SECRET = ['telinha.discordWebhook', 'telinha.turnPass'];
  const keys = () => Object.keys(localStorage).filter((k) => k.startsWith('telinha.') && !SECRET.includes(k));
  const extOf = (mime) => (/webp/.test(mime) ? 'webp' : /png/.test(mime) ? 'png' : 'gif');

  async function exportAll() {
    const data = {};
    for (const k of keys()) data[k] = localStorage.getItem(k);
    const enc = new TextEncoder();
    const files = [{ name: DATA, bytes: enc.encode(JSON.stringify({ app: 'telinha', version: 1, at: new Date().toISOString(), data }, null, 1)) }];
    const stickers = await StickerDB.list('collection').catch(() => []);
    for (const s of stickers) files.push({ name: `figurinhas/${s.id}.${extOf(s.mime)}`, bytes: new Uint8Array(await s.blob.arrayBuffer()) });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([MiniZip.build(files)], { type: 'application/zip' }));
    a.download = `telinha-meus-dados-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`Backup salvo: dados e ${stickers.length} figurinha(s). Guarde como uma senha: ele tem a sua chave.`);
  }

  async function importFrom(file) {
    let entries;
    try { entries = await MiniZip.read(new Uint8Array(await file.arrayBuffer()), { maxFiles: 3000 }); } catch {
      return toast('Esse arquivo não é um backup do Telinha.', true);
    }
    const json = entries.find((e) => e.name === DATA);
    let parsed = null;
    try { parsed = JSON.parse(new TextDecoder().decode(json?.bytes)); } catch {}
    if (parsed?.app !== 'telinha' || !parsed.data || typeof parsed.data !== 'object') return toast('Esse arquivo não é um backup do Telinha.', true);
    // Só chaves do Telinha, só texto, nada de segredo de outro serviço
    const data = Object.entries(parsed.data).filter(([k, v]) => k.startsWith('telinha.') && !SECRET.includes(k) && typeof v === 'string' && v.length < 2_000_000);
    const code = String(parsed.data['telinha.myCode'] || '');
    if (!confirm(`Trocar os dados deste aparelho pelos do backup${code ? ` (código ${code.slice(0, 4)}-${code.slice(4)})` : ''}? O código, os amigos e as configurações atuais serão substituídos. O app recarrega em seguida.`)) return;
    for (const k of keys()) localStorage.removeItem(k);
    for (const [k, v] of data) localStorage.setItem(k, v);
    let added = 0;
    for (const e of entries) {
      if (!e.name.match(/\.(webp|png|gif)$/i)) continue;
      const rec = await StickerDB.prepare(e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength), { source: 'backup' });
      if (rec && (await StickerDB.addToCollection(rec)).added) added++;
    }
    toast(`Backup restaurado (${added} figurinha(s) nova(s)). Recarregando…`);
    setTimeout(() => location.reload(), 900);
  }

  $('backupExport').addEventListener('click', () => exportAll().catch((err) => toast(`Não deu para salvar o backup: ${err.message}`, true)));
  $('backupImport').addEventListener('click', () => $('backupFile').click());
  $('backupFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFrom(f).catch((err) => toast(`Não deu para restaurar: ${err.message}`, true));
  });

  return { exportAll, importFrom };
})();
window.Backup = Backup;
