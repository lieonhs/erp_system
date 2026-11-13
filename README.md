# ERP RPA — Finance, Purchasing & Logistik

Web app untuk usaha pemotongan ayam (RPA), bisa dipakai untuk unit usaha lain.
Hosting: **Cloudflare Pages** (frontend + API) + **Cloudflare D1** (database SQL). Paket gratis Cloudflare cukup untuk usaha kecil–menengah.

## Modul
| Area | Isi |
|---|---|
| Purchasing | Purchase Order, Penerimaan Barang (timbang kandang vs timbang RPA, ekor mati/DOA, susut), Kinerja Supplier (biaya efektif/kg) |
| Logistik | Pemotongan/Produksi (rendemen karkas, alokasi biaya ke produk), Stok, Kartu Stok, Pengiriman (status + surat jalan), Armada & Driver |
| Penjualan | Invoice, HPP & laba kotor per transaksi, cetak invoice |
| Finance | Kas & Bank, Hutang & Piutang (umur/aging FIFO), Jurnal Umum, Buku Besar, Laba Rugi, Neraca, Neraca Saldo, Laba per Unit |
| Master | Barang, Supplier/Customer, Unit Usaha, Bagan Akun, Tutup buku, Backup/restore |

Semua jurnal dibuat otomatis dari transaksi. Edit transaksi → stok, HPP, jurnal, dan laporan ikut terhitung ulang.

## Deploy (sekali, ±15 menit)
Butuh: akun Cloudflare (gratis) dan Node.js 18+.

```bash
npm install
npx wrangler login
npx wrangler d1 create erp-rpa-db
#  -> salin "database_id" yang muncul ke wrangler.toml
npm run db:init:remote
npx wrangler pages project create erp-rpa --production-branch main
npm run deploy
```
Hasilnya alamat seperti `https://erp-rpa.pages.dev`.

### Wajib: kunci akses
Tanpa ini, siapa pun yang tahu alamatnya bisa melihat & mengubah data.
1. **Cloudflare Access (disarankan)**: Dashboard → Zero Trust → Access → Applications → Add → Self-hosted → domain `erp-rpa.pages.dev` → policy "Emails" berisi email tim. Gratis s/d 50 user. Email user otomatis tercatat di jejak audit.
2. **Tambahan / alternatif cepat** — token bersama:
   ```bash
   npx wrangler pages secret put APP_TOKEN   # isi kata sandi panjang
   npm run deploy
   ```
   Aplikasi akan meminta token saat dibuka.

## Jalankan di komputer sendiri
```bash
npm install
npm run db:init:local
npm run dev        # buka http://localhost:8788
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
- **Pajak** (PPN/PPh) belum dihitung otomatis. Gunakan Jurnal Umum.
- **Uang muka** ke supplier/customer belum punya alur khusus — catat via Jurnal Umum ke akun 1202.
- **Transaksi antar unit** belum memakai akun antar-kantor; neraca per unit hanya akurat bila kas dicatat di unit yang benar.
- **Skala**: semua data dimuat ke browser saat dibuka. Nyaman sampai kira-kira 10–20 ribu transaksi; setelah itu perlu filter di sisi server.
- **Hak akses per peran** (admin gudang vs keuangan) belum ada — semua yang lolos login bisa mengubah semua modul.

## Struktur
```
public/            frontend (HTML/CSS/JS murni, tanpa build)
functions/api/     API (Cloudflare Pages Functions)
schema.sql         skema D1 (records + audit)
wrangler.toml      konfigurasi Cloudflare
```
