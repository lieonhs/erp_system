/* ERP RPA — Finance, Purchasing, Logistik untuk usaha pemotongan ayam (multi unit usaha)
 * Semua laporan dihitung ulang dari transaksi (event-sourced):
 *   GR (penerimaan) -> stok masuk + hutang
 *   PRD (pemotongan) -> ayam hidup & bahan pembantu keluar, produk masuk (biaya dialokasi per nilai jual)
 *   INV (penjualan) -> stok keluar (HPP rata-rata bergerak) + piutang
 *   KAS -> pembayaran/penerimaan/biaya ; JV -> jurnal umum
 */
'use strict';

// ---------- util ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = (n, d = 2) => (n || 0).toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: d });
const rp = n => { const v = Math.round(n || 0); return (v < 0 ? '-Rp ' : 'Rp ') + Math.abs(v).toLocaleString('id-ID'); };
const pct = n => isFinite(n) ? fmt(n * 100, 1) + '%' : '-';
const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE');
const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
const nowIso = () => new Date().toISOString();

function toast(msg, err) {
  const d = document.createElement('div'); d.textContent = msg; if (err) d.className = 'err';
  $('#toast').appendChild(d); setTimeout(() => d.remove(), err ? 6000 : 2800);
}

// ---------- Bagan akun (COA) default ----------
const COA_DEFAULT = [
  ['1101', 'Kas', 'asset', true], ['1102', 'Bank', 'asset', true],
  ['1201', 'Piutang Usaha', 'asset'], ['1202', 'Uang Muka / Piutang Lain', 'asset'],
  ['1301', 'Persediaan Ayam Hidup', 'asset'], ['1302', 'Persediaan Produk Jadi', 'asset'], ['1303', 'Persediaan Bahan Pembantu', 'asset'], ['1304', 'Barang Terkirim Belum Ditagih', 'asset'],
  ['1501', 'Aset Tetap (Mesin, Kendaraan, Bangunan)', 'asset'], ['1502', 'Akumulasi Penyusutan', 'asset'],
  ['2101', 'Hutang Usaha', 'liability'], ['2102', 'Hutang Gaji / Lain-lain', 'liability'], ['2201', 'Hutang Bank', 'liability'],
  ['3101', 'Modal Pemilik', 'equity'], ['3201', 'Prive', 'equity'], ['3301', 'Laba Ditahan', 'equity'],
  ['4101', 'Penjualan', 'revenue'], ['4102', 'Pendapatan Lain-lain', 'revenue'], ['4103', 'Laba Pelepasan Aset Tetap', 'revenue'],
  ['5101', 'Harga Pokok Penjualan', 'expense'], ['5102', 'Selisih / Susut Persediaan', 'expense'], ['5103', 'Kerugian Penurunan Nilai Persediaan', 'expense'],
  ['5201', 'Overhead Produksi (aktual)', 'expense'], ['5202', 'Overhead Produksi Dibebankan', 'expense'],
  ['6101', 'Gaji & Upah', 'expense'], ['6102', 'Listrik & Air', 'expense'], ['6103', 'BBM & Transportasi', 'expense'],
  ['6104', 'Sewa', 'expense'], ['6105', 'Pemeliharaan & Perbaikan', 'expense'], ['6106', 'Beban Penyusutan', 'expense'], ['6108', 'Rugi Pelepasan Aset Tetap', 'expense'],
  ['6107', 'Perizinan, Sertifikasi & Retribusi', 'expense'], ['6199', 'Beban Lain-lain', 'expense'],
];
const TYPE_LABEL = { asset: 'Aset', liability: 'Kewajiban', equity: 'Ekuitas', revenue: 'Pendapatan', expense: 'Beban' };
const CAT_LABEL = { live: 'Ayam hidup / bahan baku', product: 'Produk utama', byproduct: 'Produk sampingan', supplies: 'Bahan pembantu', other: 'Lainnya' };
const INV_ACC = { live: '1301', product: '1302', byproduct: '1302', supplies: '1303', other: '1303' };
const CASH_CAT = {
  ap_payment: 'Bayar hutang supplier', ar_receipt: 'Terima piutang customer', expense: 'Biaya / pengeluaran',
  income: 'Pendapatan lain', capital: 'Setoran modal', drawing: 'Prive (ambil pribadi)', transfer: 'Transfer antar kas/bank',
};
const DELIV = { pending: ['Belum dikirim', 'b-warn'], shipped: ['Dalam perjalanan', 'b-info'], delivered: ['Terkirim', 'b-ok'] };

// ---------- Penyimpanan ----------
const LS_KEY = 'erp_rpa_records_v1';
const Store = {
  mode: 'local', token: '', needAuth: false, mem: null,
  lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } },
  lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  async init() {
    this.token = this.lsGet('erp_token') || '';
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (j && j.app === 'erp-rpa') { this.mode = 'cloud'; this.needAuth = j.needAuth; } }
    } catch {}
  },
  async req(method, path, body) {
    const r = await fetch('/api' + path, {
      method, headers: { 'content-type': 'application/json', 'x-app-token': this.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { const e = new Error('Butuh token akses'); e.auth = true; throw e; }
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  },
  localAll() {
    if (this.mem) return this.mem;
    let arr = [];
    try { arr = JSON.parse(this.lsGet(LS_KEY) || '[]'); } catch {}
    this.mem = arr; return arr;
  },
  localPersist() { this.lsSet(LS_KEY, JSON.stringify(this.mem)); },
  async all() {
    if (this.mode === 'cloud') return (await this.req('GET', '/records')).records;
    return this.localAll().filter(r => !r.deleted);
  },
  async save(rec) {
    if (this.mode === 'cloud') return (await this.req('POST', '/records', rec)).record;
    const all = this.localAll();
    checkLock(rec.kind, rec.date);
    const t = nowIso();
    const i = rec.id ? all.findIndex(r => r.id === rec.id) : -1;
    if (i >= 0) checkLock(all[i].kind, all[i].date);
    const out = { ...rec, id: rec.id || uid(), updated_at: t, created_at: i >= 0 ? all[i].created_at : t };
    if (!out.no && PREFIX[out.kind]) out.no = localNextNo(out.kind, out.date);
    if (i >= 0) all[i] = out; else all.push(out);
    this.localPersist(); return out;
  },
  async del(id) {
    if (this.mode === 'cloud') return this.req('DELETE', '/records/' + encodeURIComponent(id));
    const all = this.localAll(); const r = all.find(x => x.id === id);
    if (r) { checkLock(r.kind, r.date); r.deleted = 1; this.localPersist(); }
  },
  async importAll(list) {
    if (this.mode === 'cloud') return this.req('POST', '/import', { records: list });
    const all = this.localAll();
    for (const r of list) { const i = all.findIndex(x => x.id === r.id); if (i >= 0) all[i] = r; else all.push(r); }
    this.localPersist();
  },
};
const PREFIX = { po: 'PO', gr: 'GR', prod: 'PRD', adj: 'ADJ', do: 'DO', so: 'INV', cash: 'KAS', jv: 'JV' };
const DATED = new Set(['po', 'gr', 'prod', 'adj', 'do', 'so', 'cash', 'jv', 'asset']);
function localNextNo(kind, date) {
  const ym = (date || localDate()).slice(2, 7).replace('-', '');
  const pre = `${PREFIX[kind]}-${ym}-`;
  let max = 0;
  for (const r of Store.localAll()) if (r.kind === kind && r.no && r.no.startsWith(pre)) max = Math.max(max, parseInt(r.no.slice(pre.length), 10) || 0);
  return pre + String(max + 1).padStart(4, '0');
}
function lockDate() { const s = S.recs.find(r => r.id === 'setting-lock'); return s && s.data.lock_date || ''; }
function checkLock(kind, date) {
  const l = lockDate();
  if (DATED.has(kind) && l && date && date <= l) throw new Error(`Periode sampai ${l} sudah dikunci (tutup buku).`);
}

// ---------- State ----------
const S = { recs: [], map: new Map(), unit: 'all', from: '', to: '', E: null, tab: {} };
const K = k => S.recs.filter(r => r.kind === k);
const byId = id => S.map.get(id);
const doIdsOf = inv => (inv.data.dos || []).map(x => x.do_id).filter(Boolean);
const invoiceOfDO = doId => S.recs.find(r => r.kind === 'so' && doIdsOf(r).includes(doId));
function nextCode(kind, prefix, extra = []) {
  let max = 0; const re = new RegExp('^' + prefix + '-(\\d+)$');
  for (const c of K(kind).map(r => r.data.code).concat(extra)) { const m = re.exec(c || ''); if (m) max = Math.max(max, +m[1]); }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
const nm = id => { const r = byId(id); return r ? (r.data.name || r.data.plate || r.no || '') : '-'; };
const inUnit = r => S.unit === 'all' || r.unit_id === S.unit;
const inPeriod = r => (!S.from || r.date >= S.from) && (!S.to || r.date <= S.to);
const docs = k => K(k).filter(r => inUnit(r) && inPeriod(r)).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.no || '').localeCompare(a.no || ''));
const items = (cat) => K('item').filter(i => !cat || [].concat(cat).includes(i.data.category)).sort((a, b) => (a.data.code || a.data.name).localeCompare(b.data.code || b.data.name));
const partners = type => K('partner').filter(p => !type || p.data.type === type || p.data.type === 'both').sort((a, b) => a.data.name.localeCompare(b.data.name));
function accounts() {
  const m = new Map(COA_DEFAULT.map(([code, name, type, cash]) => [code, { code, name, type, cash: !!cash }]));
  for (const a of K('account')) m.set(a.data.code, { code: a.data.code, name: a.data.name, type: a.data.type, cash: !!a.data.cash, id: a.id });
  return [...m.values()].sort((a, b) => a.code.localeCompare(b.code));
}
const accName = c => (accounts().find(a => a.code === c) || { name: c }).name;
const accType = c => (accounts().find(a => a.code === c) || {}).type;
const units = () => K('unit').sort((a, b) => a.data.name.localeCompare(b.data.name));
const defaultUnit = () => (S.unit !== 'all' ? S.unit : (units()[0] || {}).id);

async function reload() {
  S.recs = await Store.all();
  S.map = new Map(S.recs.map(r => [r.id, r]));
  if (!units().length) {
    // Unit usaha pertama dibuat otomatis
    const u = await Store.save({ kind: 'unit', data: { name: 'Pemotongan Ayam', code: 'RPA', desc: 'Rumah potong ayam' } });
    S.recs.push(u); S.map.set(u.id, u);
  }
  S.E = engine();
}

// ---------- Penyusutan aset tetap (garis lurus, mulai bulan setelah perolehan) ----------
const monthEnd = (y, m) => localDate(new Date(y, m + 1, 0));
function depSchedule(a) {
  const d = a.data; const base = num(d.cost) - num(d.residual) - num(d.opening_accum); const life = num(d.life_months);
  const rows = []; let total = 0;
  if (life > 0 && base > 0 && a.date) {
    const monthly = r2((num(d.cost) - num(d.residual)) / life);
    const cap = (() => { const t = new Date(); return monthEnd(t.getFullYear(), t.getMonth()); })();
    let [y, m] = a.date.split('-').map(Number); m = m - 1;
    for (let i = 0; i < 1200 && total < base - 0.005; i++) {
      m++; if (m > 11) { m = 0; y++; }
      const me = monthEnd(y, m);
      if (me > cap) break;
      if (d.dispose_date && me >= monthEnd(+d.dispose_date.slice(0, 4), +d.dispose_date.slice(5, 7) - 1)) break;
      const amt = r2(Math.min(monthly, base - total)); total = r2(total + amt); rows.push({ date: me, amt });
    }
    return { monthly, rows, total, base };
  }
  return { monthly: 0, rows, total: 0, base };
}

// ---------- ENGINE: stok, HPP, jurnal ----------
function engine() {
  const order = { gr: 0, prod: 1, do: 2, so: 3, adj: 4 };
  const ev = S.recs.filter(r => r.kind in order).sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || order[a.kind] - order[b.kind] || (a.created_at || '').localeCompare(b.created_at || ''));
  const stock = new Map(); // unit|item -> {qty, ekor, value}
  const moves = [];
  const cost = {};
  const warnings = [];
  const itemCat = id => (byId(id) || { data: {} }).data.category || 'other';
  const st = (u, i) => { const k = u + '|' + i; if (!stock.has(k)) stock.set(k, { unit: u, item: i, qty: 0, ekor: 0, value: 0 }); return stock.get(k); };
  const move = (r, u, i, qty, ekor, value) => {
    const s = st(u, i);
    s.qty = r2(s.qty + qty); s.ekor += ekor; s.value = r2(s.value + value);
    if (Math.abs(s.qty) < 1e-6) { if (Math.abs(s.value) < 1) s.value = 0; }
    moves.push({ date: r.date, doc: r, unit: u, item: i, qty, ekor, value, balQty: s.qty, balEkor: s.ekor, balValue: s.value });
  };
  const out = (r, u, i, qty, ekor) => {
    const s = st(u, i);
    const avg = s.qty > 0 ? s.value / s.qty : 0;
    if (qty > s.qty + 1e-6) warnings.push(`${r.no || r.kind} ${r.date}: stok ${nm(i)} kurang (tersedia ${fmt(s.qty)}, dipakai ${fmt(qty)})`);
    const val = s.qty > 0 && qty >= s.qty - 1e-6 ? s.value : r2(avg * qty);
    move(r, u, i, -qty, -(ekor || 0), -val);
    return val;
  };

  for (const r of ev) {
    const d = r.data, u = r.unit_id;
    if (r.kind === 'gr') {
      let total = 0; const lines = [];
      for (const l of d.lines || []) {
        if (!l.item_id) continue;
        const basisKg = d.pay_basis === 'farm' ? num(l.kg_farm) : num(l.kg);
        const amount = r2(basisKg * num(l.price));
        total += amount; lines.push({ item: l.item_id, amount });
        move(r, u, l.item_id, num(l.kg), num(l.ekor), amount);
      }
      cost[r.id] = { total: r2(total), lines };
    } else if (r.kind === 'prod') {
      let liveCost = 0, supCost = 0; const consumed = [];
      for (const l of d.input || []) { if (!l.item_id) continue; const v = out(r, u, l.item_id, num(l.kg), num(l.ekor)); liveCost += v; consumed.push({ item: l.item_id, value: v }); }
      for (const l of d.supplies || []) { if (!l.item_id) continue; const v = out(r, u, l.item_id, num(l.qty), 0); supCost += v; consumed.push({ item: l.item_id, value: v }); }
      const overhead = num(d.overhead);
      const total = r2(liveCost + supCost + overhead);
      const outs = (d.outputs || []).filter(l => l.item_id && num(l.kg) > 0);
      const w = outs.map(l => num(l.kg) * num((byId(l.item_id) || { data: {} }).data.price));
      let sw = w.reduce((a, b) => a + b, 0);
      const useKg = sw <= 0; if (useKg) sw = outs.reduce((a, l) => a + num(l.kg), 0);
      const shares = outs.map((l, i) => sw > 0 ? (useKg ? num(l.kg) : w[i]) / sw : 0);
      const big = shares.indexOf(Math.max(...shares, 0));
      const vals = shares.map(s => r2(total * s));
      if (outs.length) vals[big] = r2(vals[big] + total - vals.reduce((a, b) => a + b, 0));
      const outVals = [];
      outs.forEach((l, i) => { outVals.push({ item: l.item_id, kg: num(l.kg), value: vals[i] }); move(r, u, l.item_id, num(l.kg), 0, vals[i]); });
      const inKg = (d.input || []).reduce((a, l) => a + num(l.kg), 0);
      const inEkor = (d.input || []).reduce((a, l) => a + num(l.ekor), 0);
      const outKg = outs.reduce((a, l) => a + num(l.kg), 0);
      const mainKg = outs.filter(l => itemCat(l.item_id) === 'product').reduce((a, l) => a + num(l.kg), 0);
      cost[r.id] = { liveCost: r2(liveCost), supCost: r2(supCost), overhead, total, outVals, consumed, inKg, inEkor, outKg, mainKg,
        yieldAll: inKg ? outKg / inKg : NaN, yieldMain: inKg ? mainKg / inKg : NaN, costPerKgMain: mainKg ? outVals.filter(o => itemCat(o.item) === 'product').reduce((a, o) => a + o.value, 0) / mainKg : NaN };
    } else if (r.kind === 'adj') {
      const lines = [];
      for (const l of d.lines || []) {
        if (!l.item_id) continue; const s = st(u, l.item_id);
        const hasAct = l.kg_actual !== null && l.kg_actual !== undefined && l.kg_actual !== '';
        const diff = hasAct ? r2(num(l.kg_actual) - s.qty) : -num(l.kg_out);
        if (diff < 0) { const v = out(r, u, l.item_id, -diff, 0); lines.push({ item: l.item_id, type: 'loss', qty: diff, value: v }); }
        else if (diff > 0) { const avg = s.qty > 0 ? s.value / s.qty : 0; const v = r2(avg * diff); move(r, u, l.item_id, diff, 0, v); lines.push({ item: l.item_id, type: 'gain', qty: diff, value: v }); }
        const hasEk = l.ekor_actual !== null && l.ekor_actual !== undefined && l.ekor_actual !== '';
        if (hasEk && num(l.ekor_actual) !== s.ekor) move(r, u, l.item_id, 0, num(l.ekor_actual) - s.ekor, 0);
        const wd = Math.min(num(l.writedown), Math.max(s.value, 0));
        if (wd > 0) { move(r, u, l.item_id, 0, 0, -wd); lines.push({ item: l.item_id, type: 'wd', qty: 0, value: r2(wd) }); }
      }
      cost[r.id] = { lines, loss: r2(lines.filter(x => x.type === 'loss').reduce((a, x) => a + x.value, 0)), gain: r2(lines.filter(x => x.type === 'gain').reduce((a, x) => a + x.value, 0)), wd: r2(lines.filter(x => x.type === 'wd').reduce((a, x) => a + x.value, 0)) };
    } else if (r.kind === 'do') {
      let cogs = 0; const lines = [];
      for (const l of d.lines || []) { if (!l.item_id) continue; const v = out(r, u, l.item_id, num(l.kg), num(l.ekor)); cogs += v; lines.push({ item: l.item_id, cogs: v }); }
      cost[r.id] = { cogs: r2(cogs), lines };
    } else if (r.kind === 'so') {
      const viaDO = doIdsOf(r).length > 0;
      let cogs = 0, total = 0; const lines = [];
      for (const l of d.lines || []) {
        if (!l.item_id) continue;
        const v = viaDO ? 0 : out(r, u, l.item_id, num(l.kg), num(l.ekor));
        const amt = r2(num(l.kg) * num(l.price));
        cogs += v; total += amt; lines.push({ item: l.item_id, cogs: v, amount: amt });
      }
      const disc = num(d.discount);
      cost[r.id] = { cogs: r2(cogs), gross: r2(total), total: r2(total - disc), discount: disc, lines, viaDO };
    }
  }
  // Invoice dari DO: HPP = biaya barang yang dikirim di DO terkait
  for (const r of S.recs) if (r.kind === 'so' && cost[r.id] && cost[r.id].viaDO)
    cost[r.id].cogs = r2(doIdsOf(r).reduce((a, id) => a + ((cost[id] || {}).cogs || 0), 0));

  // ---- Jurnal (GL) ----
  const gl = [];
  const J = (r, acc, debit, credit, memo, partner) => {
    debit = r2(debit); credit = r2(credit);
    if (!debit && !credit) return;
    gl.push({ date: r.date, unit: r.unit_id, doc: r, acc, debit, credit, memo: memo || '', partner: partner || null });
  };
  const ia = id => INV_ACC[itemCat(id)] || '1303';
  for (const r of S.recs) {
    const d = r.data, c = cost[r.id];
    if (r.kind === 'gr' && c) {
      for (const l of c.lines) J(r, ia(l.item), l.amount, 0, 'Penerimaan ' + nm(l.item));
      J(r, '2101', 0, c.total, 'Hutang ke ' + nm(d.partner_id), d.partner_id);
    } else if (r.kind === 'prod' && c) {
      for (const o of c.outVals) J(r, ia(o.item), o.value, 0, 'Hasil potong ' + nm(o.item));
      for (const x of c.consumed) J(r, ia(x.item), 0, x.value, 'Pemakaian ' + nm(x.item));
      J(r, '5202', 0, c.overhead, 'Overhead dibebankan ke produksi');
    } else if (r.kind === 'do' && c) {
      J(r, '1304', c.cogs, 0, 'Dikirim ke ' + nm(d.partner_id));
      for (const l of c.lines) J(r, ia(l.item), 0, l.cogs, 'Keluar ' + nm(l.item));
    } else if (r.kind === 'so' && c) {
      J(r, '1201', c.total, 0, 'Piutang ' + nm(d.partner_id), d.partner_id);
      J(r, '4101', 0, c.gross, 'Penjualan');
      if (c.discount) J(r, '4101', c.discount, 0, 'Potongan penjualan');
      if (c.viaDO) { J(r, '5101', c.cogs, 0, 'HPP dari DO'); J(r, '1304', 0, c.cogs, 'DO ditagih'); }
      else for (const l of c.lines) { J(r, '5101', l.cogs, 0, 'HPP ' + nm(l.item)); J(r, ia(l.item), 0, l.cogs, 'Keluar ' + nm(l.item)); }
    } else if (r.kind === 'adj' && c) {
      for (const l of c.lines) {
        if (l.type === 'loss') { J(r, '5102', l.value, 0, 'Susut/selisih ' + nm(l.item)); J(r, ia(l.item), 0, l.value, 'Penyesuaian ' + nm(l.item)); }
        if (l.type === 'gain') { J(r, ia(l.item), l.value, 0, 'Lebih hasil opname ' + nm(l.item)); J(r, '5102', 0, l.value, 'Selisih lebih ' + nm(l.item)); }
        if (l.type === 'wd') { J(r, '5103', l.value, 0, 'Penurunan nilai ' + nm(l.item)); J(r, ia(l.item), 0, l.value, 'Penurunan nilai ' + nm(l.item)); }
      }
    } else if (r.kind === 'asset') {
      const sch = depSchedule(r); cost[r.id] = sch;
      const cst = num(d.cost), open = num(d.opening_accum), fund = d.funding || '1102';
      if (fund !== 'none') { J(r, '1501', cst, 0, 'Perolehan ' + d.name); if (open) J(r, '1502', 0, open, 'Akumulasi awal ' + d.name); J(r, fund, 0, cst - open, 'Perolehan ' + d.name); }
      for (const x of sch.rows) { const pd = { id: r.id, kind: 'dep', no: `DEP-${d.code || ''}-${x.date.slice(2, 7).replace('-', '')}`, date: x.date, unit_id: r.unit_id, data: {} };
        J(pd, '6106', x.amt, 0, 'Penyusutan ' + d.name); J(pd, '1502', 0, x.amt, 'Penyusutan ' + d.name); }
      if (d.dispose_date) {
        const pd = { id: r.id, kind: 'dispose', no: `DSP-${d.code || ''}`, date: d.dispose_date, unit_id: r.unit_id, data: {} };
        const acc = open + sch.total, book = cst - acc, sale = num(d.sale_price), gl2 = sale - book;
        J(pd, d.sale_account || '1101', sale, 0, 'Penjualan aset ' + d.name); J(pd, '1502', acc, 0, 'Hapus akumulasi ' + d.name); J(pd, '1501', 0, cst, 'Hapus aset ' + d.name);
        if (gl2 > 0) J(pd, '4103', 0, gl2, 'Laba pelepasan ' + d.name); else if (gl2 < 0) J(pd, '6108', -gl2, 0, 'Rugi pelepasan ' + d.name);
      }
    } else if (r.kind === 'cash') {
      const a = num(d.amount), cashAcc = d.account || '1101', memo = d.note || CASH_CAT[d.category];
      switch (d.category) {
        case 'ap_payment': J(r, '2101', a, 0, memo, d.partner_id); J(r, cashAcc, 0, a, memo); break;
        case 'ar_receipt': J(r, cashAcc, a, 0, memo); J(r, '1201', 0, a, memo, d.partner_id); break;
        case 'expense': J(r, d.counter || '6199', a, 0, memo, d.partner_id); J(r, cashAcc, 0, a, memo); break;
        case 'income': J(r, cashAcc, a, 0, memo); J(r, d.counter || '4102', 0, a, memo, d.partner_id); break;
        case 'capital': J(r, cashAcc, a, 0, memo); J(r, '3101', 0, a, memo); break;
        case 'drawing': J(r, '3201', a, 0, memo); J(r, cashAcc, 0, a, memo); break;
        case 'transfer': J(r, d.to_account || '1102', a, 0, memo); J(r, cashAcc, 0, a, memo); break;
      }
    } else if (r.kind === 'jv') {
      for (const l of d.lines || []) if (l.account) J(r, l.account, num(l.debit), num(l.credit), l.memo || d.note, l.partner_id || null);
    }
  }
  gl.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.doc.no || '').localeCompare(b.doc.no || ''));
  return { stock, moves, cost, gl, warnings };
}

