# BTC Balance

A **private, offline** Bitcoin balance tracker that installs as an app on iOS &
Android (a PWA). You type your total, then add **buys** (+) and **sells** (−) with
a calculator pad. Everything is stored locally as plain numbers.

**Privacy by design**
- No addresses, no xpub, no account, no login — **nothing that can be tied to you.**
- All data lives in your browser's `localStorage` on this device only, and with a PIN
  set it is **AES-GCM encrypted** (key derived from your PIN via PBKDF2) — unreadable
  without unlocking. **Forgetting the PIN means the data is unrecoverable**, so keep an
  Export backup. A **decoy PIN** unlocks a separate fake balance (two encrypted blobs
  are always stored, so an inspector can't tell whether a decoy exists). Without a PIN,
  data is only lightly obfuscated.
- Amounts are **BTC / sats** native. It shows the live USD value and BTC price too,
  framed Bitcoin-first: whether **the dollar is strengthening or weakening against BTC**,
  over **24h / 1w / 1m**.
- The only network call is the **anonymous** BTC-USD price (CoinGecko, Coinbase
  fallback) — it asks "what's BTC worth" and never sends your balance. The last
  price is cached so value still shows offline.
- Clear your browser data (or tap **Erase all**) and it's gone. Use **Export backup**
  for a local JSON copy.

## How it works
- **Balance** is the source of truth. **Buy** adds, **Sell** subtracts, **Set** makes
  the entered amount your new total.
- The pad is a real calculator (`+ − × ÷`), so you can enter things like `0.1+0.05`.
  Numbers get **commas** as you type for readability.
- **Units:** enter amounts in **BTC** or **sats**.
- **History** logs every change; **✕** undoes a single entry by reversing its effect.

## Files
```
index.html             UI (balance, calculator, history, settings)
styles.css             dark, mobile-first theme
app.js                 all logic — no dependencies, no network needed
manifest.webmanifest   PWA manifest (installability)
sw.js                  service worker (offline app shell)
icon.svg               app icon (works as-is)
make-icons.html        optional: export PNG icons into icons/
.nojekyll              serve files as-is on GitHub Pages
```

## Run locally
A service worker needs http(s), not a `file://` page:
```bash
cd btc-wallet-viewer && python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy to GitHub Pages
1. Push these files to a repo (root or `/docs`).
2. **Settings → Pages → Deploy from a branch**, pick your branch + folder.
3. Live at `https://<user>.github.io/<repo>/` over HTTPS (required for install).
All paths are relative, so it works under the `/<repo>/` subpath unchanged.

## Install on a phone
- **Android (Chrome):** open the site → tap **Install** (or menu → *Install app*).
- **iOS (Safari):** Share → **Add to Home Screen**. (iOS has no auto prompt, so the
  in-app Install button is Android-only by design.)
