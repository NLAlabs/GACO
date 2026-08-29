/**
 * Router minimalista basat en #hash — sense dependències.
 * Cada secció principal pot definir submenú (veure SECCIONS.moviments.subrutes).
 * Disseny àgil i lleuger: sense passos innecessaris, la ruta reflecteix
 * directament la pantalla que es veu.
 */

const SECCIONS = {
  inici: {
    label: 'Inici',
    render: () => import('./modules/inici.js').then((m) => m.render()),
  },
  moviments: {
    label: 'Moviments',
    subrutes: {
      comptes: { label: 'Comptes bancaris', modul: './modules/moviments/comptes.js' },
      n43: { label: 'Importar N43', modul: './modules/moviments/n43-import.js' },
      conciliacio: { label: 'Conciliació', modul: './modules/moviments/conciliacio.js' },
    },
    defaultSubruta: 'conciliacio', // tasca més freqüent primer
  },
  documents: {
    label: 'Documents',
    subrutes: {
      emeses: { label: 'Factures emeses', modul: './modules/documents/factures-emeses.js' },
      rebudes: { label: 'Factures rebudes', modul: './modules/documents/factures-rebudes.js' },
    },
    defaultSubruta: 'rebudes',
  },
  financament: {
    label: 'Finançament',
    subrutes: {
      prestecs: { label: 'Préstecs / leasing', modul: './modules/financament/prestecs.js' },
      polisses: { label: 'Pòlisses / confirming', modul: './modules/financament/polisses.js' },
      socis: { label: 'Compte corrent socis', modul: './modules/financament/socis.js' },
    },
    defaultSubruta: 'prestecs',
  },
  informes: {
    label: 'Informes',
    render: () => import('./modules/informes/index.js').then((m) => m.render()),
  },
  configuracio: {
    label: 'Configuració i gestió',
    nomesAdmin: true,
    subrutes: {
      usuaris: { label: 'Usuaris', modul: './modules/config/usuaris.js' },
      conceptes: { label: 'Conceptes', modul: './modules/config/conceptes.js' },
      comptes: { label: 'Comptes bancaris', modul: './modules/config/comptes-bancaris.js' },
      proveidors: { label: 'Proveïdors', modul: './modules/config/proveidors.js' },
      clients: { label: 'Clients', modul: './modules/config/clients.js' },
    },
    defaultSubruta: 'proveidors',
  },
};

export { SECCIONS };

export function parseHash() {
  const parts = (location.hash || '#/inici').replace('#/', '').split('/');
  return { seccio: parts[0] || 'inici', subruta: parts[1] || null };
}

export async function renderRoute() {
  const { seccio, subruta } = parseHash();
  const def = SECCIONS[seccio] ?? SECCIONS.inici;

  marcarNavActiva(seccio);
  renderSubNav(def, subruta);

  if (def.render) {
    await def.render();
    return;
  }

  const sub = subruta && def.subrutes[subruta] ? subruta : def.defaultSubruta;
  const modul = await import(def.subrutes[sub].modul);
  await modul.render();
}

function marcarNavActiva(seccioActiva) {
  document.querySelectorAll('#main-nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === seccioActiva);
  });
}

function renderSubNav(def, subrutaActiva) {
  const subNav = document.getElementById('sub-nav');
  subNav.innerHTML = '';
  if (!def.subrutes) return;

  const actual = subrutaActiva && def.subrutes[subrutaActiva] ? subrutaActiva : def.defaultSubruta;
  for (const [key, info] of Object.entries(def.subrutes)) {
    const a = document.createElement('a');
    a.href = `#/${Object.keys(SECCIONS).find((k) => SECCIONS[k] === def)}/${key}`;
    a.textContent = info.label;
    a.className = key === actual ? 'active' : '';
    subNav.appendChild(a);
  }
}
