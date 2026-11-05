import { supabase } from '../lib/supabaseClient.js';

/**
 * Inici de GACO: economia i finances. La productivitat és a SAO.
 * Blocs: caixa i pòlisses · operacions pendents · tresoreria prevista a 90 dies ·
 * pendent de pagar per forma/mètode de pagament · dades per revisar · treballadors.
 * Dades: gaco_calendari_events, gaco_pendents_pagament i gaco_inici_operacions (vistes).
 */

const fImport = (n) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('ca-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const fData = (s) => {
  if (!s) return '—';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sumaDies = (s, k) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};
const errorCard = (nom) => `<div class="card"><p class="error">No s'ha pogut carregar ${nom}. Has executat l'SQL de les vistes d'Inici?</p></div>`;

// ---------- Dades ----------

async function carregarCaixa() {
  const [{ data: comptes, error }, { data: conds }] = await Promise.all([
    supabase.from('gaco_comptes').select('id, descripcio, tipus, num_compte').eq('actiu', true).order('tipus').order('descripcio'),
    supabase.from('gaco_polisses_condicions').select('compte_id, limit_import, data_formalitzacio').order('data_formalitzacio', { ascending: false }),
  ]);
  if (error) throw error;
  const limitPer = new Map();
  for (const c of conds ?? []) if (!limitPer.has(c.compte_id)) limitPer.set(c.compte_id, Number(c.limit_import));
  return Promise.all(
    (comptes ?? []).map(async (c) => {
      const { data } = await supabase
        .from('gaco_importacions_n43')
        .select('data_final, saldo_final, saldo_calculat')
        .eq('compte_id', c.id)
        .order('data_final', { ascending: false })
        .limit(1);
      const i = data?.[0];
      return { ...c, dataSaldo: i?.data_final ?? null, saldo: i ? Number(i.saldo_final ?? i.saldo_calculat) : null, limit: limitPer.get(c.id) ?? null };
    })
  );
}

async function carregarEvents(avui) {
  const { data, error } = await supabase
    .from('gaco_calendari_events')
    .select('data, font, descripcio, import')
    .lte('data', sumaDies(avui, 90))
    .order('data');
  if (error) throw error;
  return data ?? [];
}

async function llegeixVista(nom) {
  const { data, error } = await supabase.from(nom).select('*');
  if (error) throw error;
  return data ?? [];
}

async function carregarTreballadors() {
  const m = await import('./financament/treballadors.js');
  return m.saldoTotal ? await m.saldoTotal() : null;
}

// ---------- Blocs ----------

function htmlPolissa(c) {
  const color = (cls) => (cls === 'perill' ? 'inici-text-perill' : cls === 'avis' ? 'inici-text-avis' : '');
  let barra = '';
  let nota = '<span class="inici-sub">Límit no registrat (Finançament → Pòlisses → Condicions)</span>';
  let cls = '';
  if (c.limit) {
    const disponible = r2(c.limit + c.saldo);
    const dispost = c.saldo < 0 ? -c.saldo : 0;
    const pct = Math.min(100, (dispost / c.limit) * 100);
    cls = disponible < 0 ? 'perill' : disponible < c.limit * 0.05 ? 'avis' : '';
    nota =
      disponible < 0
        ? `<span class="inici-text-perill">Excedit de ${fImport(-disponible)} sobre el límit de ${fImport(c.limit)}</span>`
        : `<span class="${color(cls)}">Disponible ${fImport(disponible)} sobre ${fImport(c.limit)}</span>`;
    barra = `<div class="inici-bar ${cls}"><div style="width:${pct.toFixed(1)}%"></div></div>`;
  }
  return `<div>
    <div class="inici-fila"><span>${esc(c.descripcio ?? c.num_compte)} <span class="inici-sub">· ${fData(c.dataSaldo)}</span></span><strong class="${color(cls)}">${fImport(c.saldo)}</strong></div>
    ${barra}<div class="inici-sub">${nota}</div></div>`;
}

function htmlCaixa(comptes) {
  if (!comptes) return errorCard('la caixa');
  const amb = comptes.filter((c) => c.saldo !== null);
  const corrents = amb.filter((c) => c.tipus !== 'credit');
  const polisses = amb.filter((c) => c.tipus === 'credit');
  const liquid = r2(corrents.reduce((s, c) => s + c.saldo, 0));
  return `<div class="card">
    <p class="inici-etiq">Caixa</p>
    <p class="inici-gran">${fImport(liquid)}</p>
    <p class="inici-sub">líquid als comptes corrents</p>
    ${corrents.map((c) => `<div class="inici-fila"><span>${esc(c.descripcio ?? c.num_compte)} <span class="inici-sub">· ${fData(c.dataSaldo)}</span></span><strong>${fImport(c.saldo)}</strong></div>`).join('')}
    ${polisses.length ? `<p class="inici-etiq" style="margin-top:6px;">Pòlisses</p>${polisses.map(htmlPolissa).join('')}` : ''}
  </div>`;
}

