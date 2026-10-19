/* 적정주가 노트 — 자동 갱신·발굴 보조 스크립트 (engine.js와 같은 폴더에 두고 실행)
 *
 *   node screen.js stage1  rows.json                 1차 선별 (통계 페이지 값만으로)
 *   node screen.js build   stage2.json params.json   2차: 후보 문서 초안 + 적정가 + 등급
 *   node screen.js eval    doc.json                  문서 하나(조정 후) 재계산 + 등급
 *   node screen.js refresh docs.json updates.json params.json today   노트 종목 시세 갱신
 *
 * 금액 단위: 백만 통화단위 (USD $M, KRW 백만원). 퍼센트: % 숫자.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const FV = require(path.join(__dirname, "engine.js"));
const n = FV.num;
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/* ---------- 1차 선별 ----------
 * 통과 조건 (모두):
 *   영업이익 > 0, FCF > 0, 순부채/EBITDA ≤ 3
 *   그리고 싸다는 신호 하나 이상: EBIT/EV ≥ 8%  또는  FCF 수익률 ≥ 6%  또는  Forward PER ≤ 업종 × 0.75
 */
const STAGE1 = { ebitEv: 8, fcfYield: 6, ndEbitda: 3, peRel: 0.75 };

function stage1(r) {
  const op = n(r.opIncome), ev = n(r.ev), mcap = n(r.mcap), fcf = n(r.fcf), da = n(r.da) ?? 0;
  const ebitda = op !== null ? op + da : null;
  const netDebt = (n(r.debt) ?? 0) - (n(r.cash) ?? 0);
  const fwdPe = n(r.fwdPe), peerPe = n(r.peerPe);
  const o = {
    ticker: r.ticker, name: r.name || "", market: r.market, exchange: r.exchange || null, currency: r.currency,
    price: n(r.price), priceDate: r.priceDate || null,
    ebitEv: op !== null && ev > 0 ? r2(op / ev * 100) : null,
    fcfYield: fcf !== null && mcap > 0 ? r2(fcf / mcap * 100) : null,
    ndEbitda: ebitda !== null && ebitda > 0 ? r2(netDebt / ebitda) : null,
    fwdPe: fwdPe, peerPe: peerPe,
    belowSma200: n(r.sma200) && n(r.price) ? n(r.price) < n(r.sma200) : null,
  };
  const reasons = [];
  if (op === null || op <= 0) reasons.push("영업적자");
  if (fcf === null || fcf <= 0) reasons.push("FCF 적자");
  if (ebitda !== null && ebitda > 0 && netDebt / ebitda > STAGE1.ndEbitda) reasons.push("순부채/EBITDA 3배 초과");
  const cheap = (o.ebitEv !== null && o.ebitEv >= STAGE1.ebitEv)
    || (o.fcfYield !== null && o.fcfYield >= STAGE1.fcfYield)
    || (fwdPe > 0 && peerPe > 0 && fwdPe <= peerPe * STAGE1.peRel);
  if (reasons.length === 0 && !cheap) reasons.push("싼 신호 없음");
  o.pass = reasons.length === 0;
  o.reasons = reasons;
  o.notes = [];
  if (o.fcfYield !== null && o.fcfYield > 25) o.notes.push("FCF 수익률이 비정상적으로 높음: 리스 상환·운전자본 일회성 확인");
  if (mcap > 0 && ev / mcap > 1.8) o.notes.push("EV가 시가총액의 1.8배 초과: 리스·차입 구조 확인");
  return o;
}

