/* state/*.json → app/data/{stocks,docs,meta}.json
 * 적정가 계산은 engine.js, 선별·문서 규칙은 screen.js (적정주가 노트와 같은 코드)를 쓴다.
 *   node pipeline/build.js [오늘 YYYY-MM-DD]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const FV = require("./engine.js");
const S = require("./screen.js");
const n = FV.num;
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch (e) { return d; } };
const today = process.argv[2] || new Date().toISOString().slice(0, 10);

const universe = read("state/universe.json", []);
const fund = read("state/fund.json", {});
const prices = read("state/prices.json", {});
const params = read("state/params.json", read("config/params.json", {}));
const run = read("state/run.json", {});
const repo = process.env.GITHUB_REPOSITORY || read("config/app.json", {}).repo || "";

/* ---------- 업종 PER·PSR 중간값 ---------- */
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const rows0 = [];
for (const u of universe) {
  const f = fund[u.id], p = prices[u.id];
  if (!f || !p || !n(p.price)) continue;
  const price = n(p.price), shares = n(f.shares);
  // Forward EPS: yfinance forwardEps가 없으면(한국 종목은 대부분 없음) 다음 회계연도 컨센서스
  const fe = n(f.forwardEps) > 0 ? n(f.forwardEps) : n(f.epsNextFY) > 0 ? n(f.epsNextFY) : null;
  const fwdPe = fe ? price / fe : null;
  const mcap = shares ? price * shares : null;
  rows0.push({ u, f, p, price, fwdPe: fwdPe && fwdPe < 100 ? fwdPe : null, ps: mcap && n(f.revenue) > 0 ? mcap / n(f.revenue) : null });
}
function peers(row, key) {
  // 같은 시장 안에서 먼저 찾음: 한국 종목을 미국 PER로 재면 '코리아 디스카운트'만큼 늘 싸 보임
  const tiers = [
    (x) => x.u.market === row.u.market && x.f.industry && x.f.industry === row.f.industry,
    (x) => x.u.market === row.u.market && x.f.sector && x.f.sector === row.f.sector,
    (x) => x.f.industry && x.f.industry === row.f.industry,
  ];
  const labels = ["같은 시장·업종", "같은 시장·섹터", "같은 업종(미국·한국 합산)"];
  const need = [3, 5, 3];
  for (let i = 0; i < tiers.length; i++) {
    const g = rows0.filter((x) => x !== row && !x.f.excluded && tiers[i](x) && Number.isFinite(x[key]));
    if (g.length >= need[i]) return { v: r2(median(g.map((x) => x[key]))), n: g.length, label: labels[i], names: g.slice(0, 4).map((x) => x.u.id) };
  }
  return null;
}