function htmlOperacions(ops, pend) {
  if (!ops || !pend) return errorCard('les operacions pendents');
  const o = ops[0] ?? {};
  const v = pend.filter((p) => !p.es_nomina);
  const domiciliades = v.filter((p) => p.domiciliada_vencuda).length;
  const revisar = v.filter((p) => p.avis).length;
  const fila = (n, text, href, avis = false) =>
    `<a class="inici-op ${avis && n > 0 ? 'avis' : ''} ${n === 0 ? 'zero' : ''}" href="${href}"><b>${n}</b><span>${text}</span></a>`;
  return `<div class="card">
    <p class="inici-etiq">Operacions pendents</p>
    ${fila(domiciliades, 'factures domiciliades vençudes sense càrrec al banc', '#/documents/rebudes', true)}
    ${fila(revisar, 'despeses amb dades de pagament per revisar', '#/documents/rebudes', true)}
    ${fila(Number(o.moviments_pendents ?? 0), 'moviments pendents de conciliar', '#/moviments/conciliacio')}
    ${fila(Number(o.sense_document ?? 0), 'despeses sense document propi', '#/documents/rebudes')}
    ${fila(Number(o.sense_linies ?? 0), 'despeses sense línies', '#/documents/rebudes')}
    ${fila(Number(o.quotes_anteriors_2026 ?? 0), 'quotes de préstec anteriors al 2026 per regularitzar', '#/financament/prestecs')}
  </div>`;
}

function htmlTresoreria(events, avui, liquid) {
  if (!events) return errorCard('la tresoreria prevista');
  const d30 = sumaDies(avui, 30), d60 = sumaDies(avui, 60), d90 = sumaDies(avui, 90);
  const noms = ['Vençut', '0–30 dies', '31–60 dies', '61–90 dies'];
  const trams = noms.map(() => ({ sortides: 0, entrades: 0 }));
  for (const e of events) {
    const i = e.data < avui ? 0 : e.data <= d30 ? 1 : e.data <= d60 ? 2 : e.data <= d90 ? 3 : -1;
    if (i < 0) continue;
    const n = Number(e.import);
    if (n < 0) trams[i].sortides += n;
    else trams[i].entrades += n;
  }
  const tot = trams.reduce((a, t) => ({ sortides: a.sortides + t.sortides, entrades: a.entrades + t.entrades }), { sortides: 0, entrades: 0 });
  const fila = (nom, t, fort) =>
    `<div ${fort ? 'style="font-weight:600;"' : ''}>${nom}</div><div class="dr">${fImport(r2(t.sortides))}</div><div class="dr">${fImport(r2(t.entrades))}</div><div class="dr"><strong>${fImport(r2(t.sortides + t.entrades))}</strong></div>`;
  const grans = events.filter((e) => e.data >= avui && Number(e.import) <= -5000);
  const totalGrans = r2(grans.reduce((s, e) => s + Number(e.import), 0));
  return `<div class="card">
    <p class="inici-etiq">Tresoreria prevista</p>
    <p class="inici-sub">Només el que ja és registrat a GACO. No inclou nòmines, RLC ni 111 futurs, ni liquidacions de fruita.</p>
    <div class="inici-taula">
      <div class="cap">Tram</div><div class="cap dr">Sortides</div><div class="cap dr">Entrades</div><div class="cap dr">Net</div>
      ${trams.map((t, i) => fila(noms[i], t)).join('')}
      ${fila('A 90 dies', tot, true)}
    </div>
    ${
      grans.length
        ? `<div class="inici-gran-pag">
            <div class="inici-fila"><strong>Pagaments grans dels propers 90 dies: ${fImport(-totalGrans)} en ${grans.length}</strong><span class="inici-sub">contra ${fImport(liquid)} de líquid</span></div>
            ${grans.map((e) => `<div class="inici-fila"><span>${fData(e.data)} · ${esc(e.descripcio)}</span><span>${fImport(-Number(e.import))}</span></div>`).join('')}
          </div>`
        : ''
    }
  </div>`;
}

function etiquetaPagament(p) {
  if (!p.forma_pagament) return 'Sense indicar';
  if (p.forma_pagament === 'compte_bancari') {
    return { domiciliacio: 'Domiciliació', transferencia: 'Transferència', targeta: 'Targeta' }[p.metode_pagament_compte] ?? 'Compte bancari (sense mètode)';
  }
  return { soci: 'Soci', confirming: 'Confirming', compensacio: 'Compensació' }[p.forma_pagament] ?? p.forma_pagament;
}