// ---- helper laporan ----
const glF = (f) => S.E.gl.filter(l => (S.unit === 'all' || l.unit === S.unit) && (!f || f(l)));
function balances(toDate, fromDate) {
  const m = {};
  for (const l of glF(l => (!toDate || l.date <= toDate) && (!fromDate || l.date >= fromDate))) {
    m[l.acc] = m[l.acc] || { d: 0, c: 0 }; m[l.acc].d += l.debit; m[l.acc].c += l.credit;
  }
  return m;
}
const natural = (acc, b) => ['asset', 'expense'].includes(accType(acc)) ? b.d - b.c : b.c - b.d;
function partnerBalance(pid, acc, toDate) {
  let bal = 0;
  for (const l of glF(l => l.acc === acc && l.partner === pid && (!toDate || l.date <= toDate))) bal += acc === '1201' ? l.debit - l.credit : l.credit - l.debit;
  return r2(bal);
}
function aging(pid, kind, acc) {
  // FIFO: pembayaran melunasi dokumen tertua dulu
  const ds = K(kind).filter(r => r.data.partner_id === pid && inUnit(r)).sort((a, b) => a.date.localeCompare(b.date));
  let paid = 0;
  for (const l of glF(l => l.acc === acc && l.partner === pid)) {
    if (l.doc.kind === kind) continue;
    paid += acc === '1201' ? l.credit - l.debit : l.debit - l.credit;
  }
  const open = [];
  for (const r of ds) {
    const amt = (S.E.cost[r.id] || {}).total || 0;
    const use = Math.min(paid, amt); paid -= use;
    const rest = r2(amt - use);
    if (rest > 0.5) open.push({ r, amt, rest, due: r.data.due_date || addDays(r.date, num((byId(pid) || { data: {} }).data.terms)) });
  }
  return open;
}
function bucket(due) {
  const od = daysBetween(due, localDate());
  if (od <= 0) return 0; if (od <= 30) return 1; if (od <= 60) return 2; return 3;
}

// ---------- Form builder ----------
let FORM = null;
function opt(list, val, blank = '— pilih —') {
  return (blank !== null ? `<option value="">${esc(blank)}</option>` : '') + list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(val ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
}
function inputHtml(f, val, name) {
  const v = val ?? f.def ?? '';
  const attrs = `name="${name}" ${f.req ? 'required' : ''} ${f.ro ? 'readonly' : ''} data-k="${f.k}"`;
  if (f.type === 'select') return `<select ${attrs}>${opt(typeof f.options === 'function' ? f.options() : f.options, v, f.blank === undefined ? '— pilih —' : f.blank)}</select>`;
  if (f.type === 'textarea') return `<textarea ${attrs}>${esc(v)}</textarea>`;
  if (f.type === 'checkbox') return `<input type="checkbox" ${attrs} ${v ? 'checked' : ''}>`;
  return `<input type="${f.type || 'text'}" ${f.type === 'number' ? 'step="any"' : ''} value="${esc(v)}" ${attrs} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''}>`;
}
function rowHtml(t, row = {}) {
  return `<tr data-line="${t.k}">${t.cols.map(c => `<td style="${c.w ? 'width:' + c.w : ''}">${c.calc ? `<span data-calc="${c.k}"></span>` : inputHtml(c, row[c.k], 'l:' + c.k)}</td>`).join('')}<td style="width:30px"><button type="button" class="ghost sm" data-del-line>✕</button></td></tr>`;
}
function openForm(cfg) {
  FORM = cfg;
  const rec = cfg.rec || { data: {} };
  const d = { ...(cfg.defaults || {}), ...rec.data, date: rec.date || (cfg.defaults || {}).date, unit_id: rec.unit_id || (cfg.defaults || {}).unit_id };
  const fields = cfg.fields.map(f => `<label class="${f.wide ? 'wide' : ''}">${esc(f.label)}${f.req ? ' *' : ''}${inputHtml(f, d[f.k], 'f:' + f.k)}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`).join('');
  const tables = (cfg.tables || []).map(t => {
    const rows = (d[t.k] && d[t.k].length ? d[t.k] : [{}]);
    return `<div class="lines"><h4>${esc(t.label)}</h4><div class="tbl-wrap"><table><thead><tr>${t.cols.map(c => `<th class="${c.type === 'number' || c.calc ? 'n' : ''}">${esc(c.label)}</th>`).join('')}<th></th></tr></thead>
      <tbody data-tbody="${t.k}">${rows.map(r => rowHtml(t, r)).join('')}</tbody></table></div>
      <button type="button" class="ghost sm" data-add-line="${t.k}" style="margin-top:6px">+ Tambah baris</button></div>`;
  }).join('');
  $('#modalBox').innerHTML = `<h2>${esc(cfg.title)}${rec.no ? ' — ' + esc(rec.no) : ''}</h2>
    <form id="frm" autocomplete="off"><div class="fgrid">${fields}</div>${tables}
    <div class="summary" id="frmSum" ${cfg.calc ? '' : 'hidden'}></div>
    <div class="actions">${rec.id && cfg.canDelete !== false ? '<button type="button" class="danger" id="frmDel">Hapus</button>' : ''}<span style="flex:1"></span>
    ${cfg.extraBtn || ''}<button type="button" class="ghost" id="frmCancel">Batal</button><button type="submit" id="frmSave">Simpan</button></div></form>`;
  $('#modal').classList.remove('hidden');
  const frm = $('#frm');
  frm.addEventListener('input', e => onFormChange(e));
  frm.addEventListener('change', e => onFormChange(e));
  frm.addEventListener('click', e => {
    const add = e.target.closest('[data-add-line]');
    if (add) { const t = cfg.tables.find(x => x.k === add.dataset.addLine); $(`[data-tbody="${t.k}"]`).insertAdjacentHTML('beforeend', rowHtml(t)); recalc(); }
    if (e.target.closest('[data-del-line]')) { e.target.closest('tr').remove(); recalc(); }
  });
  $('#frmCancel').onclick = closeModal;
  if ($('#frmDel')) $('#frmDel').onclick = () => askConfirm(`Hapus ${rec.no || rec.data.name || 'data'} ini?`, async () => {
    try { await Store.del(rec.id); toast('Dihapus'); closeModal(); await refresh(); } catch (e) { handleErr(e); }
  });
  frm.addEventListener('submit', async e => {
    e.preventDefault();
    const data = readForm();
    if (cfg.validate) { const msg = cfg.validate(data); if (msg) return toast(msg, true); }
    const { date, unit_id, ...rest } = data;
    const out = { ...rec, kind: cfg.kind, date: ('date' in data) ? (date || null) : (rec.date || null), unit_id: ('unit_id' in data) ? (unit_id || null) : (rec.unit_id || null), data: { ...rest } };
    if (cfg.status) out.status = cfg.status(out);
    $('#frmSave').disabled = true;
    try { await Store.save(out); toast('Tersimpan'); closeModal(); await refresh(); }
    catch (err) { handleErr(err); $('#frmSave').disabled = false; }
  });
  if (cfg.onOpen) cfg.onOpen(frm);
  recalc();
}
function readForm() {
  const frm = $('#frm'); const data = {};
  for (const f of FORM.fields) {
    const el = frm.elements['f:' + f.k]; if (!el) continue;
    data[f.k] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? num(el.value) : el.value;
  }
  for (const t of FORM.tables || []) {
    data[t.k] = $$(`[data-line="${t.k}"]`, frm).map(tr => {
      const o = {};
      for (const c of t.cols) { if (c.calc) continue; const el = tr.querySelector(`[name="l:${c.k}"]`); o[c.k] = c.type === 'number' ? (c.nullable && el.value.trim() === '' ? null : num(el.value)) : el.value; }
      return o;
    }).filter(o => Object.entries(o).some(([k, v]) => v !== '' && v !== 0 && v !== null));
  }
  return data;
}
function setRows(tk, rows) {
  const t = FORM.tables.find(x => x.k === tk);
  $(`[data-tbody="${tk}"]`).innerHTML = (rows.length ? rows : [{}]).map(r => rowHtml(t, r)).join('');
  recalc();
}
function onFormChange(e) {
  const el = e.target; const k = el.dataset.k;
  if (e.type === 'change' && k) {
    const tr = el.closest('tr[data-line]');
    if (tr) { const t = FORM.tables.find(x => x.k === tr.dataset.line); const c = t.cols.find(c => c.k === k); if (c && c.onChange) c.onChange(tr, el.value); }
    else { const f = FORM.fields.find(f => f.k === k); if (f && f.onChange) f.onChange(el.value); }
  }
  recalc();
}
function recalc() {
  if (!FORM) return;
  const frm = $('#frm'); if (!frm) return;
  for (const t of FORM.tables || []) for (const tr of $$(`[data-line="${t.k}"]`, frm)) {
    const row = {}; for (const c of t.cols) if (!c.calc) { const el = tr.querySelector(`[name="l:${c.k}"]`); row[c.k] = c.type === 'number' ? num(el.value) : el.value; }
    for (const c of t.cols) if (c.calc) tr.querySelector(`[data-calc="${c.k}"]`).textContent = c.calc(row, readFormHead());
  }
  if (FORM.calc) $('#frmSum').innerHTML = FORM.calc(readForm());
}
function readFormHead() { const o = {}; for (const f of FORM.fields) { const el = $('#frm').elements['f:' + f.k]; if (el) o[f.k] = f.type === 'number' ? num(el.value) : el.value; } return o; }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; FORM = null; }
function askConfirm(msg, yes) {
  FORM = null;
  $('#modalBox').innerHTML = `<h2>Konfirmasi</h2><p>${esc(msg)}</p><div class="actions"><button class="ghost" id="cNo">Batal</button><button class="danger" id="cYes">Ya, lanjutkan</button></div>`;
  $('#modal').classList.remove('hidden');
  $('#cNo').onclick = closeModal; $('#cYes').onclick = () => { closeModal(); yes(); };
}
function handleErr(e) { if (e.auth) return askToken(); toast(e.message || String(e), true); }

// ---------- opsi umum ----------
const unitOpts = () => units().map(u => [u.id, u.data.name]);
const itemOpts = cat => () => items(cat).map(i => [i.id, `${i.data.code ? i.data.code + ' · ' : ''}${i.data.name} (${i.data.uom || 'kg'})`]);
const partnerOpts = t => () => partners(t).map(p => [p.id, `${p.data.code ? p.data.code + ' · ' : ''}${p.data.name}${p.data.active === false ? ' (nonaktif)' : ''}`]);
const accOpts = (f) => () => accounts().filter(a => !f || f(a)).map(a => [a.code, `${a.code} · ${a.name}`]);
const cashAccOpts = accOpts(a => a.cash);
const unitField = () => ({ k: 'unit_id', label: 'Unit usaha', type: 'select', options: unitOpts, req: true, def: defaultUnit(), blank: null });

// ---------- Halaman ----------
const NAV = [
  ['Ringkasan', [['dashboard', 'Dashboard'], ['analisis', 'Analisis Kinerja & Modal']]],
  ['Purchasing', [['po', 'Purchase Order'], ['gr', 'Penerimaan Barang'], ['supplier', 'Kinerja Supplier']]],
  ['Logistik', [['prod', 'Pemotongan / Produksi'], ['stok', 'Stok Persediaan'], ['kartu', 'Kartu Stok'], ['adj', 'Stok Opname & Penyesuaian'], ['kirim', 'Pengiriman'], ['armada', 'Armada & Driver']]],
  ['Penjualan', [['do', 'Delivery Order / Surat Jalan'], ['so', 'Invoice Penjualan']]],
  ['Finance', [['kas', 'Kas & Bank'], ['hutang', 'Hutang Supplier'], ['piutang', 'Piutang Customer'], ['aset', 'Aset Tetap & Penyusutan'], ['jv', 'Jurnal Umum'], ['ledger', 'Buku Besar'], ['lapkeu', 'Laporan Keuangan']]],
  ['Master', [['barang', 'Barang & Produk'], ['vendor', 'Vendor / Supplier'], ['customer', 'Customer'], ['unit', 'Unit Usaha'], ['akun', 'Bagan Akun'], ['setting', 'Pengaturan & Backup']]],
];
const PAGES = {};
const FORMS = {};
const TITLES = Object.fromEntries(NAV.flatMap(g => g[1]));

function renderNav() {
  const cur = location.hash.slice(1) || 'dashboard';
  $('#nav').innerHTML = NAV.map(([g, list]) => `<div class="grp">${g}</div>` + list.map(([k, l]) => `<a href="#${k}" class="${k === cur ? 'active' : ''}">${l}</a>`).join('')).join('');
}
function renderFilters() {
  $('#unitSel').innerHTML = `<option value="all">Semua unit</option>` + opt(unitOpts(), S.unit, null);
  $('#unitSel').value = S.unit;
  $('#fromSel').value = S.from; $('#toSel').value = S.to;
}
function render() {
  const cur = location.hash.slice(1) || 'dashboard';
  const page = PAGES[cur] ? cur : 'dashboard';
  renderNav(); renderFilters();
  $('#pageTitle').textContent = TITLES[page];
  try { $('#view').innerHTML = PAGES[page](); } catch (e) { console.error(e); $('#view').innerHTML = `<div class="alert">Gagal menampilkan halaman: ${esc(e.message)}</div>`; }
  $('#side').classList.remove('open');
}
async function refresh() { await reload(); render(); }