/* ---------- 2차: 문서 초안 (fair-value-note 스킬 기본 규칙) ---------- */
function buildDoc(s, p, today) {
  const kr = s.market === "KR";
  const rev = n(s.revenue), op = n(s.opIncome), da = n(s.da) ?? 0, capex = Math.abs(n(s.capex) ?? 0);
  const price = n(s.price), shares = n(s.shares);
  const tg = kr ? 2.5 : 3;
  const rf = kr ? n(p.rf_kr) : n(p.rf_us);
  const erp = kr ? n(p.erp_kr) : n(p.erp_us) + (s.koreaRevenue ? (n(p.kr_crp) ?? 0) : 0);
  let tax = n(s.taxRate);
  if (tax === null || tax < 10 || tax > 30) tax = kr ? 22 : 21;
  const margin0 = rev ? r2(op / rev * 100) : null;
  const growth1 = n(s.revGrowthNext) ?? n(s.revGrowthTtm) ?? 0;
  const reinvest0 = rev ? r2(Math.max(0, (capex - da) / rev * 100)) : 0;
  let beta = n(s.beta) ?? 1;
  const notes = [];
  if (beta < 0.5) { const adj = r2(0.67 * beta + 0.33); notes.push(`베타 ${beta} → 조정 베타 ${adj} (0.67β+0.33)`); beta = adj; }
  const fwdPe = n(s.fwdPe);
  let fwdEps = null;
  if (fwdPe && fwdPe > 0 && price) { fwdEps = Math.round(price / fwdPe * 1000) / 1000; notes.push(`Forward EPS = 주가 ÷ Forward PER ${fwdPe}`); }
  else if (n(s.epsNextFY) !== null) { fwdEps = n(s.epsNextFY); notes.push("Forward EPS = 다음 회계연도 컨센서스"); }
  const epsCur = n(s.epsCurFY), epsNext = n(s.epsNextFY);
  const epsGrowth = epsCur > 0 && epsNext > 0 ? r2((epsNext / epsCur - 1) * 100) : null;
  const mcap = price && shares ? price * shares : n(s.mcap);
  const big = kr ? 250e6 : 200e3, smallCap = kr ? 2.5e6 : 2e3;
  let category = "mid";
  if (mcap >= big && beta < 1.4) category = "bigtech";
  else if (mcap < smallCap || beta > 2) category = "small";
  else if ((n(s.divYield) ?? 0) >= 3 && (epsGrowth ?? 0) < 5) category = "value";
  const thin = margin0 !== null && Math.abs(margin0) < 4;
  // 업황 고점 보정: 현재 이익률이 5년 평균의 1.5배를 넘으면 5년 뒤 이익률은 5년 평균으로, 5년차 성장률은 영구성장률+1%p로
  const m5y = n(s.margin5yAvg);
  let margin5 = margin0, growth5 = Math.max(tg + 1, growth1 * 0.5);
  if (m5y !== null && m5y > 0 && margin0 > 1.5 * m5y) {
    margin5 = r2(m5y); growth5 = tg + 1;
    notes.push(`업황 고점 보정: 영업이익률 TTM ${margin0}%가 5년 평균 ${r2(m5y)}%의 1.5배를 넘어 5년 뒤 이익률을 평균으로, 5년차 성장률을 ${tg + 1}%로 둠`);
  }
  const relMethod = fwdEps > 0 ? "pe" : "ps";
  const doc = {
    ticker: s.ticker, name: s.name || s.ticker, market: s.market, exchange: s.exchange || (kr ? "krx" : "us"),
    currency: s.currency || (kr ? "KRW" : "USD"), category, sector: s.sector || "",
    price, priceDate: s.priceDate || today, shares, cash: n(s.cash) ?? 0, debt: n(s.debt) ?? 0, beta,
    fwdEps, epsAnalysts: n(s.epsAnalysts), peerPe: n(s.peerPe), peerLabel: s.peerLabel || "",
    epsGrowth, pegTarget: 1, relMethod, fwdRevenue: n(s.revNextFY), peerPs: n(s.peerPs),
    revenue0: rev, growth1: r2(growth1), growth5: r2(growth5),
    margin0, margin5, tax, reinvest0, reinvest5: r2(reinvest0 * 0.5),
    rf, erp: r2(erp), rd: rf !== null ? r2(rf + (n(s.creditSpread) ?? 1.5)) : null,
    waccMode: "capm", waccManual: null, tg,
    targetLow: n(s.targetLow), targetMedian: n(s.targetMedian), targetHigh: n(s.targetHigh), targetAnalysts: n(s.targetAnalysts),
    nextEarnings: s.nextEarnings || null, sma200: n(s.sma200),
    weights: { dcf: 50, rel: 50, peg: 0, target: 0 },
    scen: { growth: 3, margin: thin ? 0.5 : 2, wacc: 1, mult: 20, tg: 0.5 },
    position: { cap: 5, tranches: 5 },
    assumptions: ["자동 발굴 초안(스킬 기본 규칙).", ...notes,
      `매출성장률 1년차 ${r2(growth1)}% → 5년차 ${r2(growth5)}%`,
      margin5 === margin0 ? `영업이익률 TTM ${margin0}% 유지` : `영업이익률 ${margin0}% → 5년 뒤 ${margin5}%`, `재투자율 ${reinvest0}% → ${r2(reinvest0 * 0.5)}%`,
      thin ? "얇은 마진이라 시나리오 이익률 폭 ±0.5%p" : ""].filter(Boolean).join(" "),
    memo: "", sources: s.sources || [], updatedAt: today, updatedBy: "claude-auto", source: "screen",
    _check: { netIncome: n(s.netIncome), opIncome: op, epsCur, epsNext, margin5y: n(s.margin5yAvg) },
  };
  return doc;
}

/* ---------- 등급과 함정 점검 ----------
 * 후보: 종합 괴리율 ≤ −15% 이고 DCF·상대가치 둘 다 현재가보다 높음
 * 관찰: 종합 괴리율 ≤ −15% 이고 둘 중 하나만 높음
 */