/* ---------- 종목별 계산 ---------- */
const stocks = [], docs = {};
let nCand = 0, nWatch = 0, nPass = 0;
const yurl = (ysym) => `https://finance.yahoo.com/quote/${encodeURIComponent(ysym)}`;
for (const row of rows0) {
  const { u, f, p, price } = row;
  const base = { id: u.id, n: f.name || u.name, ko: f.nameKo || u.nameKo || null, m: u.market, cur: f.currency || (u.market === "KR" ? "KRW" : "USD"),
    ind: f.industry || null, sec: f.sector || null, p: price, pd: p.priceDate, ua: f.fundAt || null };
  if (f.excluded) { stocks.push({ ...base, ex: f.excluded }); continue; }
  if (!n(f.revenue) || !n(f.shares) || n(f.opIncome) === null) { stocks.push({ ...base, ex: "재무 정보 부족" }); continue; }
  const pe = peers(row, "fwdPe"), ps = peers(row, "ps");
  const shares = n(f.shares), mcap = shares ? price * shares : null;
  const s = {
    ...f, ticker: u.id, name: u.market === "KR" && (f.nameKo || u.nameKo) ? (f.nameKo || u.nameKo) : (f.name || u.name),
    market: u.market, exchange: u.market === "KR" ? (u.ysym.endsWith(".KQ") ? "kosdaq" : "krx") : "us",
    currency: base.cur, price, priceDate: p.priceDate, sma200: n(p.sma200),
    mcap, ev: mcap !== null ? mcap + (n(f.debt) ?? 0) - (n(f.cash) ?? 0) : null,
    fwdPe: row.fwdPe, peerPe: pe ? pe.v : null,
    peerLabel: pe ? `${pe.label} ${pe.n}개사 Forward PER 중간값 (${f.industry || f.sector}; 예: ${pe.names.join(", ")})` : "",
    peerPs: ps ? ps.v : null, sector: f.industry || f.sector || "",
    sources: [{ label: "Yahoo Finance (yfinance) 시세·재무·컨센서스", url: yurl(u.ysym), asOf: f.fundAt || today }],
  };
  // 매출성장률: 컨센서스(다음 회계연도) → 과거 3년 연평균 → 최근 분기 전년 대비. 뒤의 둘은 −10~15%로 자름
  // (분기 성장률은 일회성 행사·인수로 크게 튀어서 마지막에 씀)
  const clamp = (v) => Math.max(-10, Math.min(15, v));
  let growthNote = null;
  // yfinance의 '+1y growth'는 한국 종목에서 엉뚱한 값이 섞여 나옴(오리온 239% 등) → 매출 컨센서스로 직접 계산
  if (n(f.revNextFY) > 0 && n(f.revCurFY) > 0) s.revGrowthNext = (n(f.revNextFY) / n(f.revCurFY) - 1) * 100;
  if (n(s.revGrowthNext) !== null && (n(s.revGrowthNext) > 100 || n(s.revGrowthNext) < -50)) {
    growthNote = `매출 컨센서스 성장률 ${Math.round(n(s.revGrowthNext))}%는 이상치로 보고 제외`;
    s.revGrowthNext = null;
  }
  if (n(s.revGrowthNext) === null) {
    const alt = n(f.revCagr3) ?? n(f.revGrowthTtm);
    if (alt !== null) { s.revGrowthTtm = clamp(alt); growthNote = growthNote || "매출 컨센서스 없음 (과거 성장률 사용)"; }
    else { s.revGrowthTtm = null; growthNote = "매출 성장률 자료 없음 (0% 가정)"; }
  }
  // 베타 하한 0.6: 한국 대형주 쏠림 등으로 0.1~0.3 같은 베타가 나오면 할인율이 비현실적으로 낮아짐
  let betaNote = null;
  if (n(s.beta) !== null && n(s.beta) < 0.6) { betaNote = `베타 ${r2(n(s.beta))} → 자동 선별 하한 0.6 적용`; s.beta = 0.6; }
  const captive = /Auto Manufacturers|Farm & Heavy Construction Machinery|Recreational Vehicles/.test(f.industry || "");
  const st1 = S.stage1(s);
  const doc = S.buildDoc(s, params, today);
  doc.ysym = u.ysym;
  if (betaNote) doc.assumptions = doc.assumptions.replace("자동 발굴 초안(스킬 기본 규칙).", `자동 발굴 초안(스킬 기본 규칙). ${betaNote}.`);
  if (doc.relMethod === "ps" && !n(doc.fwdRevenue) && n(f.revenue)) doc.fwdRevenue = r2(n(f.revenue) * (1 + (n(s.revGrowthNext) ?? n(s.revGrowthTtm) ?? 0) / 100));
  const g = S.grade(doc, today);
  if (!st1.pass) g.tier = null;
  if (growthNote) g.flags = [...(g.flags || []), growthNote];
  {
    const rr = FV.compute(doc), tv = rr.dcfBase ? rr.dcfBase.tvShare : null;
    if (g.tier === "candidate" && ((tv !== null && tv > 85) || (Number.isFinite(g.gap) && g.gap < -70))) {
      g.tier = "watch"; g.flags = [...(g.flags || []), "자동 계산 신뢰 낮음: 후보 → 관찰"];
    }
  }
  if (captive && n(f.debt) > 2 * (n(f.cash) ?? 0)) g.flags = [...(g.flags || []), "금융 자회사 부채 포함 가능 (DCF 과소평가)"];
  doc.screen = { ...g, pass: st1.pass, reasons: st1.reasons, notes: st1.notes, ebitEv: st1.ebitEv, fcfYield: st1.fcfYield, ndEbitda: st1.ndEbitda };
  doc.updatedBy = "pipeline";
  docs[u.id] = doc;
  if (st1.pass) nPass++;
  if (g.tier === "candidate") nCand++; else if (g.tier === "watch") nWatch++;
  const r = FV.compute(doc);
  stocks.push({ ...base, fair: g.fair, bear: g.bear, bull: g.bull, gap: g.gap, st: r.status || null, tier: g.tier, agree: g.agree,
    flags: g.flags, fpe: r2(row.fwdPe), ebitEv: st1.ebitEv, fcfY: st1.fcfYield, ndE: st1.ndEbitda, pass: st1.pass, why: st1.reasons });
}