const table = (head, rows, opts = {}) => `<div class="tbl-wrap"><table ${opts.id ? `id="${opts.id}"` : ''}><thead><tr>${head.map(h => { const [l, n] = [].concat(h); return `<th class="${n ? 'n' : ''}">${esc(l)}</th>`; }).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="empty">${opts.empty || 'Belum ada data'}</td></tr>`}</tbody></table></div>`;
const td = (v, n) => `<td class="${n ? 'n' : ''}">${v}</td>`;
const badge = (t, c) => `<span class="badge ${c || ''}">${esc(t)}</span>`;
const exportBtn = id => `<button class="ghost" data-export="${id}">Export CSV</button>`;
const periodTxt = () => `${S.from || 'awal'} s/d ${S.to || 'sekarang'}`;

// ---- Dashboard ----
PAGES.dashboard = () => {
  const E = S.E;
  const inP = l => (!S.from || l.date >= S.from) && (!S.to || l.date <= S.to);
  const b = balances(S.to, S.from);
  const sum = (pfx, nat) => Object.entries(b).filter(([a]) => a.startsWith(pfx)).reduce((s, [a, v]) => s + (nat ? natural(a, v) : 0), 0);
  const sales = sum('41', 1), rev = sum('4', 1), cogs = sum('5', 1), opex = sum('6', 1);
  const all = balances(S.to);
  const bal = codes => codes.reduce((s, c) => s + (all[c] ? natural(c, all[c]) : 0), 0);
  const cash = accounts().filter(a => a.cash).reduce((s, a) => s + (all[a.code] ? natural(a.code, all[a.code]) : 0), 0);
  const prods = docs('prod'); const pc = prods.map(p => E.cost[p.id]).filter(Boolean);
  const inKg = pc.reduce((a, c) => a + c.inKg, 0), mainKg = pc.reduce((a, c) => a + c.mainKg, 0), outKg = pc.reduce((a, c) => a + c.outKg, 0);
  const grs = docs('gr'); let kgF = 0, kgR = 0, ek = 0, dead = 0;
  for (const g of grs) for (const l of g.data.lines || []) { if (num(l.kg_farm) > 0) { kgF += num(l.kg_farm); kgR += num(l.kg); } ek += num(l.ekor) + num(l.dead); dead += num(l.dead); }
  const invVal = [...E.stock.values()].filter(s => S.unit === 'all' || s.unit === S.unit).reduce((a, s) => a + s.value, 0);
  // grafik 14 hari terakhir
  const end = S.to || localDate(); const days = [...Array(14)].map((_, i) => addDays(end, i - 13));
  const sd = days.map(d => glF(l => l.date === d && l.acc === '4101').reduce((a, l) => a + l.credit - l.debit, 0));
  const pd = days.map(d => glF(l => l.date === d && l.doc.kind === 'gr' && l.acc === '2101').reduce((a, l) => a + l.credit, 0));
  const mx = Math.max(1, ...sd, ...pd);
  const pending = K('do').filter(r => inUnit(r) && (r.data.delivery_status || 'pending') !== 'delivered');
  const unbilled = K('do').filter(r => inUnit(r) && !invoiceOfDO(r.id));
  const openPO = K('po').filter(r => inUnit(r) && poStatus(r)[0] !== 'Selesai' && r.data.status !== 'cancel');
  const ar = bal(['1201']), ap = bal(['2101']);
  const warn = E.warnings.length ? `<div class="alert"><b>Perhatian stok:</b><br>${E.warnings.slice(0, 5).map(esc).join('<br>')}${E.warnings.length > 5 ? `<br>…dan ${E.warnings.length - 5} lainnya` : ''}</div>` : '';
  return `${warn}<div class="kpis">
    <div class="kpi"><small>Penjualan (${periodTxt()})</small><b>${rp(sales)}</b></div>
    <div class="kpi"><small>Laba kotor</small><b class="${sales - cogs < 0 ? 'neg' : ''}">${rp(sales - cogs)}</b><em>margin ${pct(sales ? (sales - cogs) / sales : NaN)}</em></div>
    <div class="kpi"><small>Laba bersih</small><b class="${rev - cogs - opex < 0 ? 'neg' : ''}">${rp(rev - cogs - opex)}</b></div>
    <div class="kpi"><small>Saldo kas & bank</small><b>${rp(cash)}</b></div>
    <div class="kpi"><small>Piutang customer</small><b>${rp(ar)}</b></div>
    <div class="kpi"><small>Hutang supplier</small><b>${rp(ap)}</b></div>
    <div class="kpi"><small>Nilai persediaan</small><b>${rp(invVal)}</b></div>
    <div class="kpi"><small>Rendemen karkas</small><b>${pct(inKg ? mainKg / inKg : NaN)}</b><em>total output ${pct(inKg ? outKg / inKg : NaN)} · ${fmt(inKg)} kg dipotong</em></div>
    <div class="kpi"><small>Susut timbang (kandang→RPA)</small><b>${pct(kgF ? (kgF - kgR) / kgF : NaN)}</b><em>mati ${pct(ek ? dead / ek : NaN)} dari ${fmt(ek, 0)} ekor</em></div>
  </div>
  <div class="grid2">
    <div class="card"><h3>14 hari terakhir</h3><div class="barchart">${days.map((d, i) => `<div title="${d} penjualan ${rp(sd[i])}" style="height:${sd[i] / mx * 100}%"></div><div class="p" title="${d} pembelian ${rp(pd[i])}" style="height:${pd[i] / mx * 100}%"></div>`).join('')}</div>
      <div class="legend"><i style="background:var(--brand)"></i>Penjualan <i style="background:#94a3b8"></i>Pembelian · ${days[0]} s/d ${days[13]}</div></div>
    <div class="card"><h3>Perlu ditindaklanjuti</h3>
      ${table(['Item', ['Jumlah', 1]], [
        `<tr class="click" data-go="kirim"><td>Pengiriman belum selesai</td>${td(pending.length, 1)}</tr>`,
        `<tr class="click" data-go="do"><td>DO belum dibuatkan invoice</td>${td(unbilled.length ? unbilled.length + ' DO · ' + fmt(unbilled.reduce((a, r) => a + (r.data.lines || []).reduce((x, l) => x + num(l.kg), 0), 0)) + ' kg' : 0, 1)}</tr>`,
        `<tr class="click" data-go="po"><td>PO masih terbuka</td>${td(openPO.length, 1)}</tr>`,
        `<tr class="click" data-go="piutang"><td>Piutang lewat jatuh tempo</td>${td(rp(partners('customer').flatMap(p => aging(p.id, 'so', '1201')).filter(o => bucket(o.due) > 0).reduce((a, o) => a + o.rest, 0)), 1)}</tr>`,
        `<tr class="click" data-go="hutang"><td>Hutang lewat jatuh tempo</td>${td(rp(partners('supplier').flatMap(p => aging(p.id, 'gr', '2101')).filter(o => bucket(o.due) > 0).reduce((a, o) => a + o.rest, 0)), 1)}</tr>`,
      ])}
      ${!K('item').length ? `<p class="note">Belum ada data barang. Buka <a href="#setting">Pengaturan</a> → "Isi master contoh RPA" untuk mulai cepat.</p>` : ''}
    </div>
  </div>`;
};

// ---- Purchase Order ----
function poReceived(po) {
  const rec = {};
  for (const g of K('gr').filter(g => g.data.po_id === po.id)) for (const l of g.data.lines || []) rec[l.item_id] = (rec[l.item_id] || 0) + num(l.kg_farm || l.kg);
  return rec;
}
function poStatus(po) {
  if (po.data.status === 'cancel') return ['Batal', 'b-bad'];
  const rec = poReceived(po); const lines = po.data.lines || [];
  const ord = lines.reduce((a, l) => a + num(l.kg), 0), got = lines.reduce((a, l) => a + Math.min(num(l.kg), rec[l.item_id] || 0), 0);
  if (!got) return ['Terbuka', 'b-info'];
  if (got >= ord * 0.97) return ['Selesai', 'b-ok'];
  return ['Sebagian', 'b-warn'];
}
const poTotal = po => (po.data.lines || []).reduce((a, l) => a + num(l.kg) * num(l.price), 0);
PAGES.po = () => `<div class="bar"><button data-new="po">+ Purchase Order</button><span class="sp"></span>${exportBtn('t-po')}</div>` +
  table(['No', 'Tanggal', 'Unit', 'Supplier', 'Kirim', ['Ekor', 1], ['Kg', 1], ['Nilai', 1], 'Status'], docs('po').map(r => {
    const [s, c] = poStatus(r); const L = r.data.lines || [];
    return `<tr class="click" data-edit="${r.id}"><td>${esc(r.no)}</td><td>${r.date}</td><td>${esc(nm(r.unit_id))}</td><td>${esc(nm(r.data.partner_id))}</td><td>${esc(r.data.delivery_date || '')}</td>${td(fmt(L.reduce((a, l) => a + num(l.ekor), 0), 0), 1)}${td(fmt(L.reduce((a, l) => a + num(l.kg), 0)), 1)}${td(rp(poTotal(r)), 1)}<td>${badge(s, c)}</td></tr>`;
  }), { id: 't-po' });
FORMS.po = rec => openForm({
  kind: 'po', title: 'Purchase Order', rec, defaults: { date: localDate(), unit_id: defaultUnit() },
  fields: [
    { k: 'date', label: 'Tanggal PO', type: 'date', req: true }, unitField(),
    { k: 'partner_id', label: 'Supplier / Peternak', type: 'select', options: partnerOpts('supplier'), req: true },
    { k: 'delivery_date', label: 'Tanggal kirim / panen', type: 'date' },
    { k: 'status', label: 'Status', type: 'select', options: [['', 'Aktif'], ['cancel', 'Batal']], blank: null },
    { k: 'note', label: 'Catatan', type: 'textarea', wide: true },
  ],
  tables: [{ k: 'lines', label: 'Barang dipesan', cols: [
    { k: 'item_id', label: 'Barang', type: 'select', options: itemOpts(), w: '34%' },
    { k: 'ekor', label: 'Ekor', type: 'number' }, { k: 'kg', label: 'Kg / Qty', type: 'number' },
    { k: 'price', label: 'Harga / kg (Rp)', type: 'number' },
    { k: 'sub', label: 'Subtotal', calc: r => rp(num(r.kg) * num(r.price)) },
  ] }],
  calc: d => { const L = d.lines || []; const kg = L.reduce((a, l) => a + l.kg, 0), ek = L.reduce((a, l) => a + l.ekor, 0); return `Total: <b>${rp(L.reduce((a, l) => a + l.kg * l.price, 0))}</b> · ${fmt(ek, 0)} ekor · ${fmt(kg)} kg${ek ? ` · rata-rata ${fmt(kg / ek, 3)} kg/ekor` : ''}`; },
  validate: d => !(d.lines || []).length ? 'Isi minimal satu baris barang' : null,
});

// ---- Penerimaan Barang (GR) ----
PAGES.gr = () => `<div class="bar"><button data-new="gr">+ Penerimaan</button><span class="sp"></span>${exportBtn('t-gr')}</div>` +
  table(['No', 'Tanggal', 'Supplier', 'PO', ['Ekor terima', 1], ['Mati', 1], ['Kg kandang', 1], ['Kg terima', 1], ['Susut', 1], ['Nilai', 1], 'Jatuh tempo', 'Cetak'], docs('gr').map(r => {
    const L = r.data.lines || []; const kf = L.reduce((a, l) => a + num(l.kg_farm), 0), kr = L.reduce((a, l) => a + num(l.kg), 0);
    return `<tr class="click" data-edit="${r.id}"><td>${esc(r.no)}</td><td>${r.date}</td><td>${esc(nm(r.data.partner_id))}</td><td>${esc(r.data.po_id ? (byId(r.data.po_id) || {}).no || '' : '')}</td>${td(fmt(L.reduce((a, l) => a + num(l.ekor), 0), 0), 1)}${td(fmt(L.reduce((a, l) => a + num(l.dead), 0), 0), 1)}${td(fmt(kf), 1)}${td(fmt(kr), 1)}${td(kf ? pct((kf - kr) / kf) : '-', 1)}${td(rp((S.E.cost[r.id] || {}).total), 1)}<td>${esc(r.data.due_date || '')}</td><td><button class="ghost sm" onclick="printBTB('${r.id}',false)">Bukti masuk</button></td></tr>`;
  }), { id: 't-gr' }) + `<p class="note">Nilai hutang dihitung dari kg sesuai <i>dasar bayar</i> di tiap penerimaan (timbang kandang atau timbang RPA). Susut & ayam mati masuk ke biaya persediaan.</p>`;
FORMS.gr = rec => openForm({
  kind: 'gr', title: 'Penerimaan Barang', rec, defaults: { date: localDate(), unit_id: defaultUnit(), pay_basis: 'farm' },
  fields: [
    { k: 'date', label: 'Tanggal terima', type: 'date', req: true }, unitField(),
    { k: 'po_id', label: 'Dari PO (opsional)', type: 'select', options: () => K('po').filter(p => p.data.status !== 'cancel' && (poStatus(p)[0] !== 'Selesai' || (rec && rec.data.po_id === p.id))).map(p => [p.id, `${p.no} · ${nm(p.data.partner_id)}`]),
      onChange: v => { const po = byId(v); if (!po) return; $('#frm').elements['f:partner_id'].value = po.data.partner_id; $('#frm').elements['f:unit_id'].value = po.unit_id;
        $('#frm').elements['f:partner_id'].dispatchEvent(new Event('change', { bubbles: true }));
        setRows('lines', (po.data.lines || []).map(l => ({ item_id: l.item_id, ekor_farm: l.ekor, kg_farm: l.kg, price: l.price }))); } },
    { k: 'partner_id', label: 'Supplier', type: 'select', options: partnerOpts('supplier'), req: true,
      onChange: v => { const p = byId(v); const el = $('#frm').elements['f:due_date']; if (p && num(p.data.terms) && !el.value) el.value = addDays($('#frm').elements['f:date'].value || localDate(), num(p.data.terms)); } },
    { k: 'pay_basis', label: 'Dasar bayar', type: 'select', options: [['farm', 'Timbang kandang (kg kirim)'], ['received', 'Timbang RPA (kg terima)']], blank: null },
    { k: 'due_date', label: 'Jatuh tempo bayar', type: 'date' },
    { k: 'vehicle', label: 'Kendaraan (plat)', type: 'text' },
    { k: 'driver', label: 'Nama sopir', type: 'text' },
    { k: 'arrive_time', label: 'Jam tiba', type: 'time' },
    { k: 'ref_doc', label: 'No. DO / surat jalan supplier', type: 'text' },
    { k: 'checker', label: 'Diperiksa oleh (gudang/QC)', type: 'text' },
    { k: 'note', label: 'Catatan', type: 'textarea', wide: true },
  ],
  extraBtn: rec ? `<button type="button" class="ghost" onclick="printBTB('${rec.id}',false)">Cetak Bukti Barang Masuk</button><button type="button" class="ghost" onclick="printBTB('${rec.id}',true)">+ harga</button>` : '',
  tables: [{ k: 'lines', label: 'Rincian timbang', cols: [
    { k: 'item_id', label: 'Barang', type: 'select', options: itemOpts(), w: '24%' },
    { k: 'koli', label: 'Keranjang/koli', type: 'number' },
    { k: 'ekor_farm', label: 'Ekor kirim', type: 'number' }, { k: 'kg_farm', label: 'Kg kandang', type: 'number' },
    { k: 'ekor', label: 'Ekor hidup diterima', type: 'number' }, { k: 'dead', label: 'Mati (DOA)', type: 'number' },
    { k: 'kg', label: 'Kg terima (RPA)', type: 'number' }, { k: 'price', label: 'Harga/kg', type: 'number' },
    { k: 'susut', label: 'Susut', calc: r => r.kg_farm ? pct((r.kg_farm - r.kg) / r.kg_farm) : '-' },
  ] }],
  calc: d => {
    const L = d.lines || []; const basis = d.pay_basis === 'farm' ? 'kg_farm' : 'kg';
    const tot = L.reduce((a, l) => a + num(l[basis]) * num(l.price), 0), kr = L.reduce((a, l) => a + l.kg, 0), kf = L.reduce((a, l) => a + l.kg_farm, 0);
    const ek = L.reduce((a, l) => a + l.ekor, 0), dead = L.reduce((a, l) => a + l.dead, 0), ef = L.reduce((a, l) => a + l.ekor_farm, 0);
    const chk = ef && Math.abs(ef - ek - dead) > 0 ? ` · <span class="neg">selisih ekor ${fmt(ef - ek - dead, 0)} (kirim ≠ hidup + mati)</span>` : '';
    return `Nilai hutang: <b>${rp(tot)}</b> · masuk stok ${fmt(kr)} kg → biaya efektif <b>${kr ? rp(tot / kr) : '-'}/kg</b> · susut ${kf ? pct((kf - kr) / kf) : '-'} · mati ${fmt(dead, 0)} ekor${chk}`;
  },
  validate: d => { if (!(d.lines || []).length) return 'Isi rincian timbang'; if ((d.lines || []).some(l => !l.item_id || !l.kg)) return 'Setiap baris wajib ada barang & kg terima'; },
});

// ---- Kinerja supplier ----
PAGES.supplier = () => {
  const rows = partners('supplier').map(p => {
    const gs = docs('gr').filter(g => g.data.partner_id === p.id); if (!gs.length) return null;
    let kf = 0, kr = 0, ek = 0, dead = 0, val = 0;
    for (const g of gs) { val += (S.E.cost[g.id] || {}).total || 0; for (const l of g.data.lines || []) { if (num(l.kg_farm) > 0) kf += num(l.kg_farm), kr += num(l.kg); ek += num(l.ekor) + num(l.dead); dead += num(l.dead); } }
    return `<tr><td>${esc(p.data.name)}</td>${td(gs.length, 1)}${td(fmt(ek, 0), 1)}${td(fmt(kr), 1)}${td(ek ? fmt(kr / (ek - dead || 1), 3) : '-', 1)}${td(kf ? pct((kf - kr) / kf) : '-', 1)}${td(pct(ek ? dead / ek : NaN), 1)}${td(rp(val), 1)}${td(kr ? rp(val / kr) : '-', 1)}${td(rp(partnerBalance(p.id, '2101')), 1)}</tr>`;
  }).filter(Boolean);
  return `<div class="bar"><span class="muted">Periode ${periodTxt()}</span><span class="sp"></span>${exportBtn('t-sup')}</div>` +
    table(['Supplier', ['Kedatangan', 1], ['Ekor', 1], ['Kg terima', 1], ['Bobot rata2 (kg/ekor)', 1], ['Susut', 1], ['Mati', 1], ['Nilai beli', 1], ['Biaya efektif/kg', 1], ['Saldo hutang', 1]], rows, { id: 't-sup' }) +
    `<p class="note">Biaya efektif/kg = nilai beli ÷ kg yang benar-benar masuk RPA. Ini angka yang jujur untuk membandingkan peternak, bukan harga di PO.</p>`;
};

// ---- Produksi ----
PAGES.prod = () => `<div class="bar"><button data-new="prod">+ Catat pemotongan</button><span class="sp"></span>${exportBtn('t-prod')}</div>` +
  table(['No', 'Tanggal', 'Unit', ['Ekor', 1], ['Kg hidup', 1], ['Kg karkas', 1], ['Rendemen karkas', 1], ['Total output', 1], ['Biaya total', 1], ['HPP karkas/kg', 1]], docs('prod').map(r => {
    const c = S.E.cost[r.id] || {};
    return `<tr class="click" data-edit="${r.id}"><td>${esc(r.no)}</td><td>${r.date}</td><td>${esc(nm(r.unit_id))}</td>${td(fmt(c.inEkor, 0), 1)}${td(fmt(c.inKg), 1)}${td(fmt(c.mainKg), 1)}${td(pct(c.yieldMain), 1)}${td(pct(c.yieldAll), 1)}${td(rp(c.total), 1)}${td(isFinite(c.costPerKgMain) ? rp(c.costPerKgMain) : '-', 1)}</tr>`;
  }), { id: 't-prod' }) +
  `<p class="note">Biaya (ayam hidup + bahan pembantu + overhead) dialokasikan ke tiap produk berdasarkan <b>nilai jual acuan</b> (kg × harga jual di master barang). Produk sampingan tanpa harga jual = biaya 0. Ubah harga acuan di master Barang bila harga pasar berubah.</p>`;
FORMS.prod = rec => openForm({
  kind: 'prod', title: 'Pemotongan / Produksi', rec, defaults: { date: localDate(), unit_id: defaultUnit() },
  fields: [
    { k: 'date', label: 'Tanggal', type: 'date', req: true }, unitField(),
    { k: 'shift', label: 'Shift / batch', type: 'text' },
    { k: 'overhead', label: 'Overhead dibebankan (Rp)', type: 'number', hint: 'Upah potong, listrik, air, gas untuk batch ini (opsional)' },
    { k: 'note', label: 'Catatan', type: 'textarea', wide: true },
  ],
  tables: [
    { k: 'input', label: '1. Ayam hidup dipotong', cols: [
      { k: 'item_id', label: 'Barang', type: 'select', options: itemOpts('live'), w: '40%' }, { k: 'ekor', label: 'Ekor', type: 'number' }, { k: 'kg', label: 'Kg hidup', type: 'number' },
      { k: 'avail', label: 'Stok tersedia', calc: (r, h) => { const s = S.E.stock.get((h.unit_id || defaultUnit()) + '|' + r.item_id); return s ? `${fmt(s.qty)} kg / ${fmt(s.ekor, 0)} ekor` : '-'; } } ] },
    { k: 'outputs', label: '2. Hasil potong', cols: [
      { k: 'item_id', label: 'Produk', type: 'select', options: itemOpts(['product', 'byproduct']), w: '40%' }, { k: 'kg', label: 'Kg', type: 'number' } ] },
    { k: 'supplies', label: '3. Bahan pembantu dipakai (es, plastik, dll — opsional)', cols: [
      { k: 'item_id', label: 'Barang', type: 'select', options: itemOpts('supplies'), w: '40%' }, { k: 'qty', label: 'Qty', type: 'number' } ] },
  ],
  onOpen: () => { if (!rec) setRows('outputs', items(['product', 'byproduct']).map(i => ({ item_id: i.id }))); },
  calc: d => {
    const inKg = (d.input || []).reduce((a, l) => a + l.kg, 0), ek = (d.input || []).reduce((a, l) => a + l.ekor, 0);
    const outs = d.outputs || []; const outKg = outs.reduce((a, l) => a + l.kg, 0);
    const main = outs.filter(l => (byId(l.item_id) || { data: {} }).data.category === 'product').reduce((a, l) => a + l.kg, 0);
    const loss = inKg - outKg;
    return `Rendemen karkas <b>${pct(inKg ? main / inKg : NaN)}</b> · total output ${pct(inKg ? outKg / inKg : NaN)} · bobot rata2 ${ek ? fmt(inKg / ek, 3) : '-'} kg/ekor · tidak tercatat (darah/air/bulu) ${fmt(loss)} kg (${pct(inKg ? loss / inKg : NaN)})` +
      (outKg > inKg ? ' · <span class="neg">output melebihi input — cek timbangan</span>' : '');
  },
  validate: d => { if (!(d.input || []).length) return 'Isi ayam hidup yang dipotong'; if (!(d.outputs || []).some(l => l.kg > 0)) return 'Isi minimal satu hasil potong'; },
});

// ---- Stok ----
PAGES.stok = () => {
  const list = [...S.E.stock.values()].filter(s => (S.unit === 'all' || s.unit === S.unit) && (Math.abs(s.qty) > 1e-6 || Math.abs(s.value) > 0.5));
  list.sort((a, b) => nm(a.item).localeCompare(nm(b.item)));
  const tot = list.reduce((a, s) => a + s.value, 0);
  return `<div class="bar"><span class="muted">Posisi stok saat ini (semua tanggal)</span><span class="sp"></span>${exportBtn('t-stok')}</div>` +
    table(['Unit', 'Barang', 'Kategori', ['Qty', 1], 'Satuan', ['Ekor', 1], ['Harga rata2', 1], ['Nilai', 1]], list.map(s => {
      const it = byId(s.item) || { data: {} };
      return `<tr class="click" data-kartu="${s.unit}|${s.item}"><td>${esc(nm(s.unit))}</td><td>${esc(it.data.name)}</td><td>${esc(CAT_LABEL[it.data.category] || '')}</td>${td(`<span class="${s.qty < 0 ? 'neg' : ''}">${fmt(s.qty)}</span>`, 1)}<td>${esc(it.data.uom || 'kg')}</td>${td(it.data.category === 'live' ? fmt(s.ekor, 0) : '', 1)}${td(s.qty > 0 ? rp(s.value / s.qty) : '-', 1)}${td(rp(s.value), 1)}</tr>`;
    }).concat(list.length ? [`<tr class="tot"><td colspan="7">Total</td>${td(rp(tot), 1)}</tr>`] : []), { id: 't-stok' }) +
    `<p class="note">Ayam hidup idealnya habis dipotong di hari yang sama; saldo ayam hidup yang menumpuk biasanya tanda pemotongan belum dicatat.</p>`;
};
PAGES.kartu = () => {
  const key = S.tab.kartu || '';
  const [u, i] = key.split('|');
  const sel = `<select id="kartuSel"><option value="">— pilih barang —</option>${[...S.E.stock.values()].map(s => `<option value="${s.unit}|${s.item}" ${key === s.unit + '|' + s.item ? 'selected' : ''}>${esc(nm(s.item))} · ${esc(nm(s.unit))}</option>`).join('')}</select>`;
  if (!i) return `<div class="bar">${sel}</div><div class="empty">Pilih barang untuk melihat kartu stok.</div>`;
  const mv = S.E.moves.filter(m => m.unit === u && m.item === i);
  return `<div class="bar">${sel}<span class="sp"></span>${exportBtn('t-kartu')}</div>` +
    table(['Tanggal', 'Dokumen', 'Keterangan', ['Masuk', 1], ['Keluar', 1], ['Saldo qty', 1], ['Saldo ekor', 1], ['Nilai mutasi', 1], ['Saldo nilai', 1]], mv.map(m =>
      `<tr><td>${m.date}</td><td>${esc(m.doc.no)}</td><td>${esc({ gr: 'Penerimaan ' + nm(m.doc.data.partner_id), prod: 'Pemotongan', adj: 'Penyesuaian / opname', do: 'Kirim (DO) ke ' + nm(m.doc.data.partner_id), so: 'Jual langsung ke ' + nm(m.doc.data.partner_id) }[m.doc.kind])}</td>${td(m.qty > 0 ? fmt(m.qty) : '', 1)}${td(m.qty < 0 ? fmt(-m.qty) : '', 1)}${td(fmt(m.balQty), 1)}${td(fmt(m.balEkor, 0), 1)}${td(rp(m.value), 1)}${td(rp(m.balValue), 1)}</tr>`), { id: 't-kartu' });
};

// ---- Delivery Order ----
const kgOf = r => (r.data.lines || []).reduce((a, l) => a + num(l.kg), 0);
PAGES.do = () => `<div class="bar"><button data-new="do">+ Delivery Order</button><span class="muted">DO = barang keluar gudang (stok berkurang). Tagihan dibuat terpisah di menu Invoice.</span><span class="sp"></span>${exportBtn('t-do')}</div>` +
  table(['No DO', 'Tanggal', 'Customer', 'Kendaraan', ['Koli', 1], ['Ekor', 1], ['Kg', 1], 'Status kirim', 'Tagihan', 'Aksi'], docs('do').map(r => {
    const L = r.data.lines || []; const v = byId(r.data.vehicle_id); const inv = invoiceOfDO(r.id);
    return `<tr class="click" data-edit="${r.id}"><td>${esc(r.no)}</td><td>${r.date}</td><td>${esc(nm(r.data.partner_id))}</td><td>${v ? esc(v.data.plate) : ''}</td>${td(fmt(L.reduce((a, l) => a + num(l.koli), 0), 0), 1)}${td(fmt(L.reduce((a, l) => a + num(l.ekor), 0), 0), 1)}${td(fmt(kgOf(r)), 1)}<td>${badge(...DELIV[r.data.delivery_status || 'pending'])}</td>
      <td>${inv ? badge(inv.no, 'b-ok') : badge('Belum ditagih', 'b-warn')}</td>
      <td><button class="ghost sm" onclick="printSJ('${r.id}')">Surat jalan</button>${inv ? '' : ` <button class="sm" onclick="invoiceFromDO('${r.id}')">Buat invoice</button>`}</td></tr>`;
  }), { id: 't-do' });
FORMS.do = rec => openForm({
  kind: 'do', title: 'Delivery Order / Surat Jalan', rec, defaults: { date: localDate(), unit_id: defaultUnit(), delivery_status: 'pending' },
  fields: [
    { k: 'date', label: 'Tanggal kirim', type: 'date', req: true }, unitField(),
    { k: 'partner_id', label: 'Customer', type: 'select', options: partnerOpts('customer'), req: true,
      onChange: v => { const p = byId(v); const el = $('#frm').elements['f:address']; if (p && !el.value) el.value = p.data.ship_address || p.data.address || ''; } },
    { k: 'cust_po', label: 'No. PO / pesanan customer', type: 'text' },
    { k: 'address', label: 'Alamat kirim', type: 'text' },
    { k: 'vehicle_id', label: 'Kendaraan', type: 'select', options: () => K('vehicle').map(v => [v.id, `${v.data.plate} · ${v.data.driver || ''}`]) },
    { k: 'depart_time', label: 'Jam berangkat', type: 'time' },
    { k: 'temp', label: 'Suhu muatan (°C)', type: 'text', ph: 'mis. -2 s/d 4' },
    { k: 'seal', label: 'No. segel / catatan muatan', type: 'text' },
    { k: 'delivery_status', label: 'Status kirim', type: 'select', options: Object.entries(DELIV).map(([k, v]) => [k, v[0]]), blank: null },
    { k: 'note', label: 'Catatan', type: 'textarea', wide: true },
  ],
  tables: [{ k: 'lines', label: 'Barang dikirim', cols: [
    { k: 'item_id', label: 'Barang', type: 'select', options: itemOpts(['product', 'byproduct', 'live', 'other']), w: '38%' },
    { k: 'koli', label: 'Koli/box', type: 'number' }, { k: 'ekor', label: 'Ekor', type: 'number' }, { k: 'kg', label: 'Berat kirim (kg/qty)', type: 'number' },
    { k: 'avail', label: 'Stok', calc: (r, h) => { const s = S.E.stock.get((h.unit_id || defaultUnit()) + '|' + r.item_id); return s ? fmt(s.qty) : '-'; } },
  ] }],
  extraBtn: rec ? `<button type="button" class="ghost" onclick="printSJ('${rec.id}')">Cetak Surat Jalan</button>${invoiceOfDO(rec.id) ? '' : `<button type="button" class="ghost" onclick="invoiceFromDO('${rec.id}')">Buat Invoice</button>`}` : '',
  calc: d => { const L = d.lines || []; return `Total kirim: <b>${fmt(L.reduce((a, l) => a + l.kg, 0))} kg</b> · ${fmt(L.reduce((a, l) => a + l.ekor, 0), 0)} ekor · ${fmt(L.reduce((a, l) => a + l.koli, 0), 0)} koli`; },
  validate: d => { if (!(d.lines || []).length) return 'Isi barang yang dikirim'; if (d.lines.some(l => !l.item_id || !l.kg)) return 'Setiap baris wajib barang & berat';
    if (rec && invoiceOfDO(rec.id) && JSON.stringify(rec.data.lines) !== JSON.stringify(d.lines)) return `DO ini sudah ditagih di ${invoiceOfDO(rec.id).no}. Ubah/hapus invoice dulu sebelum mengubah barang.`; },
});

// ---- Invoice ----
PAGES.so = () => `<div class="bar"><button data-new="so">+ Invoice</button><span class="muted">Tagih dari DO (surat jalan) atau penjualan langsung tanpa DO.</span><span class="sp"></span>${exportBtn('t-so')}</div>` +
  table(['No', 'Tanggal', 'Customer', 'Dari DO', ['Kg', 1], ['Nilai', 1], ['HPP', 1], ['Laba kotor', 1], 'Jatuh tempo', 'Status bayar', 'Cetak'], docs('so').map(r => {
    const c = S.E.cost[r.id] || {}; const open = aging(r.data.partner_id, 'so', '1201').find(o => o.r.id === r.id);
    const st = !open ? ['Lunas', 'b-ok'] : open.rest < c.total - 0.5 ? ['Sebagian', 'b-warn'] : bucket(open.due) > 0 ? ['Jatuh tempo', 'b-bad'] : ['Belum bayar', 'b-info'];
    return `<tr class="click" data-edit="${r.id}"><td>${esc(r.no)}</td><td>${r.date}</td><td>${esc(nm(r.data.partner_id))}</td><td>${esc(doIdsOf(r).map(id => (byId(id) || {}).no).join(', ') || 'langsung')}</td>${td(fmt(kgOf(r)), 1)}${td(rp(c.total), 1)}${td(rp(c.cogs), 1)}${td(`<span class="${c.total - c.cogs < 0 ? 'neg' : ''}">${rp(c.total - c.cogs)}</span>`, 1)}<td>${esc(r.data.due_date || '')}</td><td>${badge(...st)}</td><td><button class="ghost sm" onclick="printInv('${r.id}')">Invoice</button></td></tr>`;
  }), { id: 't-so' });
function rebuildInvoiceLines() {
  const frm = $('#frm'); const ids = $$('[name="l:do_id"]', frm).map(e => e.value).filter(Boolean);
  if (!ids.length) return;
  const prices = {}; for (const tr of $$('[data-line="lines"]', frm)) { const it = tr.querySelector('[name="l:item_id"]').value; const pr = num(tr.querySelector('[name="l:price"]').value); if (it && pr) prices[it] = pr; }
  const first = byId(ids[0]); if (first) { frm.elements['f:partner_id'].value = first.data.partner_id; frm.elements['f:unit_id'].value = first.unit_id; frm.elements['f:partner_id'].dispatchEvent(new Event('change', { bubbles: true }));
    if (!frm.elements['f:cust_po'].value && first.data.cust_po) frm.elements['f:cust_po'].value = first.data.cust_po; }
  const rows = [];
  for (const id of ids) for (const l of (byId(id) || { data: {} }).data.lines || []) {
    if (!l.item_id) continue;
    const ex = rows.find(x => x.item_id === l.item_id);
    if (ex) { ex.kg = r2(num(ex.kg) + num(l.kg)); ex.ekor = num(ex.ekor) + num(l.ekor); }
    else rows.push({ item_id: l.item_id, ekor: num(l.ekor) || '', kg: num(l.kg), price: prices[l.item_id] || (byId(l.item_id) || { data: {} }).data.price || '' });
  }
  setRows('lines', rows);
}
window.invoiceFromDO = id => { FORMS.so(null); const tr = $('[data-line="dos"]'); tr.querySelector('[name="l:do_id"]').value = id; rebuildInvoiceLines(); };
FORMS.so = rec => openForm({
  kind: 'so', title: 'Invoice Penjualan', rec, defaults: { date: localDate(), unit_id: defaultUnit() },
  fields: [
    { k: 'date', label: 'Tanggal invoice', type: 'date', req: true }, unitField(),
    { k: 'partner_id', label: 'Customer', type: 'select', options: partnerOpts('customer'), req: true,
      onChange: v => { const p = byId(v); const el = $('#frm').elements['f:due_date']; if (p && !el.value) el.value = addDays($('#frm').elements['f:date'].value || localDate(), num(p.data.terms)); } },
    { k: 'cust_po', label: 'No. PO customer', type: 'text' },
    { k: 'due_date', label: 'Jatuh tempo', type: 'date' },
    { k: 'discount', label: 'Potongan (Rp)', type: 'number' },
    { k: 'note', label: 'Catatan', type: 'textarea', wide: true },
  ],
  tables: [
    { k: 'dos', label: '1. DO / surat jalan yang ditagih (kosongkan untuk penjualan langsung)', cols: [
      { k: 'do_id', label: 'No DO', type: 'select', w: '60%', onChange: () => rebuildInvoiceLines(),
        options: () => K('do').filter(d => { const inv = invoiceOfDO(d.id); return !inv || (rec && inv.id === rec.id); }).sort((a, b) => b.date.localeCompare(a.date)).map(d => [d.id, `${d.no} · ${d.date} · ${nm(d.data.partner_id)} · ${fmt(kgOf(d))} kg`]) },
      { k: 'info', label: 'Status kirim', calc: r => { const d = byId(r.do_id); return d ? DELIV[d.data.delivery_status || 'pending'][0] : ''; } } ] },
    { k: 'lines', label: '2. Barang ditagih (berat & harga bisa disesuaikan dengan timbang penerima)', cols: [
      { k: 'item_id', label: 'Barang', type: 'select', options: itemOpts(['product', 'byproduct', 'live', 'other']), w: '36%',
        onChange: (tr, v) => { const it = byId(v); const p = tr.querySelector('[name="l:price"]'); if (it && !num(p.value)) p.value = it.data.price || ''; } },
      { k: 'ekor', label: 'Ekor', type: 'number' }, { k: 'kg', label: 'Kg / Qty', type: 'number' }, { k: 'price', label: 'Harga/kg', type: 'number' },
      { k: 'sub', label: 'Subtotal', calc: r => rp(r.kg * r.price) } ] },
  ],
  extraBtn: rec ? `<button type="button" class="ghost" onclick="printInv('${rec.id}')">Cetak Invoice</button>` : '',
  calc: d => {
    const g = (d.lines || []).reduce((a, l) => a + l.kg * l.price, 0), tot = g - num(d.discount); const kg = (d.lines || []).reduce((a, l) => a + l.kg, 0);
    const ids = (d.dos || []).map(x => x.do_id).filter(Boolean); const dkg = ids.reduce((a, id) => a + kgOf(byId(id) || { data: {} }), 0);
    let msg = `Total invoice: <b>${rp(tot)}</b> · ${fmt(kg)} kg`;
    if (ids.length) msg += ` · berat DO ${fmt(dkg)} kg${Math.abs(dkg - kg) > 0.01 ? ` · <span class="neg">selisih ${fmt(kg - dkg)} kg</span>` : ''}`;
    else msg += ` · <span class="muted">penjualan langsung: stok dikurangi oleh invoice ini</span>`;
    const p = byId(d.partner_id); const lim = p ? num(p.data.credit_limit) : 0;
    if (lim) { const after = partnerBalance(d.partner_id, '1201') - (rec ? (S.E.cost[rec.id] || {}).total || 0 : 0) + tot; if (after > lim) msg += `<br><span class="neg">Piutang customer menjadi ${rp(after)}, melebihi limit kredit ${rp(lim)}.</span>`; }
    return msg;
  },
  validate: d => {
    if (!(d.lines || []).length) return 'Isi barang yang ditagih'; if (d.lines.some(l => !l.item_id || !l.kg)) return 'Setiap baris wajib barang & kg';
    const ids = (d.dos || []).map(x => x.do_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) return 'DO yang sama dipilih dua kali';
    for (const id of ids) { const x = byId(id); if (x.data.partner_id !== d.partner_id) return `${x.no} milik customer lain`; const inv = invoiceOfDO(id); if (inv && (!rec || inv.id !== rec.id)) return `${x.no} sudah ditagih di ${inv.no}`; }
  },
});
// ---- Dokumen cetak: Surat Jalan, Bukti Barang Masuk, Invoice ----
function company(unitId) {
  const c = (byId('setting-company') || { data: {} }).data; const u = byId(unitId) || { data: {} };
  return { name: c.name || u.data.name || 'Nama Usaha', sub: c.name && u.data.name && u.data.name !== c.name ? u.data.name : '', address: c.address || '', phone: c.phone || '', npwp: c.npwp || '' };
}
const tglID = ds => ds ? new Date(ds + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const altNo = (no, pre) => no ? no.replace(/^[A-Z]+/, pre) : '';
function docHead(co, title, meta) {
  return `<div class="pd-head"><div><div class="pd-co">${esc(co.name)}</div>${co.sub ? `<div>${esc(co.sub)}</div>` : ''}<div class="pd-small">${esc(co.address)}${co.phone ? ' · Telp ' + esc(co.phone) : ''}${co.npwp ? ' · NPWP ' + esc(co.npwp) : ''}</div></div>
    <div class="pd-title"><div>${esc(title)}</div><table class="pd-meta">${meta.map(([k, v]) => `<tr><td>${esc(k)}</td><td>: <b>${v}</b></td></tr>`).join('')}</table></div></div>`;
}
const docParties = cols => `<div class="pd-parties">${cols.map(([t, lines]) => `<div><div class="pd-lbl">${esc(t)}</div>${lines.filter(Boolean).join('<br>')}</div>`).join('')}</div>`;
const docSign = names => `<table class="pd-sign"><tr>${names.map(n => `<td>${esc(n)}</td>`).join('')}</tr><tr>${names.map(() => '<td class="pd-space"></td>').join('')}</tr><tr>${names.map(() => '<td>( ............................ )</td>').join('')}</tr></table>`;
function printDoc(copies) {
  $('#printArea').innerHTML = copies.map(([label, html]) => `<div class="pdoc">${label ? `<div class="pd-copy">${esc(label)}</div>` : ''}${html}</div>`).join('');
  window.print();
}
window.printSJ = id => {
  const r = byId(id); if (!r) return; const d = r.data; const co = company(r.unit_id);
  const cu = byId(d.partner_id) || { data: {} }; const v = byId(d.vehicle_id) || { data: {} };
  const L = (d.lines || []).filter(l => l.item_id);
  const tot = k => L.reduce((a, l) => a + num(l[k]), 0);
  const rows = L.map((l, i) => { const it = byId(l.item_id) || { data: {} };
    return `<tr><td class="c">${i + 1}</td><td>${esc(it.data.code || '')}</td><td>${esc(it.data.name)}</td><td class="c">${esc(it.data.uom || 'kg')}</td><td class="n">${num(l.koli) ? fmt(num(l.koli), 0) : ''}</td><td class="n">${num(l.ekor) ? fmt(num(l.ekor), 0) : ''}</td><td class="n">${fmt(num(l.kg))}</td><td></td><td></td></tr>`; }).join('');
  const body = docHead(co, 'SURAT JALAN', [['No. SJ / DO', esc(r.no)], ['Tanggal', esc(tglID(r.date))], ['No. PO customer', esc(d.cust_po || '-')]]) +
    docParties([
      ['Kirim kepada', [`<b>${esc(cu.data.name)}</b>${cu.data.code ? ' (' + esc(cu.data.code) + ')' : ''}`, esc(d.address || cu.data.address || ''), cu.data.phone ? 'Telp ' + esc(cu.data.phone) : '']],
      ['Pengangkutan', [`Kendaraan: <b>${esc(v.data.plate || '-')}</b> ${v.data.type ? '(' + esc(v.data.type) + ')' : ''}`, `Sopir: ${esc(v.data.driver || '-')}${v.data.phone ? ' · ' + esc(v.data.phone) : ''}`,
        `Jam berangkat: ${esc(d.depart_time || '........')}`, `Suhu muatan: ${esc(d.temp || '........')} °C${d.seal ? ' · Segel: ' + esc(d.seal) : ''}`]],
    ]) +
    `<table class="pd-tbl"><thead><tr><th>No</th><th>Kode</th><th>Nama barang</th><th>Satuan</th><th>Koli</th><th>Ekor</th><th>Berat kirim (kg)</th><th>Berat diterima (kg)</th><th>Keterangan</th></tr></thead>
    <tbody>${rows}<tr class="pd-tot"><td colspan="4">TOTAL</td><td class="n">${tot('koli') ? fmt(tot('koli'), 0) : ''}</td><td class="n">${tot('ekor') ? fmt(tot('ekor'), 0) : ''}</td><td class="n">${fmt(tot('kg'))}</td><td></td><td></td></tr></tbody></table>
    ${d.note ? `<p class="pd-small">Catatan: ${esc(d.note)}</p>` : ''}
    <p class="pd-small">Mohon barang diperiksa (jumlah, berat, suhu, kondisi) saat diterima. Selisih atau keluhan ditulis di kolom keterangan dan ditandatangani kedua pihak. Klaim setelah surat jalan ditandatangani tanpa catatan tidak dapat diproses.</p>` +
    docSign(['Dibuat oleh (Admin/Gudang)', 'Sopir / Pengirim', 'Penerima (nama, tgl, jam & cap)']);
  printDoc([['Lembar 1 — untuk Penerima', body], ['Lembar 2 — Arsip (kembali ke kantor)', body]]);
};
window.printBTB = (id, withPrice) => {
  const r = byId(id); if (!r) return; const d = r.data; const co = company(r.unit_id);
  const sp = byId(d.partner_id) || { data: {} }; const po = byId(d.po_id);
  const L = (d.lines || []).filter(l => l.item_id);
  const tot = k => L.reduce((a, l) => a + num(l[k]), 0);
  const basis = d.pay_basis === 'farm' ? 'kg_farm' : 'kg';
  const rows = L.map((l, i) => { const it = byId(l.item_id) || { data: {} }; const su = num(l.kg_farm) ? num(l.kg_farm) - num(l.kg) : 0;
    return `<tr><td class="c">${i + 1}</td><td>${esc(it.data.code || '')}</td><td>${esc(it.data.name)}</td><td class="n">${num(l.koli) ? fmt(num(l.koli), 0) : ''}</td><td class="n">${num(l.ekor_farm) ? fmt(num(l.ekor_farm), 0) : ''}</td><td class="n">${num(l.kg_farm) ? fmt(num(l.kg_farm)) : ''}</td><td class="n">${num(l.ekor) ? fmt(num(l.ekor), 0) : ''}</td><td class="n">${num(l.dead) ? fmt(num(l.dead), 0) : ''}</td><td class="n">${fmt(num(l.kg))} ${esc(it.data.uom && it.data.uom !== 'kg' ? it.data.uom : '')}</td><td class="n">${num(l.kg_farm) ? fmt(su) + ' (' + pct(su / num(l.kg_farm)) + ')' : ''}</td>${withPrice ? `<td class="n">${rp(l.price)}</td><td class="n">${rp(num(l[basis]) * num(l.price))}</td>` : ''}</tr>`; }).join('');
  const sk = tot('kg_farm') ? tot('kg_farm') - L.filter(l => num(l.kg_farm)).reduce((a, l) => a + num(l.kg), 0) : 0;
  const body = docHead(co, 'BUKTI PENERIMAAN BARANG', [['No', esc(altNo(r.no, 'BPB'))], ['Tanggal', esc(tglID(r.date))], ['Jam tiba', esc(d.arrive_time || '-')]]) +
    docParties([
      ['Diterima dari', [`<b>${esc(sp.data.name)}</b>${sp.data.code ? ' (' + esc(sp.data.code) + ')' : ''}`, esc(sp.data.address || ''), sp.data.phone ? 'Telp ' + esc(sp.data.phone) : '']],
      ['Referensi', [`No. PO: ${esc(po ? po.no : '-')}`, `No. DO/SJ supplier: ${esc(d.ref_doc || '-')}`, `Kendaraan: ${esc(d.vehicle || '-')} · Sopir: ${esc(d.driver || '-')}`, `No. sistem: ${esc(r.no)}`]],
    ]) +
    `<table class="pd-tbl"><thead><tr><th>No</th><th>Kode</th><th>Nama barang</th><th>Koli</th><th>Ekor kirim</th><th>Kg kandang</th><th>Ekor hidup</th><th>Mati</th><th>Kg diterima</th><th>Susut kg</th>${withPrice ? '<th>Harga/kg</th><th>Jumlah</th>' : ''}</tr></thead>
    <tbody>${rows}<tr class="pd-tot"><td colspan="3">TOTAL</td><td class="n">${tot('koli') ? fmt(tot('koli'), 0) : ''}</td><td class="n">${tot('ekor_farm') ? fmt(tot('ekor_farm'), 0) : ''}</td><td class="n">${tot('kg_farm') ? fmt(tot('kg_farm')) : ''}</td><td class="n">${tot('ekor') ? fmt(tot('ekor'), 0) : ''}</td><td class="n">${tot('dead') ? fmt(tot('dead'), 0) : ''}</td><td class="n">${fmt(tot('kg'))}</td><td class="n">${tot('kg_farm') ? fmt(sk) + ' (' + pct(sk / tot('kg_farm')) + ')' : ''}</td>${withPrice ? `<td></td><td class="n">${rp((S.E.cost[r.id] || {}).total)}</td>` : ''}</tr></tbody></table>
    ${withPrice ? `<p class="pd-small">Dasar pembayaran: ${d.pay_basis === 'farm' ? 'timbang kandang' : 'timbang RPA'}. Jatuh tempo: ${esc(tglID(d.due_date) || '-')}.</p>` : ''}
    ${d.note ? `<p class="pd-small">Catatan: ${esc(d.note)}</p>` : ''}
    <p class="pd-small">Ditimbang dan dihitung bersama saat bongkar. Ayam mati (DOA) dan susut tercatat di atas disetujui kedua pihak.</p>` +
    docSign(['Sopir / Pengirim', 'Diterima & diperiksa' + (d.checker ? ' (' + d.checker + ')' : ''), 'Mengetahui']);
  printDoc(withPrice ? [['Arsip internal', body]] : [['Lembar 1 — untuk Supplier/Sopir', body], ['Lembar 2 — Arsip Gudang', body]]);
};
window.printInv = id => {
  const r = byId(id); if (!r) return; const d = r.data; const co = company(r.unit_id); const c = S.E.cost[id] || {};
  const cu = byId(d.partner_id) || { data: {} };
  const L = (d.lines || []).filter(l => l.item_id);
  const rows = L.map((l, i) => `<tr><td class="c">${i + 1}</td><td>${esc((byId(l.item_id) || { data: {} }).data.code || '')}</td><td>${esc(nm(l.item_id))}</td><td class="n">${num(l.ekor) ? fmt(num(l.ekor), 0) : ''}</td><td class="n">${fmt(num(l.kg))}</td><td class="n">${rp(l.price)}</td><td class="n">${rp(num(l.kg) * num(l.price))}</td></tr>`).join('');
  const body = docHead(co, 'INVOICE', [['No', esc(r.no)], ['Tanggal', esc(tglID(r.date))], ['Jatuh tempo', esc(tglID(d.due_date) || '-')]]) +
    docParties([['Ditagihkan kepada', [`<b>${esc(cu.data.name)}</b>`, cu.data.code ? 'Kode: ' + esc(cu.data.code) : '', esc(cu.data.address || ''), cu.data.npwp ? 'NPWP ' + esc(cu.data.npwp) : '']],
      ['Referensi', [`Surat jalan / DO: ${esc(doIdsOf(r).map(id => (byId(id) || {}).no).join(', ') || '-')}`, `No. PO customer: ${esc(d.cust_po || '-')}`]]]) +
    `<table class="pd-tbl"><thead><tr><th>No</th><th>Kode</th><th>Barang</th><th>Ekor</th><th>Kg</th><th>Harga/kg</th><th>Jumlah</th></tr></thead><tbody>${rows}
    <tr><td colspan="6" class="n">Subtotal</td><td class="n">${rp(c.gross)}</td></tr>${c.discount ? `<tr><td colspan="6" class="n">Potongan</td><td class="n">-${rp(c.discount)}</td></tr>` : ''}
    <tr class="pd-tot"><td colspan="6" class="n">TOTAL</td><td class="n">${rp(c.total)}</td></tr></tbody></table>
    ${d.note ? `<p class="pd-small">Catatan: ${esc(d.note)}</p>` : ''}${(byId('setting-company') || { data: {} }).data.bank ? `<p class="pd-small">Pembayaran ke: ${esc(byId('setting-company').data.bank)}</p>` : ''}` +
    docSign(['Hormat kami', 'Diterima oleh']);
  printDoc([['', body]]);
};

// ---- Pengiriman ----
PAGES.kirim = () => {
  const list = K('do').filter(inUnit).filter(r => (r.data.delivery_status || 'pending') !== 'delivered' || inPeriod(r)).sort((a, b) => b.date.localeCompare(a.date));
  return `<div class="bar"><span class="muted">Semua pengiriman yang belum selesai + yang terkirim di periode ini</span><span class="sp"></span>${exportBtn('t-kirim')}</div>` +
    table(['No DO', 'Tanggal', 'Customer', 'Alamat', 'Kendaraan', ['Kg', 1], 'Status', 'Aksi'], list.map(r => {
      const st = r.data.delivery_status || 'pending'; const v = byId(r.data.vehicle_id); const nx = { pending: 'shipped', shipped: 'delivered' }[st];
      return `<tr><td>${esc(r.no)}</td><td>${r.date}</td><td>${esc(nm(r.data.partner_id))}</td><td>${esc(r.data.address || (byId(r.data.partner_id) || { data: {} }).data.address || '')}</td><td>${v ? esc(v.data.plate + ' · ' + (v.data.driver || '')) : '<span class="muted">belum</span>'}</td>${td(fmt((r.data.lines || []).reduce((a, l) => a + num(l.kg), 0)), 1)}<td>${badge(...DELIV[st])}</td>
      <td>${nx ? `<button class="sm" data-deliv="${r.id}|${nx}">${nx === 'shipped' ? 'Berangkat' : 'Terkirim'}</button>` : esc(r.data.delivered_at || '')} <button class="ghost sm" onclick="printSJ('${r.id}')">Surat jalan</button></td></tr>`;
    }), { id: 't-kirim' });
};
async function setDelivery(id, st) {
  const r = byId(id); if (!r) return;
  const out = { ...r, data: { ...r.data, delivery_status: st, ...(st === 'delivered' ? { delivered_at: localDate() } : {}) } };
  try { await Store.save(out); await refresh(); toast('Status pengiriman diperbarui'); } catch (e) { handleErr(e); }
}
PAGES.armada = () => {
  const so = docs('do');
  return `<div class="bar"><button data-new="vehicle">+ Kendaraan</button></div>` +
    table(['Plat', 'Jenis', 'Driver', 'No HP', ['Kapasitas (kg)', 1], ['Trip periode ini', 1], ['Kg diantar', 1]], K('vehicle').map(v => {
      const t = so.filter(s => s.data.vehicle_id === v.id);
      return `<tr class="click" data-edit="${v.id}"><td>${esc(v.data.plate)}</td><td>${esc(v.data.type || '')}</td><td>${esc(v.data.driver || '')}</td><td>${esc(v.data.phone || '')}</td>${td(fmt(num(v.data.capacity)), 1)}${td(t.length, 1)}${td(fmt(t.reduce((a, s) => a + (s.data.lines || []).reduce((x, l) => x + num(l.kg), 0), 0)), 1)}</tr>`;
    }));
};
FORMS.vehicle = rec => openForm({ kind: 'vehicle', title: 'Kendaraan', rec, fields: [
  { k: 'plate', label: 'Plat nomor', req: true }, { k: 'type', label: 'Jenis (pickup, box, motor)' }, { k: 'driver', label: 'Driver' }, { k: 'phone', label: 'No HP driver' },
  { k: 'capacity', label: 'Kapasitas (kg)', type: 'number' }] });

// ---- Kas & Bank ----
PAGES.kas = () => {
  const all = balances(S.to);
  const cashAccs = accounts().filter(a => a.cash);
  const list = docs('cash');
  return `<div class="kpis">${cashAccs.map(a => `<div class="kpi"><small>${esc(a.code + ' ' + a.name)}</small><b>${rp(all[a.code] ? natural(a.code, all[a.code]) : 0)}</b><em>per ${S.to || 'hari ini'}</em></div>`).join('')}</div>
  <div class="bar"><button data-new="cash" data-cat="ar_receipt">+ Terima piutang</button><button data-new="cash" data-cat="ap_payment">+ Bayar supplier</button><button data-new="cash" data-cat="expense">+ Catat biaya</button><button data-new="cash" class="ghost">+ Transaksi lain</button><span class="sp"></span>${exportBtn('t-kas')}</div>` +
    table(['No', 'Tanggal', 'Akun kas', 'Jenis', 'Mitra / Akun lawan', 'Keterangan', ['Masuk', 1], ['Keluar', 1]], list.map(r => {
      const d = r.data; const inn = ['ar_receipt', 'income', 'capital'].includes(d.category);
      const other = d.partner_id ? nm(d.partner_id) : d.category === 'transfer' ? '→ ' + accName(d.to_account) : d.counter ? accName(d.counter) : '';
      return `<tr class="click" data-edit="${r.id}"><td>${esc(r.no)}</td><td>${r.date}</td><td>${esc(accName(d.account))}</td><td>${esc(CASH_CAT[d.category] || '')}</td><td>${esc(other)}</td><td>${esc(d.note || '')}</td>${td(inn ? rp(d.amount) : '', 1)}${td(!inn ? rp(d.amount) : '', 1)}</tr>`;
    }), { id: 't-kas' });
};
FORMS.cash = (rec, cat) => {
  const show = () => { const c = $('#frm').elements['f:category'].value; const vis = { partner_id: ['ap_payment', 'ar_receipt', 'expense', 'income'], counter: ['expense', 'income'], to_account: ['transfer'] };
    for (const [k, cats] of Object.entries(vis)) $('#frm').elements['f:' + k].closest('label').style.display = cats.includes(c) ? '' : 'none'; };
  openForm({ kind: 'cash', title: 'Transaksi Kas & Bank', rec, defaults: { date: localDate(), unit_id: defaultUnit(), category: cat || 'expense', account: '1101' },
    fields: [
      { k: 'date', label: 'Tanggal', type: 'date', req: true }, unitField(),
      { k: 'category', label: 'Jenis transaksi', type: 'select', options: Object.entries(CASH_CAT), blank: null, onChange: show },
      { k: 'account', label: 'Akun kas / bank', type: 'select', options: cashAccOpts, blank: null },
      { k: 'partner_id', label: 'Supplier / customer', type: 'select', options: partnerOpts(),
        onChange: () => { const c = $('#frm').elements['f:category'].value; const p = $('#frm').elements['f:partner_id'].value; if (!p) return;
          const bal = c === 'ap_payment' ? partnerBalance(p, '2101') : c === 'ar_receipt' ? partnerBalance(p, '1201') : 0;
          const el = $('#frm').elements['f:amount']; if (bal > 0 && !num(el.value)) el.value = bal; recalc(); } },
      { k: 'counter', label: 'Akun biaya / pendapatan', type: 'select', options: accOpts(a => ['expense', 'revenue', 'asset', 'liability'].includes(a.type) && !a.cash) },
      { k: 'to_account', label: 'Ke akun kas/bank', type: 'select', options: cashAccOpts },
      { k: 'amount', label: 'Jumlah (Rp)', type: 'number', req: true },
      { k: 'ref', label: 'No. referensi / bukti', type: 'text' },
      { k: 'note', label: 'Keterangan', type: 'textarea', wide: true },
    ],
    onOpen: show,
    calc: d => {
      if (d.category === 'ap_payment' && d.partner_id) return `Saldo hutang ke ${esc(nm(d.partner_id))}: <b>${rp(partnerBalance(d.partner_id, '2101'))}</b>`;
      if (d.category === 'ar_receipt' && d.partner_id) return `Saldo piutang ${esc(nm(d.partner_id))}: <b>${rp(partnerBalance(d.partner_id, '1201'))}</b>`;
      return `Jumlah: <b>${rp(d.amount)}</b>`;
    },
    validate: d => {
      if (!(d.amount > 0)) return 'Jumlah harus lebih dari 0';
      if (['ap_payment', 'ar_receipt'].includes(d.category) && !d.partner_id) return 'Pilih supplier/customer';
      if (d.category === 'expense' && !d.counter) return 'Pilih akun biaya';
      if (d.category === 'transfer' && (!d.to_account || d.to_account === d.account)) return 'Pilih akun tujuan yang berbeda';
      if (d.category === 'transfer') { d.partner_id = ''; d.counter = ''; }
    },
  });
};

// ---- Hutang & Piutang ----
function apArPage(type) {
  const isAR = type === 'customer'; const acc = isAR ? '1201' : '2101'; const kind = isAR ? 'so' : 'gr';
  const rows = partners(type).map(p => {
    const open = aging(p.id, kind, acc); const b = [0, 0, 0, 0]; open.forEach(o => b[bucket(o.due)] += o.rest);
    const bal = partnerBalance(p.id, acc); if (Math.abs(bal) < 1 && !open.length) return null;
    return `<tr class="click" data-partner="${p.id}"><td>${esc(p.data.name)}</td>${b.map(x => td(x ? rp(x) : '', 1)).join('')}${td(`<b>${rp(bal)}</b>`, 1)}</tr>`;
  }).filter(Boolean);
  const sel = S.tab[type];
  let detail = '';
  if (sel) {
    const open = aging(sel, kind, acc);
    detail = `<div class="card" style="margin-top:16px"><h3>Dokumen terbuka — ${esc(nm(sel))}</h3>` + table(['Dokumen', 'Tanggal', 'Jatuh tempo', ['Nilai', 1], ['Sisa', 1], ['Telat (hari)', 1]], open.map(o => {
      const late = daysBetween(o.due, localDate());
      return `<tr class="click" data-edit="${o.r.id}"><td>${esc(o.r.no)}</td><td>${o.r.date}</td><td>${esc(o.due)}</td>${td(rp(o.amt), 1)}${td(rp(o.rest), 1)}${td(late > 0 ? `<span class="neg">${late}</span>` : '-', 1)}</tr>`;
    }), { empty: 'Tidak ada dokumen terbuka' }) + `<div class="bar" style="margin-top:10px"><button data-new="cash" data-cat="${isAR ? 'ar_receipt' : 'ap_payment'}" data-partner-pre="${sel}">${isAR ? 'Terima pembayaran' : 'Bayar'}</button></div></div>`;
  }
  return `<div class="bar"><span class="muted">Umur ${isAR ? 'piutang' : 'hutang'} per hari ini. Pembayaran dialokasikan ke dokumen tertua (FIFO).</span><span class="sp"></span>${exportBtn('t-' + type)}</div>` +
    table([isAR ? 'Customer' : 'Supplier', ['Belum jatuh tempo', 1], ['1–30 hari', 1], ['31–60 hari', 1], ['> 60 hari', 1], ['Saldo', 1]], rows, { id: 't-' + type }) + detail;
}
PAGES.hutang = () => apArPage('supplier');
PAGES.piutang = () => apArPage('customer');

// ---- Jurnal umum ----
PAGES.jv = () => `<div class="bar"><button data-new="jv">+ Jurnal umum</button><span class="muted">Untuk saldo awal, penyusutan, koreksi, akrual gaji, dll.</span><span class="sp"></span>${exportBtn('t-jv')}</div>` +
  table(['No', 'Tanggal', 'Keterangan', ['Debit', 1], ['Kredit', 1]], docs('jv').map(r => {
    const L = r.data.lines || []; return `<tr class="click" data-edit="${r.id}"><td>${esc(r.no)}</td><td>${r.date}</td><td>${esc(r.data.note || '')}</td>${td(rp(L.reduce((a, l) => a + num(l.debit), 0)), 1)}${td(rp(L.reduce((a, l) => a + num(l.credit), 0)), 1)}</tr>`;
  }), { id: 't-jv' });
FORMS.jv = rec => openForm({ kind: 'jv', title: 'Jurnal Umum', rec, defaults: { date: localDate(), unit_id: defaultUnit() },
  fields: [{ k: 'date', label: 'Tanggal', type: 'date', req: true }, unitField(), { k: 'note', label: 'Keterangan', type: 'text', wide: true, req: true }],
  tables: [{ k: 'lines', label: 'Baris jurnal', cols: [
    { k: 'account', label: 'Akun', type: 'select', options: accOpts(), w: '34%' }, { k: 'partner_id', label: 'Mitra (untuk hutang/piutang)', type: 'select', options: partnerOpts() },
    { k: 'debit', label: 'Debit', type: 'number' }, { k: 'credit', label: 'Kredit', type: 'number' }, { k: 'memo', label: 'Memo' }] }],
  calc: d => { const D = (d.lines || []).reduce((a, l) => a + l.debit, 0), C = (d.lines || []).reduce((a, l) => a + l.credit, 0);
    return `Debit ${rp(D)} · Kredit ${rp(C)} · ${Math.abs(D - C) < 0.5 ? '<span class="pos">Seimbang</span>' : `<span class="neg">Selisih ${rp(D - C)}</span>`}`; },
  validate: d => { const D = (d.lines || []).reduce((a, l) => a + l.debit, 0), C = (d.lines || []).reduce((a, l) => a + l.credit, 0);
    if (!(d.lines || []).length) return 'Isi baris jurnal'; if (Math.abs(D - C) >= 0.5) return 'Jurnal belum seimbang'; if (d.lines.some(l => !l.account)) return 'Setiap baris wajib akun'; },
});

// ---- Buku besar ----
PAGES.ledger = () => {
  const acc = S.tab.ledger || '1101';
  const sel = `<select id="ledgerSel">${opt(accOpts()(), acc, null)}</select>`;
  const open = glF(l => l.acc === acc && S.from && l.date < S.from);
  const dr = ['asset', 'expense'].includes(accType(acc));
  let bal = open.reduce((a, l) => a + (dr ? l.debit - l.credit : l.credit - l.debit), 0);
  const lines = glF(l => l.acc === acc && inPeriod(l));
  const rows = [`<tr class="sub"><td colspan="6">Saldo awal</td>${td(rp(bal), 1)}</tr>`].concat(lines.map(l => {
    bal += dr ? l.debit - l.credit : l.credit - l.debit;
    return `<tr class="click" data-edit="${l.doc.id}"><td>${l.date}</td><td>${esc(l.doc.no || '')}</td><td>${esc(l.memo)}</td><td>${esc(l.partner ? nm(l.partner) : '')}</td>${td(l.debit ? rp(l.debit) : '', 1)}${td(l.credit ? rp(l.credit) : '', 1)}${td(rp(bal), 1)}</tr>`;
  }));
  return `<div class="bar">${sel}<span class="muted">${periodTxt()}</span><span class="sp"></span>${exportBtn('t-ledger')}</div>` + table(['Tanggal', 'Dokumen', 'Keterangan', 'Mitra', ['Debit', 1], ['Kredit', 1], ['Saldo', 1]], rows, { id: 't-ledger' });
};

// ---- Laporan keuangan ----
PAGES.lapkeu = () => {
  const tab = S.tab.lapkeu || 'pl';
  const tabs = `<div class="tabs">${[['pl', 'Laba Rugi'], ['bs', 'Neraca'], ['tb', 'Neraca Saldo'], ['unit', 'Laba per Unit']].map(([k, l]) => `<a href="#lapkeu" data-tab="lapkeu:${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}<span style="flex:1"></span><button class="ghost sm" onclick="printView()">Cetak</button></div>`;
  return tabs + `<div id="rpt">${{ pl: rptPL, bs: rptBS, tb: rptTB, unit: rptUnit }[tab]()}</div>`;
};
function plData(from, to, unitFilter) {
  const m = {};
  for (const l of S.E.gl) {
    if (unitFilter && l.unit !== unitFilter) continue; if (!unitFilter && S.unit !== 'all' && l.unit !== S.unit) continue;
    if ((from && l.date < from) || (to && l.date > to)) continue;
    const t = accType(l.acc); if (t !== 'revenue' && t !== 'expense') continue;
    m[l.acc] = (m[l.acc] || 0) + (t === 'revenue' ? l.credit - l.debit : l.debit - l.credit);
  }
  const g = p => Object.entries(m).filter(([a]) => a.startsWith(p)).sort();
  const sum = arr => arr.reduce((a, [, v]) => a + v, 0);
  const rev = g('41'), oth = g('4').filter(([a]) => !a.startsWith('41')), cogs = g('5'), opex = g('6').concat(g('7'), g('8'), g('9'));
  return { rev, oth, cogs, opex, R: sum(rev), O: sum(oth), C: sum(cogs), X: sum(opex) };
}
function rptPL() {
  const d = plData(S.from, S.to);
  const sec = (title, arr) => [`<tr class="sub"><td colspan="2">${title}</td></tr>`].concat(arr.map(([a, v]) => `<tr><td>&nbsp;&nbsp;${a} ${esc(accName(a))}</td>${td(rp(v), 1)}</tr>`));
  const gp = d.R - d.C, np = gp - d.X + d.O;
  return `<p class="muted">Periode ${periodTxt()} · ${S.unit === 'all' ? 'Semua unit' : esc(nm(S.unit))}</p>` + table(['Akun', ['Jumlah', 1]], [
    ...sec('Pendapatan usaha', d.rev), `<tr class="tot"><td>Total pendapatan usaha</td>${td(rp(d.R), 1)}</tr>`,
    ...sec('Harga pokok & biaya produksi', d.cogs), `<tr class="tot"><td>Laba kotor (${pct(d.R ? gp / d.R : NaN)})</td>${td(rp(gp), 1)}</tr>`,
    ...sec('Beban operasional', d.opex), `<tr class="tot"><td>Total beban operasional</td>${td(rp(d.X), 1)}</tr>`,
    ...sec('Pendapatan lain-lain', d.oth),
    `<tr class="tot"><td>LABA (RUGI) BERSIH</td>${td(`<span class="${np < 0 ? 'neg' : ''}">${rp(np)}</span>`, 1)}</tr>`,
  ]) + `<p class="note">Akun 5201 (overhead aktual) dikurangi 5202 (overhead dibebankan ke produksi): selisihnya = overhead yang belum/lebih dibebankan. Pajak penghasilan belum dihitung.</p>`;
}
function rptBS() {
  const b = balances(S.to); const rows = []; let A = 0, L = 0, Q = 0, pl = 0;
  for (const [acc, v] of Object.entries(b)) { const t = accType(acc); if (t === 'revenue') pl += v.c - v.d; if (t === 'expense') pl -= v.d - v.c; }
  const sec = (type, label) => {
    const arr = Object.entries(b).filter(([a]) => accType(a) === type).sort().map(([a, v]) => [a, natural(a, v)]).filter(([, v]) => Math.abs(v) >= 0.5);
    rows.push(`<tr class="sub"><td colspan="2">${label}</td></tr>`, ...arr.map(([a, v]) => `<tr><td>&nbsp;&nbsp;${a} ${esc(accName(a))}</td>${td(rp(v), 1)}</tr>`));
    return arr.reduce((s, [, v]) => s + v, 0);
  };
  A = sec('asset', 'ASET'); rows.push(`<tr class="tot"><td>TOTAL ASET</td>${td(rp(A), 1)}</tr>`);
  L = sec('liability', 'KEWAJIBAN'); rows.push(`<tr class="tot"><td>Total kewajiban</td>${td(rp(L), 1)}</tr>`);
  Q = sec('equity', 'EKUITAS'); rows.push(`<tr><td>&nbsp;&nbsp;Laba berjalan (belum ditutup)</td>${td(rp(pl), 1)}</tr>`, `<tr class="tot"><td>Total ekuitas</td>${td(rp(Q + pl), 1)}</tr>`);
  rows.push(`<tr class="tot"><td>TOTAL KEWAJIBAN + EKUITAS</td>${td(rp(L + Q + pl), 1)}</tr>`);
  const diff = r2(A - L - Q - pl);
  return `<p class="muted">Per ${S.to || localDate()} · ${S.unit === 'all' ? 'Semua unit' : esc(nm(S.unit))}</p>` + (Math.abs(diff) >= 1 ? `<div class="alert">Neraca tidak seimbang: selisih ${rp(diff)}.</div>` : '') + table(['Akun', ['Saldo', 1]], rows) +
    (S.unit !== 'all' ? `<p class="note">Neraca per unit hanya akurat bila setiap transaksi kas dicatat di unit yang benar. Transfer antar unit belum memakai akun antar-kantor.</p>` : '');
}
function rptTB() {
  const b = balances(S.to); let D = 0, C = 0;
  const rows = Object.entries(b).sort().map(([a, v]) => { const n = v.d - v.c; if (Math.abs(n) < 0.5) return null; n > 0 ? D += n : C -= n;
    return `<tr class="click" data-ledger="${a}"><td>${a}</td><td>${esc(accName(a))}</td><td>${TYPE_LABEL[accType(a)] || ''}</td>${td(n > 0 ? rp(n) : '', 1)}${td(n < 0 ? rp(-n) : '', 1)}</tr>`; }).filter(Boolean);
  rows.push(`<tr class="tot"><td colspan="3">Total</td>${td(rp(D), 1)}${td(rp(C), 1)}</tr>`);
  return `<p class="muted">Per ${S.to || localDate()}</p>` + table(['Kode', 'Akun', 'Tipe', ['Debit', 1], ['Kredit', 1]], rows, { id: 't-tb' });
}
function rptUnit() {
  const rows = units().map(u => { const d = plData(S.from, S.to, u.id); const np = d.R - d.C - d.X + d.O;
    return `<tr><td>${esc(u.data.name)}</td>${td(rp(d.R), 1)}${td(rp(d.C), 1)}${td(rp(d.R - d.C), 1)}${td(pct(d.R ? (d.R - d.C) / d.R : NaN), 1)}${td(rp(d.X), 1)}${td(`<span class="${np < 0 ? 'neg' : ''}">${rp(np)}</span>`, 1)}</tr>`; });
  return `<p class="muted">Periode ${periodTxt()}</p>` + table(['Unit usaha', ['Penjualan', 1], ['HPP', 1], ['Laba kotor', 1], ['Margin', 1], ['Beban', 1], ['Laba bersih', 1]], rows);
}
window.printView = () => { $('#printArea').innerHTML = `<h2>${esc($('#pageTitle').textContent)}</h2>` + $('#rpt').innerHTML; window.print(); };

// ---- Master ----
PAGES.barang = () => `<div class="bar"><button data-new="item">+ Barang / produk</button><span class="sp"></span>${exportBtn('t-item')}</div>` +
  table(['Kode', 'Nama', 'Kategori', 'Satuan', ['Harga jual acuan', 1], 'Unit'], items().map(i =>
    `<tr class="click" data-edit="${i.id}"><td>${esc(i.data.code || '')}</td><td>${esc(i.data.name)}</td><td>${esc(CAT_LABEL[i.data.category] || '')}</td><td>${esc(i.data.uom || 'kg')}</td>${td(i.data.price ? rp(i.data.price) : '', 1)}<td>${esc(i.unit_id ? nm(i.unit_id) : 'Semua')}</td></tr>`), { id: 't-item' }) +
  `<p class="note"><b>Kategori menentukan akun persediaan:</b> ayam hidup → 1301, produk & sampingan → 1302, bahan pembantu → 1303. Harga jual acuan dipakai untuk membagi biaya produksi antar produk.</p>`;
FORMS.item = rec => openForm({ kind: 'item', title: 'Barang / Produk', rec, defaults: { category: 'product', uom: 'kg', code: nextCode('item', 'BRG') }, fields: [
  { k: 'code', label: 'No. barang (otomatis, boleh diubah)', req: true }, { k: 'name', label: 'Nama', req: true },
  { k: 'category', label: 'Kategori', type: 'select', options: Object.entries(CAT_LABEL), blank: null },
  { k: 'uom', label: 'Satuan', type: 'select', options: [['kg', 'kg'], ['ekor', 'ekor'], ['pcs', 'pcs'], ['pack', 'pack'], ['liter', 'liter'], ['balok', 'balok']], blank: null },
  { k: 'price', label: 'Harga jual acuan / satuan (Rp)', type: 'number' },
  { k: 'unit_id', label: 'Khusus unit (kosong = semua)', type: 'select', options: unitOpts, blank: 'Semua unit' },
  { k: 'note', label: 'Catatan', type: 'textarea', wide: true }],
  validate: d => { if (K('item').some(i => i.data.code === d.code && (!rec || i.id !== rec.id))) return `No. barang ${d.code} sudah dipakai`; } });

const VENDOR_CAT = [['peternak', 'Peternak / ayam hidup'], ['bahan', 'Bahan pembantu (es, plastik, gas)'], ['jasa', 'Jasa (transport, perbaikan)'], ['lain', 'Lainnya']];
const CUST_CAT = [['pasar', 'Pedagang pasar'], ['resto', 'Rumah makan / katering'], ['retail', 'Retail / supermarket'], ['distributor', 'Distributor / agen'], ['lain', 'Lainnya']];
function partnerPage(type) {
  const isV = type === 'supplier'; const list = partners(type).sort((a, b) => (a.data.code || '').localeCompare(b.data.code || '') || a.data.name.localeCompare(b.data.name));
  const head = isV ? ['No. vendor', 'Nama', 'Kategori', 'Kontak', 'Telepon', 'Rekening', ['Termin', 1], ['Saldo hutang', 1], 'Status']
    : ['No. customer', 'Nama', 'Segmen', 'Kontak', 'Telepon', ['Termin', 1], ['Limit kredit', 1], ['Saldo piutang', 1], 'Status'];
  return `<div class="bar"><button data-new="${isV ? 'vendor' : 'customer'}">+ ${isV ? 'Vendor' : 'Customer'}</button><span class="sp"></span>${exportBtn('t-' + type)}</div>` +
    table(head, list.map(p => { const d = p.data; const cat = Object.fromEntries(isV ? VENDOR_CAT : CUST_CAT)[d.category] || '';
      const bal = partnerBalance(p.id, isV ? '2101' : '1201'); const st = d.active === false ? badge('Nonaktif') : badge('Aktif', 'b-ok');
      return `<tr class="click" data-edit="${p.id}"><td>${esc(d.code || '')}</td><td>${esc(d.name)}${d.type === 'both' ? ' ' + badge('vendor+customer', 'b-info') : ''}</td><td>${esc(cat)}</td><td>${esc(d.contact || '')}</td><td>${esc(d.phone || '')}</td>` +
        (isV ? `<td>${esc([d.bank_name, d.bank_acc].filter(Boolean).join(' '))}</td>${td(fmt(num(d.terms), 0) + ' hr', 1)}${td(rp(bal), 1)}`
             : `${td(fmt(num(d.terms), 0) + ' hr', 1)}${td(d.credit_limit ? rp(d.credit_limit) : '-', 1)}${td(`<span class="${d.credit_limit && bal > d.credit_limit ? 'neg' : ''}">${rp(bal)}</span>`, 1)}`) + `<td>${st}</td></tr>`;
    }), { id: 't-' + type });
}
PAGES.vendor = () => partnerPage('supplier');
PAGES.customer = () => partnerPage('customer');
FORMS.partner = (rec, preset) => {
  const type = rec ? rec.data.type : preset; const isV = type !== 'customer';
  const pre = isV ? 'V' : 'C';
  const common = [
    { k: 'code', label: `No. ${isV ? 'vendor' : 'customer'} (otomatis, boleh diubah)`, req: true }, { k: 'name', label: 'Nama', req: true },
    { k: 'type', label: 'Tipe', type: 'select', options: [['supplier', 'Vendor / supplier'], ['customer', 'Customer'], ['both', 'Vendor sekaligus customer']], blank: null },
    { k: 'category', label: isV ? 'Kategori vendor' : 'Segmen customer', type: 'select', options: isV ? VENDOR_CAT : CUST_CAT },
    { k: 'contact', label: 'Nama kontak / PIC' }, { k: 'phone', label: 'Telepon / WA' }, { k: 'email', label: 'Email' }, { k: 'npwp', label: 'NPWP' },
    { k: 'terms', label: 'Termin bayar (hari)', type: 'number' },
  ];
  const vend = [{ k: 'bank_name', label: 'Bank' }, { k: 'bank_acc', label: 'No. rekening' }, { k: 'bank_holder', label: 'Atas nama rekening' }];
  const cust = [{ k: 'credit_limit', label: 'Limit kredit (Rp)', type: 'number' }];
  openForm({ kind: 'partner', title: isV ? 'Master Vendor' : 'Master Customer', rec,
    defaults: { type: preset || 'supplier', code: nextCode('partner', pre), terms: isV ? 7 : 14 },
    fields: [...common, ...(isV ? vend : cust),
      { k: 'active', label: 'Aktif', type: 'checkbox', def: true },
      { k: 'address', label: isV ? 'Alamat' : 'Alamat penagihan', type: 'textarea', wide: true },
      ...(isV ? [] : [{ k: 'ship_address', label: 'Alamat kirim (bila beda)', type: 'textarea', wide: true }]),
      { k: 'note', label: 'Catatan', type: 'textarea', wide: true }],
    canDelete: !rec || !S.recs.some(r => r.data && r.data.partner_id === rec.id),
    validate: d => { if (K('partner').some(p => p.data.code === d.code && (!rec || p.id !== rec.id))) return `No. ${d.code} sudah dipakai`; },
  });
};
FORMS.vendor = () => FORMS.partner(null, 'supplier');
FORMS.customer = () => FORMS.partner(null, 'customer');

// ---- Analisis kinerja, modal & termin ----
const SEG_TERM = { pasar: [0, 3], resto: [7, 14], retail: [30, 45], distributor: [7, 14], lain: [0, 7] };
PAGES.analisis = () => {
  const from = S.from || (S.recs.filter(r => r.date).map(r => r.date).sort()[0] || localDate()), to = S.to || localDate();
  const days = Math.max(1, daysBetween(from, to) + 1), ann = 365 / days, perMonth = 30 / days;
  const P = plData(from, to); const NI = P.R - P.C - P.X + P.O;
  const pos = date => { const b = balances(date); const sum = f => Object.entries(b).filter(([a]) => f(a)).reduce((x, [a, v]) => x + natural(a, v), 0);
    const pl = Object.entries(b).reduce((x, [a, v]) => { const t = accType(a); return x + (t === 'revenue' ? v.c - v.d : t === 'expense' ? -(v.d - v.c) : 0); }, 0);
    const A = sum(a => accType(a) === 'asset'), L = sum(a => accType(a) === 'liability'), Q = sum(a => accType(a) === 'equity') + pl;
    return { A, L, Q, CA: sum(a => /^1[1-4]/.test(a)), CL: sum(a => /^21/.test(a)), FA: sum(a => /^15/.test(a)), AR: sum(a => a === '1201'), AP: sum(a => a === '2101'),
      INV: sum(a => /^130/.test(a)), CASH: sum(a => accounts().some(x => x.cash && x.code === a)) };
  };
  const E1 = pos(to), E0 = pos(addDays(from, -1));
  const avgA = (E0.A + E1.A) / 2 || E1.A, avgQ = (E0.Q + E1.Q) / 2 || E1.Q;
  const dep = glF(l => l.acc === '6106' && l.date >= from && l.date <= to).reduce((a, l) => a + l.debit - l.credit, 0);
  const purch = glF(l => l.doc.kind === 'gr' && l.acc === '2101' && l.date >= from && l.date <= to).reduce((a, l) => a + l.credit, 0);
  const soKg = K('so').filter(r => inUnit(r) && r.date >= from && r.date <= to).reduce((a, r) => a + (r.data.lines || []).filter(l => (byId(l.item_id) || { data: {} }).data.category === 'product').reduce((x, l) => x + num(l.kg), 0), 0);
  const DSO = P.R ? E1.AR / (P.R / days) : NaN, DIO = P.C ? E1.INV / (P.C / days) : NaN, DPO = purch ? E1.AP / (purch / days) : NaN, CCC = DIO + DSO - DPO;
  const wcNeed = isFinite(CCC) ? Math.max(0, CCC) * (P.C / days) : NaN;
  const cashProfitM = (NI + dep) * perMonth;
  const invest = E1.FA + Math.max(0, E1.CA - E1.CL);
  const payback = cashProfitM > 0 ? invest / cashProfitM : NaN;
  const cmr = P.R ? (P.R - P.C) / P.R : NaN, fixedM = P.X * perMonth;
  const bepRev = cmr > 0 ? fixedM / cmr : NaN, revPerKg = soKg ? P.R / soKg : NaN;
  const k = (l, v, sub, bad) => `<div class="kpi"><small>${l}</small><b class="${bad ? 'neg' : ''}">${v}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
  const pctA = (v) => isFinite(v) ? pct(v) : '-';
  // termin
  const supW = {}; let supT = 0;
  for (const g of K('gr').filter(r => inUnit(r) && r.date >= from && r.date <= to)) { const v = (S.E.cost[g.id] || {}).total || 0; supT += v; supW[g.data.partner_id] = (supW[g.data.partner_id] || 0) + v; }
  const avgSupTerm = supT ? Object.entries(supW).reduce((a, [pid, v]) => a + num((byId(pid) || { data: {} }).data.terms) * v, 0) / supT : NaN;
  const basisTerm = isFinite(DPO) ? DPO : avgSupTerm;
  const recCust = isFinite(basisTerm) ? Math.max(0, Math.floor(basisTerm - (isFinite(DIO) ? DIO : 0))) : NaN;
  const custRows = partners('customer').map(p => { const d = p.data; const bal = partnerBalance(p.id, '1201'); const od = aging(p.id, 'so', '1201').filter(o => bucket(o.due) > 0).reduce((a, o) => a + o.rest, 0);
    const seg = SEG_TERM[d.category] || null; const t = num(d.terms);
    const flag = od > 0 ? badge('Ada tunggakan', 'b-bad') : isFinite(recCust) && t > recCust ? badge('Termin > batas aman', 'b-warn') : badge('OK', 'b-ok');
    return `<tr><td>${esc(d.code || '')} ${esc(d.name)}</td><td>${esc((CUST_CAT.find(c => c[0] === d.category) || [, '-'])[1])}</td>${td(t + ' hr', 1)}<td>${seg ? seg[0] + '–' + seg[1] + ' hr' : '-'}</td>${td(rp(bal), 1)}${td(od ? rp(od) : '', 1)}${td(d.credit_limit ? rp(d.credit_limit) : '-', 1)}<td>${flag}</td></tr>`; });
  const supRows = partners('supplier').filter(p => supW[p.id]).map(p => `<tr><td>${esc(p.data.code || '')} ${esc(p.data.name)}</td>${td(num(p.data.terms) + ' hr', 1)}${td(rp(supW[p.id]), 1)}${td(pct(supW[p.id] / supT), 1)}${td(rp(partnerBalance(p.id, '2101')), 1)}</tr>`);
  return `<p class="muted">Periode ${from} s/d ${to} (${days} hari) · ${S.unit === 'all' ? 'Semua unit' : esc(nm(S.unit))}. Rasio tahunan = rasio periode × 365/${days}. Periode pendek (&lt; 3 bulan) membuat angka tahunan sangat fluktuatif.</p>
  <h3>Profitabilitas</h3><div class="kpis">
    ${k('Pendapatan', rp(P.R), rp(P.R * perMonth) + '/bulan')}${k('Laba kotor', rp(P.R - P.C), 'margin ' + pctA(P.R ? (P.R - P.C) / P.R : NaN), P.R - P.C < 0)}
    ${k('Beban operasional', rp(P.X), pctA(P.R ? P.X / P.R : NaN) + ' dari pendapatan')}${k('Laba bersih', rp(NI), 'margin ' + pctA(P.R ? NI / P.R : NaN), NI < 0)}
    ${k('Harga jual rata2 produk utama', isFinite(revPerKg) ? rp(revPerKg) + '/kg' : '-', fmt(soKg) + ' kg terjual')}${k('EBITDA', rp(NI + dep), 'laba bersih + penyusutan ' + rp(dep))}
  </div>
  <h3>Imbal hasil (return)</h3><div class="kpis">
    ${k('ROA (tahunan)', pctA(avgA ? NI / avgA * ann : NaN), 'periode ' + pctA(avgA ? NI / avgA : NaN) + ' · rata2 aset ' + rp(avgA), NI < 0)}
    ${k('ROE (tahunan)', pctA(avgQ > 0 ? NI / avgQ * ann : NaN), 'periode ' + pctA(avgQ > 0 ? NI / avgQ : NaN) + ' · rata2 ekuitas ' + rp(avgQ), NI < 0)}
    ${k('Perputaran aset (tahunan)', isFinite(P.R / avgA) ? fmt(P.R / avgA * ann, 2) + '×' : '-', 'pendapatan ÷ aset')}
    ${k('Utang ÷ ekuitas', E1.Q > 0 ? fmt(E1.L / E1.Q, 2) + '×' : '-', 'kewajiban ' + rp(E1.L))}
  </div>
  <h3>Modal & investasi</h3><div class="kpis">
    ${k('Aset tetap (nilai buku)', rp(E1.FA))}${k('Modal kerja bersih', rp(E1.CA - E1.CL), 'aset lancar ' + rp(E1.CA) + ' − utang lancar ' + rp(E1.CL), E1.CA - E1.CL < 0)}
    ${k('Total modal tertanam', rp(invest), 'aset tetap + modal kerja')}
    ${k('Arus kas operasi est./bulan', rp(cashProfitM), 'laba bersih + penyusutan', cashProfitM < 0)}
    ${k('Payback period', isFinite(payback) ? fmt(payback, 1) + ' bulan' : 'tidak tercapai', isFinite(payback) ? '≈ ' + fmt(payback / 12, 1) + ' tahun' : 'arus kas negatif', !isFinite(payback))}
    ${k('Titik impas (BEP) / bulan', isFinite(bepRev) ? rp(bepRev) : '-', isFinite(bepRev) && isFinite(revPerKg) ? '≈ ' + fmt(bepRev / revPerKg, 0) + ' kg produk utama/bulan' : 'butuh data penjualan')}
  </div>
  <h3>Siklus kas & termin pembayaran</h3><div class="kpis">
    ${k('Lama stok (DIO)', isFinite(DIO) ? fmt(DIO, 1) + ' hari' : '-', 'persediaan ÷ HPP harian')}
    ${k('Lama tagih piutang (DSO)', isFinite(DSO) ? fmt(DSO, 1) + ' hari' : '-', 'piutang ÷ penjualan harian')}
    ${k('Lama bayar supplier (DPO)', isFinite(DPO) ? fmt(DPO, 1) + ' hari' : '-', 'termin master rata2 ' + (isFinite(avgSupTerm) ? fmt(avgSupTerm, 1) + ' hr' : '-'))}
    ${k('Siklus konversi kas (CCC)', isFinite(CCC) ? fmt(CCC, 1) + ' hari' : '-', 'DIO + DSO − DPO', CCC > 0)}
    ${k('Modal kerja yang terikat', isFinite(wcNeed) ? rp(wcNeed) : '-', 'CCC × HPP harian')}
    ${k('Batas aman termin customer', isFinite(recCust) ? recCust + ' hari' : '-', 'DPO − DIO: customer harus bayar sebelum supplier ditagih')}
  </div>
  <div class="card"><h3>Arti angka & rekomendasi termin</h3><ul style="margin:0;padding-left:18px;line-height:1.7">
    ${isFinite(CCC) ? (CCC > 0 ? `<li>Uang kamu "nyangkut" <b>${fmt(CCC, 1)} hari</b> antara bayar ayam ke peternak dan terima uang dari customer. Itu butuh modal kerja sekitar <b>${rp(wcNeed)}</b>. Setiap 1 hari termin customer dipercepat membebaskan ±<b>${rp(P.R / days)}</b>.</li>` : `<li>CCC ${fmt(CCC, 1)} hari (≤ 0): customer membayar sebelum supplier ditagih — posisi kas sehat, operasional dibiayai supplier.</li>`) : '<li>Belum cukup data (butuh penjualan, pembelian, dan HPP di periode ini).</li>'}
    <li><b>Aturan dasar:</b> termin customer ≤ termin supplier − lama stok. Ayam segar/karkas hanya bertahan 1–2 hari, jadi DIO idealnya ≤ 2 hari; kalau lebih, cek stok yang menumpuk.</li>
    <li><b>Patokan umum (perlu kamu cocokkan dengan kondisi lapangan):</b> peternak/broker ayam hidup biasanya minta tunai s/d 7 hari; pedagang pasar tunai–3 hari; rumah makan/katering & agen 7–14 hari; supermarket/retail modern 30–45 hari. Customer bertermin panjang sebaiknya diberi harga lebih tinggi (biaya modal) dan limit kredit.</li>
    <li>Pasang <b>limit kredit</b> di master customer — invoice yang membuat piutang melebihi limit akan ditandai merah.</li>
  </ul></div>
  <div class="grid2"><div><h3>Customer vs batas termin</h3>${table(['Customer', 'Segmen', ['Termin', 1], 'Patokan segmen', ['Saldo', 1], ['Tunggakan', 1], ['Limit', 1], 'Status'], custRows)}</div>
  <div><h3>Supplier (porsi pembelian periode ini)</h3>${table(['Supplier', ['Termin', 1], ['Pembelian', 1], ['Porsi', 1], ['Saldo hutang', 1]], supRows)}</div></div>
  <p class="note">Asumsi: HPP dianggap biaya variabel dan seluruh beban operasional (termasuk penyusutan) dianggap biaya tetap untuk BEP. ROE memakai ekuitas termasuk laba berjalan. Payback = (aset tetap + modal kerja) ÷ arus kas operasi bulanan; bukan pengganti NPV/IRR untuk keputusan investasi besar.</p>`;
};

// ---- Stok opname & penyesuaian ----
const ADJ_REASON = [['opname', 'Stok opname (hitung fisik)'], ['susut', 'Susut berat / penguapan di cold storage'], ['rusak', 'Rusak / busuk / afkir'], ['expired', 'Kedaluwarsa'], ['nrv', 'Penurunan nilai (harga pasar turun)']];
PAGES.adj = () => `<div class="bar"><button data-new="adj">+ Penyesuaian / opname</button><span class="sp"></span>${exportBtn('t-adj')}</div>` +
  table(['No', 'Tanggal', 'Unit', 'Alasan', ['Barang', 1], ['Rugi susut/selisih', 1], ['Selisih lebih', 1], ['Penurunan nilai', 1], 'Keterangan'], docs('adj').map(r => {
    const c = S.E.cost[r.id] || {};
    return `<tr class="click" data-edit="${r.id}"><td>${esc(r.no)}</td><td>${r.date}</td><td>${esc(nm(r.unit_id))}</td><td>${esc(Object.fromEntries(ADJ_REASON)[r.data.reason] || '')}</td>${td((r.data.lines || []).length, 1)}${td(c.loss ? rp(c.loss) : '', 1)}${td(c.gain ? rp(c.gain) : '', 1)}${td(c.wd ? rp(c.wd) : '', 1)}<td>${esc(r.data.note || '')}</td></tr>`;
  }), { id: 't-adj' }) +
  `<p class="note"><b>Cara isi:</b> isi <i>Qty fisik</i> bila menghitung ulang stok (selisih dihitung otomatis terhadap stok sistem pada tanggal itu), <i>atau</i> isi <i>Qty dibuang</i> untuk barang rusak/busuk. <i>Penurunan nilai</i> dipakai bila barang masih ada tapi nilainya turun (mis. karkas jadi produk afkir). Rugi masuk akun 5102/5103 dengan nilai rata-rata persediaan.</p>`;
FORMS.adj = rec => openForm({
  kind: 'adj', title: 'Stok Opname & Penyesuaian', rec, defaults: { date: localDate(), unit_id: defaultUnit(), reason: 'opname' },
  fields: [{ k: 'date', label: 'Tanggal', type: 'date', req: true }, unitField(),
    { k: 'reason', label: 'Alasan', type: 'select', options: ADJ_REASON, blank: null }, { k: 'checker', label: 'Dihitung / disetujui oleh' },
    { k: 'note', label: 'Keterangan', type: 'textarea', wide: true }],
  tables: [{ k: 'lines', label: 'Barang', cols: [
    { k: 'item_id', label: 'Barang', type: 'select', options: itemOpts(), w: '30%' },
    { k: 'sys', label: 'Stok sistem (saat ini)', calc: (r, h) => { const s = S.E.stock.get((h.unit_id || defaultUnit()) + '|' + r.item_id); return s ? `${fmt(s.qty)}${s.ekor ? ' / ' + fmt(s.ekor, 0) + ' ekor' : ''} · ${s.qty > 0 ? rp(s.value / s.qty) + '/sat' : ''}` : '-'; } },
    { k: 'kg_actual', label: 'Qty fisik', type: 'number', nullable: true }, { k: 'ekor_actual', label: 'Ekor fisik', type: 'number', nullable: true },
    { k: 'kg_out', label: 'Qty dibuang/rusak', type: 'number' }, { k: 'writedown', label: 'Penurunan nilai (Rp)', type: 'number' }, { k: 'note', label: 'Ket.' }] }],
  calc: d => {
    let est = 0; const u = d.unit_id || defaultUnit();
    for (const l of d.lines || []) { const s = S.E.stock.get(u + '|' + l.item_id); if (!s) continue; const avg = s.qty > 0 ? s.value / s.qty : 0;
      const diff = l.kg_actual !== null && l.kg_actual !== undefined ? l.kg_actual - s.qty : -num(l.kg_out); est += diff * avg - num(l.writedown); }
    return `Perkiraan dampak ke laba: <b class="${est < 0 ? 'neg' : 'pos'}">${rp(est)}</b> <span class="muted">(dihitung dari stok & harga rata-rata saat ini; angka final memakai posisi stok pada tanggal penyesuaian)</span>`;
  },
  validate: d => { if (!(d.lines || []).length) return 'Isi minimal satu barang'; if (d.lines.some(l => !l.item_id)) return 'Setiap baris wajib barang';
    if (d.lines.some(l => (l.kg_actual === null || l.kg_actual === undefined) && !l.kg_out && !l.writedown && (l.ekor_actual === null || l.ekor_actual === undefined))) return 'Isi qty fisik, qty dibuang, atau penurunan nilai di setiap baris'; },
});

// ---- Aset tetap & penyusutan ----
const ASSET_CAT = [['bangunan', 'Bangunan (20 th)', 240], ['mesin', 'Mesin & peralatan potong (8 th)', 96], ['kendaraan', 'Kendaraan (8 th)', 96], ['pendingin', 'Cold storage / freezer (8 th)', 96], ['peralatan', 'Peralatan kecil, timbangan, IT (4 th)', 48], ['tanah', 'Tanah (tidak disusutkan)', 0]];
function assetAt(a, asOf) { const c = S.E.cost[a.id] || { rows: [], monthly: 0 }; const acc = num(a.data.opening_accum) + c.rows.filter(x => x.date <= asOf).reduce((s, x) => s + x.amt, 0); return { acc, book: num(a.data.cost) - acc, monthly: c.monthly }; }
PAGES.aset = () => {
  const asOf = S.to || localDate(); const list = K('asset').filter(inUnit).sort((a, b) => (a.data.code || '').localeCompare(b.data.code || ''));
  let T = [0, 0, 0, 0];
  const rows = list.map(a => { const d = a.data; const x = assetAt(a, asOf); const sold = d.dispose_date && d.dispose_date <= asOf;
    if (!sold) { T[0] += num(d.cost); T[1] += x.monthly; T[2] += x.acc; T[3] += x.book; }
    return `<tr class="click" data-edit="${a.id}"><td>${esc(d.code || '')}</td><td>${esc(d.name)}</td><td>${esc((ASSET_CAT.find(c => c[0] === d.category) || [, ''])[1])}</td><td>${a.date}</td>${td(rp(d.cost), 1)}${td(fmt(num(d.life_months), 0), 1)}${td(rp(x.monthly), 1)}${td(rp(x.acc), 1)}${td(rp(x.book), 1)}<td>${sold ? badge('Dilepas ' + d.dispose_date) : x.book <= num(d.residual) + 0.5 && num(d.life_months) ? badge('Habis disusutkan', 'b-warn') : badge('Aktif', 'b-ok')}</td></tr>`; });
  rows.push(`<tr class="tot"><td colspan="4">Total aset aktif</td>${td(rp(T[0]), 1)}<td></td>${td(rp(T[1]), 1)}${td(rp(T[2]), 1)}${td(rp(T[3]), 1)}<td></td></tr>`);
  return `<div class="bar"><button data-new="asset">+ Aset tetap</button><span class="muted">Posisi per ${asOf}</span><span class="sp"></span>${exportBtn('t-aset')}</div>` +
    table(['No. aset', 'Nama', 'Kategori', 'Tgl perolehan', ['Harga perolehan', 1], ['Umur (bln)', 1], ['Penyusutan/bln', 1], ['Akumulasi', 1], ['Nilai buku', 1], 'Status'], rows, { id: 't-aset' }) +
    `<p class="note">Metode garis lurus: (harga perolehan − nilai sisa) ÷ umur. Penyusutan dijurnal otomatis setiap akhir bulan mulai bulan setelah perolehan (Dr 6106 Beban Penyusutan / Cr 1502 Akumulasi). Umur default mengikuti kelompok fiskal; untuk laporan komersial boleh diubah sesuai taksiran manfaat.</p>`;
};
FORMS.asset = rec => openForm({
  kind: 'asset', title: 'Aset Tetap', rec, defaults: { date: localDate(), unit_id: defaultUnit(), code: nextCode('asset', 'AT'), category: 'mesin', life_months: 96, residual: 0, funding: '1102' },
  fields: [
    { k: 'code', label: 'No. aset (otomatis)', req: true }, { k: 'name', label: 'Nama aset', req: true },
    { k: 'category', label: 'Kategori', type: 'select', options: ASSET_CAT.map(c => [c[0], c[1]]), blank: null, onChange: v => { const c = ASSET_CAT.find(x => x[0] === v); if (c) $('#frm').elements['f:life_months'].value = c[2]; } },
    unitField(), { k: 'date', label: 'Tanggal perolehan', type: 'date', req: true },
    { k: 'cost', label: 'Harga perolehan (Rp)', type: 'number', req: true }, { k: 'residual', label: 'Nilai sisa (Rp)', type: 'number' },
    { k: 'life_months', label: 'Umur manfaat (bulan)', type: 'number' },
    { k: 'funding', label: 'Dibayar dari', type: 'select', blank: null, options: () => [...accounts().filter(a => a.cash).map(a => [a.code, a.code + ' · ' + a.name]), ['2102', '2102 · Hutang lain-lain (kredit)'], ['2201', '2201 · Hutang bank'], ['3101', '3101 · Modal pemilik / saldo awal'], ['none', 'Sudah dicatat lewat Kas/Jurnal (jangan jurnal lagi)']],
      hint: 'Jangan catat lagi di Kas, supaya tidak dobel' },
    { k: 'opening_accum', label: 'Akumulasi penyusutan awal (aset lama)', type: 'number', hint: 'Isi bila aset sudah dipakai sebelum memakai aplikasi ini' },
    { k: 'location', label: 'Lokasi / penanggung jawab' }, { k: 'serial', label: 'No. seri / plat / sertifikat' },
    { k: 'dispose_date', label: 'Tanggal dijual / dilepas', type: 'date' }, { k: 'sale_price', label: 'Harga jual saat dilepas (Rp)', type: 'number' },
    { k: 'sale_account', label: 'Hasil jual masuk ke', type: 'select', options: cashAccOpts, blank: null },
    { k: 'note', label: 'Catatan', type: 'textarea', wide: true },
  ],
  calc: d => { const m = num(d.life_months) ? (num(d.cost) - num(d.residual)) / num(d.life_months) : 0;
    return m ? `Penyusutan <b>${rp(m)}/bulan</b> · ${rp(m * 12)}/tahun · sisa yang akan disusutkan ${rp(num(d.cost) - num(d.residual) - num(d.opening_accum))}` : 'Tidak disusutkan'; },
  validate: d => { if (!(d.cost > 0)) return 'Harga perolehan wajib > 0'; if (d.residual >= d.cost) return 'Nilai sisa harus lebih kecil dari harga perolehan';
    if (num(d.opening_accum) > d.cost - num(d.residual)) return 'Akumulasi awal melebihi nilai yang dapat disusutkan';
    if (d.dispose_date && d.dispose_date < d.date) return 'Tanggal pelepasan sebelum tanggal perolehan';
    if (K('asset').some(a => a.data.code === d.code && (!rec || a.id !== rec.id))) return `No. aset ${d.code} sudah dipakai`; },
});

PAGES.unit = () => `<div class="bar"><button data-new="unit">+ Unit usaha</button><span class="muted">Tambah unit untuk ekspansi (mis. distribusi daging, pakan, peternakan, frozen food). Semua modul otomatis bisa dipakai per unit.</span></div>` +
  table(['Kode', 'Nama', 'Keterangan', ['Transaksi', 1]], units().map(u => `<tr class="click" data-edit="${u.id}"><td>${esc(u.data.code || '')}</td><td>${esc(u.data.name)}</td><td>${esc(u.data.desc || '')}</td>${td(S.recs.filter(r => r.unit_id === u.id && DATED.has(r.kind)).length, 1)}</tr>`));
FORMS.unit = rec => openForm({ kind: 'unit', title: 'Unit Usaha', rec, canDelete: !rec || !S.recs.some(r => r.unit_id === rec.id && DATED.has(r.kind)),
  fields: [{ k: 'code', label: 'Kode singkat' }, { k: 'name', label: 'Nama unit', req: true }, { k: 'desc', label: 'Keterangan', type: 'textarea', wide: true }] });

PAGES.akun = () => `<div class="bar"><button data-new="account">+ Akun</button><span class="muted">Akun bawaan bisa diganti namanya dengan membuat akun berkode sama.</span></div>` +
  table(['Kode', 'Nama', 'Tipe', 'Kas/Bank', 'Sumber'], accounts().map(a => `<tr class="${a.id ? 'click' : ''}" ${a.id ? `data-edit="${a.id}"` : `data-newacc="${a.code}"`}><td>${a.code}</td><td>${esc(a.name)}</td><td>${TYPE_LABEL[a.type]}</td><td>${a.cash ? '✓' : ''}</td><td>${a.id ? 'Custom' : '<span class="muted">Bawaan</span>'}</td></tr>`));
FORMS.account = (rec, code) => {
  const base = code ? accounts().find(a => a.code === code) : null;
  openForm({ kind: 'account', title: 'Akun', rec, defaults: base ? { code: base.code, name: base.name, type: base.type, cash: base.cash } : { type: 'expense' }, fields: [
    { k: 'code', label: 'Kode (4 digit, awalan 1-6)', req: true }, { k: 'name', label: 'Nama akun', req: true },
    { k: 'type', label: 'Tipe', type: 'select', options: Object.entries(TYPE_LABEL), blank: null }, { k: 'cash', label: 'Akun kas / bank?', type: 'checkbox' }],
    validate: d => { if (!/^[1-9]\d{3,5}$/.test(d.code)) return 'Kode akun harus angka 4–6 digit'; const dup = K('account').find(a => a.data.code === d.code && (!rec || a.id !== rec.id)); if (dup) return 'Kode sudah ada'; } });
};

PAGES.setting = () => {
  const l = lockDate();
  return `<div class="grid2"><div class="card"><h3>Mode penyimpanan</h3>
    <p>${Store.mode === 'cloud' ? '<span class="badge b-ok">Cloudflare D1</span> Data tersimpan di database server dan bisa diakses semua perangkat.' : '<span class="badge b-warn">Demo lokal</span> Data hanya tersimpan di browser ini. Deploy ke Cloudflare agar data aman & bisa dipakai bersama.'}</p>
    ${Store.mode === 'cloud' && Store.needAuth ? '<button class="ghost" id="tokenBtn">Ganti token akses</button>' : ''}</div>
  <div class="card"><h3>Kop dokumen (surat jalan, bukti masuk, invoice)</h3>
    ${(() => { const c = (byId('setting-company') || { data: {} }).data; return `<div class="fgrid" id="coForm">
      <label>Nama usaha<input id="co_name" value="${esc(c.name || '')}"></label><label>Telepon<input id="co_phone" value="${esc(c.phone || '')}"></label>
      <label>NPWP<input id="co_npwp" value="${esc(c.npwp || '')}"></label><label>Rekening pembayaran<input id="co_bank" value="${esc(c.bank || '')}" placeholder="BCA 123xxx a.n. ..."></label>
      <label class="wide">Alamat<input id="co_address" value="${esc(c.address || '')}"></label></div><button id="coBtn">Simpan kop</button>`; })()}</div>
  <div class="card"><h3>Tutup buku (kunci periode)</h3><p class="muted">Transaksi bertanggal sampai tanggal ini tidak bisa ditambah/diubah/dihapus.</p>
    <div class="bar"><input type="date" id="lockInp" value="${esc(l)}"><button id="lockBtn">Simpan kunci</button></div></div>
  <div class="card"><h3>Backup & restore</h3><p class="muted">Simpan backup rutin (mingguan). File JSON berisi seluruh data.</p>
    <div class="bar"><button class="ghost" id="bkBtn">Download backup JSON</button><label class="ghost" style="cursor:pointer">Restore: <input type="file" id="rsInp" accept=".json"></label></div></div>
  <div class="card"><h3>Mulai cepat</h3><p class="muted">Isi master contoh untuk RPA: ayam hidup, karkas, ati ampela, ceker, kepala, usus, bulu/limbah, es balok, plastik, akun bank. Tidak menghapus data yang ada.</p>
    <button class="ghost" id="seedBtn">Isi master contoh RPA</button></div></div>`;
};
async function seedMaster() {
  const have = new Set(K('item').map(i => i.data.name.toLowerCase()));
  const list = [
    ['AH', 'Ayam Hidup (broiler)', 'live', 'kg', 0], ['KRK', 'Karkas Ayam', 'product', 'kg', 0], ['AA', 'Ati Ampela', 'byproduct', 'kg', 0],
    ['CKR', 'Ceker', 'byproduct', 'kg', 0], ['KPL', 'Kepala & Leher', 'byproduct', 'kg', 0], ['USS', 'Usus', 'byproduct', 'kg', 0],
    ['BL', 'Bulu / Limbah', 'byproduct', 'kg', 0], ['ES', 'Es Balok', 'supplies', 'balok', 0], ['PLS', 'Plastik Kemasan', 'supplies', 'pack', 0],
  ];
  const used = [];
  for (const [, name, category, uom, price] of list) if (!have.has(name.toLowerCase())) { const code = nextCode('item', 'BRG', used); used.push(code); await Store.save({ kind: 'item', data: { code, name, category, uom, price } }); }
  toast('Master contoh ditambahkan. Isi harga jual acuan tiap produk di menu Barang.');
  await refresh();
}

// ---------- token ----------
function askToken() {
  FORM = null;
  $('#modalBox').innerHTML = `<h2>Token akses</h2><p class="muted">Server ini dilindungi token. Masukkan token yang diatur di Cloudflare (APP_TOKEN).</p>
    <form id="tkF" class="bar"><input type="password" id="tkI" style="flex:1" value=""><button>Masuk</button></form>`;
  $('#modal').classList.remove('hidden');
  $('#tkF').onsubmit = async e => { e.preventDefault(); Store.token = $('#tkI').value.trim(); Store.lsSet('erp_token', Store.token); closeModal(); boot(); };
}

// ---------- CSV ----------
function exportCsv(id) {
  const t = document.getElementById(id); if (!t) return;
  const csv = $$('tr', t).map(tr => $$('th,td', tr).map(c => `"${c.innerText.replace(/"/g, '""').trim()}"`).join(';')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `${id.replace('t-', '')}_${localDate()}.csv`; document.body.appendChild(a); a.click(); a.remove();
}

