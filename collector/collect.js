#!/usr/bin/env node
// JuanAir restock collector.
// Polls YATA's foreign stock export a few times per run, learns how long each
// item stays empty before it restocks, and writes everything the JuanAir
// userscript needs (price, stock, sold-out time, learned restock gap) to one file.
// No Torn API key, and no requests to torn.com.
'use strict';
const fs = require('fs');
const path = require('path');

const YATA_URL = 'https://yata.yt/api/v1/travel/export/'; // exact URL, no params (YATA caches it)
const FILE = process.argv[2] || 'restock.json';
const POLLS = Number(process.env.POLLS || 5);
const GAP_MS = Number(process.env.GAP_MS || 55000);
const MAX_DELAYS = 12;            // restock cycles remembered per item
const MAX_UNCERTAINTY = 20 * 60;  // skip cycles we only saw roughly (seconds)

function ingest(state, payload) {
  if (!payload || !payload.stocks) return false;
  let changed = false;
  state.items = state.items || {};
  for (const cc of Object.keys(payload.stocks)) {
    const c = payload.stocks[cc];
    if (!c || !Array.isArray(c.stocks)) continue;
    const upd = Number(c.update);
    if (!isFinite(upd)) continue;
    for (const it of c.stocks) {
      const key = it.id + '|' + cc;
      const rec = state.items[key] || (state.items[key] = { delays: [] });
      rec.delays = rec.delays || [];
      rec.spans = rec.spans || [];   // how long each batch lasted (restock -> sold out)
      rec.name = it.name; rec.id = it.id; rec.cc = cc; rec.cost = Number(it.cost) || 0;
      const q = Number(it.quantity) || 0;
      if (rec.t === upd) continue;                       // same sighting as last time
      if (rec.t !== undefined && upd < rec.t) continue;  // older than what we have
      changed = true;
      const hadPrev = rec.t !== undefined;
      if (q > 0) {
        if (hadPrev && rec.q === 0) {
          // restocked somewhere between the last "empty" sighting and this one
          const restockT = (rec.t + upd) / 2;
          const uR = (upd - rec.t) / 2;
          if (rec.emptyMid != null) {
            const d = restockT - rec.emptyMid;
            const u = uR + (rec.emptyUnc || 0);
            if (d > 0 && u <= MAX_UNCERTAINTY) {
              rec.delays.push({ d: Math.round(d), u: Math.round(u) });
              if (rec.delays.length > MAX_DELAYS) rec.delays.shift();
            }
          }
          rec.lastRestock = Math.round(restockT);
          rec.lrU = Math.round(uR);                        // how precisely that restock was seen
          rec.rate = null;                                // new batch: relearn sell speed
        } else if (hadPrev && rec.q > 0 && q < rec.q && upd > rec.t) {
          const r = (rec.q - q) / ((upd - rec.t) / 60);   // items per minute
          rec.rate = Math.round((rec.rate ? rec.rate * 0.5 + r * 0.5 : r) * 100) / 100;
        } else if (hadPrev && q > rec.q) {
          rec.lastRestock = Math.round((rec.t + upd) / 2); // topped up without emptying
          rec.lrU = null;                                  // not a clean batch: do not time it
        }
        rec.emptyMid = null; rec.emptyUnc = null;
      } else if (hadPrev && rec.q > 0) {
        rec.emptyMid = Math.round((rec.t + upd) / 2);     // sold out between the two sightings
        rec.emptyUnc = Math.round((upd - rec.t) / 2);
        if (rec.lastRestock != null && rec.lrU != null) {
          const d = rec.emptyMid - rec.lastRestock;
          const u = rec.emptyUnc + rec.lrU;
          if (d > 0 && u <= MAX_UNCERTAINTY) {
            rec.spans.push({ d: Math.round(d), u: Math.round(u) });
            if (rec.spans.length > MAX_DELAYS) rec.spans.shift();
          }
        }
      } else if (!hadPrev) {
        rec.emptyMid = null; rec.emptyUnc = null;         // first sighting already empty: unknown
      }
      rec.q = q; rec.t = upd;
    }
  }
  return changed;
}

// ---- Bazaar prices and price history (weav3r.dev / TornW3B) ----
// Checked lightly: a few items per poll, so each item comes round about once an hour.
const BZ_URL = 'https://weav3r.dev/api/marketplace/';
const BZ_PER_POLL = Number(process.env.BZ_PER_POLL || 4);
const HIST_DAYS = 400;

