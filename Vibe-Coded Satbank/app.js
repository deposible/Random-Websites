// BTC Balance — a private, offline holdings tracker.
// You type your total; buys add, sells subtract, via a calculator pad. Everything
// lives in localStorage as plain numbers. No addresses, no accounts, no identity.
// The ONLY optional network call is "update price" (asks the public BTC spot price,
// reveals nothing about you). The app is fully usable with networking disabled.

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SATS = 1e8;
  const STORE = 'btcbalance.v2';
  const LEGACY = 'btcbalance.v1';
  const APP_SECRET = 'satbank-obfuscation-v1';   // obfuscation key used when no PIN is set
  const ITERS = 100000;
  const hasCrypto = !!(window.crypto && crypto.subtle);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // ---- in-memory state (the currently-unlocked dataset: real OR decoy) ----
  const def = { balance: 0, unit: 'btc', log: [], hideBalance: false,
    currency: 'usd', currencies: null,
    lastPrice: null, chg24: null, chg7: null, chg30: null, trendTf: '24h', lastPriceAt: null };
  const freshState = () => JSON.parse(JSON.stringify(def));

  let state = freshState();
  let expr = '';                       // transient calculator entry (never saved)
  let unit = 'btc';
  let sessionKey = null, sessionSalt = null, mode = 'real';   // mode: real | fake(decoy)
  let meta = { hasPin: false, pinPrompted: false };

  // ---- crypto: AES-GCM with a key from PBKDF2(secret + per-slot salt) ----
  const newSalt = () => crypto.getRandomValues(new Uint8Array(16));
  async function deriveKey(secret, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encSlot(key, salt, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }
  async function decSlot(key, slot) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(slot.iv) }, key, unb64(slot.ct));
    return JSON.parse(dec.decode(pt));
  }
  // filler decoy under a thrown-away key, so a fake slot ALWAYS exists (deniability)
  async function randomDecoy() {
    const salt = newSalt();
    const key = await deriveKey(b64(crypto.getRandomValues(new Uint8Array(16))), salt);
    return encSlot(key, salt, freshState());
  }

  // ---- encrypted vault on disk ----
  function readDisk() { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } }
  function writeDisk(v) {
    try { localStorage.setItem(STORE, JSON.stringify(v)); }
    catch (e) { console.warn('save failed', e); flashHint('⚠ could not save — storage full or disabled'); }
  }
  async function persist() {
    state.unit = unit;
    if (!hasCrypto) { writeDisk({ v: 2, plain: true, pinPrompted: meta.pinPrompted, state }); return; }
    if (!sessionKey) return;   // locked (no key yet) — don't touch the encrypted real slot
    const disk = readDisk() || { v: 2, hasPin: false, pinPrompted: meta.pinPrompted };
    const slot = await encSlot(sessionKey, sessionSalt, state);
    if (mode === 'fake') disk.fake = slot; else disk.real = slot;
    if (!disk.real) disk.real = slot;
    if (!disk.fake) disk.fake = await randomDecoy();   // keep two slots present always
    disk.v = 2; disk.hasPin = meta.hasPin; disk.pinPrompted = meta.pinPrompted;
    writeDisk(disk);
  }
  function save() { persist(); }   // fire-and-forget; keeps existing call sites working

  function migrateLegacy() {
    const old = localStorage.getItem(LEGACY);
    if (!old) return null;
    try { const s = JSON.parse(old); localStorage.removeItem(LEGACY); return Object.assign(freshState(), s); }
    catch { return null; }
  }
  // returns true if the app is locked (a real PIN exists and we must unlock)
  async function boot() {
    if (!hasCrypto) {
      const disk = readDisk();
      if (disk && disk.state) { state = Object.assign(freshState(), disk.state); meta.pinPrompted = !!disk.pinPrompted; }
      else { const m = migrateLegacy(); if (m) state = m; }
      unit = state.unit || 'btc'; return false;
    }
    const disk = readDisk();
    if (!disk) {
      state = migrateLegacy() || freshState(); unit = state.unit || 'btc';
      sessionSalt = newSalt(); sessionKey = await deriveKey(APP_SECRET, sessionSalt); mode = 'real';
      meta = { hasPin: false, pinPrompted: false };
      await persist(); return false;
    }
    if (disk.plain && disk.state) {   // earlier plaintext fallback → encrypt it now
      state = Object.assign(freshState(), disk.state); unit = state.unit || 'btc';
      meta = { hasPin: false, pinPrompted: !!disk.pinPrompted };
      sessionSalt = newSalt(); sessionKey = await deriveKey(APP_SECRET, sessionSalt); mode = 'real';
      await persist(); return false;
    }
    meta = { hasPin: !!disk.hasPin, pinPrompted: !!disk.pinPrompted };
    if (!disk.hasPin) {
      try {
        sessionSalt = unb64(disk.real.salt); sessionKey = await deriveKey(APP_SECRET, sessionSalt);
        state = Object.assign(freshState(), await decSlot(sessionKey, disk.real)); mode = 'real';
        unit = state.unit || 'btc';
      } catch (e) { console.warn('decrypt failed', e); state = freshState(); }
      return false;
    }
    return true;   // locked
  }

  // ---- formatting ----
  function fmtBtc(v) {
    const s = (Math.round(v * SATS) / SATS).toLocaleString('en-US', { maximumFractionDigits: 8 });
    return s + ' BTC';
  }
  function fmtSats(v) {
    return Math.round(v * SATS).toLocaleString('en-US') + ' sats';
  }
  const MASK = '••••••';   // shown in place of personal amounts when hidden

  // format a value in the chosen currency (ISO gets a symbol; crypto/other gets a code)
  function fmtFiat(v, maxFrac = 2) {
    const code = (state.currency || 'usd').toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: maxFrac }).format(v);
    } catch {
      return v.toLocaleString(undefined, { maximumFractionDigits: maxFrac }) + ' ' + code;
    }
  }
  // group the integer part with commas, leaving any decimal part untouched
  function withCommas(s) {
    if (s === '') return '';
    const dot = s.indexOf('.');
    const intp = (dot === -1 ? s : s.slice(0, dot)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return intp + (dot === -1 ? '' : s.slice(dot));
  }
  // add commas to every number in a calculator expression (keeps operators as-is)
  function formatExpr(s) {
    return s.replace(/\d+(?:\.\d*)?|\.\d+/g, (n) => withCommas(n));
  }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch { return ''; }
  }

  // ---- BTC-USD price (anonymous: never sends your balance) -----------------------
  async function fetchPrice() {
    // CoinGecko markets endpoint gives price + 24h/7d/30d change; fall back to
    // Coinbase spot (price only, no change windows).
    const cur = encodeURIComponent(state.currency || 'usd');
    try {
      const r = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${cur}&ids=bitcoin&price_change_percentage=24h,7d,30d`,
        { cache: 'no-store' });
      if (!r.ok) throw 0;
      const d = (await r.json())[0];
      state.lastPrice = d.current_price;
      state.chg24 = d.price_change_percentage_24h_in_currency ?? null;
      state.chg7  = d.price_change_percentage_7d_in_currency ?? null;
      state.chg30 = d.price_change_percentage_30d_in_currency ?? null;
      state.lastPriceAt = Date.now();
      save(); renderPrice(); return;
    } catch { /* try fallback */ }
    try {
      const r = await fetch(`https://api.coinbase.com/v2/prices/BTC-${(state.currency || 'usd').toUpperCase()}/spot`, { cache: 'no-store' });
      const j = await r.json();
      state.lastPrice = parseFloat(j.data.amount);
      state.chg24 = state.chg7 = state.chg30 = null;   // no change windows from this source
      state.lastPriceAt = Date.now();
      save(); renderPrice();
    } catch { renderPrice(); }            // offline: keep showing the cached value
  }

  function renderPrice() {
    const p = state.lastPrice;
    const tf = state.trendTf || '24h';
    const ch = { '24h': state.chg24, '1w': state.chg7, '1m': state.chg30 }[tf];
    const val = $('holdValue'), btc = $('btcPrice'), trend = $('dollarTrend');
    document.querySelectorAll('.tf').forEach((x) => x.classList.toggle('active', x.dataset.tf === tf));
    const hasChange = state.chg24 != null || state.chg7 != null || state.chg30 != null;
    $('tfBtns').style.display = hasChange ? '' : 'none';

    if (!p) { val.textContent = ''; btc.textContent = 'tap to load BTC price'; trend.textContent = ''; trend.className = 'dollar'; return; }
    val.textContent = state.hideBalance ? MASK : '≈ ' + fmtFiat(state.balance * p);
    btc.textContent = '1 BTC = ' + fmtFiat(p, 0)
      + (state.lastPriceAt ? '  ·  ' + fmtTime(state.lastPriceAt) : '');
    if (ch == null) { trend.textContent = ''; trend.className = 'dollar'; return; }
    // BTC up over the window => each unit of currency buys less BTC => it is WEAKENING vs BTC.
    const weakening = ch >= 0;
    const movePct = Math.abs((1 / (1 + ch / 100) - 1) * 100); // the currency's own move vs BTC
    const code = (state.currency || 'usd').toUpperCase();
    trend.className = 'dollar ' + (weakening ? 'weak' : 'strong');
    trend.textContent = `${code} ${weakening ? 'weakening' : 'strengthening'} ${movePct.toFixed(2)}% vs BTC (${tf})`;
  }

  // ---- safe expression evaluator (no eval): + − × ÷ with precedence ----
  function evalExpr(raw) {
    if (!raw) return null;
    const s = raw.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
    const toks = s.match(/(\d+\.?\d*|\.\d+|[+\-*/()])/g);
    if (!toks) return null;
    const out = [], ops = [], prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
    for (const t of toks) {
      if (/^[\d.]/.test(t)) out.push(parseFloat(t));
      else if (t in prec) {
        while (ops.length) { const o = ops[ops.length - 1]; if (prec[o] >= prec[t]) out.push(ops.pop()); else break; }
        ops.push(t);
      } else if (t === '(') ops.push(t);
      else if (t === ')') { while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop()); ops.pop(); }
    }
    while (ops.length) out.push(ops.pop());
    const st = [];
    for (const t of out) {
      if (typeof t === 'number') st.push(t);
      else {
        const b = st.pop(), a = st.pop();
        if (a === undefined || b === undefined) return null;
        st.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : a / b);
      }
    }
    const v = st.pop();
    return (st.length === 0 && typeof v === 'number' && isFinite(v)) ? v : null;
  }

  // convert the entered value (in the active unit) to a BTC amount
  function toBtc(value) {
    return unit === 'sats' ? value / SATS : value;
  }

  // ---- rendering ----
  function feedItem(e, withDelete) {
    const hide = !!state.hideBalance;
    const dir = e.delta > 0 ? 'in' : e.delta < 0 ? 'out' : 'set';
    const icon = dir === 'in' ? '↘' : dir === 'out' ? '↗' : '=';
    const label = e.type === 'set' ? 'Set total' : e.type === 'buy' ? 'Bought' : 'Sold';
    const sign = e.delta > 0 ? '+' : e.delta < 0 ? '−' : '';
    const cls = e.delta > 0 ? 'pos' : e.delta < 0 ? 'neg' : '';
    const when = new Date(e.ts).toLocaleString();
    const amt = hide ? sign + MASK : sign + fmtBtc(Math.abs(e.delta));
    const metaText = (hide || !e.note) ? when : when + ' · ' + e.note;   // note can hold a sats amount
    return `<li class="feeditem">
      <span class="fic ${dir}">${icon}</span>
      <div class="fmeta"><b>${label}</b><small>${metaText}</small></div>
      <span class="famt ${cls}">${amt}</span>
      ${withDelete ? `<button class="fdel" data-undo="${e.id}" aria-label="Undo">✕</button>` : ''}
    </li>`;
  }

  // hide-balance (eye) — mask personal numbers; the public BTC price stays visible
  function applyHide() {
    $('eyeBtn').classList.toggle('off', !!state.hideBalance);
  }

  // net stacked in the current calendar month
  function renderMonth() {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth();
    let net = 0, bought = 0, sold = 0;
    for (const e of state.log) {
      const d = new Date(e.ts);
      if (d.getFullYear() === y && d.getMonth() === m) {
        net += e.delta;
        if (e.delta > 0) bought += e.delta; else if (e.delta < 0) sold += -e.delta;
      }
    }
    const card = $('monthCard');
    if (net === 0 && bought === 0 && sold === 0) { card.hidden = true; return; }
    card.hidden = false;
    const sign = net > 0 ? '+' : net < 0 ? '−' : '';
    const nn = $('monthNet');
    nn.textContent = state.hideBalance ? MASK : sign + fmtSats(Math.abs(net));
    nn.className = 'month-net ' + (net > 0 ? 'pos' : net < 0 ? 'neg' : '');
    $('monthBreak').textContent = state.hideBalance ? '' : `Bought +${fmtSats(bought)} · Sold −${fmtSats(sold)}`;
  }

  function render() {
    const hide = !!state.hideBalance;
    $('balanceSats').textContent = hide ? MASK : fmtSats(state.balance);   // big, bold (sats)
    $('balanceBtc').textContent = hide ? MASK : fmtBtc(state.balance);     // smaller, below (BTC)
    $('expr').textContent = expr ? formatExpr(expr) : '0';
    document.querySelectorAll('.unit').forEach((x) => x.classList.toggle('active', x.dataset.unit === unit));
    renderPrice();   // refresh the $ value as the balance changes (uses cached price)
    applyHide();
    renderMonth();

    const items = state.log.slice().reverse();
    const has = items.length > 0;
    $('histList').innerHTML = items.map((e) => feedItem(e, true)).join('');
    $('recentList').innerHTML = items.slice(0, 4).map((e) => feedItem(e, false)).join('');
    $('histList').hidden = !has;   $('histEmpty').hidden = has;
    $('recentList').hidden = !has; $('recentEmpty').hidden = has;
  }

  // ---- applying changes ----
  let idc = Date.now();
  function applyDelta(deltaBtc, type, note, ts) {
    state.balance = Math.max(0, +(state.balance + deltaBtc).toFixed(8));
    state.log.push({ id: ++idc, type, delta: +deltaBtc.toFixed(8), note, ts: ts || Date.now() });
    save(); render();
  }

  // datetime-local helpers (the chosen transaction date)
  function nowLocalInput(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function txDateMs() {
    const v = $('txDate').value;
    const t = v ? new Date(v).getTime() : NaN;
    return isFinite(t) ? t : Date.now();
  }

  function commit(kind) {
    const value = evalExpr(expr);
    if (value === null) { flashHint('enter a valid amount'); return false; }
    const btcAmt = toBtc(value);
    const note = unit === 'sats' ? Math.round(value).toLocaleString('en-US') + ' sats' : null;
    const ts = txDateMs();   // user-chosen date (defaults to now)
    if (kind === 'set') applyDelta(+(btcAmt - state.balance).toFixed(8), 'set', note, ts);
    else if (kind === 'buy') applyDelta(Math.abs(btcAmt), 'buy', note, ts);
    else if (kind === 'sell') applyDelta(-Math.abs(btcAmt), 'sell', note, ts);
    expr = '';
    render();
    return true;
  }

  let hintTimer;
  function flashHint(msg) {
    const el = $('exprHint');
    el.textContent = msg; el.classList.add('warn');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { el.classList.remove('warn'); el.textContent = 'enter an amount'; }, 1800);
  }

  // ---- calculator input ----
  function pushKey(k) {
    const ops = '+−×÷';
    if (ops.includes(k)) {
      if (expr === '' && k !== '−') return;             // don't start with an operator (except minus)
      if (ops.includes(expr.slice(-1))) expr = expr.slice(0, -1); // replace trailing operator
      expr += k;
    } else if (k === '.') {
      const last = expr.split(/[+\-−×÷*/]/).pop();
      if (last.includes('.')) return;                    // one decimal per number
      expr += (expr === '' || ops.includes(expr.slice(-1))) ? '0.' : '.';
    } else {
      expr += k;
    }
    render();
  }

  document.querySelectorAll('.key[data-k]').forEach((b) =>
    b.addEventListener('click', () => pushKey(b.dataset.k)));
  $('backKey').addEventListener('click', () => { expr = expr.slice(0, -1); render(); });
  $('clrBtn').addEventListener('click', () => { expr = ''; render(); });

  // ---- amount sheet (banking-style enter-amount) ----
  let sheetMode = 'buy';
  const TITLES = { buy: 'Buy Bitcoin', sell: 'Sell Bitcoin', set: 'Set total' };
  const CTA = { buy: 'Buy', sell: 'Sell', set: 'Set total' };
  function sheetOpen() { return $('sheet').classList.contains('open'); }
  function openSheet(mode) {
    sheetMode = mode; expr = '';
    $('sheetTitle').textContent = TITLES[mode];
    $('txDate').value = nowLocalInput();   // default to now; user can backdate it
    const cb = $('confirmBtn'); cb.textContent = CTA[mode]; cb.className = 'confirm ' + mode;
    render();
    $('scrim').hidden = false;
    requestAnimationFrame(() => $('sheet').classList.add('open'));
    $('sheet').setAttribute('aria-hidden', 'false');
  }
  function closeSheet() {
    $('sheet').classList.remove('open');
    $('sheet').setAttribute('aria-hidden', 'true');
    $('scrim').hidden = true; expr = ''; render();
  }
  $('actBuy').addEventListener('click', () => openSheet('buy'));
  $('actSell').addEventListener('click', () => openSheet('sell'));
  $('actSet').addEventListener('click', () => openSheet('set'));
  $('confirmBtn').addEventListener('click', () => { if (commit(sheetMode)) closeSheet(); });
  $('scrim').addEventListener('click', closeSheet);

  // ---- bottom nav ----
  function showView(name) {
    ['home', 'activity', 'settings'].forEach((v) => { $('view-' + v).hidden = v !== name; });
    document.querySelectorAll('.tabitem').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabitem').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('seeAll').addEventListener('click', () => showView('activity'));

  // ---- hide balance (eye) — persists via save(); render() re-masks everything ----
  $('eyeBtn').addEventListener('click', () => {
    state.hideBalance = !state.hideBalance; save(); render();
  });

  // ---- currency selector (any vs_currency CoinGecko supports) ----
  const FALLBACK_CURRENCIES = ['usd','eur','gbp','jpy','cny','aud','cad','chf','hkd','sgd','inr',
    'krw','brl','mxn','rub','zar','try','sek','nok','dkk','pln','nzd','aed','sar','thb','idr','myr',
    'php','czk','huf','ils','clp','twd','ngn','vnd','uah','btc','eth','sats'];
  function populateCurrencies(list) {
    const sel = $('curSelect');
    const opts = list.slice().sort();
    sel.innerHTML = opts.map((c) => `<option value="${c}">${c.toUpperCase()}</option>`).join('');
    sel.value = opts.includes(state.currency) ? state.currency : 'usd';
    state.currency = sel.value;
  }
  async function loadCurrencies() {
    if (state.currencies && state.currencies.length) populateCurrencies(state.currencies); // instant (cached/offline)
    else populateCurrencies(FALLBACK_CURRENCIES);
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/supported_vs_currencies', { cache: 'no-store' });
      const list = await r.json();
      if (Array.isArray(list) && list.length) { state.currencies = list; save(); populateCurrencies(list); }
    } catch { /* keep fallback/cached */ }
  }
  $('curSelect').addEventListener('change', () => {
    state.currency = $('curSelect').value; save(); render(); fetchPrice();
  });

  // ---- pull to refresh (home, top of scroll) ----
  let ptrStart = null, ptrDist = 0;
  const ptr = $('ptr');
  const ptrActive = () => !sheetOpen() && $('pinScreen').hidden && !$('view-home').hidden;
  window.addEventListener('touchstart', (e) => {
    if (window.scrollY <= 0 && ptrActive()) ptrStart = e.touches[0].clientY; else ptrStart = null;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (ptrStart === null) return;
    ptrDist = e.touches[0].clientY - ptrStart;
    if (ptrDist > 0) { ptr.style.height = Math.min(ptrDist * 0.5, 64) + 'px'; ptr.classList.toggle('ready', ptrDist > 70); }
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (ptrStart === null) return;
    const go = ptrDist > 70; ptrStart = null; ptrDist = 0; ptr.classList.remove('ready');
    if (go) { ptr.classList.add('spin'); ptr.style.height = '46px'; await fetchPrice(); ptr.classList.remove('spin'); }
    ptr.style.height = '0px';
  });

  // ---- PIN lock + decoy (encryption-based) ----
  const pinScreen = $('pinScreen');
  let pinEntry = '', pinMode = 'unlock', pinFirst = '', lastHidden = 0;
  const PIN_LEN = 4;
  const PIN_TITLES = { unlock: 'Enter PIN', set: 'Set a PIN', confirm: 'Confirm PIN',
    setfake: 'Set a decoy PIN', confirmfake: 'Confirm decoy PIN' };
  const renderDots = () => {
    $('pinDots').innerHTML = Array.from({ length: PIN_LEN },
      (_, i) => `<span class="pdot ${i < pinEntry.length ? 'on' : ''}"></span>`).join('');
  };
  function showPin(m) {
    pinMode = m; pinEntry = '';
    $('pinTitle').textContent = PIN_TITLES[m] || 'Enter PIN';
    $('pinCancel').hidden = (m === 'unlock');
    $('pinCancel').textContent = (m === 'set' && !meta.hasPin) ? 'Skip for now' : 'Cancel';
    renderDots(); pinScreen.hidden = false;
  }
  const hidePin = () => { pinScreen.hidden = true; pinEntry = ''; };
  function pinError() {
    const inner = pinScreen.querySelector('.pin-inner');
    inner.classList.remove('shake'); void inner.offsetWidth; inner.classList.add('shake');
    pinEntry = ''; renderDots();
  }

  // try the entered PIN against the real slot, then the decoy slot
  async function tryUnlock(pin) {
    const disk = readDisk(); if (!disk) return false;
    for (const which of ['real', 'fake']) {
      const slot = disk[which]; if (!slot) continue;
      try {
        const salt = unb64(slot.salt); const key = await deriveKey(pin, salt);
        const s = await decSlot(key, slot);
        state = Object.assign(freshState(), s); unit = state.unit || 'btc';
        sessionKey = key; sessionSalt = salt; mode = which; return true;
      } catch { /* wrong key for this slot */ }
    }
    return false;
  }
  async function setRealPin(pin) {
    sessionSalt = newSalt(); sessionKey = await deriveKey(pin, sessionSalt); mode = 'real'; meta.hasPin = true;
    await persist();
  }
  async function removePinLock() {
    sessionSalt = newSalt(); sessionKey = await deriveKey(APP_SECRET, sessionSalt); mode = 'real'; meta.hasPin = false;
    await persist();
    const disk = readDisk(); if (disk) { disk.fake = await randomDecoy(); writeDisk(disk); }
  }
  async function setFakePin(pin) {
    const disk = readDisk();
    if (disk && disk.real) {   // a decoy PIN that decrypts the real slot would be ==real PIN
      try { await decSlot(await deriveKey(pin, unb64(disk.real.salt)), disk.real); return 'same'; } catch {}
    }
    const salt = newSalt(); const key = await deriveKey(pin, salt);
    const fakeState = freshState();
    const d = readDisk() || {}; d.fake = await encSlot(key, salt, fakeState); writeDisk(d);
    // drop into decoy mode so the owner can craft the fake balance right away
    state = fakeState; unit = 'btc'; sessionKey = key; sessionSalt = salt; mode = 'fake';
    render();
    return 'ok';
  }

  async function pinComplete() {
    if (pinMode === 'unlock') {
      if (await tryUnlock(pinEntry)) { hidePin(); render(); fetchPrice(); } else pinError();
    } else if (pinMode === 'set') { pinFirst = pinEntry; showPin('confirm'); }
    else if (pinMode === 'confirm') {
      if (pinEntry === pinFirst) { await setRealPin(pinEntry); updatePinSettings(); hidePin(); render(); }
      else { pinError(); pinFirst = ''; showPin('set'); }
    } else if (pinMode === 'setfake') { pinFirst = pinEntry; showPin('confirmfake'); }
    else if (pinMode === 'confirmfake') {
      if (pinEntry !== pinFirst) { pinError(); pinFirst = ''; showPin('setfake'); return; }
      const r = await setFakePin(pinEntry);
      if (r === 'same') { alert('The decoy PIN must be different from your real PIN.'); showPin('setfake'); }
      else { updatePinSettings(); hidePin(); render();
        alert('Decoy ready — you are now in decoy mode. Set a fake balance now; it shows whenever this PIN is entered.'); }
    }
  }
  function pinPush(d) {
    if (pinEntry.length >= PIN_LEN) return;
    pinEntry += d; renderDots();
    if (pinEntry.length === PIN_LEN) setTimeout(pinComplete, 130);
  }
  $('pinKeys').addEventListener('click', (e) => {
    const k = e.target.closest('.pkey'); if (!k) return;
    if (k.id === 'pinBack') { pinEntry = pinEntry.slice(0, -1); renderDots(); }
    else if (k.dataset.d) pinPush(k.dataset.d);
  });
  $('pinCancel').addEventListener('click', hidePin);

  function updatePinSettings() {
    $('pinBtnLabel').textContent = meta.hasPin ? 'Change PIN lock' : 'Set PIN lock';
    $('pinRemoveBtn').hidden = !meta.hasPin;
    $('fakeBtn').hidden = !meta.hasPin;   // decoy only makes sense once a real PIN exists
  }
  $('pinBtn').addEventListener('click', () => {
    if (!hasCrypto) { alert('PIN needs a secure page (https or localhost).'); return; }
    showPin('set');
  });
  $('pinRemoveBtn').addEventListener('click', async () => {
    if (confirm('Remove the PIN lock? Data will be only lightly obfuscated, and the decoy is cleared.')) {
      await removePinLock(); updatePinSettings();
    }
  });
  $('fakeBtn').addEventListener('click', () => { if (hasCrypto) showPin('setfake'); });

  const lockIfNeeded = () => { if (meta.hasPin && hasCrypto) showPin('unlock'); };
  function maybePromptPin() {
    if (!meta.hasPin && !meta.pinPrompted && hasCrypto) {
      meta.pinPrompted = true; persist(); showPin('set');
    }
  }
  // re-lock if the app was backgrounded for a while
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) lastHidden = Date.now();
    else if (meta.hasPin && pinScreen.hidden && Date.now() - lastHidden > 15000) lockIfNeeded();
  });

  // physical keyboard support
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (!sheetOpen()) return;   // keypad only drives the open amount sheet
    const map = { '*': '×', '/': '÷', '-': '−' };
    if (/[0-9.]/.test(e.key)) pushKey(e.key);
    else if ('+-*/'.includes(e.key)) pushKey(map[e.key] || e.key);
    else if (e.key === 'Backspace') { expr = expr.slice(0, -1); render(); }
    else if (e.key === 'Enter') { if (commit(sheetMode)) closeSheet(); }
    else if (e.key === 'Escape') closeSheet();
  });

  // unit toggle
  $('unitBtns').addEventListener('click', (e) => {
    const b = e.target.closest('.unit'); if (!b) return;
    unit = b.dataset.unit;
    save();   // remember the chosen unit across reloads
    render();
  });

  // history undo
  $('histList').addEventListener('click', (e) => {
    const id = e.target.getAttribute('data-undo'); if (!id) return;
    const idx = state.log.findIndex((x) => String(x.id) === id);
    if (idx < 0) return;
    state.balance = Math.max(0, +(state.balance - state.log[idx].delta).toFixed(8)); // reverse its effect
    state.log.splice(idx, 1);
    save(); render();
  });
  $('undoAllBtn').addEventListener('click', () => {
    if (confirm('Clear the history log? Your balance stays the same.')) { state.log = []; save(); render(); }
  });

  // ---- settings ----
  // export / import / wipe
  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'btc-balance-backup.json';
    a.click(); URL.revokeObjectURL(a.href);
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { state = Object.assign(freshState(), JSON.parse(rd.result)); unit = state.unit || 'btc'; save(); render(); }
      catch { alert('That file is not a valid backup.'); }
    };
    rd.readAsText(f);
  });
  $('wipeBtn').addEventListener('click', async () => {
    if (confirm('Erase your balance, history and settings from this device?')) {
      localStorage.removeItem(STORE); localStorage.removeItem(LEGACY);
      state = freshState(); expr = ''; mode = 'real'; meta = { hasPin: false, pinPrompted: false };
      if (hasCrypto) { sessionSalt = newSalt(); sessionKey = await deriveKey(APP_SECRET, sessionSalt); await persist(); }
      updatePinSettings(); render();
    }
  });

  // ---- PWA: install + service worker ----
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('installBtn').hidden = false; });
  $('installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt(); await deferred.userChoice; deferred = null; $('installBtn').hidden = true;
  });
  // Service worker only works over http(s) — skip it on file:// (and never break the app).
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // Ask the browser to keep our data durable (don't evict under storage pressure).
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // Keep multiple tabs in sync — re-decrypt the current slot with our session key.
  window.addEventListener('storage', async (e) => {
    if (e.key !== STORE || !sessionKey) return;
    try {
      const disk = readDisk(); const slot = mode === 'fake' ? disk.fake : disk.real;
      if (slot) { state = Object.assign(freshState(), await decSlot(sessionKey, slot)); unit = state.unit || 'btc'; render(); }
    } catch { /* key changed elsewhere; ignore */ }
  });

  // Dollar-trend timeframe selector (24h / 1w / 1m), remembered across reloads.
  $('tfBtns').addEventListener('click', (e) => {
    const b = e.target.closest('.tf'); if (!b) return;
    e.stopPropagation();                 // don't also trigger the price-line refresh
    state.trendTf = b.dataset.tf; save(); renderPrice();
  });

  // Live BTC price: fetch on open, refresh each minute, on reconnect, and on tap.
  $('priceLine').addEventListener('click', fetchPrice);
  window.addEventListener('online', fetchPrice);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchPrice(); });
  setInterval(fetchPrice, 60000);

  (async () => {
    let locked = false;
    try { locked = await boot(); } catch (e) { console.warn('boot failed', e); }
    render();
    updatePinSettings();
    loadCurrencies();                 // populate the currency picker (cached → live)
    if (locked) showPin('unlock');    // encrypted & a PIN exists → must unlock
    else if (!meta.hasPin) maybePromptPin();
    fetchPrice();
  })();
})();
