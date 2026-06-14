/* ============================================================
   契約管理システム  app.js
   - 純粋ロジックは core.* に集約 (Nodeで単体テスト可能)
   - データは localStorage に永続化
   ============================================================ */

(function (global) {
  "use strict";

  const EXPIRING_DAYS = 60; // この日数以内に終了 = 更新間近

  /* ============================================================
     core : 純粋ロジック (副作用なし)
     ============================================================ */
  const core = {
    EXPIRING_DAYS,

    parseDate(s) {
      if (!s) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (!m) return null;
      return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    },

    fmtDateISO(d) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    },

    /** 開始日から years 年の契約終了日（開始日＋年数−1日）。例: 2026-04-01 / 1年 → 2027-03-31 */
    termEnd(startStr, years) {
      const s = core.parseDate(startStr);
      if (!s) return "";
      const e = new Date(Date.UTC(s.getUTCFullYear() + years, s.getUTCMonth(), s.getUTCDate()));
      e.setUTCDate(e.getUTCDate() - 1);
      return core.fmtDateISO(e);
    },

    daysUntil(endDate, today) {
      const e = core.parseDate(endDate);
      const t = core.parseDate(today);
      if (!e || !t) return null;
      return Math.round((e - t) / 86400000);
    },

    computeStatus(c, today) {
      if (c.statusOverride === "cancelled") return "cancelled"; // 手動: 解約
      const t = core.parseDate(today);
      const s = core.parseDate(c.startDate);
      const e = core.parseDate(c.endDate);
      if (s && t && s > t) return "upcoming";
      if (!e) return "active";
      if (e < t) return "expired";
      const days = Math.round((e - t) / 86400000);
      if (days <= EXPIRING_DAYS) return "expiring";
      return "active";
    },

    statusLabel(st) {
      return { active: "有効", expiring: "更新間近", expired: "期限切れ", upcoming: "開始前", cancelled: "解約" }[st] || st;
    },

    contractAmount(c) {
      const q = Number(c.quantity) || 0;
      const u = Number(c.unitPrice) || 0;
      if (u > 0) return q * u;
      return Number(c.amount) || 0;
    },

    /** 契約金額を年額換算 (ARR)。契約期間で割って365日換算。期間不明なら金額そのまま */
    annualAmount(c) {
      const amt = core.contractAmount(c);
      const s = core.parseDate(c.startDate), e = core.parseDate(c.endDate);
      if (!s || !e) return amt;
      const days = Math.round((e - s) / 86400000) + 1; // 終了日を含む
      if (days <= 0) return amt;
      return Math.round((amt * 365) / days);
    },

    formatYen(n) {
      const v = Number(n) || 0;
      return "¥" + v.toLocaleString("ja-JP");
    },

    /** href 用にURLスキームを検証（http/https/mailto/tel のみ許可、それ以外は # ）。javascript: 等のXSSを防ぐ */
    safeUrl(u) {
      const s = String(u || "").trim();
      return /^(https?:|mailto:|tel:)/i.test(s) ? s : "#";
    },

    TAX_RATE: 0.1,

    /** 税込金額（四捨五入）。rate 省略時は標準税率 */
    taxIncluded(amount, rate) {
      const r = rate == null ? core.TAX_RATE : rate;
      return Math.round((Number(amount) || 0) * (1 + r));
    },

    formatDate(s) {
      const d = core.parseDate(s);
      if (!d) return "—";
      return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
    },

    filterContracts(contracts, companies, opts) {
      const { keyword = "", status = "all", rep = "all", planner = "all", product = "all", tag = "all", billing = "all" } = opts || {};
      const kw = keyword.trim().toLowerCase();
      const today = opts && opts.today;
      const nameById = {};
      (companies || []).forEach((c) => (nameById[c.id] = c.name));
      return contracts.filter((c) => {
        if (status !== "all" && core.computeStatus(c, today) !== status) return false;
        if (rep !== "all" && (c.salesRep || "") !== rep) return false;
        if (planner !== "all" && (c.plannerRep || "") !== planner) return false;
        if (product !== "all" && (c.productName || "") !== product) return false;
        if (billing !== "all" && (c.billingType || "") !== billing) return false;
        if (tag !== "all" && !((c.tags || []).includes(tag))) return false;
        if (kw) {
          const hay = [nameById[c.companyId] || "", c.department, c.productName, c.licenseType, c.salesRep, c.contractNo, (c.tags || []).join(" "), c.note]
            .join(" ")
            .toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      });
    },

    sortContracts(contracts, companies, key, dir, today) {
      const nameById = {};
      (companies || []).forEach((c) => (nameById[c.id] = c.name));
      const sign = dir === "desc" ? -1 : 1;
      const val = (c) => {
        switch (key) {
          case "contractNo": return c.contractNo || "";
          case "company": return nameById[c.companyId] || "";
          case "department": return c.department || "";
          case "product": return (c.productName || "") + (c.licenseType || "");
          case "billing": return c.billingType || "";
          case "licenseType": return c.licenseType || "";
          case "salesRep": return c.salesRep || "";
          case "quantity": return Number(c.quantity) || 0;
          case "amount": return core.contractAmount(c);
          case "endDate": return core.parseDate(c.endDate) ? core.parseDate(c.endDate).getTime() : Infinity;
          case "daysLeft": {
            const d = core.daysUntil(c.endDate, today);
            return d === null ? Infinity : d;
          }
          default: return "";
        }
      };
      return contracts.slice().sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va < vb) return -1 * sign;
        if (va > vb) return 1 * sign;
        return 0;
      });
    },

    summarize(contracts, today) {
      const out = { total: contracts.length, active: 0, expiring: 0, expired: 0, upcoming: 0, cancelled: 0, annualActive: 0, arrActive: 0 };
      contracts.forEach((c) => {
        const st = core.computeStatus(c, today);
        if (out[st] != null) out[st]++;
        if (st === "active" || st === "expiring") {
          out.annualActive += core.contractAmount(c);
          out.arrActive += core.annualAmount(c);
        }
      });
      return out;
    },

    /** 営業担当ごとの契約数・金額・主な製品・状態内訳（金額降順） */
    repRanking(contracts, today) {
      const map = {};
      (contracts || []).forEach((c) => {
        const r = c.salesRep || "(未割当)";
        if (!map[r]) map[r] = { name: r, count: 0, amount: 0, products: {}, status: { active: 0, expiring: 0, expired: 0, upcoming: 0, cancelled: 0 } };
        const m = map[r];
        m.count++;
        m.amount += core.contractAmount(c);
        const p = c.productName || "(製品未設定)";
        m.products[p] = (m.products[p] || 0) + 1;
        const st = core.computeStatus(c, today);
        if (m.status[st] != null) m.status[st]++;
      });
      return Object.values(map)
        .map((m) => ({
          ...m,
          topProducts: Object.entries(m.products).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, q]) => `${n}×${q}`),
        }))
        .sort((a, b) => b.amount - a.amount);
    },

    /** 契約配列の件数・金額合計・税込合計 */
    totals(contracts) {
      let amount = 0;
      (contracts || []).forEach((c) => { amount += core.contractAmount(c); });
      return { count: (contracts || []).length, amount, taxIncluded: core.taxIncluded(amount) };
    },

    /** 活動メモを新しい順で先頭に追加（空文字は無視）。純粋関数: stamp は呼び出し側が渡す */
    addActivity(activities, text, stamp) {
      const list = Array.isArray(activities) ? activities.slice() : [];
      if (!text || !String(text).trim()) return list;
      list.unshift({ at: stamp || "", text: String(text).trim() });
      return list;
    },

    /** ステータス構成比（有効/更新間近/期限切れ/開始前/解約） */
    statusBreakdown(contracts, today) {
      const order = ["active", "expiring", "expired", "upcoming", "cancelled"];
      const counts = { active: 0, expiring: 0, expired: 0, upcoming: 0, cancelled: 0 };
      (contracts || []).forEach((c) => { const st = core.computeStatus(c, today); if (counts[st] != null) counts[st]++; });
      const total = (contracts || []).length || 1;
      return order.map((st) => ({ status: st, label: core.statusLabel(st), count: counts[st], pct: Math.round((counts[st] / total) * 100) }));
    },

    /** 日付が属する会計年度（startMonth 始まり, 既定4月）。2026/04〜2027/03 → 2026 */
    fiscalYear(dateStr, startMonth) {
      startMonth = startMonth || 4;
      const d = core.parseDate(dateStr);
      if (!d) return null;
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
      return m >= startMonth ? y : y - 1;
    },

    /** 開始日基準で会計年度ごとの件数・金額を集計 */
    byFiscalYear(contracts, startMonth) {
      const map = {};
      (contracts || []).forEach((c) => {
        const fy = core.fiscalYear(c.startDate, startMonth);
        if (fy === null) return;
        if (!map[fy]) map[fy] = { fy, count: 0, amount: 0 };
        map[fy].count++;
        map[fy].amount += core.contractAmount(c);
      });
      return Object.values(map).sort((a, b) => a.fy - b.fy);
    },

    forecastByMonth(contracts, today, months) {
      months = months || 6;
      const t = core.parseDate(today);
      if (!t) return [];
      const buckets = [];
      const idx = {};
      for (let i = 0; i < months; i++) {
        const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + i, 1));
        const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        const b = { ym, label: `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`, count: 0, amount: 0 };
        idx[ym] = b;
        buckets.push(b);
      }
      contracts.forEach((c) => {
        const e = core.parseDate(c.endDate);
        if (!e) return;
        const ym = `${e.getUTCFullYear()}-${String(e.getUTCMonth() + 1).padStart(2, "0")}`;
        if (idx[ym]) {
          idx[ym].count++;
          idx[ym].amount += core.contractAmount(c);
        }
      });
      return buckets;
    },

    nextContractNo(contracts, year) {
      const prefix = `C-${year}-`;
      let max = 0;
      (contracts || []).forEach((c) => {
        if (c.contractNo && c.contractNo.indexOf(prefix) === 0) {
          const n = parseInt(c.contractNo.slice(prefix.length), 10);
          if (!isNaN(n) && n > max) max = n;
        }
      });
      return prefix + String(max + 1).padStart(4, "0");
    },

    renewalEmail(c, companyName, contactName) {
      const lic = [c.productName, c.licenseType].filter(Boolean).join(" ");
      const subject = `【ご契約更新のご案内】${lic || "ライセンス"}（${companyName || ""}）`;
      const body = [
        `${companyName || ""}`,
        `${contactName ? contactName + " 様" : "ご担当者様"}`,
        ``,
        `いつもお世話になっております。`,
        `下記ご契約の更新時期が近づいておりますので、ご案内申し上げます。`,
        ``,
        `■ 契約番号: ${c.contractNo || "-"}`,
        `■ 製品 / ライセンス: ${lic || "-"}`,
        `■ 数量: ${Number(c.quantity) || 0} ライセンス`,
        `■ 契約期間: ${core.formatDate(c.startDate)} 〜 ${core.formatDate(c.endDate)}`,
        ``,
        `更新のご意向につきまして、ご確認いただけますと幸いです。`,
        `何卒よろしくお願い申し上げます。`,
      ].join("\n");
      return { subject, body };
    },

    renewalCopy(c) {
      const out = {
        companyId: c.companyId, department: c.department,
        productName: c.productName, licenseType: c.licenseType, billingType: c.billingType,
        quantity: c.quantity, unitPrice: c.unitPrice, amount: c.amount,
        salesRep: c.salesRep, plannerRep: c.plannerRep, customerContact: c.customerContact, autoRenew: c.autoRenew,
        tags: (c.tags || []).slice(), note: c.note,
        startDate: "", endDate: "",
      };
      const s = core.parseDate(c.startDate);
      const e = core.parseDate(c.endDate);
      if (s && e) {
        const lenDays = Math.round((e - s) / 86400000);
        const ns = new Date(e.getTime() + 86400000);
        const ne = new Date(ns.getTime() + lenDays * 86400000);
        out.startDate = core.fmtDateISO(ns);
        out.endDate = core.fmtDateISO(ne);
      }
      return out;
    },

    /* ---------- ガント ---------- */
    /** today を中心に before ヶ月前〜after ヶ月後の月配列と範囲日付を返す */
    ganttRange(today, before, after) {
      const t = core.parseDate(today);
      if (!t) return null;
      const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - before, 1));
      const end = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + after + 1, 1));
      const months = [];
      let cur = new Date(start);
      while (cur < end) {
        months.push({
          ym: `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`,
          month: cur.getUTCMonth() + 1,
          year: cur.getUTCFullYear(),
        });
        cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
      }
      return { startStr: core.fmtDateISO(start), endStr: core.fmtDateISO(end), months };
    },

    /** ある日付が範囲内の何%位置かを返す (0〜100, 範囲外は clip) */
    datePct(dateStr, startStr, endStr) {
      const d = core.parseDate(dateStr), rs = core.parseDate(startStr), re = core.parseDate(endStr);
      if (!d || !rs || !re || re <= rs) return null;
      return Math.max(0, Math.min(100, ((d - rs) / (re - rs)) * 100));
    },

    /** 契約バーの left/width(%)。範囲外なら visible:false */
    ganttBar(c, startStr, endStr) {
      const rs = core.parseDate(startStr), re = core.parseDate(endStr);
      const cs = core.parseDate(c.startDate), ce = core.parseDate(c.endDate);
      if (!rs || !re || !cs || !ce || re <= rs) return { visible: false };
      if (ce < rs || cs > re) return { visible: false };
      const total = re - rs;
      const left = Math.max(0, (cs - rs) / total) * 100;
      const right = Math.min(1, (ce - rs) / total) * 100;
      return { visible: true, leftPct: left, widthPct: Math.max(1.5, right - left) };
    },

    /** 表示スケール(week/month/year)に応じた時間軸 {startStr,endStr,ticks[],scale} を返す */
    ganttAxis(scale, today, units) {
      const t = core.parseDate(today);
      if (!t) return null;
      const fmt = core.fmtDateISO;
      const DAY = 86400000;
      const WD = ["日", "月", "火", "水", "木", "金", "土"];
      scale = scale === "day" || scale === "year" ? scale : "month";
      let start, end;
      const ticks = [];

      if (scale === "day") {
        const total = units || 35;
        const before = Math.round(total * 0.2);
        const base = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
        start = new Date(base.getTime() - before * DAY);
        end = new Date(start.getTime() + total * DAY);
        let cur = new Date(start);
        while (cur < end) {
          const dow = cur.getUTCDay();
          ticks.push({ date: fmt(cur), label: String(cur.getUTCDate()), sub: WD[dow], major: cur.getUTCDate() === 1, weekend: dow === 0 || dow === 6 });
          cur = new Date(cur.getTime() + DAY);
        }
      } else if (scale === "year") {
        const total = units || 4;
        start = new Date(Date.UTC(t.getUTCFullYear() - 1, 0, 1));
        end = new Date(Date.UTC(t.getUTCFullYear() - 1 + total, 0, 1));
        let cur = new Date(start);
        while (cur < end) {
          ticks.push({ date: fmt(cur), label: "Q" + (cur.getUTCMonth() / 3 + 1), major: cur.getUTCMonth() === 0, weekend: false });
          cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 3, 1));
        }
      } else {
        const total = units || 15;
        start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 2, 1));
        end = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 2 + total, 1));
        let cur = new Date(start);
        while (cur < end) {
          ticks.push({ date: fmt(cur), label: (cur.getUTCMonth() + 1) + "月", major: cur.getUTCMonth() === 0, weekend: false });
          cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
        }
      }

      const startStr = fmt(start), endStr = fmt(end);
      ticks.forEach((tk) => (tk.pos = core.datePct(tk.date, startStr, endStr)));

      // 上段見出し（日表示=月バンド / 月・年表示=年バンド）
      const groups = [];
      const byMonth = scale === "day";
      let g = byMonth ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)) : new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
      while (g < end) {
        const next = byMonth ? new Date(Date.UTC(g.getUTCFullYear(), g.getUTCMonth() + 1, 1)) : new Date(Date.UTC(g.getUTCFullYear() + 1, 0, 1));
        const gs = g < start ? start : g;
        const ge = next > end ? end : next;
        const pos = core.datePct(fmt(gs), startStr, endStr);
        const wend = core.datePct(fmt(ge), startStr, endStr);
        groups.push({ pos, width: wend - pos, label: byMonth ? `${g.getUTCFullYear()}年${g.getUTCMonth() + 1}月` : `${g.getUTCFullYear()}年` });
        g = next;
      }

      return { startStr, endStr, ticks, groups, scale };
    },

    /** 更新間近/期限切れで既存タスクが無い契約からタスク草案を生成 */
    suggestRenewalTasks(contracts, today, existingContractIds) {
      const ex = new Set(existingContractIds || []);
      const out = [];
      contracts.forEach((c) => {
        const st = core.computeStatus(c, today);
        if ((st === "expiring" || st === "expired") && !ex.has(c.id)) {
          out.push({ contractId: c.id, title: `${c.licenseType || c.productName || "契約"} の更新`, dueDate: c.endDate || "", status: "open" });
        }
      });
      return out;
    },

    /** 2契約の期間が重なるか */
    periodsOverlap(a, b) {
      const as = core.parseDate(a.startDate), ae = core.parseDate(a.endDate);
      const bs = core.parseDate(b.startDate), be = core.parseDate(b.endDate);
      if (!as || !ae || !bs || !be) return false;
      return as <= be && bs <= ae;
    },

    /** 同一企業×製品×ライセンスで期間が重なる契約グループを返す（重複の疑い） */
    findDuplicates(contracts) {
      const groups = {};
      contracts.forEach((c) => {
        const key = [c.companyId, c.productName || "", c.licenseType || ""].join("|");
        (groups[key] = groups[key] || []).push(c);
      });
      const out = [];
      Object.values(groups).forEach((arr) => {
        if (arr.length < 2) return;
        const flagged = new Set();
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            if (core.periodsOverlap(arr[i], arr[j])) { flagged.add(arr[i]); flagged.add(arr[j]); }
          }
        }
        if (flagged.size) out.push([...flagged]);
      });
      return out;
    },

    /* ---------- CSV ---------- */
    CSV_HEADERS: [
      "契約番号", "企業名", "部署", "製品", "ライセンス種別", "数量", "単価", "金額",
      "開始日", "終了日", "自動更新", "営業担当", "企画担当", "顧客担当者", "契約形態", "備考",
    ],

    csvEscape(v) {
      const s = v == null ? "" : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    },

    toCSV(contracts, companies) {
      const nameById = {};
      (companies || []).forEach((c) => (nameById[c.id] = c.name));
      const rows = [core.CSV_HEADERS.join(",")];
      contracts.forEach((c) => {
        rows.push(
          [
            c.contractNo, nameById[c.companyId] || "", c.department, c.productName, c.licenseType,
            c.quantity, c.unitPrice, core.contractAmount(c), c.startDate, c.endDate,
            c.autoRenew ? "あり" : "なし", c.salesRep, c.plannerRep, c.customerContact, c.billingType, c.note,
          ].map(core.csvEscape).join(",")
        );
      });
      return rows.join("\r\n");
    },

    parseCSV(text) {
      const rows = [];
      let row = [], cell = "", inQ = false;
      const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inQ) {
          if (ch === '"') {
            if (s[i + 1] === '"') { cell += '"'; i++; }
            else inQ = false;
          } else cell += ch;
        } else {
          if (ch === '"') inQ = true;
          else if (ch === ",") { row.push(cell); cell = ""; }
          else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
          else cell += ch;
        }
      }
      if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
      return rows.filter((r) => r.length && r.some((x) => x !== ""));
    },

    /* ---------- マスタ別 CSV ---------- */
    productsToCSV(products) {
      const rows = [["製品", "ライセンス", "説明", "色"].join(",")];
      (products || []).forEach((p) => {
        const lics = p.licenses && p.licenses.length ? p.licenses : [""];
        lics.forEach((l) => rows.push([p.name, l, p.description || "", p.color || ""].map(core.csvEscape).join(",")));
      });
      return rows.join("\r\n");
    },
    parseProductsCSV(text) {
      const rows = core.parseCSV(String(text).replace(/^﻿/, ""));
      if (rows.length < 2) return [];
      const h = rows[0]; const gi = (n) => h.indexOf(n);
      const map = {};
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; const g = (n) => { const j = gi(n); return j >= 0 ? (r[j] || "").trim() : ""; };
        const name = g("製品"); if (!name) continue;
        if (!map[name]) map[name] = { name, description: "", color: "", licenses: [] };
        const lic = g("ライセンス"); if (lic && !map[name].licenses.includes(lic)) map[name].licenses.push(lic);
        if (g("説明")) map[name].description = g("説明");
        if (g("色")) map[name].color = g("色");
      }
      return Object.values(map);
    },
    repsToCSV(sales, planners) {
      const rows = [["区分", "氏名", "部署", "メール", "Teams", "備考"].join(",")];
      const add = (kind, list) => (list || []).forEach((r) => { const o = typeof r === "string" ? { name: r } : r; rows.push([kind, o.name, o.dept || "", o.email || "", o.teams || "", o.note || ""].map(core.csvEscape).join(",")); });
      add("営業", sales); add("企画", planners);
      return rows.join("\r\n");
    },
    parseRepsCSV(text) {
      const rows = core.parseCSV(String(text).replace(/^﻿/, ""));
      const out = { sales: [], planners: [] };
      if (rows.length < 2) return out;
      const h = rows[0]; const gi = (n) => h.indexOf(n);
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; const g = (n) => { const j = gi(n); return j >= 0 ? (r[j] || "").trim() : ""; };
        const name = g("氏名"); if (!name) continue;
        const rep = { name, dept: g("部署"), email: g("メール"), teams: g("Teams"), note: g("備考") };
        (g("区分") === "企画" ? out.planners : out.sales).push(rep);
      }
      return out;
    },
    listToCSV(header, list) {
      return [header].concat((list || []).map((v) => core.csvEscape(v))).join("\r\n");
    },
    parseListCSV(text) {
      const rows = core.parseCSV(String(text).replace(/^﻿/, ""));
      return rows.slice(1).map((r) => (r[0] || "").trim()).filter(Boolean);
    },
    companiesToCSV(companies) {
      const rows = [["企業", "部署", "備考"].join(",")];
      (companies || []).forEach((co) => {
        const depts = (co.departments && co.departments.length) ? co.departments : [""];
        depts.forEach((d) => rows.push([co.name, d, co.note || ""].map(core.csvEscape).join(",")));
      });
      return rows.join("\r\n");
    },
    parseCompaniesCSV(text) {
      const rows = core.parseCSV(String(text).replace(/^﻿/, ""));
      if (rows.length < 2) return [];
      const h = rows[0]; const gi = (n) => h.indexOf(n);
      const map = {};
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; const g = (n) => { const j = gi(n); return j >= 0 ? (r[j] || "").trim() : ""; };
        const name = g("企業"); if (!name) continue;
        if (!map[name]) map[name] = { name, departments: [], note: "" };
        const d = g("部署"); if (d && !map[name].departments.includes(d)) map[name].departments.push(d);
        if (g("備考")) map[name].note = g("備考");
      }
      return Object.values(map);
    },

    makeId(prefix, seed) {
      return `${prefix}_${seed.toString(36)}`;
    },

    /** カンマ/読点区切り文字列をタグ配列に（重複・空白除去） */
    parseTags(str) {
      return [...new Set(String(str || "").split(/[,、]/).map((s) => s.trim()).filter(Boolean))];
    },

    /* ---------- バックアップ ---------- */
    BACKUP_VERSION: 1,

    /** 全データをバックアップ用オブジェクトに整形 */
    makeBackup(data) {
      const d = data || {};
      return {
        app: "keiyaku-kanri",
        version: core.BACKUP_VERSION,
        data: {
          companies: d.companies || [],
          contracts: d.contracts || [],
          products: d.products || [],
          salesRepsList: d.salesRepsList || [],
          plannerRepsList: d.plannerRepsList || [],
          billingTypes: d.billingTypes || [],
          tasks: d.tasks || [],
        },
      };
    },

    /** バックアップ文字列を解析し各コレクションを返す（不正なら例外） */
    parseBackup(text) {
      let obj;
      try { obj = JSON.parse(text); } catch (e) { throw new Error("JSONの解析に失敗しました"); }
      const d = obj && obj.data ? obj.data : obj;
      if (!d || typeof d !== "object" || (!Array.isArray(d.contracts) && !Array.isArray(d.companies))) {
        throw new Error("不正なバックアップ形式です");
      }
      const arr = (x) => (Array.isArray(x) ? x : []);
      return {
        companies: arr(d.companies),
        contracts: arr(d.contracts),
        products: arr(d.products),
        salesRepsList: arr(d.salesRepsList),
        plannerRepsList: arr(d.plannerRepsList),
        billingTypes: arr(d.billingTypes),
        tasks: arr(d.tasks),
      };
    },

    /* ---------- マスタ既定値 ---------- */
    defaultProducts() {
      return [
        { id: "pr_sf", name: "Salesforce", color: "#00A1E0", description: "クラウドCRM/SFA。営業・サービス・マーケを統合管理。", licenses: ["Sales Cloud", "Service Cloud", "Marketing Cloud Account Engagement", "Platform", "Experience Cloud", "CRM Analytics", "Field Service", "MuleSoft", "Tableau", "Slack"] },
        { id: "pr_ms", name: "Microsoft 365", color: "#D83B01", description: "Office/Teams/Exchange等の統合グループウェア。", licenses: ["Business Basic", "Business Standard", "Business Premium", "Enterprise E3", "Enterprise E5"] },
        { id: "pr_gw", name: "Google Workspace", color: "#1A73E8", description: "Gmail/ドライブ/Meet等のクラウド業務基盤。", licenses: ["Business Starter", "Business Standard", "Business Plus", "Enterprise"] },
        { id: "pr_adobe", name: "Adobe", color: "#FA0F00", description: "PDF・クリエイティブ制作ツール群。", licenses: ["Acrobat Pro", "Creative Cloud コンプリート", "Photoshop", "Illustrator"] },
        { id: "pr_box", name: "Box", color: "#0061D5", description: "企業向けクラウドストレージ・コンテンツ管理。", licenses: ["Business", "Business Plus", "Enterprise"] },
        { id: "pr_zoom", name: "Zoom", color: "#2D8CFF", description: "Web会議・ウェビナー。", licenses: ["Pro", "Business", "Enterprise"] },
        { id: "pr_aws", name: "AWS", color: "#FF9900", description: "クラウドインフラのサポートプラン。", licenses: ["Developer サポート", "Business サポート", "Enterprise サポート"] },
      ];
    },
    defaultSalesReps() {
      return ["田中 太郎", "佐藤 花子", "鈴木 一郎", "高橋 みなみ"];
    },
    defaultPlannerReps() {
      return ["山本 健", "中村 彩"];
    },
    defaultBillingTypes() {
      return ["年額", "月額", "複数年", "従量課金", "買い切り", "保守・サポート"];
    },
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { core };
    return;
  }

  /* ============================================================
     ブラウザ専用
     ============================================================ */

  const STORE_KEY = "keiyaku_kanri_v1";
  const AUTOBAK_KEY = "keiyaku_autobak";
  const AUTOBAK_MAX = 7;          // 保持する自動バックアップ数
  const AUTOBAK_THROTTLE = 300000; // 5分に1回まで

  function loadAutoBak() {
    const def = { enabled: false, interval: "off", snapshots: [], lastAt: 0, lastPeriodicAt: 0 };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(AUTOBAK_KEY)) || {}); }
    catch (e) { return def; }
  }
  function saveAutoBak(o) { try { localStorage.setItem(AUTOBAK_KEY, JSON.stringify(o)); } catch (e) { /* noop */ } }
  function nowStamp() {
    const d = new Date();
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  function pushSnapshot(o, kind) {
    o.snapshots.unshift({ at: nowStamp(), kind, data: core.makeBackup(db).data });
    o.snapshots = o.snapshots.slice(0, AUTOBAK_MAX);
    saveAutoBak(o);
  }
  // 変更時の自動バックアップ（db.save から呼ばれる・5分に1回まで）
  function maybeAutoBackup() {
    const o = loadAutoBak();
    if (!o.enabled) return;
    const now = Date.now();
    if (o.snapshots.length && now - (o.lastAt || 0) < AUTOBAK_THROTTLE) return;
    o.lastAt = now;
    pushSnapshot(o, "自動");
  }
  // 定期バックアップ（毎日/毎週・起動時と1時間ごとに判定）
  function periodicBackupCheck() {
    const o = loadAutoBak();
    if (!o.interval || o.interval === "off") return;
    const span = o.interval === "weekly" ? 7 * 86400000 : 86400000;
    const now = Date.now();
    if (now - (o.lastPeriodicAt || 0) < span) return;
    o.lastPeriodicAt = now;
    pushSnapshot(o, "定期");
  }
  let idCounter = Date.now();
  const nextId = (p) => core.makeId(p, idCounter++);

  const db = {
    companies: [],
    contracts: [],
    products: [],
    salesRepsList: [],
    plannerRepsList: [],
    billingTypes: [],
    tasks: [],
    load() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) {
          const d = JSON.parse(raw);
          db.companies = d.companies || [];
          db.contracts = d.contracts || [];
          db.products = d.products || [];
          db.salesRepsList = d.salesRepsList || [];
          db.plannerRepsList = d.plannerRepsList || [];
          db.billingTypes = d.billingTypes || [];
          db.tasks = d.tasks || [];
        }
      } catch (e) {
        console.error("読込失敗", e);
      }
      // マイグレーション / 既定マスタ
      if (!db.products.length) db.products = core.defaultProducts();
      if (!db.salesRepsList.length) db.salesRepsList = core.defaultSalesReps();
      if (!db.plannerRepsList.length) db.plannerRepsList = core.defaultPlannerReps();
      if (!db.billingTypes.length) db.billingTypes = core.defaultBillingTypes();
      db.companies.forEach((co) => {
        if (!Array.isArray(co.departments)) co.departments = [];
        if (!Array.isArray(co.contacts)) co.contacts = [];
      });
      db.normalizeReps();
    },
    // 担当者マスタを {name,email,teams} オブジェクトに正規化（旧:文字列配列）
    normalizeReps() {
      const norm = (list) => (list || []).map((r) => (typeof r === "string" ? { name: r, dept: "", email: "", teams: "", note: "" } : { name: r.name || "", dept: r.dept || "", email: r.email || "", teams: r.teams || "", note: r.note || "" })).filter((r) => r.name);
      db.salesRepsList = norm(db.salesRepsList);
      db.plannerRepsList = norm(db.plannerRepsList);
    },
    repProfile(name) {
      const f = (list) => (list || []).find((r) => (typeof r === "string" ? r : r.name) === name);
      const r = f(db.salesRepsList) || f(db.plannerRepsList);
      return r && typeof r === "object" ? r : null;
    },
    repExists(list, name) { return (list || []).some((r) => (typeof r === "string" ? r : r.name) === name); },
    addRep(list, name) { if (name && name.trim() && !db.repExists(list, name.trim())) list.push({ name: name.trim(), dept: "", email: "", teams: "", note: "" }); },
    save() {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        companies: db.companies, contracts: db.contracts, products: db.products,
        salesRepsList: db.salesRepsList, plannerRepsList: db.plannerRepsList,
        billingTypes: db.billingTypes, tasks: db.tasks,
      }));
      maybeAutoBackup();
    },
    companyName(id) {
      const c = db.companies.find((x) => x.id === id);
      return c ? c.name : "(不明)";
    },
    company(id) { return db.companies.find((x) => x.id === id); },
    product(name) { return db.products.find((p) => p.name === name); },
    /** マスタ + 契約に使われている担当者名（文字列）の和集合 */
    allSalesReps() {
      const set = new Set(db.salesRepsList.map((r) => (typeof r === "string" ? r : r.name)));
      db.contracts.forEach((c) => c.salesRep && set.add(c.salesRep));
      return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, "ja"));
    },
    allPlannerReps() {
      const set = new Set(db.plannerRepsList.map((r) => (typeof r === "string" ? r : r.name)));
      db.contracts.forEach((c) => c.plannerRep && set.add(c.plannerRep));
      return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, "ja"));
    },
    allProductNames() {
      const set = new Set(db.products.map((p) => p.name));
      db.contracts.forEach((c) => c.productName && set.add(c.productName));
      return [...set].sort((a, b) => a.localeCompare(b, "ja"));
    },
    allTags() {
      const set = new Set();
      db.contracts.forEach((c) => (c.tags || []).forEach((t) => set.add(t)));
      return [...set].sort((a, b) => a.localeCompare(b, "ja"));
    },
    allTaskTags() {
      const set = new Set();
      db.tasks.forEach((t) => (t.tags || []).forEach((x) => set.add(x)));
      return [...set].sort((a, b) => a.localeCompare(b, "ja"));
    },
  };

  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const state = {
    view: "dashboard",
    filter: { keyword: "", status: "all", rep: "all", planner: "all", product: "all", tag: "all", billing: "all" },
    sort: { key: "endDate", dir: "asc" },
    ganttScale: "month",
    ganttGroup: true,
    ganttUnits: { day: 35, month: 15, year: 4 },
    ganttAnchor: "",
    taskFilter: "open",
    companyFilter: { keyword: "", sort: "name" },
    alertFilter: "all",
    contractGroup: true,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, html) => {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "class") n.className = v;
      else if (k === "dataset") Object.assign(n.dataset, v);
      else if (k in n && k !== "list") n[k] = v;
      else n.setAttribute(k, v);
    });
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));

  let toastTimer;
  function toast(msg, kind = "") {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  function statusBadge(c) {
    const st = core.computeStatus(c, todayStr());
    return `<span class="badge ${st}">${core.statusLabel(st)}</span>`;
  }
  function daysLeftCell(c) {
    const d = core.daysUntil(c.endDate, todayStr());
    if (d === null) return "—";
    if (d < 0) return `<span class="days-left danger">${Math.abs(d)}日超過</span>`;
    let cls = "days-left";
    if (d <= 30) cls += " danger";
    else if (d <= EXPIRING_DAYS) cls += " warn";
    return `<span class="${cls}">あと${d}日</span>`;
  }

  /* ============================================================
     ルーティング
     ============================================================ */
  function render() {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
    const titles = { dashboard: "ダッシュボード", contracts: "契約一覧", gantt: "タイムライン", tasks: "タスク一覧", settings: "マスタ管理" };
    if (!titles[state.view]) state.view = "dashboard";
    $("#pageTitle").textContent = titles[state.view] || "";
    updateTaskBadge();
    const actions = $("#topbarActions");
    actions.innerHTML = "";
    const content = $("#content");
    content.innerHTML = "";

    if (state.view === "dashboard") renderDashboard(content);
    else if (state.view === "contracts") renderContracts(content, actions);
    else if (state.view === "gantt") renderGantt(content, actions);
    else if (state.view === "tasks") renderTasks(content, actions);
    else if (state.view === "settings") renderSettings(content);

    persistPrefs();
  }

  function updateTaskBadge() {
    const b = $("#navTaskBadge");
    if (!b) return;
    const n = db.tasks.filter((t) => t.status !== "done").length;
    b.textContent = n;
    b.hidden = n === 0;
  }

  /* ---------- ダッシュボード ---------- */
  function distinctCompanies(list) {
    return new Set(list.map((c) => c.companyId)).size;
  }
  function buildGroupTip(list, today, heading) {
    const st = core.statusBreakdown(list, today).filter((x) => x.count > 0);
    const amount = list.reduce((a, c) => a + core.contractAmount(c), 0);
    const pm = {}; list.forEach((c) => { const p = c.productName || "(未設定)"; pm[p] = (pm[p] || 0) + 1; });
    const topP = Object.entries(pm).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, q]) => `${esc(n)}×${q}`).join("、");
    const cm = {}; list.forEach((c) => { cm[c.companyId] = (cm[c.companyId] || 0) + 1; });
    const topC = Object.entries(cm).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, q]) => `${esc(db.companyName(id))}(${q})`).join("、");
    const stLine = st.map((x) => `<span class="badge ${x.status}">${x.label}${x.count}</span>`).join(" ");
    return `<div class="tip-co">${esc(heading)}</div>` +
      `<div class="tip-line">件数 <strong>${list.length}</strong> ・ 企業 <strong>${distinctCompanies(list)}</strong> 社</div>` +
      `<div class="tip-line">金額 <strong>${core.formatYen(amount)}</strong> <span class="tip-sub">税込 ${core.formatYen(core.taxIncluded(amount))}</span></div>` +
      `<div class="tip-line">${stLine || "—"}</div>` +
      `<div class="tip-line tip-sub">主な製品: ${topP || "—"}</div>` +
      `<div class="tip-line tip-sub">主な企業: ${topC || "—"}</div>`;
  }
  function attachTip(node, htmlFn) {
    node.classList.add("has-tip");
    node.addEventListener("mouseenter", (e) => showTip(e, htmlFn()));
    node.addEventListener("mousemove", moveGanttTip);
    node.addEventListener("mouseleave", hideGanttTip);
  }
  function renderDashboard(root) {
    const today = todayStr();
    const all = db.contracts;
    const allAmount = all.reduce((a, c) => a + core.contractAmount(c), 0);
    const activeList = all.filter((c) => ["active", "expiring"].includes(core.computeStatus(c, today)));
    const activeAmount = activeList.reduce((a, c) => a + core.contractAmount(c), 0);
    const expiring = all.filter((c) => core.computeStatus(c, today) === "expiring");
    const expired = all.filter((c) => core.computeStatus(c, today) === "expired");

    const card = (accent, ico, label, value, foot) =>
      `<div class="kpi ${accent}"><div class="kpi-ico">${ico}</div><div class="kpi-body"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-foot">${foot || ""}</div></div></div>`;

    // ■ 全体
    root.appendChild(el("h2", { class: "section-title" }, "全体"));
    const g1 = el("div", { class: "kpi-grid" });
    g1.innerHTML =
      card("accent-indigo", "¥", "累計契約金額", `<span style="font-size:24px">${core.formatYen(allAmount)}</span>`, `税込 ${core.formatYen(core.taxIncluded(allAmount))}`) +
      card("accent-blue", "▤", "累計契約数", `${all.length}<small>件</small>`) +
      card("accent-blue", "▣", "累計契約企業数", `${distinctCompanies(all)}<small>社</small>`);
    root.appendChild(g1);
    g1.querySelectorAll(".kpi").forEach((c) => attachTip(c, () => buildGroupTip(all, today, "全体（すべての契約）")));

    // ■ 有効契約
    root.appendChild(el("h2", { class: "section-title" }, "有効契約"));
    const g2 = el("div", { class: "kpi-grid" });
    g2.innerHTML =
      card("accent-green", "¥", "有効契約金額", `<span style="font-size:24px">${core.formatYen(activeAmount)}</span>`, `税込 ${core.formatYen(core.taxIncluded(activeAmount))}`) +
      card("accent-green", "✓", "有効契約数", `${activeList.length}<small>件</small>`) +
      card("accent-green", "▣", "有効契約企業数", `${distinctCompanies(activeList)}<small>社</small>`);
    root.appendChild(g2);
    g2.querySelectorAll(".kpi").forEach((c) => attachTip(c, () => buildGroupTip(activeList, today, "有効契約（有効＋更新間近）")));
    if (all.length) {
      const bd = core.statusBreakdown(all, today).filter((x) => x.count > 0);
      const panel = el("div", { class: "panel" });
      panel.innerHTML = `<div class="panel-head"><h3 class="panel-title">契約ステータス</h3><span style="color:var(--text-mute);font-weight:600">全${all.length}件</span></div>`;
      const body = el("div", { class: "panel-body", style: "padding:16px 18px" });
      const stack = el("div", { class: "stack-bar" });
      bd.forEach((x) => {
        const seg = el("div", { class: "stack-seg st-" + x.status });
        seg.style.width = x.pct + "%";
        const amt = all.filter((c) => core.computeStatus(c, today) === x.status).reduce((a, c) => a + core.contractAmount(c), 0);
        attachTip(seg, () => `<div class="tip-co">${x.label}</div><div class="tip-line">${x.count}件（${x.pct}%）</div><div class="tip-line">金額 <strong>${core.formatYen(amt)}</strong></div>`);
        stack.appendChild(seg);
      });
      body.appendChild(stack);
      const legend = el("div", { class: "stack-legend" });
      bd.forEach((x) => { legend.innerHTML += `<span class="stack-leg"><span class="dot st-${x.status}"></span>${x.label} <strong>${x.count}</strong> <span class="cell-sub">${x.pct}%</span></span>`; });
      body.appendChild(legend);
      panel.appendChild(body);
      root.appendChild(panel);
    }

    // ■ アラート
    root.appendChild(el("h2", { class: "section-title" }, "アラート"));
    const af = state.alertFilter || "all";
    const g3 = el("div", { class: "kpi-grid" });
    g3.innerHTML =
      card("accent-amber", "⏰", "更新間近", `${expiring.length}<small>件</small>`, `${EXPIRING_DAYS}日以内`) +
      card("accent-red", "!", "期限切れ", `${expired.length}<small>件</small>`, "未更新");
    root.appendChild(g3);
    const aCards = g3.querySelectorAll(".kpi");
    [["expiring", aCards[0]], ["expired", aCards[1]]].forEach(([key, cardEl]) => {
      cardEl.classList.add("kpi-click");
      if (af === key) cardEl.classList.add("kpi-active");
      cardEl.addEventListener("click", () => { state.alertFilter = af === key ? "all" : key; render(); });
    });

    // 対応が必要な契約（更新間近/期限切れ → 企業 → 部署でグルーピング、KPIクリックで絞り込み）
    let need = expiring.concat(expired);
    if (af === "expiring") need = expiring.slice();
    else if (af === "expired") need = expired.slice();
    const panel = el("div", { class: "panel" });
    const filterLabel = af === "expiring" ? "（更新間近のみ）" : af === "expired" ? "（期限切れのみ）" : "";
    const clearBtn = af !== "all" ? `<button class="btn btn-sec btn-sm" data-clear="1">絞り込み解除</button>` : `<span style="color:var(--text-mute);font-weight:600">${need.length}件</span>`;
    panel.innerHTML = `<div class="panel-head"><h3 class="panel-title">対応が必要な契約 <span class="cell-sub">${filterLabel}</span></h3>${clearBtn}</div>`;
    const body = el("div", { class: "panel-body table-wrap" });
    if (need.length === 0) {
      body.innerHTML = `<div class="empty"><div class="empty-ico">✓</div><div class="empty-title">対応が必要な契約はありません</div></div>`;
    } else {
      body.appendChild(groupedContractsTable(need, true));
    }
    panel.appendChild(body);
    const clr = panel.querySelector("[data-clear]");
    if (clr) clr.addEventListener("click", () => { state.alertFilter = "all"; render(); });
    root.appendChild(panel);

    // ■ 営業担当ランキング（最下部）
    root.appendChild(el("h2", { class: "section-title" }, "営業担当ランキング"));
    root.appendChild(repRankingPanel(today));
  }

  /* ---------- 契約一覧 ---------- */
  function renderContracts(root, actions) {
    actions.appendChild(buttonEl("+ 契約を追加", "btn", () => openContractModal()));
    const bar = el("div", { class: "toolbar" });
    const search = el("div", { class: "search" });
    const input = el("input", { type: "text", placeholder: "契約番号・企業・部署・製品・担当で検索", value: state.filter.keyword });
    input.addEventListener("input", (e) => { state.filter.keyword = e.target.value; refreshContractTable(); });
    search.appendChild(input);
    bar.appendChild(search);

    const statusSel = el("select", { class: "select" });
    [["all", "すべての状態"], ["active", "有効"], ["expiring", "更新間近"], ["expired", "期限切れ"], ["upcoming", "開始前"], ["cancelled", "解約"]].forEach(
      ([v, l]) => statusSel.appendChild(el("option", { value: v, selected: state.filter.status === v }, l)));
    statusSel.addEventListener("change", (e) => { state.filter.status = e.target.value; refreshContractTable(); });
    bar.appendChild(statusSel);

    const prodSel = el("select", { class: "select" });
    prodSel.appendChild(el("option", { value: "all" }, "すべての製品"));
    db.allProductNames().forEach((p) => prodSel.appendChild(el("option", { value: p, selected: state.filter.product === p }, p)));
    prodSel.addEventListener("change", (e) => { state.filter.product = e.target.value; refreshContractTable(); });
    bar.appendChild(prodSel);

    const usedBilling = [...new Set(db.contracts.map((c) => c.billingType).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
    if (usedBilling.length) {
      const billSel = el("select", { class: "select" });
      billSel.appendChild(el("option", { value: "all" }, "すべての契約形態"));
      usedBilling.forEach((b) => billSel.appendChild(el("option", { value: b, selected: state.filter.billing === b }, b)));
      billSel.addEventListener("change", (e) => { state.filter.billing = e.target.value; refreshContractTable(); });
      bar.appendChild(billSel);
    }

    const repSel = el("select", { class: "select" });
    repSel.appendChild(el("option", { value: "all" }, "すべての営業担当"));
    db.allSalesReps().forEach((r) => repSel.appendChild(el("option", { value: r, selected: state.filter.rep === r }, r)));
    repSel.addEventListener("change", (e) => { state.filter.rep = e.target.value; refreshContractTable(); });
    bar.appendChild(repSel);

    const plannerReps = db.allPlannerReps();
    if (plannerReps.length) {
      const plSel = el("select", { class: "select" });
      plSel.appendChild(el("option", { value: "all" }, "すべての企画担当"));
      plannerReps.forEach((r) => plSel.appendChild(el("option", { value: r, selected: state.filter.planner === r }, r)));
      plSel.addEventListener("change", (e) => { state.filter.planner = e.target.value; refreshContractTable(); });
      bar.appendChild(plSel);
    }

    const tags = db.allTags();
    if (tags.length) {
      const tagSel = el("select", { class: "select" });
      tagSel.appendChild(el("option", { value: "all" }, "すべてのタグ"));
      tags.forEach((t) => tagSel.appendChild(el("option", { value: t, selected: state.filter.tag === t }, t)));
      tagSel.addEventListener("change", (e) => { state.filter.tag = e.target.value; refreshContractTable(); });
      bar.appendChild(tagSel);
    }

    const grpWrap = el("label", { class: "switch-label" });
    const grpChk = el("input", { type: "checkbox", checked: state.contractGroup });
    grpChk.addEventListener("change", () => { state.contractGroup = grpChk.checked; refreshContractTable(); });
    grpWrap.appendChild(grpChk);
    grpWrap.appendChild(document.createTextNode("企業・部署でグループ化"));
    bar.appendChild(grpWrap);

    bar.appendChild(buttonEl("📤 CSV書き出し", "btn-sec", () => {
      const today = todayStr();
      let list = core.filterContracts(db.contracts, db.companies, { ...state.filter, today });
      list = core.sortContracts(list, db.companies, state.sort.key, state.sort.dir, today);
      exportCSV(list);
    }));
    bar.appendChild(buttonEl("📥 CSV取込", "btn-sec", () => $("#importFile").click()));
    bar.appendChild(buttonEl("📄 テンプレート", "btn-sec", downloadTemplate));

    root.appendChild(bar);
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "panel-body table-wrap", id: "contractTableBody" }));
    root.appendChild(panel);
    refreshContractTable();
  }

  function refreshContractTable() {
    const body = $("#contractTableBody");
    if (!body) return;
    const today = todayStr();
    let list = core.filterContracts(db.contracts, db.companies, { ...state.filter, today });
    list = core.sortContracts(list, db.companies, state.sort.key, state.sort.dir, today);
    body.innerHTML = "";
    if (list.length === 0) {
      body.innerHTML = `<div class="empty"><div class="empty-ico">▤</div><div class="empty-title">該当する契約がありません</div></div>`;
      return;
    }
    if (state.contractGroup) {
      body.appendChild(groupedContractsTable(list, true));
    } else {
      body.appendChild(contractsTable(list, true));
    }
    const t = core.totals(list);
    const foot = el("div", { class: "table-total" });
    foot.innerHTML = `<span>${t.count}件</span><span>金額合計 <strong>${core.formatYen(t.amount)}</strong></span><span class="cell-sub">税込 ${core.formatYen(t.taxIncluded)}</span>`;
    body.appendChild(foot);
  }

  const CONTRACT_COLS = [
    ["contractNo", "契約番号"],
    ["company", "企業 / 部署"],
    ["product", "製品 / ライセンス"],
    ["billing", "契約形態"],
    ["quantity", "数量", "num"],
    ["amount", "金額", "num"],
    ["salesRep", "営業担当"],
    ["endDate", "終了日"],
    ["daysLeft", "残日数"],
    ["status", "状態"],
  ];
  function contractHead(withActions) {
    const thead = el("thead");
    const tr = el("tr");
    CONTRACT_COLS.forEach(([key, label, cls]) => {
      const sortable = key !== "status";
      const ind = state.sort.key === key ? `<span class="sort-ind">${state.sort.dir === "asc" ? "▲" : "▼"}</span>` : "";
      const th = el("th", { class: (cls ? cls + " " : "") + (sortable ? "sortable" : "") }, label + ind);
      if (sortable) th.addEventListener("click", () => toggleSort(key));
      tr.appendChild(th);
    });
    if (withActions) tr.appendChild(el("th", {}, ""));
    thead.appendChild(tr);
    return thead;
  }
  function contractRow(c, withActions) {
    const row = el("tr", { class: "row-" + core.computeStatus(c, todayStr()) });
    row.innerHTML = `
      <td class="cell-sub">${esc(c.contractNo || "—")}</td>
      <td><div class="cell-strong">${esc(db.companyName(c.companyId))}</div><div class="cell-sub">${esc(c.department || "—")}</div></td>
      <td><div class="cell-strong">${esc(c.productName || "—")}</div><div class="cell-sub">${esc(c.licenseType || "—")}</div></td>
      <td>${esc(c.billingType || "—")}</td>
      <td class="num">${Number(c.quantity) || 0}</td>
      <td class="num">${core.formatYen(core.contractAmount(c))}</td>
      <td>${esc(c.salesRep || "—")}</td>
      <td>${core.formatDate(c.endDate)}</td>
      <td>${daysLeftCell(c)}</td>
      <td>${statusBadge(c)}</td>`;
    if (withActions) {
      const td = el("td");
      const wrap = el("div", { class: "row-actions" });
      wrap.appendChild(buttonEl("詳細", "btn-icon", () => openContractDetail(c.id), "詳細"));
      wrap.appendChild(buttonEl("✎", "btn-icon", () => openContractModal(c.id), "編集"));
      wrap.appendChild(buttonEl("🗑", "btn-icon", () => deleteContract(c.id), "削除"));
      td.appendChild(wrap);
      row.appendChild(td);
    } else {
      row.style.cursor = "pointer";
      row.addEventListener("click", () => openContractDetail(c.id));
    }
    return row;
  }
  function contractsTable(list, withActions) {
    const t = el("table", { class: "data" });
    t.appendChild(contractHead(withActions));
    const tb = el("tbody");
    list.forEach((c) => tb.appendChild(contractRow(c, withActions)));
    t.appendChild(tb);
    return t;
  }
  /** 企業→部署のグループ見出し行を内包した単一テーブル（列が揃う） */
  function groupedContractsTable(list, withActions) {
    const colCount = CONTRACT_COLS.length + (withActions ? 1 : 0);
    const t = el("table", { class: "data" });
    t.appendChild(contractHead(withActions));
    const tb = el("tbody");
    const byCompany = {};
    list.forEach((c) => { (byCompany[c.companyId] = byCompany[c.companyId] || []).push(c); });
    Object.keys(byCompany)
      .sort((a, b) => db.companyName(a).localeCompare(db.companyName(b), "ja"))
      .forEach((cid) => {
        const cs = byCompany[cid];
        const gr = el("tr", { class: "grp-row" });
        gr.innerHTML = `<td colspan="${colCount}"><span class="grp-co">${esc(db.companyName(cid))}</span><span class="gantt-group-count">${cs.length}</span></td>`;
        tb.appendChild(gr);
        const byDept = {};
        cs.forEach((c) => { const d = c.department || "（部署なし）"; (byDept[d] = byDept[d] || []).push(c); });
        Object.keys(byDept).sort((a, b) => a.localeCompare(b, "ja")).forEach((dept) => {
          const sr = el("tr", { class: "subgrp-row" });
          sr.innerHTML = `<td colspan="${colCount}">${esc(dept)}</td>`;
          tb.appendChild(sr);
          byDept[dept]
            .sort((a, b) => (a.productName || "").localeCompare(b.productName || "", "ja") || (a.licenseType || "").localeCompare(b.licenseType || "", "ja"))
            .forEach((c) => tb.appendChild(contractRow(c, withActions)));
        });
      });
    t.appendChild(tb);
    return t;
  }

  function toggleSort(key) {
    if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    else { state.sort.key = key; state.sort.dir = "asc"; }
    refreshContractTable();
  }

  /* ---------- ガント バーのツールチップ ---------- */
  let _ganttTip = null;
  function ganttTipEl() {
    if (!_ganttTip) { _ganttTip = el("div", { class: "gantt-tip", hidden: true }); document.body.appendChild(_ganttTip); }
    return _ganttTip;
  }
  function showTip(e, html) {
    const tip = ganttTipEl();
    tip.innerHTML = html;
    tip.hidden = false;
    moveGanttTip(e);
  }
  function showGanttTip(e, c) {
    const st = core.computeStatus(c, todayStr());
    const dl = daysLeftCell(c);
    showTip(e,
      `<div class="tip-co">${esc(db.companyName(c.companyId))}</div>` +
      `<div class="tip-sub">${esc(c.department || "—")}</div>` +
      `<div class="tip-main">${esc(c.productName || "")} <span class="tip-lic">${esc(c.licenseType || "")}</span></div>` +
      `<div class="tip-line">${esc(c.contractNo || "")}${c.billingType ? " ・ " + esc(c.billingType) : ""}</div>` +
      `<div class="tip-line">${core.formatDate(c.startDate)} 〜 ${core.formatDate(c.endDate)} ${dl}</div>` +
      `<div class="tip-line"><strong>${core.formatYen(core.contractAmount(c))}</strong> &nbsp; <span class="badge ${st}">${core.statusLabel(st)}</span></div>` +
      `<div class="tip-line tip-sub">営業: ${esc(c.salesRep || "—")} ／ 企画: ${esc(c.plannerRep || "—")}</div>`);
  }
  function showRepTip(e, name, list) {
    const today = todayStr();
    const rows = list.slice(0, 12).map((c) => {
      const st = core.computeStatus(c, today);
      return `<div class="tip-line">${esc(db.companyName(c.companyId))}・${esc(c.productName || "")} ${esc(c.licenseType || "")} <strong>${core.formatYen(core.contractAmount(c))}</strong> <span class="badge ${st}">${core.statusLabel(st)}</span></div>`;
    }).join("");
    const more = list.length > 12 ? `<div class="tip-line tip-sub">…他 ${list.length - 12} 件</div>` : "";
    showTip(e, `<div class="tip-co">${esc(name)} の契約（${list.length}件）</div>${rows}${more}`);
  }
  function moveGanttTip(e) {
    const tip = _ganttTip; if (!tip || tip.hidden) return;
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const w = tip.offsetWidth || 260, h = tip.offsetHeight || 120;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function hideGanttTip() { if (_ganttTip) _ganttTip.hidden = true; }

  function repRankingPanel(today) {
    const ranking = core.repRanking(db.contracts, today);
    const panel = el("div", { class: "panel" });
    panel.innerHTML = `<div class="panel-head"><h3 class="panel-title">営業担当ランキング</h3><span class="cell-sub">契約金額順</span></div>`;
    const body = el("div", { class: "panel-body table-wrap" });
    if (ranking.length === 0) {
      body.innerHTML = `<div class="empty"><div class="empty-title">データがありません</div></div>`;
      panel.appendChild(body); return panel;
    }
    const t = el("table", { class: "data" });
    t.innerHTML = `<thead><tr><th>順位</th><th>営業担当</th><th class="num">契約数</th><th class="num">契約金額</th><th>主な契約</th><th>状態</th></tr></thead>`;
    const tb = el("tbody");
    ranking.forEach((m, i) => {
      const statusBits = [["active", "有効"], ["expiring", "更新間近"], ["expired", "期限切れ"]]
        .filter(([k]) => m.status[k]).map(([k, l]) => `<span class="badge ${k}">${l}${m.status[k]}</span>`).join(" ");
      const tr = el("tr");
      tr.innerHTML =
        `<td class="cell-strong">${i + 1}</td>` +
        `<td class="cell-strong">${esc(m.name)}</td>` +
        `<td class="num">${m.count}</td>` +
        `<td class="num"><strong>${core.formatYen(m.amount)}</strong></td>` +
        `<td class="cell-sub">${esc(m.topProducts.join("、")) || "—"}</td>` +
        `<td>${statusBits || "—"}</td>`;
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => { state.view = "contracts"; state.filter.rep = m.name; render(); });
      const repContracts = db.contracts.filter((c) => (c.salesRep || "(未割当)") === m.name);
      tr.addEventListener("mouseenter", (e) => showRepTip(e, m.name, repContracts));
      tr.addEventListener("mousemove", moveGanttTip);
      tr.addEventListener("mouseleave", hideGanttTip);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    body.appendChild(t);
    panel.appendChild(body);
    return panel;
  }

  /* ---------- ガント / タイムライン ---------- */
  function renderGantt(root, actions) {
    hideGanttTip();
    actions.appendChild(buttonEl("+ 契約を追加", "btn", () => openContractModal()));
    const today = todayStr();
    const anchor = state.ganttAnchor || today;
    const axis = core.ganttAxis(state.ganttScale, anchor, state.ganttUnits[state.ganttScale]);

    // ツールバー（スケール切替 + 表示期間 + グループ化 + 状態の凡例）
    const bar = el("div", { class: "toolbar" });
    const seg = el("div", { class: "segmented" });
    [["day", "日"], ["month", "月"], ["year", "年"]].forEach(([v, l]) => {
      const b = el("button", { class: "seg-btn" + (state.ganttScale === v ? " active" : "") }, l);
      b.addEventListener("click", () => { state.ganttScale = v; render(); });
      seg.appendChild(b);
    });
    bar.appendChild(seg);

    // 表示期間（数値入力 + スライダーで自由調整）
    const spanCfg = { day: { min: 7, max: 180, unit: "日" }, month: { min: 3, max: 48, unit: "ヶ月" }, year: { min: 2, max: 15, unit: "年" } }[state.ganttScale];
    const curUnits = state.ganttUnits[state.ganttScale];
    const spanWrap = el("div", { class: "span-ctrl" });
    spanWrap.appendChild(el("span", { class: "span-label" }, "表示期間"));
    const range = el("input", { type: "range", min: spanCfg.min, max: spanCfg.max, value: curUnits, class: "span-range" });
    const num = el("input", { type: "number", min: spanCfg.min, max: spanCfg.max, value: curUnits, class: "span-num" });
    const unitLbl = el("span", { class: "span-unit" }, spanCfg.unit);
    const applySpan = (v) => {
      let n = Math.max(spanCfg.min, Math.min(spanCfg.max, Number(v) || spanCfg.min));
      state.ganttUnits[state.ganttScale] = n;
      render();
    };
    range.addEventListener("input", () => { num.value = range.value; });
    range.addEventListener("change", () => applySpan(range.value));
    num.addEventListener("change", () => applySpan(num.value));
    spanWrap.appendChild(range);
    spanWrap.appendChild(num);
    spanWrap.appendChild(unitLbl);
    bar.appendChild(spanWrap);

    // 基準日（過去・未来へ表示をずらす）
    const anchorWrap = el("div", { class: "span-ctrl" });
    anchorWrap.appendChild(el("span", { class: "span-label" }, "基準日"));
    const anchorInput = el("input", { type: "date", class: "select", value: anchor });
    anchorInput.addEventListener("change", () => { state.ganttAnchor = anchorInput.value || ""; render(); });
    anchorWrap.appendChild(anchorInput);
    anchorWrap.appendChild(buttonEl("今日", "btn-sec btn-sm", () => { state.ganttAnchor = ""; render(); }));
    bar.appendChild(anchorWrap);
    const grpWrap = el("label", { class: "switch-label" });
    const grpChk = el("input", { type: "checkbox", checked: state.ganttGroup });
    grpChk.addEventListener("change", () => { state.ganttGroup = grpChk.checked; render(); });
    grpWrap.appendChild(grpChk);
    grpWrap.appendChild(document.createTextNode("企業でグループ化"));
    bar.appendChild(grpWrap);
    const legend = el("div", { class: "gantt-legend" });
    [["active", "有効"], ["expiring", "更新間近"], ["expired", "期限切れ"], ["upcoming", "開始前"], ["cancelled", "解約"]]
      .forEach(([st, l]) => { legend.innerHTML += `<span class="stack-leg"><span class="dot st-${st}"></span>${l}</span>`; });
    bar.appendChild(legend);
    root.appendChild(bar);

    const panel = el("div", { class: "panel" });
    panel.innerHTML = `<div class="panel-head"><h3 class="panel-title">契約タイムライン</h3><span style="color:var(--text-mute);font-weight:600">${esc(core.formatDate(axis.startStr))} 〜 ${esc(core.formatDate(axis.endStr))}</span></div>`;
    const body = el("div", { class: "panel-body" });
    if (db.contracts.length === 0) {
      body.innerHTML = `<div class="empty"><div class="empty-ico">▭</div><div class="empty-title">契約がありません</div></div>`;
      panel.appendChild(body); root.appendChild(panel); return;
    }

    const scroll = el("div", { class: "gantt-scroll" });
    const wrap = el("div", { class: "gantt tl-" + axis.scale });
    const colPx = axis.scale === "day" ? 38 : axis.scale === "year" ? 64 : 60;
    wrap.style.minWidth = (250 + axis.ticks.length * colPx) + "px";
    const tp = core.datePct(today, axis.startStr, axis.endStr);

    const tickCells = (cls) => {
      const frag = el("div", { class: "gantt-track" });
      axis.ticks.forEach((tk, i) => {
        const next = axis.ticks[i + 1];
        const w = (next ? next.pos : 100) - tk.pos;
        const c = el("div", { class: cls + (tk.major ? " major" : "") + (tk.weekend ? " weekend" : "") });
        c.style.left = tk.pos + "%"; c.style.width = w + "%";
        if (cls === "gantt-tick") c.innerHTML = `<span class="gantt-tk-main">${tk.label}</span>` + (tk.sub ? `<span class="gantt-wd">${tk.sub}</span>` : "");
        frag.appendChild(c);
      });
      return frag;
    };

    // 上段見出し（年/月バンド）
    const groupHead = el("div", { class: "gantt-row gantt-grouprow" });
    groupHead.appendChild(el("div", { class: "gantt-label" }, ""));
    const gtrack = el("div", { class: "gantt-track" });
    axis.groups.forEach((gp) => {
      const cell = el("div", { class: "gantt-band" }, gp.label);
      cell.style.left = gp.pos + "%"; cell.style.width = gp.width + "%";
      gtrack.appendChild(cell);
    });
    groupHead.appendChild(gtrack);
    wrap.appendChild(groupHead);

    // 目盛り行
    const head = el("div", { class: "gantt-row gantt-head" });
    head.appendChild(el("div", { class: "gantt-label" }, ""));
    head.appendChild(tickCells("gantt-tick"));
    wrap.appendChild(head);

    const makeContractRow = (c, showCompany) => {
      const rowEl = el("div", { class: "gantt-row" });
      const label = el("div", { class: "gantt-label" });
      label.innerHTML = showCompany
        ? `<div class="cell-strong">${esc(db.companyName(c.companyId))}</div><div class="cell-sub">${esc(c.productName || "")} ${esc(c.licenseType || "")}</div>`
        : `<div class="cell-strong" style="font-size:12.5px">${esc(c.productName || "")}</div><div class="cell-sub">${esc(c.licenseType || "")}</div>`;
      rowEl.appendChild(label);
      const tr = tickCells("gantt-grid");
      const b = core.ganttBar(c, axis.startStr, axis.endStr);
      if (b.visible) {
        const st = core.computeStatus(c, today);
        const bar2 = el("div", { class: "gantt-bar " + st });
        bar2.style.left = b.leftPct + "%"; bar2.style.width = b.widthPct + "%";
        const barInfo = [c.billingType, core.formatYen(core.contractAmount(c)), c.customerContact, c.salesRep, c.plannerRep].filter(Boolean).join(" ・ ");
        bar2.innerHTML = `<span class="gantt-bar-text">${esc(barInfo)}</span>`;
        bar2.addEventListener("click", () => openContractDetail(c.id));
        bar2.addEventListener("mouseenter", (e) => showGanttTip(e, c));
        bar2.addEventListener("mousemove", moveGanttTip);
        bar2.addEventListener("mouseleave", hideGanttTip);
        tr.appendChild(bar2);
      }
      rowEl.appendChild(tr);
      return rowEl;
    };

    if (state.ganttGroup) {
      // 企業 → 部署 → 製品 → ライセンス の順でグルーピング
      const byCompany = {};
      db.contracts.forEach((c) => { (byCompany[c.companyId] = byCompany[c.companyId] || []).push(c); });
      const licSort = (a, b) =>
        (a.department || "").localeCompare(b.department || "", "ja") ||
        (a.productName || "").localeCompare(b.productName || "", "ja") ||
        (a.licenseType || "").localeCompare(b.licenseType || "", "ja");
      Object.keys(byCompany)
        .sort((a, b) => db.companyName(a).localeCompare(db.companyName(b), "ja"))
        .forEach((cid) => {
          const group = el("div", { class: "gantt-group" });
          const gh = el("div", { class: "gantt-group-head" });
          gh.innerHTML = `<span>${esc(db.companyName(cid))}</span><span class="gantt-group-count">${byCompany[cid].length}</span>`;
          group.appendChild(gh);
          // 部署ごとにサブ見出し
          const byDept = {};
          byCompany[cid].forEach((c) => { const d = c.department || "（部署なし）"; (byDept[d] = byDept[d] || []).push(c); });
          Object.keys(byDept).sort((a, b) => a.localeCompare(b, "ja")).forEach((dept) => {
            const dh = el("div", { class: "gantt-dept-head" });
            dh.innerHTML = `<span>${esc(dept)}</span>`;
            group.appendChild(dh);
            byDept[dept].sort(licSort).forEach((c) => group.appendChild(makeContractRow(c, false)));
          });
          wrap.appendChild(group);
        });
    } else {
      db.contracts.slice()
        .sort((a, b) => (core.parseDate(a.endDate) || 0) - (core.parseDate(b.endDate) || 0))
        .forEach((c) => wrap.appendChild(makeContractRow(c, true)));
    }

    // 今日線（全体を縦断する赤い線・ラベル列の右から）
    if (tp !== null) {
      const line = el("div", { class: "gantt-todayline" });
      line.style.left = `calc(250px + (100% - 250px) * ${tp / 100})`;
      wrap.appendChild(line);
    }

    scroll.appendChild(wrap);
    body.appendChild(scroll);
    panel.appendChild(body);
    root.appendChild(panel);
  }

  /* ---------- 更新タスク ---------- */
  function renderTasks(root, actions) {
    actions.appendChild(buttonEl("自動生成", "btn btn-sec", autoGenTasks));
    actions.appendChild(buttonEl("+ タスク追加", "btn", () => openTaskModal()));

    const bar = el("div", { class: "toolbar" });
    const seg = el("div", { class: "segmented" });
    [["open", "未完了"], ["done", "完了"], ["all", "すべて"]].forEach(([v, l]) => {
      const b = el("button", { class: "seg-btn" + (state.taskFilter === v ? " active" : "") }, l);
      b.addEventListener("click", () => { state.taskFilter = v; render(); });
      seg.appendChild(b);
    });
    bar.appendChild(seg);
    root.appendChild(bar);

    const today = todayStr();
    let list = db.tasks.slice();
    if (state.taskFilter === "open") list = list.filter((t) => t.status !== "done");
    else if (state.taskFilter === "done") list = list.filter((t) => t.status === "done");
    list.sort((a, b) => (core.parseDate(a.dueDate) || 8e15) - (core.parseDate(b.dueDate) || 8e15));

    const panel = el("div", { class: "panel" });
    const body = el("div", { class: "panel-body table-wrap" });
    if (list.length === 0) {
      body.innerHTML = `<div class="empty"><div class="empty-ico">✓</div><div class="empty-title">タスクはありません</div></div>`;
      panel.appendChild(body); root.appendChild(panel); return;
    }

    const taskRow = (tk) => {
      const dl = tk.status === "done" ? "—" : daysLeftCellFromDate(tk.dueDate, today);
      const row = el("tr");
      if (tk.status === "done") row.style.opacity = ".55";
      const chkTd = el("td");
      const chk = el("input", { type: "checkbox", checked: tk.status === "done", style: "width:auto;cursor:pointer" });
      chk.addEventListener("change", () => { tk.status = chk.checked ? "done" : "open"; db.save(); render(); });
      chkTd.appendChild(chk);
      row.appendChild(chkTd);
      const tagPills = (tk.tags || []).map((tg) => `<span class="tag-pill">${esc(tg)}</span>`).join(" ");
      const td2 = el("td"); td2.innerHTML = `<div class="cell-strong"${tk.status === "done" ? ' style="text-decoration:line-through"' : ""}>${esc(tk.title)}</div>${tagPills ? `<div>${tagPills}</div>` : ""}${tk.note ? `<div class="cell-sub">${esc(tk.note)}</div>` : ""}`; row.appendChild(td2);
      const tc = tk.contractId ? db.contracts.find((x) => x.id === tk.contractId) : null;
      const td3 = el("td"); td3.innerHTML = tc ? `<div class="cell-sub">${esc(tc.productName || "")} ${esc(tc.licenseType || "")}</div>` : "—";
      if (tc) { td3.style.cursor = "pointer"; td3.addEventListener("click", () => openContractDetail(tc.id)); }
      row.appendChild(td3);
      const td4 = el("td"); td4.innerHTML = `${core.formatDate(tk.dueDate)} ${tk.status !== "done" ? `<div class="cell-sub">${dl}</div>` : ""}`; row.appendChild(td4);
      row.appendChild(el("td", {}, esc(tk.assignee || "—")));
      row.appendChild(el("td", {}, tk.status === "done" ? `<span class="badge active">完了</span>` : `<span class="badge expiring">未完了</span>`));
      const tdA = el("td");
      const wrap = el("div", { class: "row-actions" });
      wrap.appendChild(buttonEl("✎", "btn-icon", () => openTaskModal(tk.id), "編集"));
      wrap.appendChild(buttonEl("🗑", "btn-icon", () => { if (confirm("このタスクを削除しますか?")) { db.tasks = db.tasks.filter((x) => x.id !== tk.id); db.save(); render(); } }, "削除"));
      tdA.appendChild(wrap); row.appendChild(tdA);
      return row;
    };

    // 企業 → 部署 でグルーピング
    const NONE = "__none__";
    const groups = {};
    list.forEach((tk) => {
      const c = tk.contractId ? db.contracts.find((x) => x.id === tk.contractId) : null;
      const cid = c ? c.companyId : (tk.companyId || NONE);
      const dept = c ? (c.department || "（部署なし）") : (tk.companyId ? "（企業タスク）" : "（契約なし）");
      groups[cid] = groups[cid] || {};
      (groups[cid][dept] = groups[cid][dept] || []).push(tk);
    });
    const cids = Object.keys(groups).sort((a, b) => {
      if (a === NONE) return 1; if (b === NONE) return -1;
      return db.companyName(a).localeCompare(db.companyName(b), "ja");
    });
    // 単一テーブルにグループ見出し行を内包（列が揃う）
    const t = el("table", { class: "data" });
    t.innerHTML = `<thead><tr><th></th><th>タスク</th><th>関連契約</th><th>期日</th><th>担当</th><th>状態</th><th></th></tr></thead>`;
    const tb = el("tbody");
    cids.forEach((cid) => {
      const total = Object.values(groups[cid]).reduce((s, arr) => s + arr.length, 0);
      const gr = el("tr", { class: "grp-row" });
      gr.innerHTML = `<td colspan="7"><span class="grp-co">${cid === NONE ? "（契約なし）" : esc(db.companyName(cid))}</span><span class="gantt-group-count">${total}</span></td>`;
      tb.appendChild(gr);
      Object.keys(groups[cid]).sort((a, b) => a.localeCompare(b, "ja")).forEach((dept) => {
        if (cid !== NONE) { const sr = el("tr", { class: "subgrp-row" }); sr.innerHTML = `<td colspan="7">${esc(dept)}</td>`; tb.appendChild(sr); }
        groups[cid][dept].forEach((tk) => tb.appendChild(taskRow(tk)));
      });
    });
    t.appendChild(tb);
    body.appendChild(t);
    panel.appendChild(body);
    root.appendChild(panel);
  }

  function daysLeftCellFromDate(dateStr, today) {
    const d = core.daysUntil(dateStr, today);
    if (d === null) return "";
    if (d < 0) return `<span class="days-left danger">${Math.abs(d)}日超過</span>`;
    let cls = "days-left";
    if (d <= 7) cls += " danger"; else if (d <= 30) cls += " warn";
    return `<span class="${cls}">あと${d}日</span>`;
  }

  function autoGenTasks() {
    const existing = db.tasks.map((t) => t.contractId).filter(Boolean);
    const drafts = core.suggestRenewalTasks(db.contracts, todayStr(), existing);
    if (drafts.length === 0) { toast("生成対象の契約はありません", ""); return; }
    drafts.forEach((d) => {
      const c = db.contracts.find((x) => x.id === d.contractId);
      db.tasks.push({ id: nextId("tk"), contractId: d.contractId, title: d.title, dueDate: d.dueDate, assignee: (c && c.salesRep) || "", status: "open", note: "" });
    });
    db.save();
    toast(`${drafts.length}件のタスクを生成しました`, "success");
    render();
  }

  function openBulkTaskModal(companyIds) {
    const ids = companyIds || [];
    const grid = el("div", { class: "form-grid" });
    const titleInput = el("input", { type: "text", placeholder: "例: セキュリティパッチ適用" });
    const dueInput = el("input", { type: "date" });
    const assigneeSel = el("select");
    fillSelect(assigneeSel, db.allSalesReps(), "", "（任意）");
    const tagsInput = el("input", { type: "text", value: "パッチ", placeholder: "カンマ区切り（例: パッチ, 改修）", list: "tasktaglist" });
    const tdl = el("datalist", { id: "tasktaglist" });
    ["契約", "パッチ", "改修", "アナウンス"].concat(db.allTaskTags()).forEach((tg, i, arr) => { if (arr.indexOf(tg) === i) tdl.appendChild(el("option", { value: tg })); });
    const noteInput = el("textarea", { placeholder: "備考" });
    const names = ids.map((id) => db.companyName(id)).join("、");
    grid.appendChild(field("対象企業", el("input", { type: "text", value: names, disabled: true }), true));
    grid.appendChild(field('タスク名 <span class="req">*</span>', titleInput, true));
    grid.appendChild(field("期日", dueInput));
    grid.appendChild(field("担当", assigneeSel));
    const tgField = field("タグ", tagsInput, true); tgField.appendChild(tdl);
    grid.appendChild(tgField);
    grid.appendChild(field("備考", noteInput, true));
    const foot = el("div");
    foot.appendChild(buttonEl("キャンセル", "btn btn-sec", closeModal));
    foot.appendChild(buttonEl(`${ids.length}社にタスク作成`, "btn", () => {
      if (!titleInput.value.trim()) { titleInput.closest(".field").classList.add("invalid"); return; }
      const tags = core.parseTags(tagsInput.value);
      ids.forEach((cid) => db.tasks.push({
        id: nextId("tk"), status: "open", companyId: cid, contractId: null,
        title: titleInput.value.trim(), dueDate: dueInput.value, assignee: assigneeSel.value, tags, note: noteInput.value.trim(),
      }));
      db.save(); closeModal();
      toast(`${ids.length}社にタスクを作成しました`, "success");
      state.view = "tasks"; render();
    }));
    openModal("企業にタスクを一括追加", grid, foot);
  }
  function openTaskModal(id) {
    const editing = db.tasks.find((t) => t.id === id);
    const tk = editing || { status: "open" };
    const grid = el("div", { class: "form-grid" });
    const titleInput = el("input", { type: "text", value: tk.title || "", placeholder: "例: Sales Cloud の更新" });
    const dueInput = el("input", { type: "date", value: tk.dueDate || "" });
    const assigneeSel = el("select");
    fillSelect(assigneeSel, db.allSalesReps(), tk.assignee, "（任意）");
    // 関連契約（検索可能・参照型）
    const labelFor = (c) => `${db.companyName(c.companyId)} / ${c.productName || ""} ${c.licenseType || ""}${c.contractNo ? " (" + c.contractNo + ")" : ""}`.replace(/\s+/g, " ").trim();
    const contractMap = {};
    const cdl = el("datalist", { id: "taskcontracts" });
    db.contracts.slice().sort((a, b) => db.companyName(a.companyId).localeCompare(db.companyName(b.companyId), "ja")).forEach((c) => {
      const lb = labelFor(c); contractMap[lb] = c.id; cdl.appendChild(el("option", { value: lb }));
    });
    const contractInput = el("input", { type: "text", placeholder: "企業・製品で検索して選択" });
    contractInput.setAttribute("list", "taskcontracts");
    if (tk.contractId) { const c = db.contracts.find((x) => x.id === tk.contractId); if (c) contractInput.value = labelFor(c); }
    const tagsInput = el("input", { type: "text", value: (tk.tags || []).join(", "), placeholder: "カンマ区切り（例: 契約, パッチ, 改修, アナウンス）", list: "tasktaglist" });
    const tdl = el("datalist", { id: "tasktaglist" });
    ["契約", "パッチ", "改修", "アナウンス"].concat(db.allTaskTags()).forEach((tg, i, arr) => { if (arr.indexOf(tg) === i) tdl.appendChild(el("option", { value: tg })); });
    const noteInput = el("textarea", { placeholder: "備考" });
    noteInput.value = tk.note || "";

    grid.appendChild(field('タスク名 <span class="req">*</span>', titleInput, true));
    grid.appendChild(field("期日", dueInput));
    grid.appendChild(field("担当", assigneeSel));
    const cField = field("関連契約", contractInput, true);
    cField.appendChild(cdl);
    grid.appendChild(cField);
    const tgField = field("タグ", tagsInput, true);
    tgField.appendChild(tdl);
    grid.appendChild(tgField);
    grid.appendChild(field("備考", noteInput, true));

    const foot = el("div");
    foot.appendChild(buttonEl("キャンセル", "btn btn-sec", closeModal));
    foot.appendChild(buttonEl(editing ? "更新" : "登録", "btn", () => {
      if (!titleInput.value.trim()) { titleInput.closest(".field").classList.add("invalid"); return; }
      const cv = contractInput.value.trim();
      const contractId = cv ? (contractMap[cv] || (tk.contractId && db.contracts.find((x) => x.id === tk.contractId && labelFor(x) === cv) ? tk.contractId : null)) : null;
      const data = { title: titleInput.value.trim(), dueDate: dueInput.value, assignee: assigneeSel.value, contractId, tags: core.parseTags(tagsInput.value), note: noteInput.value.trim() };
      if (editing) { Object.assign(editing, data); toast("タスクを更新しました", "success"); }
      else { db.tasks.push({ id: nextId("tk"), status: "open", companyId: tk.companyId || null, ...data }); toast("タスクを登録しました", "success"); }
      db.save(); closeModal(); render();
    }));
    openModal(editing ? "タスクを編集" : "タスクを追加", grid, foot);
  }

  /* ---------- 企業一覧 ---------- */
  function renderCompanies(root, actions) {
    actions.appendChild(buttonEl("+ 企業を追加", "btn", () => openCompanyModal()));
    const today = todayStr();
    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    const contactNames = (co) => (co.contacts || []).map((ct) => (typeof ct === "string" ? ct : ct.name));

    // 企業ごとの集計
    let rows = db.companies.map((co) => {
      const cs = db.contracts.filter((c) => c.companyId === co.id);
      return {
        co, cs,
        amount: cs.reduce((s, c) => s + core.contractAmount(c), 0),
        alert: cs.filter((c) => ["expiring", "expired"].includes(core.computeStatus(c, today))).length,
        reps: uniq(cs.map((c) => c.salesRep)),
        planners: uniq(cs.map((c) => c.plannerRep)),
        contacts: uniq(contactNames(co).concat(cs.map((c) => c.customerContact))),
      };
    });

    // 検索
    const kw = state.companyFilter.keyword.trim().toLowerCase();
    if (kw) {
      rows = rows.filter((r) => {
        const hay = [r.co.name, (r.co.departments || []).join(" "), r.reps.join(" "), r.planners.join(" "), r.contacts.join(" ")].join(" ").toLowerCase();
        return hay.includes(kw);
      });
    }
    // 並び替え
    const sort = state.companyFilter.sort;
    rows.sort((a, b) => {
      if (sort === "amount") return b.amount - a.amount;
      if (sort === "count") return b.cs.length - a.cs.length;
      if (sort === "alert") return b.alert - a.alert;
      return a.co.name.localeCompare(b.co.name, "ja");
    });

    // ツールバー
    const bar = el("div", { class: "toolbar" });
    const search = el("div", { class: "search" });
    const sInput = el("input", { type: "text", placeholder: "企業・部署・担当・顧客担当者で検索", value: state.companyFilter.keyword });
    sInput.addEventListener("input", (e) => { state.companyFilter.keyword = e.target.value; render(); });
    search.appendChild(sInput);
    bar.appendChild(search);
    const sortSel = el("select", { class: "select" });
    [["name", "企業名順"], ["count", "契約数順"], ["amount", "金額順"], ["alert", "要対応順"]].forEach(([v, l]) =>
      sortSel.appendChild(el("option", { value: v, selected: sort === v }, l)));
    sortSel.addEventListener("change", (e) => { state.companyFilter.sort = e.target.value; render(); });
    bar.appendChild(sortSel);
    bar.appendChild(buttonEl("✔ 選択企業にタスク追加", "btn btn-sec", () => {
      const ids = [...document.querySelectorAll(".company-check:checked")].map((x) => x.dataset.cid);
      if (!ids.length) { toast("企業を選択してください", "error"); return; }
      openBulkTaskModal(ids);
    }));
    root.appendChild(bar);

    const panel = el("div", { class: "panel" });
    const body = el("div", { class: "panel-body table-wrap" });
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty"><div class="empty-ico">▣</div><div class="empty-title">${db.companies.length ? "該当する企業がありません" : "企業が登録されていません"}</div></div>`;
    } else {
      const t = el("table", { class: "data" });
      t.innerHTML = `<thead><tr><th></th><th>企業</th><th>部署</th><th class="num">契約数</th><th class="num">金額</th><th>営業担当</th><th>企画担当</th><th>顧客担当者</th><th class="num">要対応</th><th></th></tr></thead>`;
      const tb = el("tbody");
      const join = (arr) => arr.join("、") || "—";
      rows.forEach((r) => {
        const co = r.co;
        const deptMap = {};
        r.cs.forEach((c) => { const d = c.department || "（部署なし）"; (deptMap[d] = deptMap[d] || []).push(c); });
        (co.departments || []).forEach((d) => { if (!deptMap[d]) deptMap[d] = []; });
        let depts = Object.keys(deptMap).sort((a, b) => a.localeCompare(b, "ja"));
        if (depts.length === 0) { depts = ["（部署なし）"]; deptMap["（部署なし）"] = []; }
        depts.forEach((d, idx) => {
          const list = deptMap[d];
          const amount = list.reduce((s, c) => s + core.contractAmount(c), 0);
          const alert = list.filter((c) => ["expiring", "expired"].includes(core.computeStatus(c, today))).length;
          const first = idx === 0;
          const row = el("tr", { class: first ? "company-first" : "" });
          const chkTd = el("td");
          if (first) {
            const chk = el("input", { type: "checkbox", class: "company-check", style: "width:auto;cursor:pointer" });
            chk.dataset.cid = co.id;
            chkTd.appendChild(chk);
          }
          row.appendChild(chkTd);
          row.insertAdjacentHTML("beforeend",
            `<td class="cell-strong">${first ? esc(co.name) : ""}</td>` +
            `<td>${esc(d)}</td>` +
            `<td class="num">${list.length}</td>` +
            `<td class="num">${core.formatYen(amount)}</td>` +
            `<td class="cell-sub">${esc(join(uniq(list.map((c) => c.salesRep))))}</td>` +
            `<td class="cell-sub">${esc(join(uniq(list.map((c) => c.plannerRep))))}</td>` +
            `<td class="cell-sub">${first ? esc(join(r.contacts)) : ""}</td>` +
            `<td class="num">${alert ? `<span class="days-left warn">${alert}</span>` : "0"}</td>`);
          const td = el("td");
          if (first) {
            const wrap = el("div", { class: "row-actions" });
            wrap.appendChild(buttonEl("タスク", "btn-icon", () => openBulkTaskModal([co.id]), "この企業にタスク追加"));
            wrap.appendChild(buttonEl("詳細", "btn-icon", () => openCompanyDetail(co.id), "詳細"));
            wrap.appendChild(buttonEl("✎", "btn-icon", () => openCompanyModal(co.id), "編集"));
            wrap.appendChild(buttonEl("🗑", "btn-icon", () => deleteCompany(co.id), "削除"));
            td.appendChild(wrap);
          }
          row.appendChild(td);
          tb.appendChild(row);
        });
      });
      t.appendChild(tb);
      body.appendChild(t);
    }
    panel.appendChild(body);
    root.appendChild(panel);
  }

  /* ---------- マスタ管理 ---------- */
  function masterChipPanel(title, items, onAdd, addLabel) {
    const panel = el("div", { class: "panel" });
    panel.innerHTML = `<div class="panel-head"><h3 class="panel-title">${title}</h3></div>`;
    const body = el("div", { class: "panel-body", style: "padding:16px 18px" });
    const chips = el("div", { class: "chips" });
    items.forEach((val, i) => {
      const chip = el("span", { class: "chip" }, esc(val));
      const x = el("button", { class: "chip-x", title: "削除" }, "×");
      x.addEventListener("click", () => { items.splice(i, 1); db.save(); render(); });
      chip.appendChild(x);
      chips.appendChild(chip);
    });
    chips.appendChild(buttonEl(addLabel, "btn-sec btn-sm", onAdd));
    body.appendChild(chips);
    panel.appendChild(body);
    return panel;
  }

  function openRepModal(title, list, index) {
    const editing = index != null ? (typeof list[index] === "string" ? { name: list[index] } : list[index]) : null;
    const r = editing || {};
    const grid = el("div", { class: "form-grid" });
    const nameInput = el("input", { type: "text", value: r.name || "", placeholder: "氏名" });
    const deptInput = el("input", { type: "text", value: r.dept || "", placeholder: "所属部署" });
    const emailInput = el("input", { type: "email", value: r.email || "", placeholder: "メールアドレス" });
    const teamsInput = el("input", { type: "url", value: r.teams || "", placeholder: "Teamsチャットのリンク（URL）" });
    const noteInput = el("textarea", { placeholder: "備考" });
    noteInput.value = r.note || "";
    grid.appendChild(field('氏名 <span class="req">*</span>', nameInput));
    grid.appendChild(field("部署", deptInput));
    grid.appendChild(field("メールアドレス", emailInput));
    grid.appendChild(field("Teams", teamsInput));
    grid.appendChild(field("備考", noteInput, true));
    const foot = el("div");
    foot.appendChild(buttonEl("キャンセル", "btn btn-sec", closeModal));
    foot.appendChild(buttonEl(editing ? "更新" : "登録", "btn", () => {
      if (!nameInput.value.trim()) { nameInput.closest(".field").classList.add("invalid"); return; }
      const data = { name: nameInput.value.trim(), dept: deptInput.value.trim(), email: emailInput.value.trim(), teams: teamsInput.value.trim(), note: noteInput.value.trim() };
      if (editing) { list[index] = data; toast(`${title}を更新しました`, "success"); }
      else { if (db.repExists(list, data.name)) { toast("既に登録されています", "error"); return; } list.push(data); toast(`${title}を登録しました`, "success"); }
      db.save(); closeModal(); render();
    }));
    openModal(editing ? `${title}を編集` : `${title}を追加`, grid, foot);
  }
  function repsPanel(title, list) {
    const panel = el("div", { class: "panel" });
    const head = el("div", { class: "panel-head" });
    head.innerHTML = `<h3 class="panel-title">${title}</h3>`;
    head.appendChild(buttonEl(`＋ ${title}を追加`, "btn btn-sm", () => openRepModal(title, list)));
    panel.appendChild(head);
    const body = el("div", { class: "panel-body table-wrap" });
    const t = el("table", { class: "data" });
    t.innerHTML = `<thead><tr><th>氏名</th><th>部署</th><th>メール</th><th>Teams</th><th>備考</th><th></th></tr></thead>`;
    const tb = el("tbody");
    list.forEach((rr, i) => {
      const rep = typeof rr === "string" ? { name: rr } : rr;
      const tr = el("tr");
      tr.innerHTML =
        `<td class="cell-strong">${esc(rep.name)}</td>` +
        `<td class="cell-sub">${esc(rep.dept) || "—"}</td>` +
        `<td class="cell-sub">${rep.email ? `<a class="doc-link" href="mailto:${esc(rep.email)}">${esc(rep.email)}</a>` : "—"}</td>` +
        `<td class="cell-sub">${rep.teams ? `<a class="doc-link" href="${esc(core.safeUrl(rep.teams))}" target="_blank" rel="noopener">💬 チャット</a>` : "—"}</td>` +
        `<td class="cell-sub">${esc(rep.note) || "—"}</td>`;
      const td = el("td");
      const wrap = el("div", { class: "row-actions" });
      wrap.appendChild(buttonEl("✎", "btn-icon", () => openRepModal(title, list, i), "編集"));
      wrap.appendChild(buttonEl("🗑", "btn-icon", () => { if (confirm(`「${rep.name}」を削除しますか?`)) { list.splice(i, 1); db.save(); render(); } }, "削除"));
      td.appendChild(wrap); tr.appendChild(td);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    body.appendChild(t);
    panel.appendChild(body);
    return panel;
  }

  function pickCsv(cb) {
    const inp = el("input", { type: "file", accept: ".csv", style: "display:none" });
    inp.addEventListener("change", () => {
      const f = inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { try { cb(String(r.result)); } catch (e) { console.error(e); toast("取込に失敗しました", "error"); } };
      r.readAsText(f);
    });
    document.body.appendChild(inp); inp.click();
    setTimeout(() => inp.remove(), 2000);
  }
  function masterCsvRow(exportFn, importFn, templateCSV, baseName) {
    const row = el("div", { class: "master-csv" });
    row.appendChild(buttonEl("📤 書き出し", "btn-sec btn-sm", exportFn));
    row.appendChild(buttonEl("📥 取込", "btn-sec btn-sm", () => pickCsv(importFn)));
    row.appendChild(buttonEl("📄 テンプレート", "btn-sec btn-sm", () => downloadCSV(templateCSV, baseName + "_テンプレート.csv")));
    return row;
  }
  function importProductsCsv(text) {
    const parsed = core.parseProductsCSV(text);
    parsed.forEach((p) => {
      const ex = db.products.find((x) => x.name === p.name);
      if (ex) { p.licenses.forEach((l) => { if (!ex.licenses.includes(l)) ex.licenses.push(l); }); if (p.description) ex.description = p.description; if (p.color) ex.color = p.color; }
      else db.products.push({ id: nextId("pr"), name: p.name, description: p.description, color: p.color, licenses: p.licenses });
    });
    db.save(); toast(`製品 ${parsed.length} 件を取込みました`, "success"); render();
  }
  function importRepsCsv(text) {
    const { sales, planners } = core.parseRepsCSV(text);
    const merge = (list, reps) => reps.forEach((r) => { const ex = list.find((x) => (typeof x === "string" ? x : x.name) === r.name); if (ex && typeof ex === "object") { ex.email = r.email || ex.email; ex.teams = r.teams || ex.teams; } else if (!ex) list.push(r); });
    merge(db.salesRepsList, sales); merge(db.plannerRepsList, planners);
    db.save(); toast(`担当者 ${sales.length + planners.length} 件を取込みました`, "success"); render();
  }
  function importBillingCsv(text) {
    const items = core.parseListCSV(text);
    items.forEach((v) => { if (!db.billingTypes.includes(v)) db.billingTypes.push(v); });
    db.save(); toast(`契約形態 ${items.length} 件を取込みました`, "success"); render();
  }
  function importCompaniesCsv(text) {
    const parsed = core.parseCompaniesCSV(text);
    parsed.forEach((c) => {
      const ex = db.companies.find((x) => x.name === c.name);
      if (ex) { c.departments.forEach((d) => { if (!ex.departments.includes(d)) ex.departments.push(d); }); if (c.note) ex.note = c.note; }
      else db.companies.push({ id: nextId("co"), name: c.name, note: c.note, departments: c.departments, contacts: [] });
    });
    db.save(); toast(`企業 ${parsed.length} 件を取込みました`, "success"); render();
  }

  function openCustomerContactModal(companyId, contactIndex) {
    const co0 = companyId ? db.company(companyId) : null;
    const editing = co0 && contactIndex != null;
    const ct = editing ? (typeof co0.contacts[contactIndex] === "string" ? { name: co0.contacts[contactIndex] } : co0.contacts[contactIndex]) : {};
    const grid = el("div", { class: "form-grid" });
    const compSel = el("select");
    compSel.appendChild(el("option", { value: "" }, "選択してください"));
    db.companies.slice().sort((a, b) => a.name.localeCompare(b.name, "ja")).forEach((c) => compSel.appendChild(el("option", { value: c.id, selected: c.id === companyId }, c.name)));
    compSel.disabled = !!editing;
    const nameInput = el("input", { type: "text", value: ct.name || "", placeholder: "氏名" });
    const emailInput = el("input", { type: "email", value: ct.email || "", placeholder: "メールアドレス" });
    const phoneInput = el("input", { type: "tel", value: ct.phone || "", placeholder: "電話番号" });
    grid.appendChild(field('企業 <span class="req">*</span>', compSel));
    grid.appendChild(field('氏名 <span class="req">*</span>', nameInput));
    grid.appendChild(field("メールアドレス", emailInput));
    grid.appendChild(field("電話番号", phoneInput));
    const foot = el("div");
    foot.appendChild(buttonEl("キャンセル", "btn btn-sec", closeModal));
    foot.appendChild(buttonEl(editing ? "更新" : "登録", "btn", () => {
      const co = db.company(compSel.value);
      if (!co) { compSel.closest(".field").classList.add("invalid"); return; }
      if (!nameInput.value.trim()) { nameInput.closest(".field").classList.add("invalid"); return; }
      if (!Array.isArray(co.contacts)) co.contacts = [];
      const data = { name: nameInput.value.trim(), email: emailInput.value.trim(), phone: phoneInput.value.trim() };
      if (editing) { co.contacts[contactIndex] = data; toast("顧客担当者を更新しました", "success"); }
      else { co.contacts.push(data); toast("顧客担当者を登録しました", "success"); }
      db.save(); closeModal(); render();
    }));
    openModal(editing ? "顧客担当者を編集" : "顧客担当者を追加", grid, foot);
  }
  function customerContactsPanel() {
    const panel = el("div", { class: "panel" });
    const head = el("div", { class: "panel-head" });
    head.innerHTML = `<h3 class="panel-title">顧客担当者</h3>`;
    head.appendChild(buttonEl("＋ 顧客担当者を追加", "btn btn-sm", () => openCustomerContactModal()));
    panel.appendChild(head);
    const body = el("div", { class: "panel-body table-wrap" });
    const rows = [];
    db.companies.forEach((co) => (co.contacts || []).forEach((ct, idx) => {
      const c = typeof ct === "string" ? { name: ct } : ct;
      rows.push({ co, idx, name: c.name, email: c.email || "", phone: c.phone || "" });
    }));
    rows.sort((a, b) => a.co.name.localeCompare(b.co.name, "ja") || a.name.localeCompare(b.name, "ja"));
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty"><div class="empty-title">顧客担当者は未登録です</div></div>`;
    } else {
      const t = el("table", { class: "data" });
      t.innerHTML = `<thead><tr><th>氏名</th><th>企業</th><th>メール</th><th>電話</th><th></th></tr></thead>`;
      const tb = el("tbody");
      rows.forEach((r) => {
        const tr = el("tr");
        tr.innerHTML = `<td class="cell-strong">${esc(r.name)}</td><td>${esc(r.co.name)}</td><td class="cell-sub">${r.email ? `<a class="doc-link" href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "—"}</td><td class="cell-sub">${esc(r.phone) || "—"}</td>`;
        const td = el("td");
        const wrap = el("div", { class: "row-actions" });
        wrap.appendChild(buttonEl("✎", "btn-icon", () => openCustomerContactModal(r.co.id, r.idx), "編集"));
        wrap.appendChild(buttonEl("🗑", "btn-icon", () => { if (confirm(`「${r.name}」を削除しますか?`)) { r.co.contacts.splice(r.idx, 1); db.save(); render(); } }, "削除"));
        td.appendChild(wrap);
        tr.appendChild(td);
        tb.appendChild(tr);
      });
      t.appendChild(tb); body.appendChild(t);
    }
    panel.appendChild(body);
    return panel;
  }

  function renderSettings(root) {
    // ■ 製品・ライセンス
    root.appendChild(el("h2", { class: "section-title" }, "製品・ライセンス"));
    const pPanel = el("div", { class: "panel" });
    const pBody = el("div", { class: "panel-body", style: "padding:16px 18px" });
    // 製品が増えても探しやすいよう検索
    const psearch = el("div", { class: "search", style: "margin-bottom:14px" });
    const psearchInput = el("input", { type: "text", placeholder: "製品を検索" });
    psearchInput.addEventListener("input", () => {
      const kw = psearchInput.value.trim().toLowerCase();
      pBody.querySelectorAll(".master-prod").forEach((card) => { card.hidden = kw && !card.dataset.name.includes(kw); });
    });
    psearch.appendChild(psearchInput);
    pBody.appendChild(psearch);
    db.products.forEach((p) => {
      // アコーディオン: 既定は折りたたみ、製品名＋ライセンス数のみ表示
      const card = el("details", { class: "master-prod", dataset: { name: p.name.toLowerCase() } });
      const summary = el("summary", { class: "master-prod-head" });
      const color = p.color || "#64748b";
      const initial = esc((p.name || "?").trim().charAt(0).toUpperCase());
      summary.innerHTML =
        `<span class="prod-logo" style="background:${esc(color)}">${initial}</span>` +
        `<span class="prod-meta"><span class="master-prod-name">${esc(p.name)}</span>` +
        `<span class="prod-desc">${esc(p.description || "")}</span></span>` +
        `<span class="master-prod-count">${p.licenses.length}</span>`;
      card.appendChild(summary);
      const inner = el("div", { class: "master-prod-body" });
      const hact = el("div", { class: "row-actions", style: "margin-bottom:8px" });
      hact.appendChild(buttonEl("名称変更", "btn-icon", () => {
        const v = prompt("製品名", p.name); if (v && v.trim()) { p.name = v.trim(); db.save(); render(); }
      }, "名称変更"));
      hact.appendChild(buttonEl("説明を編集", "btn-icon", () => {
        const v = prompt("製品の説明", p.description || ""); if (v !== null) { p.description = v.trim(); db.save(); render(); }
      }, "説明を編集"));
      hact.appendChild(buttonEl("色を変更", "btn-icon", () => {
        const v = prompt("ロゴ色（#RRGGBB）", p.color || "#64748b"); if (v && /^#?[0-9a-fA-F]{6}$/.test(v.trim())) { p.color = v.trim().startsWith("#") ? v.trim() : "#" + v.trim(); db.save(); render(); }
      }, "色を変更"));
      hact.appendChild(buttonEl("🗑 製品を削除", "btn-icon", () => {
        if (confirm(`製品「${p.name}」を削除しますか?`)) { db.products = db.products.filter((x) => x.id !== p.id); db.save(); render(); }
      }, "削除"));
      inner.appendChild(hact);
      const chips = el("div", { class: "chips" });
      p.licenses.forEach((lic, i) => {
        const chip = el("span", { class: "chip" }, esc(lic));
        const x = el("button", { class: "chip-x", title: "削除" }, "×");
        x.addEventListener("click", () => { p.licenses.splice(i, 1); db.save(); render(); });
        chip.appendChild(x);
        chips.appendChild(chip);
      });
      chips.appendChild(buttonEl("＋ ライセンス追加", "btn-sec btn-sm", () => {
        const v = prompt(`「${p.name}」に追加するライセンス名`); if (v && v.trim()) { p.licenses.push(v.trim()); db.save(); render(); }
      }));
      inner.appendChild(chips);
      card.appendChild(inner);
      pBody.appendChild(card);
    });
    const addProd = buttonEl("＋ 製品を追加", "btn", () => {
      const v = prompt("製品名"); if (v && v.trim()) { db.products.push({ id: nextId("pr"), name: v.trim(), licenses: [] }); db.save(); render(); }
    });
    pBody.appendChild(addProd);
    pPanel.appendChild(pBody);
    root.appendChild(pPanel);
    root.appendChild(masterCsvRow(
      () => downloadCSV(core.productsToCSV(db.products), "製品ライセンス.csv"),
      importProductsCsv,
      "製品,ライセンス,説明,色\r\n" + ["Salesforce", "Sales Cloud", "クラウドCRM", "#00A1E0"].map(core.csvEscape).join(","),
      "製品ライセンス"));

    // ■ 契約
    root.appendChild(el("h2", { class: "section-title" }, "契約"));
    root.appendChild(masterChipPanel("契約形態", db.billingTypes, () => {
      const v = prompt("契約形態（例: 年額, 月額, 従量課金）"); if (v && v.trim() && !db.billingTypes.includes(v.trim())) { db.billingTypes.push(v.trim()); db.save(); render(); }
    }, "＋ 契約形態を追加"));
    root.appendChild(masterCsvRow(
      () => downloadCSV(core.listToCSV("契約形態", db.billingTypes), "契約形態.csv"),
      importBillingCsv,
      "契約形態\r\n年額",
      "契約形態"));

    // ■ 企業・部署（企業一覧を統合）
    root.appendChild(el("h2", { class: "section-title" }, "企業・部署"));
    const compActions = el("div", { class: "section-actions" });
    root.appendChild(compActions);
    renderCompanies(root, compActions);
    root.appendChild(masterCsvRow(
      () => downloadCSV(core.companiesToCSV(db.companies), "企業部署.csv"),
      importCompaniesCsv,
      "企業,部署,備考\r\n" + ["株式会社サンプル", "営業部", ""].map(core.csvEscape).join(","),
      "企業部署"));

    // ■ 担当者
    root.appendChild(el("h2", { class: "section-title" }, "担当者"));
    root.appendChild(customerContactsPanel());
    root.appendChild(repsPanel("営業担当者", db.salesRepsList));
    root.appendChild(repsPanel("企画担当者", db.plannerRepsList));
    root.appendChild(masterCsvRow(
      () => downloadCSV(core.repsToCSV(db.salesRepsList, db.plannerRepsList), "担当者.csv"),
      importRepsCsv,
      "区分,氏名,部署,メール,Teams,備考\r\n" + ["営業", "田中 太郎", "営業部", "tanaka@example.com", "", ""].map(core.csvEscape).join(","),
      "担当者"));

    // ■ データ（サンプル投入）
    root.appendChild(el("h2", { class: "section-title" }, "データ"));
    const dPanel = el("div", { class: "panel" });
    dPanel.innerHTML = `<div class="panel-head"><h3 class="panel-title">サンプルデータ</h3><span class="cell-sub">契約のCSV入出力は「契約一覧」画面にあります</span></div>`;
    const dBody = el("div", { class: "panel-body", style: "padding:16px 18px;display:flex;gap:8px;flex-wrap:wrap" });
    dBody.appendChild(buttonEl("🧪 サンプル契約を投入", "btn btn-sec", seedData));
    dPanel.appendChild(dBody);
    root.appendChild(dPanel);

    // ■ バックアップ
    root.appendChild(el("h2", { class: "section-title" }, "バックアップ"));
    root.appendChild(backupPanel());
  }

  function backupPanel() {
    const o = loadAutoBak();
    const panel = el("div", { class: "panel" });
    panel.innerHTML = `<div class="panel-head"><h3 class="panel-title">バックアップ</h3><span class="cell-sub">全データ（契約・企業・部署・顧客担当者・製品/ライセンス・契約形態・担当者・タスク）が対象</span></div>`;
    const body = el("div", { class: "panel-body", style: "padding:16px 18px" });

    // 手動
    const row = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px" });
    row.appendChild(buttonEl("今すぐバックアップ (JSON)", "btn", exportBackup));
    row.appendChild(buttonEl("ファイルから復元", "btn btn-sec", () => $("#restoreFile").click()));
    body.appendChild(row);

    // 自動バックアップ（変更時）
    const sw = el("label", { class: "switch-label", style: "display:flex;margin-bottom:10px" });
    const chk = el("input", { type: "checkbox", checked: !!o.enabled });
    chk.addEventListener("change", () => { const x = loadAutoBak(); x.enabled = chk.checked; saveAutoBak(x); if (chk.checked) maybeAutoBackup(); render(); });
    sw.appendChild(chk);
    sw.appendChild(document.createTextNode("自動バックアップ（変更のたびに自動保存）"));
    body.appendChild(sw);

    // 定期バックアップ（毎日/毎週）
    const pRow = el("div", { class: "span-ctrl", style: "margin-bottom:16px" });
    pRow.appendChild(el("span", { class: "span-label" }, "定期バックアップ"));
    const pSel = el("select", { class: "select" });
    [["off", "オフ"], ["daily", "毎日"], ["weekly", "毎週"]].forEach(([v, l]) => pSel.appendChild(el("option", { value: v, selected: (o.interval || "off") === v }, l)));
    pSel.addEventListener("change", () => { const x = loadAutoBak(); x.interval = pSel.value; saveAutoBak(x); periodicBackupCheck(); render(); });
    pRow.appendChild(pSel);
    pRow.appendChild(el("span", { class: "cell-sub" }, "アプリを開いている間に自動保存"));
    body.appendChild(pRow);

    // スナップショット一覧（最新7件）
    body.appendChild(el("div", { class: "section-title", style: "margin:6px 0 8px;font-size:12px" }, "保存済みバックアップ（最新7件）"));
    const list = el("div", { class: "table-wrap" });
    if (!o.snapshots || o.snapshots.length === 0) {
      list.innerHTML = `<div class="cell-sub" style="padding:6px 0">まだありません</div>`;
    } else {
      const t = el("table", { class: "data" });
      t.innerHTML = `<thead><tr><th>日時</th><th>種別</th><th class="num">契約</th><th class="num">企業</th><th></th></tr></thead>`;
      const tb = el("tbody");
      o.snapshots.forEach((snap) => {
        const r = el("tr");
        r.innerHTML = `<td class="cell-strong">${esc(snap.at)}</td><td><span class="badge ${snap.kind === "定期" ? "upcoming" : "active"}">${esc(snap.kind || "自動")}</span></td><td class="num">${(snap.data.contracts || []).length}</td><td class="num">${(snap.data.companies || []).length}</td>`;
        const td = el("td");
        const wrap = el("div", { class: "row-actions" });
        wrap.appendChild(buttonEl("復元", "btn-icon", () => { if (confirm(`${snap.at} のバックアップで現在のデータを置き換えます。よろしいですか?`)) restoreFromData(snap.data); }, "復元"));
        wrap.appendChild(buttonEl("DL", "btn-icon", () => downloadJSON(core.makeBackup(snap.data), `契約管理バックアップ_${snap.at.replace(/[\/: ]/g, "")}.json`), "ダウンロード"));
        td.appendChild(wrap); r.appendChild(td);
        tb.appendChild(r);
      });
      t.appendChild(tb); list.appendChild(t);
    }
    body.appendChild(list);
    panel.appendChild(body);
    return panel;
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function restoreFromData(data) {
    try {
      const d = core.parseBackup(JSON.stringify({ data }));
      db.companies = d.companies; db.contracts = d.contracts;
      db.products = d.products.length ? d.products : core.defaultProducts();
      db.salesRepsList = d.salesRepsList.length ? d.salesRepsList : core.defaultSalesReps();
      db.plannerRepsList = d.plannerRepsList.length ? d.plannerRepsList : core.defaultPlannerReps();
      db.billingTypes = d.billingTypes.length ? d.billingTypes : core.defaultBillingTypes();
      db.tasks = d.tasks;
      db.companies.forEach((co) => { if (!Array.isArray(co.departments)) co.departments = []; if (!Array.isArray(co.contacts)) co.contacts = []; });
      db.normalizeReps();
      db.save();
      toast("復元しました", "success");
      render();
    } catch (e) { console.error(e); toast("復元に失敗しました", "error"); }
  }

  /* ============================================================
     モーダル基盤
     ============================================================ */
  function openModal(title, bodyNode, footNode) {
    $("#modalTitle").textContent = title;
    const mb = $("#modalBody"); mb.innerHTML = ""; mb.appendChild(bodyNode);
    const mf = $("#modalFoot"); mf.innerHTML = ""; if (footNode) mf.appendChild(footNode);
    $("#modalOverlay").hidden = false;
  }
  function closeModal() { $("#modalOverlay").hidden = true; }

  function field(labelHtml, inputNode, full) {
    const f = el("div", { class: "field" + (full ? " full" : "") });
    f.appendChild(el("label", {}, labelHtml));
    f.appendChild(inputNode);
    f.appendChild(el("div", { class: "err" }, "入力してください"));
    return f;
  }

  function fillSelect(sel, items, selected, placeholder) {
    sel.innerHTML = "";
    if (placeholder != null) sel.appendChild(el("option", { value: "" }, placeholder));
    items.forEach((it) => {
      const value = typeof it === "string" ? it : it.value;
      const label = typeof it === "string" ? it : it.label;
      sel.appendChild(el("option", { value, selected: value === selected }, label));
    });
  }

  /* ---------- 契約モーダル ---------- */
  function openContractModal(id, prefill) {
    const editing = id ? db.contracts.find((c) => c.id === id) : null;
    const c = editing || prefill || { quantity: 1, autoRenew: false };
    const grid = el("div", { class: "form-grid" });

    // 企業
    const companySel = el("select", { id: "f_company" });
    const rebuildCompany = () => {
      companySel.innerHTML = "";
      companySel.appendChild(el("option", { value: "" }, "選択してください"));
      db.companies.slice().sort((a, b) => a.name.localeCompare(b.name, "ja")).forEach((co) =>
        companySel.appendChild(el("option", { value: co.id, selected: c.companyId === co.id }, co.name)));
      companySel.appendChild(el("option", { value: "__new__" }, "＋ 新しい企業を登録…"));
    };
    rebuildCompany();

    // 部署 (企業に紐づく)
    const deptSel = el("select", { id: "f_dept" });
    const rebuildDept = (selected) => {
      const co = db.company(companySel.value);
      const depts = (co && co.departments) || [];
      deptSel.innerHTML = "";
      deptSel.appendChild(el("option", { value: "" }, "（任意）"));
      depts.forEach((d) => deptSel.appendChild(el("option", { value: d, selected: d === selected }, d)));
      deptSel.appendChild(el("option", { value: "__new__" }, "＋ 新しい部署を追加…"));
    };
    rebuildDept(c.department);

    companySel.addEventListener("change", () => {
      if (companySel.value === "__new__") {
        const name = prompt("企業名を入力");
        if (name && name.trim()) { const co = { id: nextId("co"), name: name.trim(), note: "", departments: [] }; db.companies.push(co); db.save(); c.companyId = co.id; rebuildCompany(); companySel.value = co.id; }
        else { companySel.value = c.companyId || ""; }
      }
      rebuildDept("");
      rebuildContact("");
    });
    deptSel.addEventListener("change", () => {
      if (deptSel.value === "__new__") {
        const co = db.company(companySel.value);
        if (!co) { toast("先に企業を選択してください", "error"); deptSel.value = ""; return; }
        const v = prompt(`「${co.name}」の部署名を入力`);
        if (v && v.trim()) { if (!co.departments.includes(v.trim())) co.departments.push(v.trim()); db.save(); rebuildDept(v.trim()); }
        else deptSel.value = "";
      }
    });

    // 製品 → ライセンス（検索可能・製品/ライセンスが多くても使いやすい datalist 入力）
    const prodInput = el("input", { type: "text", id: "f_product", value: c.productName || "", placeholder: "製品を選択 または 入力" });
    prodInput.setAttribute("list", "prodlist");
    const prodDl = el("datalist", { id: "prodlist" });
    db.allProductNames().forEach((n) => prodDl.appendChild(el("option", { value: n })));
    const licInput = el("input", { type: "text", id: "f_license", value: c.licenseType || "", placeholder: "ライセンスを選択 または 入力" });
    licInput.setAttribute("list", "liclist");
    const licDl = el("datalist", { id: "liclist" });
    const rebuildLicense = () => {
      licDl.innerHTML = "";
      const p = db.product(prodInput.value);
      const lics = p ? p.licenses : db.products.reduce((a, x) => a.concat(x.licenses), []);
      [...new Set(lics)].forEach((l) => licDl.appendChild(el("option", { value: l })));
    };
    rebuildLicense();
    prodInput.addEventListener("input", rebuildLicense);
    const prodSel = prodInput, licSel = licInput; // 以降の参照を共通化

    // 契約形態（課金タイプ）
    const billingSel = el("select", { id: "f_billing" });
    fillSelect(billingSel, db.billingTypes, c.billingType, "（任意）");

    const qtyInput = el("input", { type: "number", id: "f_qty", min: "0", value: c.quantity ?? 1 });
    const unitInput = el("input", { type: "number", id: "f_unit", min: "0", value: c.unitPrice ?? "", placeholder: "1ライセンス単価" });
    const amountHint = el("div", { class: "hint-val", id: "f_amount_hint" }, "");
    const updateAmount = () => {
      const q = Number(qtyInput.value) || 0, u = Number(unitInput.value) || 0;
      amountHint.textContent = u > 0 ? "金額: " + core.formatYen(q * u) : "";
    };
    qtyInput.addEventListener("input", updateAmount);
    unitInput.addEventListener("input", updateAmount);

    const startInput = el("input", { type: "date", id: "f_start", value: c.startDate || "" });
    const endInput = el("input", { type: "date", id: "f_end", value: c.endDate || "" });
    startInput.addEventListener("change", () => { if (startInput.value && !endInput.value) endInput.value = core.termEnd(startInput.value, 1); });
    const termPresets = el("div", { class: "term-presets" });
    [1, 2, 3].forEach((y) => {
      const b = el("button", { class: "chip-btn", type: "button" }, `${y}年`);
      b.addEventListener("click", () => {
        if (!startInput.value) { toast("先に開始日を入力してください", "error"); return; }
        endInput.value = core.termEnd(startInput.value, y);
        endInput.closest(".field").classList.remove("invalid");
      });
      termPresets.appendChild(b);
    });

    // 自社担当 (営業)
    const repSel = el("select", { id: "f_rep" });
    const rebuildRep = (selected) => {
      const list = db.allSalesReps().map((r) => ({ value: r, label: r }));
      list.push({ value: "__new__", label: "＋ 新しい担当を追加…" });
      fillSelect(repSel, list, selected, "（任意）");
    };
    rebuildRep(c.salesRep);
    repSel.addEventListener("change", () => {
      if (repSel.value === "__new__") {
        const v = prompt("営業担当名"); if (v && v.trim()) { db.addRep(db.salesRepsList, v.trim()); db.save(); rebuildRep(v.trim()); }
        else repSel.value = c.salesRep || "";
      }
    });

    // 企画担当
    const plannerSel = el("select", { id: "f_planner" });
    const rebuildPlanner = (selected) => {
      const list = db.allPlannerReps().map((r) => ({ value: r, label: r }));
      list.push({ value: "__new__", label: "＋ 新しい担当を追加…" });
      fillSelect(plannerSel, list, selected, "（任意）");
    };
    rebuildPlanner(c.plannerRep);
    plannerSel.addEventListener("change", () => {
      if (plannerSel.value === "__new__") {
        const v = prompt("企画担当名"); if (v && v.trim()) { db.addRep(db.plannerRepsList, v.trim()); db.save(); rebuildPlanner(v.trim()); }
        else plannerSel.value = c.plannerRep || "";
      }
    });

    // 顧客担当者 (企業側の窓口)
    const contactSel = el("select", { id: "f_contact" });
    const rebuildContact = (selected) => {
      const co = db.company(companySel.value);
      const contacts = ((co && co.contacts) || []).map((ct) => (typeof ct === "string" ? ct : ct.name));
      const list = contacts.slice();
      if (selected && !list.includes(selected)) list.unshift(selected);
      const opts = list.map((n) => ({ value: n, label: n }));
      opts.push({ value: "__new__", label: "＋ 新しい顧客担当者を追加…" });
      fillSelect(contactSel, opts, selected, "（任意）");
    };
    rebuildContact(c.customerContact);
    contactSel.addEventListener("change", () => {
      if (contactSel.value === "__new__") {
        const co = db.company(companySel.value);
        if (!co) { toast("先に企業を選択してください", "error"); contactSel.value = ""; return; }
        const v = prompt(`「${co.name}」の顧客担当者名を入力`);
        if (v && v.trim()) { co.contacts = co.contacts || []; if (!co.contacts.some((ct) => (typeof ct === "string" ? ct : ct.name) === v.trim())) co.contacts.push({ name: v.trim(), email: "", phone: "" }); db.save(); rebuildContact(v.trim()); }
        else contactSel.value = c.customerContact || "";
      }
    });

    const autoWrap = el("label", { style: "display:flex;align-items:center;gap:8px;font-weight:500;color:var(--text)" });
    const autoChk = el("input", { type: "checkbox", id: "f_auto", checked: !!c.autoRenew, style: "width:auto" });
    autoWrap.appendChild(autoChk);
    autoWrap.appendChild(document.createTextNode("自動更新あり"));
    const autoField = el("div", { class: "field" });
    autoField.appendChild(el("label", {}, "自動更新"));
    autoField.appendChild(autoWrap);

    const cancelWrap = el("label", { style: "display:flex;align-items:center;gap:8px;font-weight:500;color:var(--text)" });
    const cancelChk = el("input", { type: "checkbox", id: "f_cancelled", checked: c.statusOverride === "cancelled", style: "width:auto" });
    cancelWrap.appendChild(cancelChk);
    cancelWrap.appendChild(document.createTextNode("解約済み"));
    const cancelField = el("div", { class: "field" });
    cancelField.appendChild(el("label", {}, "ステータス"));
    cancelField.appendChild(cancelWrap);

    const tagsInput = el("input", { type: "text", id: "f_tags", value: (c.tags || []).join(", "), placeholder: "カンマ区切り（例: 重要顧客, アップセル）" });
    const quoteInput = el("input", { type: "url", id: "f_quote", value: c.quoteUrl || "", placeholder: "見積書のURL（SharePoint/Drive等）" });
    const docInput = el("input", { type: "url", id: "f_doc", value: c.contractUrl || "", placeholder: "契約書のURL" });

    const noteInput = el("textarea", { id: "f_note", placeholder: "備考" });
    noteInput.value = c.note || "";

    grid.appendChild(field('企業 <span class="req">*</span>', companySel));
    grid.appendChild(field("部署", deptSel));
    const prodField = field('製品 <span class="req">*</span>', prodInput);
    prodField.appendChild(prodDl);
    grid.appendChild(prodField);
    const licField = field('ライセンス <span class="req">*</span>', licInput);
    licField.appendChild(licDl);
    grid.appendChild(licField);
    grid.appendChild(field("契約形態", billingSel));
    grid.appendChild(field("数量", qtyInput));
    const unitField = field("単価 (円)", unitInput);
    unitField.appendChild(amountHint);
    grid.appendChild(unitField);
    grid.appendChild(field("営業担当", repSel));
    grid.appendChild(field("企画担当", plannerSel));
    grid.appendChild(field("顧客担当者", contactSel));
    grid.appendChild(autoField);
    grid.appendChild(cancelField);
    grid.appendChild(field('開始日 <span class="req">*</span>', startInput));
    const endField = field('終了日 <span class="req">*</span>', endInput);
    endField.appendChild(termPresets);
    grid.appendChild(endField);
    grid.appendChild(field("見積書リンク", quoteInput));
    grid.appendChild(field("契約書リンク", docInput));
    grid.appendChild(field("タグ", tagsInput, true));
    grid.appendChild(field("備考", noteInput, true));
    updateAmount();

    const foot = el("div");
    foot.appendChild(buttonEl("キャンセル", "btn btn-sec", closeModal));
    foot.appendChild(buttonEl(editing ? "更新" : "登録", "btn", () => {
      const errs = [];
      const setInvalid = (input, bad) => input.closest(".field").classList.toggle("invalid", bad);
      const compVal = companySel.value && companySel.value !== "__new__" ? companySel.value : "";
      setInvalid(companySel, !compVal); if (!compVal) errs.push(1);
      setInvalid(prodSel, !prodSel.value.trim()); if (!prodSel.value.trim()) errs.push(1);
      setInvalid(licSel, !licSel.value.trim()); if (!licSel.value.trim()) errs.push(1);
      setInvalid(startInput, !startInput.value); if (!startInput.value) errs.push(1);
      setInvalid(endInput, !endInput.value); if (!endInput.value) errs.push(1);
      if (startInput.value && endInput.value && endInput.value < startInput.value) {
        setInvalid(endInput, true);
        endInput.closest(".field").querySelector(".err").textContent = "終了日は開始日以降にしてください";
        errs.push(1);
      }
      if (errs.length) { toast("入力内容を確認してください", "error"); return; }

      const repVal = repSel.value && repSel.value !== "__new__" ? repSel.value : "";
      const plannerVal = plannerSel.value && plannerSel.value !== "__new__" ? plannerSel.value : "";
      const contactVal = contactSel.value && contactSel.value !== "__new__" ? contactSel.value : "";
      const data = {
        companyId: compVal,
        department: deptSel.value && deptSel.value !== "__new__" ? deptSel.value : "",
        productName: prodSel.value.trim(),
        licenseType: licSel.value.trim(),
        billingType: billingSel.value || "",
        quantity: Number(qtyInput.value) || 0,
        unitPrice: Number(unitInput.value) || 0,
        startDate: startInput.value,
        endDate: endInput.value,
        salesRep: repVal,
        plannerRep: plannerVal,
        customerContact: contactVal,
        autoRenew: autoChk.checked,
        statusOverride: cancelChk.checked ? "cancelled" : "",
        tags: core.parseTags(tagsInput.value),
        quoteUrl: quoteInput.value.trim(),
        contractUrl: docInput.value.trim(),
        note: noteInput.value.trim(),
      };
      if (editing) {
        Object.assign(editing, data);
        toast("契約を更新しました", "success");
      } else {
        const year = startInput.value.slice(0, 4) || String(new Date().getFullYear());
        db.contracts.push({ id: nextId("ct"), contractNo: core.nextContractNo(db.contracts, year), ...data });
        toast("契約を登録しました", "success");
      }
      db.save();
      closeModal();
      render();
    }));
    openModal(editing ? "契約を編集" : "契約を追加", grid, foot);
  }

  function repWithLinks(name) {
    if (!name) return "—";
    const p = db.repProfile(name);
    let s = esc(name);
    if (p && p.email) s += ` <a class="doc-link" href="mailto:${esc(p.email)}" title="${esc(p.email)}">✉</a>`;
    if (p && p.teams) s += ` <a class="doc-link" href="${esc(core.safeUrl(p.teams))}" target="_blank" rel="noopener" title="Teams">💬</a>`;
    return s;
  }
  function openContractDetail(id) {
    const c = db.contracts.find((x) => x.id === id);
    if (!c) return;
    const g = el("div", { class: "detail-grid" });
    const item = (label, value, full) => `<div class="detail-item${full ? " full" : ""}"><div class="detail-label">${label}</div><div class="detail-value">${value}</div></div>`;
    g.innerHTML =
      item("契約番号", esc(c.contractNo) || "—") +
      item("企業", esc(db.companyName(c.companyId))) +
      item("部署", esc(c.department) || "—") +
      item("製品", esc(c.productName) || "—") +
      item("ライセンス", esc(c.licenseType) || "—") +
      item("契約形態", esc(c.billingType) || "—") +
      item("営業担当", repWithLinks(c.salesRep)) +
      item("企画担当", repWithLinks(c.plannerRep)) +
      item("顧客担当者", esc(c.customerContact) || "—") +
      item("数量", (Number(c.quantity) || 0) + " ライセンス") +
      item("単価", c.unitPrice ? core.formatYen(c.unitPrice) : "—") +
      item("金額 (税抜)", `<strong>${core.formatYen(core.contractAmount(c))}</strong>`) +
      item("金額 (税込10%)", core.formatYen(core.taxIncluded(core.contractAmount(c)))) +
      item("自動更新", c.autoRenew ? "あり" : "なし") +
      item("契約期間", `${core.formatDate(c.startDate)} 〜 ${core.formatDate(c.endDate)}`) +
      item("状態", `${statusBadge(c)} &nbsp; ${daysLeftCell(c)}`) +
      item("見積書", c.quoteUrl ? `<a href="${esc(core.safeUrl(c.quoteUrl))}" target="_blank" rel="noopener" class="doc-link">📄 見積書を開く</a>` : "—") +
      item("契約書", c.contractUrl ? `<a href="${esc(core.safeUrl(c.contractUrl))}" target="_blank" rel="noopener" class="doc-link">📄 契約書を開く</a>` : "—") +
      item("タグ", (c.tags && c.tags.length) ? c.tags.map((t) => `<span class="tag-pill">${esc(t)}</span>`).join(" ") : "—", true) +
      item("備考", `<span class="detail-note">${esc(c.note) || "—"}</span>`, true);

    const container = el("div");
    container.appendChild(g);

    // 活動メモ
    const actSec = el("div", { class: "activity" });
    actSec.appendChild(el("div", { class: "detail-label", style: "margin:20px 0 8px" }, "活動メモ"));
    const actList = el("div", { class: "activity-list" });
    const renderAct = () => {
      actList.innerHTML = "";
      const items = c.activities || [];
      if (!items.length) { actList.innerHTML = `<div class="cell-sub" style="padding:4px 0">記録はありません</div>`; return; }
      items.forEach((a) => { actList.innerHTML += `<div class="activity-item"><div class="activity-at">${esc(a.at)}</div><div class="activity-text">${esc(a.text)}</div></div>`; });
    };
    renderAct();
    const inputRow = el("div", { class: "activity-add" });
    const inp = el("input", { type: "text", placeholder: "メモを追加（更新交渉の状況など）" });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") addAct(); });
    const addAct = () => {
      if (!inp.value.trim()) return;
      const now = new Date();
      const stamp = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      c.activities = core.addActivity(c.activities, inp.value, stamp);
      db.save(); inp.value = ""; renderAct();
    };
    inputRow.appendChild(inp);
    inputRow.appendChild(buttonEl("追加", "btn btn-sec btn-sm", addAct));
    actSec.appendChild(actList);
    actSec.appendChild(inputRow);
    container.appendChild(actSec);

    const foot = el("div", { class: "modal-foot-split" });
    const footL = el("div", { class: "foot-left" });
    footL.appendChild(buttonEl("閉じる", "btn btn-sec", closeModal));
    const footR = el("div", { class: "foot-right" });
    footR.appendChild(buttonEl("✉ 更新メール作成", "btn btn-sec", () => {
      const mail = core.renewalEmail(c, db.companyName(c.companyId), c.customerContact);
      const href = `mailto:?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`;
      const a = el("a", { href });
      document.body.appendChild(a); a.click(); a.remove();
      toast("メール下書きを開きました", "success");
    }));
    footR.appendChild(buttonEl("⧉ 更新（複製）", "btn btn-sec", () => { closeModal(); openContractModal(null, core.renewalCopy(c)); }));
    footR.appendChild(buttonEl("✎ 編集", "btn", () => { closeModal(); openContractModal(c.id); }));
    foot.appendChild(footL);
    foot.appendChild(footR);
    openModal("契約の詳細", container, foot);
  }

  function deleteContract(id) {
    const c = db.contracts.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`${db.companyName(c.companyId)} の「${c.licenseType || c.productName}」契約を削除しますか?`)) return;
    db.contracts = db.contracts.filter((x) => x.id !== id);
    db.save();
    toast("契約を削除しました");
    render();
  }

  /* ---------- 企業モーダル (部署管理つき) ---------- */
  function openCompanyDetail(id) {
    const co = db.company(id);
    if (!co) return;
    const today = todayStr();
    const cs = db.contracts.filter((c) => c.companyId === id);
    const t = core.totals(cs);
    const alert = cs.filter((c) => ["expiring", "expired"].includes(core.computeStatus(c, today))).length;
    const depts = (co.departments || []);
    const contacts = (co.contacts || []).map((ct) => (typeof ct === "string" ? { name: ct } : ct));

    const container = el("div");
    const g = el("div", { class: "detail-grid" });
    const item = (label, value, full) => `<div class="detail-item${full ? " full" : ""}"><div class="detail-label">${label}</div><div class="detail-value">${value}</div></div>`;
    g.innerHTML =
      item("企業名", esc(co.name)) +
      item("契約数", `${cs.length} 件（要対応 ${alert} 件）`) +
      item("金額合計", `<strong>${core.formatYen(t.amount)}</strong> <span class="cell-sub">税込 ${core.formatYen(t.taxIncluded)}</span>`) +
      item("自動更新", `${cs.filter((c) => c.autoRenew).length} 件`) +
      item("部署", depts.length ? depts.map(esc).join("、") : "—", true) +
      item("顧客担当者", contacts.length ? contacts.map((ct) => esc(ct.name) + (ct.email ? `（${esc(ct.email)}）` : "")).join("、") : "—", true) +
      item("備考", `<span class="detail-note">${esc(co.note) || "—"}</span>`, true);
    container.appendChild(g);

    container.appendChild(el("div", { class: "detail-label", style: "margin:20px 0 8px" }, "契約一覧"));
    const listWrap = el("div", { class: "table-wrap" });
    if (cs.length === 0) {
      listWrap.innerHTML = `<div class="cell-sub" style="padding:4px 0">契約はありません</div>`;
    } else {
      const tbl = el("table", { class: "data" });
      tbl.innerHTML = `<thead><tr><th>製品 / ライセンス</th><th class="num">金額</th><th>終了日</th><th>状態</th></tr></thead>`;
      const tb = el("tbody");
      cs.slice().sort((a, b) => (core.parseDate(a.endDate) || 0) - (core.parseDate(b.endDate) || 0)).forEach((c) => {
        const row = el("tr", { style: "cursor:pointer" });
        row.innerHTML = `<td><div class="cell-strong">${esc(c.productName || "—")}</div><div class="cell-sub">${esc(c.licenseType || "")}</div></td><td class="num">${core.formatYen(core.contractAmount(c))}</td><td>${core.formatDate(c.endDate)}</td><td>${statusBadge(c)}</td>`;
        row.addEventListener("click", () => { closeModal(); openContractDetail(c.id); });
        tb.appendChild(row);
      });
      tbl.appendChild(tb);
      listWrap.appendChild(tbl);
    }
    container.appendChild(listWrap);

    const foot = el("div");
    foot.appendChild(buttonEl("閉じる", "btn btn-sec", closeModal));
    foot.appendChild(buttonEl("編集", "btn", () => { closeModal(); openCompanyModal(co.id); }));
    openModal(co.name, container, foot);
  }

  function openCompanyModal(id) {
    const editing = db.companies.find((c) => c.id === id);
    const co = editing || { departments: [], contacts: [] };
    const depts = (co.departments || []).slice();
    const contacts = (co.contacts || []).map((ct) => (typeof ct === "string" ? { name: ct, email: "", phone: "" } : { ...ct }));
    const grid = el("div", { class: "form-grid" });
    const nameInput = el("input", { type: "text", value: co.name || "", placeholder: "企業名" });
    const noteInput = el("textarea", { placeholder: "備考" });
    noteInput.value = co.note || "";

    // チップ生成ヘルパ
    const chipList = (arr, wrap, label, render) => {
      wrap.innerHTML = "";
      arr.forEach((d, i) => {
        const chip = el("span", { class: "chip" }, esc(typeof d === "string" ? d : d.name));
        const x = el("button", { class: "chip-x", title: "削除" }, "×");
        x.addEventListener("click", () => { arr.splice(i, 1); render(); });
        chip.appendChild(x);
        wrap.appendChild(chip);
      });
    };

    const deptWrap = el("div", { class: "chips" });
    const renderDepts = () => {
      chipList(depts, deptWrap, "部署", renderDepts);
      deptWrap.appendChild(buttonEl("＋ 部署を追加", "btn-sec btn-sm", () => {
        const v = prompt("部署名"); if (v && v.trim() && !depts.includes(v.trim())) { depts.push(v.trim()); renderDepts(); }
      }));
    };
    renderDepts();

    const contactWrap = el("div", { class: "chips" });
    const renderContacts = () => {
      chipList(contacts, contactWrap, "顧客担当者", renderContacts);
      contactWrap.appendChild(buttonEl("＋ 顧客担当者を追加", "btn-sec btn-sm", () => {
        const name = prompt("顧客担当者名"); if (!name || !name.trim()) return;
        if (contacts.some((ct) => ct.name === name.trim())) return;
        const email = prompt("メールアドレス（任意）") || "";
        const phone = prompt("電話番号（任意）") || "";
        contacts.push({ name: name.trim(), email: email.trim(), phone: phone.trim() });
        renderContacts();
      }));
    };
    renderContacts();

    grid.appendChild(field('企業名 <span class="req">*</span>', nameInput, true));
    const deptField = el("div", { class: "field full" });
    deptField.appendChild(el("label", {}, "部署"));
    deptField.appendChild(deptWrap);
    grid.appendChild(deptField);
    const contactField = el("div", { class: "field full" });
    contactField.appendChild(el("label", {}, "顧客担当者"));
    contactField.appendChild(contactWrap);
    grid.appendChild(contactField);
    grid.appendChild(field("備考", noteInput, true));

    const foot = el("div");
    foot.appendChild(buttonEl("キャンセル", "btn btn-sec", closeModal));
    foot.appendChild(buttonEl(editing ? "更新" : "登録", "btn", () => {
      if (!nameInput.value.trim()) { nameInput.closest(".field").classList.add("invalid"); return; }
      if (editing) { editing.name = nameInput.value.trim(); editing.note = noteInput.value.trim(); editing.departments = depts; editing.contacts = contacts; toast("企業を更新しました", "success"); }
      else { db.companies.push({ id: nextId("co"), name: nameInput.value.trim(), note: noteInput.value.trim(), departments: depts, contacts }); toast("企業を登録しました", "success"); }
      db.save(); closeModal(); render();
    }));
    openModal(editing ? "企業を編集" : "企業を追加", grid, foot);
  }

  function deleteCompany(id) {
    const co = db.companies.find((c) => c.id === id);
    if (!co) return;
    const n = db.contracts.filter((c) => c.companyId === id).length;
    if (n > 0) { alert(`この企業には ${n} 件の契約が紐づいています。先に契約を削除してください。`); return; }
    if (!confirm(`「${co.name}」を削除しますか?`)) return;
    db.companies = db.companies.filter((c) => c.id !== id);
    db.save();
    toast("企業を削除しました");
    render();
  }

  const SHORTCUT_VIEWS = ["dashboard", "gantt", "tasks", "contracts", "settings"];
  function handleShortcut(e) {
    if (e.key === "Escape") { closeModal(); return; }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = (e.target && e.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return; // 入力中は無効
    if (!$("#modalOverlay").hidden) return; // モーダル表示中は無効
    if (e.key === "n" || e.key === "N") { e.preventDefault(); openContractModal(); return; }
    if (e.key === "/") {
      e.preventDefault();
      if (state.view !== "contracts") { state.view = "contracts"; render(); }
      const s = $(".search input"); if (s) s.focus();
      return;
    }
    if (/^[1-7]$/.test(e.key)) { state.view = SHORTCUT_VIEWS[+e.key - 1]; render(); }
  }

  function buttonEl(label, cls, onClick, title) {
    const b = el("button", { class: cls, title: title || "" }, label);
    b.addEventListener("click", onClick);
    return b;
  }

  /* ============================================================
     CSV
     ============================================================ */
  function exportCSV(list) {
    const data = Array.isArray(list) ? list : db.contracts;
    const csv = core.toCSV(data, db.companies);
    downloadCSV(csv, `契約一覧_${todayStr()}.csv`);
    toast(`CSVをエクスポートしました (${data.length}件)`, "success");
  }

  function downloadTemplate() {
    const csv = core.CSV_HEADERS.join(",") + "\r\n" +
      ["", "株式会社サンプル", "営業部", "Salesforce", "Sales Cloud", "10", "18000", "180000", "2026-04-01", "2027-03-31", "あり", "田中 太郎", "山田 花子", "年額", "メモ"].map(core.csvEscape).join(",");
    downloadCSV(csv, "インポート用テンプレート.csv");
    toast("テンプレートをダウンロードしました", "success");
  }

  function exportBackup() {
    const backup = core.makeBackup(db);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: `契約管理バックアップ_${todayStr()}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("バックアップを保存しました", "success");
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = core.parseBackup(String(reader.result));
        if (!confirm("現在のデータをバックアップ内容で置き換えます。よろしいですか?")) return;
        db.companies = data.companies;
        db.contracts = data.contracts;
        db.products = data.products.length ? data.products : core.defaultProducts();
        db.salesRepsList = data.salesRepsList.length ? data.salesRepsList : core.defaultSalesReps();
        db.plannerRepsList = data.plannerRepsList.length ? data.plannerRepsList : core.defaultPlannerReps();
        db.billingTypes = data.billingTypes.length ? data.billingTypes : core.defaultBillingTypes();
        db.tasks = data.tasks;
        db.companies.forEach((co) => { if (!Array.isArray(co.departments)) co.departments = []; if (!Array.isArray(co.contacts)) co.contacts = []; });
        db.normalizeReps();
        db.save();
        toast(`復元しました (契約${db.contracts.length}件)`, "success");
        render();
      } catch (e) {
        console.error(e);
        toast(e.message || "復元に失敗しました", "error");
      }
    };
    reader.readAsText(file);
  }

  function downloadCSV(csv, filename) {
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function importCSV(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = core.parseCSV(String(reader.result).replace(/^﻿/, ""));
        if (rows.length < 2) { toast("データがありません", "error"); return; }
        const header = rows[0];
        const idx = (name) => header.indexOf(name);
        let added = 0;
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          const get = (name) => { const j = idx(name); return j >= 0 ? (r[j] || "").trim() : ""; };
          const compName = get("企業名");
          if (!compName) continue;
          let co = db.companies.find((x) => x.name === compName);
          if (!co) { co = { id: nextId("co"), name: compName, note: "", departments: [] }; db.companies.push(co); }
          const dept = get("部署");
          if (dept && !co.departments.includes(dept)) co.departments.push(dept);
          const productName = get("製品");
          if (productName && !db.product(productName)) db.products.push({ id: nextId("pr"), name: productName, licenses: [] });
          const lic = get("ライセンス種別");
          const p = db.product(productName);
          if (p && lic && !p.licenses.includes(lic)) p.licenses.push(lic);
          const rep = get("営業担当") || get("担当営業");
          if (rep) db.addRep(db.salesRepsList, rep);
          const planner = get("企画担当");
          if (planner) db.addRep(db.plannerRepsList, planner);
          const contact = get("顧客担当者");
          if (contact && !(co.contacts || []).some((ct) => (typeof ct === "string" ? ct : ct.name) === contact)) { co.contacts = co.contacts || []; co.contacts.push({ name: contact, email: "", phone: "" }); }
          const start = normalizeDate(get("開始日"));
          const year = (start || todayStr()).slice(0, 4);
          db.contracts.push({
            id: nextId("ct"),
            contractNo: get("契約番号") || core.nextContractNo(db.contracts, year),
            companyId: co.id, department: dept, productName, licenseType: lic,
            quantity: Number(get("数量")) || 0, unitPrice: Number(get("単価")) || 0, amount: Number(get("金額")) || 0,
            startDate: start, endDate: normalizeDate(get("終了日")),
            autoRenew: get("自動更新") === "あり", salesRep: rep, plannerRep: planner, customerContact: contact,
            billingType: get("契約形態"), note: get("備考"),
          });
          added++;
        }
        db.save();
        toast(`${added}件をインポートしました`, "success");
        render();
      } catch (e) {
        console.error(e);
        toast("インポートに失敗しました", "error");
      }
    };
    reader.readAsText(file);
  }

  function normalizeDate(s) {
    if (!s) return "";
    const m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/.exec(s);
    if (!m) return "";
    return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
  }

  /* ============================================================
     サンプルデータ
     ============================================================ */
  function seedData() {
    if (db.contracts.length && !confirm("既存データに加えてサンプルを投入しますか?")) return;
    const today = new Date();
    const d = (offsetDays) => core.fmtDateISO(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + offsetDays * 86400000));
    const samples = [
      ["株式会社アルファ商事", "営業本部", "Salesforce", "Sales Cloud", 50, 18000, -300, 65, "田中 太郎", true, "年間契約"],
      ["株式会社アルファ商事", "カスタマーサポート部", "Salesforce", "Service Cloud", 30, 19800, -300, 20, "田中 太郎", false, "更新交渉中"],
      ["ベータテクノロジー株式会社", "情報システム部", "Microsoft 365", "Enterprise E3", 100, 2800, -200, 200, "佐藤 花子", true, ""],
      ["ベータテクノロジー株式会社", "マーケティング部", "Salesforce", "Marketing Cloud Account Engagement", 5, 150000, -100, 15, "佐藤 花子", false, "要更新フォロー"],
      ["ガンマ物流株式会社", "経営企画室", "Salesforce", "CRM Analytics", 10, 90000, -180, -10, "鈴木 一郎", false, "期限切れ・未更新"],
      ["デルタ製作所", "営業推進部", "Google Workspace", "Business Standard", 80, 1360, -90, 280, "田中 太郎", true, ""],
      ["イプシロン銀行", "DX推進部", "Salesforce", "MuleSoft", 8, 250000, -250, 120, "鈴木 一郎", true, "大型案件"],
      ["ゼータ商会", "総務部", "Zoom", "Business", 200, 2700, -30, 340, "高橋 みなみ", true, ""],
      ["イータ工業", "情報システム部", "Adobe", "Creative Cloud コンプリート", 15, 7800, -60, 5, "佐藤 花子", false, "更新確認中"],
      ["シータ食品", "営業部", "Box", "Business Plus", 60, 2500, -120, 95, "高橋 みなみ", true, ""],
    ];
    samples.forEach((s) => {
      let co = db.companies.find((x) => x.name === s[0]);
      if (!co) { co = { id: nextId("co"), name: s[0], note: "", departments: [] }; db.companies.push(co); }
      if (s[1] && !co.departments.includes(s[1])) co.departments.push(s[1]);
      const start = d(s[6]);
      db.contracts.push({
        id: nextId("ct"), contractNo: core.nextContractNo(db.contracts, start.slice(0, 4)),
        companyId: co.id, department: s[1], productName: s[2], licenseType: s[3],
        billingType: s[9] ? "年額" : "月額",
        quantity: s[4], unitPrice: s[5], startDate: start, endDate: d(s[7]),
        salesRep: s[8], autoRenew: s[9], note: s[10],
      });
    });
    db.save();
    toast("サンプルデータを投入しました", "success");
    render();
  }

  /* ============================================================
     初期化
     ============================================================ */
  const THEME_KEY = "keiyaku_theme";
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = $("#btnTheme");
    if (btn) { btn.textContent = theme === "dark" ? "☀" : "🌙"; btn.title = theme === "dark" ? "ライトモード" : "ダークモード"; }
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, cur); } catch (e) { /* noop */ }
    applyTheme(cur);
  }

  const PREFS_KEY = "keiyaku_prefs";
  const KNOWN_VIEWS = ["dashboard", "contracts", "gantt", "tasks", "settings"];
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.view && KNOWN_VIEWS.includes(p.view)) state.view = p.view;
      if (p.filter && typeof p.filter === "object") Object.assign(state.filter, p.filter);
      if (p.sort && p.sort.key) state.sort = { key: p.sort.key, dir: p.sort.dir === "desc" ? "desc" : "asc" };
      if (["day", "month", "year"].includes(p.ganttScale)) state.ganttScale = p.ganttScale;
      if (typeof p.ganttGroup === "boolean") state.ganttGroup = p.ganttGroup;
      if (p.ganttUnits && typeof p.ganttUnits === "object") Object.assign(state.ganttUnits, p.ganttUnits);
      if (typeof p.contractGroup === "boolean") state.contractGroup = p.contractGroup;
      if (p.taskFilter) state.taskFilter = p.taskFilter;
      if (p.companyFilter && typeof p.companyFilter === "object") Object.assign(state.companyFilter, p.companyFilter);
    } catch (e) { /* noop */ }
  }
  function persistPrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        view: state.view, filter: state.filter, sort: state.sort,
        ganttScale: state.ganttScale, ganttGroup: state.ganttGroup, ganttUnits: state.ganttUnits,
        contractGroup: state.contractGroup, taskFilter: state.taskFilter, companyFilter: state.companyFilter,
      }));
    } catch (e) { /* noop */ }
  }

  function init() {
    db.load();
    loadPrefs();
    let savedTheme = "light";
    try { savedTheme = localStorage.getItem(THEME_KEY) || "light"; } catch (e) { /* noop */ }
    applyTheme(savedTheme);
    document.querySelectorAll(".nav-item").forEach((b) =>
      b.addEventListener("click", () => { state.view = b.dataset.view; render(); }));
    $("#modalClose").addEventListener("click", closeModal);
    $("#modalOverlay").addEventListener("click", (e) => { if (e.target.id === "modalOverlay") closeModal(); });
    document.addEventListener("keydown", handleShortcut);
    // データ/バックアップ操作はマスタ管理画面に集約。隠しファイル入力のみ常設。
    $("#importFile").addEventListener("change", (e) => { if (e.target.files[0]) importCSV(e.target.files[0]); e.target.value = ""; });
    $("#restoreFile").addEventListener("change", (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; });
    const themeBtn = $("#btnTheme");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
    periodicBackupCheck();
    try { setInterval(periodicBackupCheck, 3600000); } catch (e) { /* noop */ }
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  global.__app = { db, core, state };
})(typeof window !== "undefined" ? window : globalThis);