function cheapestBazaar(d, nowSec) {
  const mv = Number(d.market_price) || 0;
  const ok = (d.listings || []).filter((l) => l.quantity > 0 && l.price > 0
    && (!mv || l.price >= mv * 0.3)                                  // ignore joke prices
    && (!l.last_checked || nowSec - l.last_checked < 2 * 86400));    // ignore listings nobody has seen for days
  return ok.length ? Math.min(...ok.map((l) => l.price)) : null;
}

function addHistory(histDir, id, nowSec, bazaar, marketValue) {
  const file = path.join(histDir, id + '.json');
  let h = {};
  try { h = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { h = {}; }
  const day = Math.floor(nowSec / 86400);
  const put = (key, v) => {
    if (!(v > 0)) return;
    const a = h[key] || (h[key] = []);
    if (a.length && a[a.length - 1][0] === day) a[a.length - 1][1] = v; else a.push([day, v]);   // one point per day: the latest seen
    if (a.length > HIST_DAYS) a.splice(0, a.length - HIST_DAYS);
  };
  put('b', bazaar); put('m', marketValue);
  fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(h));
}

async function bazaarStep(state, histDir, get) {
  const ids = [...new Set(Object.values(state.items || {}).map((v) => v.id))].filter((x) => x != null);
  state.px = state.px || {};
  ids.sort((a, b) => ((state.px[a] || {}).c || 0) - ((state.px[b] || {}).c || 0));   // least recently checked first
  let ok = 0, bad = 0;
  for (const id of ids.slice(0, BZ_PER_POLL)) {
    const now = Math.floor(Date.now() / 1000);
    const rec = state.px[id] || (state.px[id] = {});
    rec.c = now;                                   // counts as checked even if it fails, so one bad item cannot block the queue
    try {
      const d = await get(BZ_URL + id);
      rec.b = cheapestBazaar(d, now); rec.n = Number(d.total_count) || 0; rec.mv = Number(d.market_price) || null; rec.t = now;
      addHistory(histDir, id, now, rec.b, rec.mv);
      ok++;
    } catch (e) { bad++; console.error('bazaar ' + id + ' failed:', e.message); }
  }
  return { ok, bad };
}

module.exports = { ingest, cheapestBazaar, addHistory, bazaarStep };

async function main() {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { state = {}; }
  if (typeof state !== 'object' || Array.isArray(state)) state = {};
  const histDir = path.join(path.dirname(path.resolve(FILE)), 'hist');
  const getJson = async (url) => {
    const r = await fetch(url, { headers: { 'User-Agent': 'JuanAir-restock-collector (github.com/stevensewell1986/JuanAir)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  let ok = 0, bzOk = 0, bzBad = 0;
  for (let i = 0; i < POLLS; i++) {
    try {
      const r = await fetch(YATA_URL, { headers: { 'User-Agent': 'JuanAir-restock-collector (github.com/stevensewell1986/JuanAir)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      ingest(state, await r.json());
      ok++;
    } catch (e) { console.error('poll ' + (i + 1) + ' failed:', e.message); }
    if (ok) { const b = await bazaarStep(state, histDir, getJson); bzOk += b.ok; bzBad += b.bad; }
    if (i < POLLS - 1) await new Promise((res) => setTimeout(res, GAP_MS));
  }
  if (!ok) { console.error('No successful polls - leaving the data file untouched.'); process.exit(1); }
  // Starter averages (restock gap "g" and time to sell out "s", in seconds, with a reliability "r"),
  // used by the userscript only until this collector has seen real cycles for the item.
  try {
    const seeds = JSON.parse(fs.readFileSync(path.join(__dirname, 'seeds.json'), 'utf8'));
    for (const k of Object.keys(state.items || {})) { if (seeds[k]) state.items[k].seed = seeds[k]; else delete state.items[k].seed; }
  } catch (e) { console.error('seeds not loaded:', e.message); }
  state.v = 1;
  state.updated = Math.floor(Date.now() / 1000);
  fs.writeFileSync(FILE, JSON.stringify(state));
  const items = Object.values(state.items || {});
  console.log('bazaar checks: ' + bzOk + ' ok, ' + bzBad + ' failed');
  console.log(ok + '/' + POLLS + ' polls ok, ' + items.length + ' items, ' + items.filter((x) => x.delays && x.delays.length).length + ' with a learned restock gap');
}
if (require.main === module) main();
