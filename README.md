# ERP RPA — Finance, Purchasing & Logistik

Web app untuk usaha pemotongan ayam (RPA), bisa dipakai untuk unit usaha lain.
Hosting: **Cloudflare Workers** (frontend + API) + **Cloudflare D1** (database SQL). Paket gratis Cloudflare cukup untuk usaha kecil–menengah.

## Modul
| Area | Isi |
|---|---|
| Purchasing | Purchase Order, Penerimaan Barang (timbang kandang vs timbang RPA, ekor mati/DOA, susut), Kinerja Supplier (biaya efektif/kg) |
| Logistik | Pemotongan/Produksi (rendemen karkas, alokasi biaya ke produk), Stok, Kartu Stok, Pengiriman (status DO), Armada & Driver |
| Penjualan | **Delivery Order / Surat Jalan** (barang keluar) → **Invoice** (tagihan dari satu/lebih DO, atau penjualan langsung), limit kredit, status bayar |
| Dokumen cetak | Surat Jalan (2 lembar), Bukti Penerimaan Barang (2 lembar, opsi dengan harga), Invoice — kop diatur di Pengaturan |
| Finance | Kas & Bank, Hutang & Piutang (umur/aging FIFO), Jurnal Umum, Buku Besar, Laba Rugi, Neraca, Neraca Saldo, Laba per Unit |
| Master | Barang (No. barang otomatis BRG-0001), Vendor (V-0001, rekening bank), Customer (C-0001, limit kredit, alamat kirim), Unit Usaha, Bagan Akun, Tutup buku, Backup/restore |

Semua jurnal dibuat otomatis dari transaksi. Edit transaksi → stok, HPP, jurnal, dan laporan ikut terhitung ulang.

## Deploy (Cloudflare Workers + D1)
Database D1 `erp-rpa-db` sudah dibuat dan ID-nya ada di `wrangler.toml`.

**Lewat GitHub (otomatis):** Workers & Pages → Worker `erp-system` → Settings → Build → hubungkan repo ini.
Deploy command: `npx wrangler deploy` (default). Setiap push ke `main` = deploy ulang.

**Manual dari komputer:**
```bash
npm install
npx wrangler login
npm run deploy
```
Alamat: `https://erp-system.<subdomain-akun>.workers.dev`

Membuat database baru dari nol: `npx wrangler d1 create erp-rpa-db`, salin ID ke `wrangler.toml`, lalu `npm run db:init:remote`.

### Wajib: kunci akses
Tanpa ini, siapa pun yang tahu alamatnya bisa melihat & mengubah data.
1. **Cloudflare Access (disarankan)**: Dashboard → Zero Trust → Access → Applications → Add → Self-hosted → domain `erp-system.<subdomain>.workers.dev` → policy "Emails" berisi email tim. Gratis s/d 50 user. Email user otomatis tercatat di jejak audit.
2. **Tambahan / alternatif cepat** — token bersama:
   ```bash
   npx wrangler secret put APP_TOKEN   # isi kata sandi panjang
   npm run deploy
   ```
   Aplikasi akan meminta token saat dibuka.

## Jalankan di komputer sendiri
```bash
npm install
npm run db:init:local
npm run dev        # buka http://localhost:8787
```
Membuka `public/index.html` langsung (tanpa server) = **mode demo**: data hanya di browser itu.

## Mulai pakai
1. Pengaturan → **Isi master contoh RPA**, lalu isi **harga jual acuan** tiap produk di menu Barang (dipakai untuk membagi biaya produksi).
2. Input saldo awal lewat **Jurnal Umum** (kas, bank, aset tetap, hutang/piutang lama per mitra, modal).
3. Alur harian: PO → Penerimaan → Pemotongan → Penjualan (+ pengiriman) → Kas (bayar/terima).
4. Akhir bulan: jurnal penyusutan & akrual, cek Neraca Saldo, lalu **Tutup buku** di Pengaturan. Download backup.

## Ekspansi ke usaha lain
Tambah **Unit Usaha** (mis. distribusi frozen food, pakan, peternakan). Barang, supplier, transaksi, dan laporan bisa difilter per unit; laporan "Laba per Unit" membandingkan semuanya.

## Batasan yang perlu diketahui
- **Metode biaya**: rata-rata bergerak (moving average). Biaya produksi bersama dialokasikan berdasarkan nilai jual acuan (kg × harga). Bila harga acuan tidak diperbarui, HPP per produk akan bias.
- **Susut & ayam mati** dibebankan ke biaya persediaan (bukan beban terpisah). Bila ingin dilaporkan terpisah, buat jurnal koreksi ke akun 5102.
- **DO vs invoice**: DO mengurangi stok dan memindahkan nilainya ke akun 1304 (Barang Terkirim Belum Ditagih). HPP baru diakui saat invoice dibuat. Saldo 1304 di akhir bulan = DO yang belum ditagih — cek menu DO sebelum tutup buku.
- **Pajak** (PPN/PPh) belum dihitung otomatis. Gunakan Jurnal Umum.
- **Uang muka** ke supplier/customer belum punya alur khusus — catat via Jurnal Umum ke akun 1202.
- **Transaksi antar unit** belum memakai akun antar-kantor; neraca per unit hanya akurat bila kas dicatat di unit yang benar.
- **Skala**: semua data dimuat ke browser saat dibuka. Nyaman sampai kira-kira 10–20 ribu transaksi; setelah itu perlu filter di sisi server.
- **Hak akses per peran** (admin gudang vs keuangan) belum ada — semua yang lolos login bisa mengubah semua modul.

## Struktur
```
public/            frontend (HTML/CSS/JS murni, tanpa build)
src/worker.js      entry Worker: /api/* -> API, sisanya file statis
src/api.js         logika API + D1
functions/api/     adapter bila suatu saat dipindah ke Cloudflare Pages
schema.sql         skema D1 (records + audit)
wrangler.toml      konfigurasi Cloudflare
```