/* ---------- 노트 종목 (직접 정리한 문서, 시세만 갱신) ---------- */
const noteDir = path.join(ROOT, "config", "notes");
for (const file of fs.existsSync(noteDir) ? fs.readdirSync(noteDir).filter((x) => x.endsWith(".json")) : []) {
  const d0 = JSON.parse(fs.readFileSync(path.join(noteDir, file), "utf8"));
  const id = d0.ticker, f = fund[id] || {}, p = prices[id] || {};
  const upd = { price: p.price, priceDate: p.priceDate, sma200: p.sma200, nextEarnings: f.nextEarnings,
    fwdPe: n(f.forwardEps) > 0 && n(p.price) ? n(p.price) / n(f.forwardEps) : null,
    targetLow: f.targetLow, targetMedian: f.targetMedian, targetHigh: f.targetHigh, targetAnalysts: f.targetAnalysts, epsAnalysts: f.epsAnalysts };
  const { doc, earningsPassed } = S.refresh(d0, upd, params, today);
  doc.note = true;
  doc.needsReview = earningsPassed || null;
  doc.updatedBy = d0.updatedBy;
  docs[id] = doc;
  const r = FV.compute(doc);
  const i = stocks.findIndex((x) => x.id === id);
  const row = { id, n: doc.name, ko: doc.market === "KR" ? doc.name : null, m: doc.market, cur: doc.currency, ind: doc.sector || null, sec: null,
    p: n(doc.price), pd: doc.priceDate, ua: d0.updatedAt, fair: r2(r.blend.base), bear: r2(r.blend.bear), bull: r2(r.blend.bull),
    gap: r2(r.gap), st: r.status || null, tier: null, fpe: r2(r.fwdPe), note: true, nr: doc.needsReview };
  if (i >= 0) stocks[i] = { ...stocks[i], ...row }; else stocks.push(row);
}

const meta = {
  generatedAt: new Date().toISOString(), today, repo,
  params: { rf_us: params.rf_us, rf_us_asOf: params.rf_us_asOf, erp_us: params.erp_us, erp_us_asOf: params.erp_us_asOf,
    rf_kr: params.rf_kr, rf_kr_asOf: params.rf_kr_asOf, erp_kr: params.erp_kr, erp_kr_asOf: params.erp_kr_asOf },
  universe: { size: universe.length, sources: run.universeSources || {} },
  counts: { priced: rows0.length, docs: Object.keys(docs).length, pass: nPass, candidates: nCand, watch: nWatch,
    excluded: stocks.filter((x) => x.ex).length, notes: stocks.filter((x) => x.note).length },
  run: { lastRun: run.lastRun, fundUpdated: (run.fundUpdated || []).length, errors: (run.errors || []).length },
  criteria: "1차: 영업이익·FCF 흑자, 순부채/EBITDA ≤ 3배, EBIT/EV ≥ 8% 또는 FCF 수익률 ≥ 6% 또는 Forward PER ≤ 업종 × 0.75. 2차: 종합 괴리율 ≤ −15%이고 DCF·상대가치 모두 현재가보다 높으면 후보, 하나만 높으면 관찰.",
};
const out = path.join(ROOT, "app", "data");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "stocks.json"), JSON.stringify(stocks));
fs.writeFileSync(path.join(out, "docs.json"), JSON.stringify(docs));
fs.writeFileSync(path.join(out, "meta.json"), JSON.stringify(meta, null, 1));
fs.copyFileSync(path.join(__dirname, "engine.js"), path.join(ROOT, "app", "engine.js"));
// 화면 파일이 바뀌면 서비스 워커 캐시 이름도 바뀌게 (설치된 앱이 옛 화면에 머물지 않도록)
{
  const crypto = require("crypto");
  const h = crypto.createHash("sha1");
  for (const f of ["index.html", "engine.js", "manifest.webmanifest"]) { try { h.update(fs.readFileSync(path.join(ROOT, "app", f))); } catch (e) { /* 없는 파일은 건너뜀 */ } }
  const swp = path.join(ROOT, "app", "sw.js");
  if (fs.existsSync(swp)) fs.writeFileSync(swp, fs.readFileSync(swp, "utf8").replace(/const VER = "[^"]*";/, `const VER = "fv-${h.digest("hex").slice(0, 10)}";`));
}
console.log(`stocks ${stocks.length} · docs ${Object.keys(docs).length} · 1차 통과 ${nPass} · 후보 ${nCand} · 관찰 ${nWatch}`);