// ---------- event ----------
document.addEventListener('click', async e => {
  const t = e.target;
  const nw = t.closest('[data-new]');
  if (nw) { const k = nw.dataset.new; FORMS[k](null, nw.dataset.cat);
    if (nw.dataset.partnerPre) { const el = $('#frm').elements['f:partner_id']; el.value = nw.dataset.partnerPre; el.dispatchEvent(new Event('change', { bubbles: true })); }
    return; }
  const ed = t.closest('[data-edit]');
  if (ed && !t.closest('button')) { const r = byId(ed.dataset.edit); if (r && FORMS[r.kind]) FORMS[r.kind](r); return; }
  const na = t.closest('[data-newacc]'); if (na) return FORMS.account(null, na.dataset.newacc);
  const go = t.closest('[data-go]'); if (go) { location.hash = go.dataset.go; return; }
  const tab = t.closest('[data-tab]'); if (tab) { e.preventDefault(); const [p, v] = tab.dataset.tab.split(':'); S.tab[p] = v; render(); return; }
  const pt = t.closest('[data-partner]'); if (pt) { const type = location.hash.slice(1) === 'piutang' ? 'customer' : 'supplier'; S.tab[type] = pt.dataset.partner; render(); return; }
  const kt = t.closest('[data-kartu]'); if (kt) { S.tab.kartu = kt.dataset.kartu; location.hash = 'kartu'; return; }
  const lg = t.closest('[data-ledger]'); if (lg) { S.tab.ledger = lg.dataset.ledger; location.hash = 'ledger'; return; }
  const dv = t.closest('[data-deliv]'); if (dv) { const [id, st] = dv.dataset.deliv.split('|'); return setDelivery(id, st); }
  const ex = t.closest('[data-export]'); if (ex) return exportCsv(ex.dataset.export);
  if (t.id === 'menuBtn') return $('#side').classList.toggle('open');
  if (t.id === 'seedBtn') return seedMaster().catch(handleErr);
  if (t.id === 'tokenBtn') return askToken();
  if (t.id === 'coBtn') {
    const prev = byId('setting-company'); const data = {};
    for (const k of ['name', 'phone', 'npwp', 'bank', 'address']) data[k] = $('#co_' + k).value.trim();
    try { await Store.save({ ...(prev || {}), id: 'setting-company', kind: 'setting', data }); toast('Kop dokumen disimpan'); await refresh(); } catch (err) { handleErr(err); }
    return;
  }
  if (t.id === 'lockBtn') {
    const v = $('#lockInp').value; const prev = byId('setting-lock');
    try { await Store.save({ ...(prev || {}), id: 'setting-lock', kind: 'setting', data: { lock_date: v } }); toast(v ? 'Periode dikunci s/d ' + v : 'Kunci dibuka'); await refresh(); } catch (err) { handleErr(err); }
    return;
  }
  if (t.id === 'bkBtn') {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'erp-rpa', exported_at: nowIso(), records: S.recs }, null, 1)], { type: 'application/json' }));
    a.download = `backup-erp-rpa-${localDate()}.json`; document.body.appendChild(a); a.click(); a.remove(); return;
  }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'unitSel') { S.unit = t.value; Store.lsSet('erp_unit', S.unit); S.E = engine(); render(); }
  if (t.id === 'fromSel') { S.from = t.value; render(); }
  if (t.id === 'toSel') { S.to = t.value; render(); }
  if (t.id === 'kartuSel') { S.tab.kartu = t.value; render(); }
  if (t.id === 'ledgerSel') { S.tab.ledger = t.value; render(); }
  if (t.id === 'rsInp' && t.files[0]) {
    try { const j = JSON.parse(await t.files[0].text()); if (!Array.isArray(j.records)) throw new Error('File bukan backup ERP RPA');
      await Store.importAll(j.records); toast(`Restore ${j.records.length} data selesai`); await refresh(); } catch (err) { handleErr(err); }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(); });
window.addEventListener('hashchange', render);

// ---------- boot ----------
async function boot() {
  await Store.init();
  $('#modeTag').textContent = Store.mode === 'cloud' ? 'Cloudflare D1' : 'Mode demo (lokal)';
  const t = localDate(); S.from = t.slice(0, 8) + '01'; S.to = t;
  S.unit = Store.lsGet('erp_unit') || 'all';
  try { await reload(); if (S.unit !== 'all' && !byId(S.unit)) S.unit = 'all'; render(); }
  catch (e) { if (e.auth) return askToken(); $('#view').innerHTML = `<div class="alert">Gagal memuat data: ${esc(e.message)}</div>`; }
}
boot();