function grade(doc, today) {
  const r = FV.compute(doc);
  const price = n(doc.price);
  const dcfB = r.methods.dcf ? r.methods.dcf.base : null;
  const relB = r.methods.rel ? r.methods.rel.base : null;
  const agree = [dcfB, relB].filter((v) => v !== null && price < v).length;
  const ck = doc._check || {};
  const flags = [];
  if (n(doc.sma200) && price < n(doc.sma200)) flags.push("200일선 아래");
  if (n(doc.epsAnalysts) !== null && n(doc.epsAnalysts) < 5) flags.push("애널리스트 5명 미만");
  if (r.dcfBase && r.dcfBase.tvShare > 85) flags.push("영구가치 85% 초과");
  if (ck.epsCur > 0 && ck.epsNext !== null && ck.epsNext < ck.epsCur) flags.push("내년 EPS 감소 전망");
  if (ck.netIncome !== null && ck.opIncome > 0 && ck.netIncome > 1.5 * ck.opIncome * (1 - (n(doc.tax) || 21) / 100)) flags.push("영업외 이익 비중 큼");
  if (ck.margin5y && doc.margin0 > 1.5 * ck.margin5y && ck.margin5y > 0) flags.push("이익률이 5년 평균의 1.5배 (업황 고점 가능)");
  if (r.fwdPe && r.fwdPe > 60) flags.push("Forward PER 60배 초과");
  let tier = null;
  if (r.gap !== undefined && r.gap <= -15 && agree === 2) tier = "candidate";
  else if (r.gap !== undefined && r.gap <= -15 && agree === 1) tier = "watch";
  return {
    tier, agree, flags,
    fair: r2(r.blend.base), bear: r2(r.blend.bear), bull: r2(r.blend.bull), gap: r2(r.gap),
    dcf: r2(dcfB), rel: r2(relB), wacc: r.wacc ? r2(r.wacc.wacc) : null, runAt: today,
  };
}

/* ---------- 노트 종목 시세 갱신 ----------
 * 바꾸는 값: price, priceDate, sma200, nextEarnings, 목표주가·애널리스트 수, fwdEps(PER 방식일 때), rf·erp(CAPM일 때)
 * 그대로 두는 값: 매출·이익률·부채·현금·주식수·성장률·사용자가 정한 가정 (실적 발표 후 전체 재평가 때만 바꿈)
 */
function refresh(doc, u, p, today) {
  const d = JSON.parse(JSON.stringify(doc));
  const changes = [];
  const set = (k, v, label) => {
    if (v === null || v === undefined || v === "") return;
    if (JSON.stringify(d[k]) !== JSON.stringify(v)) { changes.push(`${label || k} ${d[k] ?? "–"} → ${v}`); d[k] = v; }
  };
  const earningsPassed = !!(doc.nextEarnings && doc.nextEarnings < today);
  set("price", n(u.price), "주가");
  set("priceDate", u.priceDate, "기준일");
  set("sma200", n(u.sma200), "200일선");
  if (u.nextEarnings && (!doc.nextEarnings || u.nextEarnings >= today)) set("nextEarnings", u.nextEarnings, "다음 실적일");
  set("targetLow", n(u.targetLow), "목표주가 최저");
  set("targetMedian", n(u.targetMedian), "목표주가 중간값");
  set("targetHigh", n(u.targetHigh), "목표주가 최고");
  set("targetAnalysts", n(u.targetAnalysts), "목표주가 애널리스트");
  set("epsAnalysts", n(u.epsAnalysts), "EPS 애널리스트");
  if ((d.relMethod || "pe") === "pe" && n(u.fwdPe) > 0 && n(u.price)) set("fwdEps", Math.round(n(u.price) / n(u.fwdPe) * 1000) / 1000, "Forward EPS");
  if (d.waccMode !== "manual") {
    const kr = d.market === "KR";
    set("rf", kr ? n(p.rf_kr) : n(p.rf_us), "무위험금리");
  }
  d.updatedAt = today;
  if (d.updatedBy !== "user") d.updatedBy = "claude-auto";
  d.lastAuto = { at: today, changes, earningsPassed };
  return { doc: d, changes, earningsPassed };
}

/* ---------- CLI ---------- */
function readJson(f) { return JSON.parse(fs.readFileSync(f, "utf8")); }
if (require.main === module) {
const [cmd, a, b, c, dArg] = process.argv.slice(2);
const today = dArg || c || new Date().toISOString().slice(0, 10);
if (cmd === "stage1") {
  console.log(JSON.stringify(readJson(a).map(stage1), null, 2));
} else if (cmd === "build") {
  const rows = readJson(a), params = readJson(b);
  const t = c || new Date().toISOString().slice(0, 10);
  console.log(JSON.stringify(rows.map((s) => { const doc = buildDoc(s, params, t); doc.screen = grade(doc, t); return doc; }), null, 2));
} else if (cmd === "eval") {
  const doc = readJson(a);
  const t = b || new Date().toISOString().slice(0, 10);
  doc.screen = grade(doc, t);
  console.log(JSON.stringify(doc, null, 2));
} else if (cmd === "refresh") {
  const docs = readJson(a), ups = readJson(b), params = readJson(c);
  const t = dArg || new Date().toISOString().slice(0, 10);
  console.log(JSON.stringify(docs.map((doc) => refresh(doc, ups[doc.ticker] || {}, params, t)), null, 2));
} else {
  console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(0, 9).join("\n"));
}
}
module.exports = { stage1, buildDoc, grade, refresh, STAGE1 };
