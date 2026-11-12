/* Telinha · novidades: as notas de cada versão, geradas de scripts/notes/ (notes-data.js). */
'use strict';

const Notes = (() => {
  const HOME_ITEMS = 3;

  function block(note, limit = Infinity) {
    const box = document.createElement('div');
    box.className = 'noteBlock';
    const title = document.createElement('b');
    title.textContent = `Versão ${note.version}`;
    const list = document.createElement('ul');
    list.className = 'noteItems';
    for (const text of note.items.slice(0, limit)) {
      const li = document.createElement('li');
      li.textContent = text;
      list.append(li);
    }
    box.append(title, list);
    return box;
  }

  function show(notes) {
    $('homeNotes').replaceChildren(block(notes[0], HOME_ITEMS));
    $('notesList').replaceChildren(...notes.map((n) => block(n)));
  }
  show(window.TELINHA_NOTES);
  return { show };
})();
window.Notes = Notes;