function htmlPendent(pend, avui) {
  if (!pend) return errorCard('el pendent de pagament');
  const v = pend.filter((p) => !p.es_nomina);
  const total = r2(v.reduce((s, p) => s + Number(p.import_pendent), 0));
  const vencut = r2(v.filter((p) => p.data_venciment && p.data_venciment < avui).reduce((s, p) => s + Number(p.import_pendent), 0));
  const grups = new Map();
  for (const p of v) {
    const k = etiquetaPagament(p);
    const g = grups.get(k) ?? { n: 0, import: 0, vencut: 0 };
    g.n++;
    g.import += Number(p.import_pendent);
    if (p.data_venciment && p.data_venciment < avui) g.vencut += Number(p.import_pendent);
    grups.set(k, g);
  }
  const files = [...grups.entries()].sort((a, b) => b[1].import - a[1].import);
  const domic = new Map();
  for (const p of v.filter((x) => x.domiciliada_vencuda)) {
    const g = domic.get(p.proveidor) ?? { n: 0, import: 0 };
    g.n++;
    g.import += Number(p.import_pendent);
    domic.set(p.proveidor, g);
  }
  const domicFiles = [...domic.entries()].sort((a, b) => b[1].import - a[1].import).slice(0, 5);
  return `<div class="card">
    <p class="inici-etiq">Pendent de pagar</p>
    <p class="inici-gran">${fImport(total)}</p>
    <p class="inici-sub">a proveïdors (sense nòmines), dels quals ${fImport(vencut)} ja vençuts</p>
    ${files
      .map(([k, g]) => {
        const avis = k === 'Sense indicar' || k.includes('sense mètode');
        return `<div class="inici-fila ${avis ? 'inici-text-avis' : ''}"><span>${esc(k)} <span class="inici-sub">· ${g.n} ${g.n === 1 ? 'factura' : 'factures'}</span></span><strong>${fImport(r2(g.import))}</strong></div>`;
      })
      .join('')}
    ${
      domicFiles.length
        ? `<div class="inici-gran-pag" style="background:#fbebd3; border-color:#efd3a6;">
            <strong style="color:#8a5200;">Domiciliacions vençudes que no han arribat al banc</strong>
            ${domicFiles.map(([nom, g]) => `<div class="inici-fila"><span>${esc(nom)} <span class="inici-sub">· ${g.n}</span></span><span>${fImport(r2(g.import))}</span></div>`).join('')}
          </div>`
        : ''
    }
  </div>`;
}

function htmlRevisar(pend) {
  const llista = (pend ?? []).filter((p) => !p.es_nomina && p.avis);
  if (!llista.length) return '';
  return `<div class="card">
    <p class="inici-etiq">Dades per revisar</p>
    <p class="inici-sub">Despeses pendents amb dades de pagament incompletes.</p>
    ${llista.slice(0, 8).map((p) => `<div class="inici-fila"><span>${esc(p.proveidor)} · ${esc(p.num_factura ?? 's/n')}</span><span class="inici-text-avis">${esc(p.avis)}</span></div>`).join('')}
    ${llista.length > 8 ? `<p class="inici-sub">… i ${llista.length - 8} més a Factures rebudes</p>` : ''}
  </div>`;
}

function htmlTreballadors(saldo) {
  if (saldo === null || saldo === undefined) return '';
  const text = Math.abs(saldo) < 0.005 ? 'Saldat' : saldo > 0 ? `la SL els deu ${fImport(saldo)}` : `els treballadors deuen ${fImport(-saldo)}`;
  return `<div class="card">
    <p class="inici-etiq">Treballadors</p>
    <div class="inici-fila"><span>Saldo conjunt</span><strong>${text}</strong></div>
    <p><a href="#/financament/treballadors">Veure el compte per treballador →</a></p>
  </div>`;
}

// ---------- Render ----------

export async function render() {
  const contenidor = document.getElementById('app-content');
  contenidor.innerHTML = '<p>Carregant...</p>';
  const avui = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD en hora local

  const [caixa, events, pend, ops, treb] = await Promise.all([
    carregarCaixa().catch((e) => (console.error('caixa', e), null)),
    carregarEvents(avui).catch((e) => (console.error('events', e), null)),
    llegeixVista('gaco_pendents_pagament').catch((e) => (console.error('pendents', e), null)),
    llegeixVista('gaco_inici_operacions').catch((e) => (console.error('operacions', e), null)),
    carregarTreballadors().catch((e) => (console.warn('treballadors', e), null)),
  ]);

  const liquid = r2((caixa ?? []).filter((c) => c.tipus !== 'credit' && c.saldo !== null).reduce((s, c) => s + c.saldo, 0));
  const revisar = htmlRevisar(pend);
  const persones = htmlTreballadors(treb);

  contenidor.innerHTML = `
    <div class="inici-grid">${htmlCaixa(caixa)}${htmlOperacions(ops, pend)}</div>
    ${htmlTresoreria(events, avui, liquid)}
    <div class="inici-grid">${htmlPendent(pend, avui)}${revisar}${persones}</div>
  `;
}