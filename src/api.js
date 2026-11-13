// Cloudflare Pages Function — API ERP RPA
// Rute:
//   GET    /api/health
//   GET    /api/records            -> semua record aktif
//   POST   /api/records            -> simpan (create/update) satu record
//   DELETE /api/records/:id        -> hapus (soft delete)
//   POST   /api/import             -> impor banyak record (restore backup)
//   GET    /api/audit/:id          -> riwayat perubahan satu record

const KINDS = new Set(['unit', 'item', 'partner', 'vehicle', 'account', 'po', 'gr', 'prod', 'adj', 'do', 'so', 'cash', 'jv', 'asset', 'price', 'setting']);
const PREFIX = { po: 'PO', gr: 'GR', prod: 'PRD', adj: 'ADJ', do: 'DO', so: 'INV', cash: 'KAS', jv: 'JV', price: 'HRG' };
const DATED = new Set(['po', 'gr', 'prod', 'adj', 'do', 'so', 'cash', 'jv', 'asset', 'price']);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const nowIso = () => new Date().toISOString();

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const route = parts.join('/');
  const method = request.method;

  if (route === 'health') {
    return json({ ok: true, app: 'erp-rpa', needAuth: !!env.APP_TOKEN, db: !!env.DB });
  }
  if (!env.DB) return json({ error: 'Binding D1 "DB" belum dipasang. Cek wrangler.toml / pengaturan Pages.' }, 500);

  // Autentikasi sederhana: token bersama (APP_TOKEN). Untuk produksi, tambahkan Cloudflare Access.
  if (env.APP_TOKEN && request.headers.get('x-app-token') !== env.APP_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  const user = request.headers.get('cf-access-authenticated-user-email') || request.headers.get('x-app-user') || 'user';

  try {
    if (route === 'records' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM records WHERE deleted = 0 ORDER BY date, created_at').all();
      return json({ records: results.map(rowToRec) });
    }
    if (route === 'records' && method === 'POST') {
      const rec = await request.json();
      const saved = await saveRecord(env, rec, user);
      return json({ record: saved });
    }
    if (parts[0] === 'records' && parts[1] && method === 'DELETE') {
      const id = parts[1];
      const row = await env.DB.prepare('SELECT * FROM records WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'Data tidak ditemukan' }, 404);
      await assertNotLocked(env, row.kind, row.date);
      await env.DB.batch([
        env.DB.prepare('UPDATE records SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ?').bind(nowIso(), user, id),
        env.DB.prepare('INSERT INTO audit (record_id, kind, action, data, at, by_user) VALUES (?,?,?,?,?,?)').bind(id, row.kind, 'delete', row.data, nowIso(), user),
      ]);
      return json({ ok: true });
    }
    if (route === 'import' && method === 'POST') {
      const body = await request.json();
      const list = Array.isArray(body.records) ? body.records : [];
      const stmts = [];
      const t = nowIso();
      for (const r of list) {
        if (!r || !KINDS.has(r.kind) || !r.id) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO records (id, kind, unit_id, date, no, status, data, created_at, updated_at, created_by, updated_by, deleted)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,0)
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, unit_id=excluded.unit_id, date=excluded.date, no=excluded.no,
               status=excluded.status, data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by, deleted=0`
          ).bind(r.id, r.kind, r.unit_id || null, r.date || null, r.no || null, r.status || null, JSON.stringify(r.data || {}),
            r.created_at || t, t, user, user)
        );
      }
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      return json({ ok: true, imported: stmts.length });
    }
    if (parts[0] === 'audit' && parts[1] && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM audit WHERE record_id = ? ORDER BY id DESC LIMIT 100').bind(parts[1]).all();
      return json({ audit: results });
    }
    return json({ error: 'Rute tidak dikenal' }, 404);
  } catch (e) {
    const status = e.status || 500;
    return json({ error: e.message || String(e) }, status);
  }
}

function rowToRec(r) {
  let data = {};
  try { data = JSON.parse(r.data); } catch {}
  return { id: r.id, kind: r.kind, unit_id: r.unit_id, date: r.date, no: r.no, status: r.status, data,
    created_at: r.created_at, updated_at: r.updated_at, created_by: r.created_by, updated_by: r.updated_by };
}

function httpError(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

async function assertNotLocked(env, kind, date) {
  if (!DATED.has(kind) || !date) return;
  const row = await env.DB.prepare("SELECT data FROM records WHERE id = 'setting-lock' AND deleted = 0").first();
  if (!row) return;
  let lock = null;
  try { lock = JSON.parse(row.data).lock_date; } catch {}
  if (lock && date <= lock) throw httpError(`Periode sampai ${lock} sudah dikunci (tutup buku). Buka kunci di Pengaturan bila perlu.`, 409);
}

async function nextNo(env, kind, date) {
  const prefix = PREFIX[kind];
  const ym = (date || nowIso().slice(0, 10)).slice(2, 7).replace('-', ''); // YYMM
  const like = `${prefix}-${ym}-%`;
  const row = await env.DB.prepare('SELECT no FROM records WHERE kind = ? AND no LIKE ? ORDER BY no DESC LIMIT 1').bind(kind, like).first();
  const last = row ? parseInt(String(row.no).split('-').pop(), 10) || 0 : 0;
  return `${prefix}-${ym}-${String(last + 1).padStart(4, '0')}`;
}

async function saveRecord(env, rec, user) {
  if (!rec || !KINDS.has(rec.kind)) throw httpError('Jenis data tidak valid');
  if (DATED.has(rec.kind) && !/^\d{4}-\d{2}-\d{2}$/.test(rec.date || '')) throw httpError('Tanggal wajib diisi (YYYY-MM-DD)');
  const t = nowIso();
  const id = rec.id || crypto.randomUUID();
  const existing = await env.DB.prepare('SELECT * FROM records WHERE id = ?').bind(id).first();
  if (existing) await assertNotLocked(env, existing.kind, existing.date); // tanggal lama
  await assertNotLocked(env, rec.kind, rec.date);                        // tanggal baru

  let no = rec.no || (existing && existing.no) || null;
  const data = JSON.stringify(rec.data || {});
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!no && PREFIX[rec.kind]) no = await nextNo(env, rec.kind, rec.date);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO records (id, kind, unit_id, date, no, status, data, created_at, updated_at, created_by, updated_by, deleted)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,0)
           ON CONFLICT(id) DO UPDATE SET unit_id=excluded.unit_id, date=excluded.date, no=excluded.no, status=excluded.status,
             data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by, deleted=0`
        ).bind(id, rec.kind, rec.unit_id || null, rec.date || null, no, rec.status || null, data,
          existing ? existing.created_at : t, t, existing ? existing.created_by : user, user),
        env.DB.prepare('INSERT INTO audit (record_id, kind, action, data, at, by_user) VALUES (?,?,?,?,?,?)')
          .bind(id, rec.kind, existing ? 'update' : 'create', data, t, user),
      ]);
      break;
    } catch (e) {
      // Nomor dokumen bentrok (dua user simpan bersamaan) -> ambil nomor berikutnya
      if (/UNIQUE/i.test(e.message) && !rec.no && attempt < 2) { no = null; continue; }
      if (/UNIQUE/i.test(e.message)) throw httpError(`Nomor dokumen ${no} sudah dipakai`, 409);
      throw e;
    }
  }
  const row = await env.DB.prepare('SELECT * FROM records WHERE id = ?').bind(id).first();
  return rowToRec(row);
}
