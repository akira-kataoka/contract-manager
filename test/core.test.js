/* 契約管理システム コアロジック単体テスト (依存なし・Nodeで実行) */
const assert = require("assert");
const { core } = require("../app.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.error("  ✗ " + name + "\n      " + e.message); }
}

const TODAY = "2026-06-13";

console.log("\n— parseDate / daysUntil —");
test("parseDate が UTC で解釈される", () => {
  const d = core.parseDate("2026-06-13");
  assert.strictEqual(d.getUTCFullYear(), 2026);
  assert.strictEqual(d.getUTCMonth(), 5);
  assert.strictEqual(d.getUTCDate(), 13);
});
test("parseDate 不正値は null", () => {
  assert.strictEqual(core.parseDate(""), null);
  assert.strictEqual(core.parseDate("abc"), null);
});
test("daysUntil 未来は正", () => assert.strictEqual(core.daysUntil("2026-06-23", TODAY), 10));
test("daysUntil 過去は負", () => assert.strictEqual(core.daysUntil("2026-06-03", TODAY), -10));
test("daysUntil 当日は0", () => assert.strictEqual(core.daysUntil(TODAY, TODAY), 0));

console.log("\n— termEnd —");
test("1年契約は開始日+1年-1日", () => assert.strictEqual(core.termEnd("2026-04-01", 1), "2027-03-31"));
test("3年契約", () => assert.strictEqual(core.termEnd("2026-04-01", 3), "2029-03-31"));
test("うるう年跨ぎ", () => assert.strictEqual(core.termEnd("2024-03-01", 1), "2025-02-28"));
test("開始日なしは空", () => assert.strictEqual(core.termEnd("", 1), ""));

console.log("\n— computeStatus —");
test("終了日が過去 → expired", () =>
  assert.strictEqual(core.computeStatus({ startDate: "2025-01-01", endDate: "2026-06-01" }, TODAY), "expired"));
test("60日以内に終了 → expiring", () =>
  assert.strictEqual(core.computeStatus({ startDate: "2025-01-01", endDate: "2026-07-01" }, TODAY), "expiring"));
test("60日ちょうど → expiring (境界)", () =>
  assert.strictEqual(core.computeStatus({ startDate: "2025-01-01", endDate: "2026-08-12" }, TODAY), "expiring"));
test("61日先 → active (境界外)", () =>
  assert.strictEqual(core.computeStatus({ startDate: "2025-01-01", endDate: "2026-08-13" }, TODAY), "active"));
test("開始日が未来 → upcoming", () =>
  assert.strictEqual(core.computeStatus({ startDate: "2026-07-01", endDate: "2027-07-01" }, TODAY), "upcoming"));
test("終了日なし → active", () =>
  assert.strictEqual(core.computeStatus({ startDate: "2025-01-01", endDate: "" }, TODAY), "active"));
test("statusOverride=cancelled は日付に関わらず解約", () =>
  assert.strictEqual(core.computeStatus({ startDate: "2025-01-01", endDate: "2030-01-01", statusOverride: "cancelled" }, TODAY), "cancelled"));
test("解約契約は金額合計に含めない", () => {
  const cs = [
    { startDate: "2025-01-01", endDate: "2030-01-01", quantity: 1, unitPrice: 100 }, // active 100
    { startDate: "2025-01-01", endDate: "2030-01-01", quantity: 1, unitPrice: 999, statusOverride: "cancelled" }, // 解約 → 除外
  ];
  const s = core.summarize(cs, TODAY);
  assert.strictEqual(s.cancelled, 1);
  assert.strictEqual(s.annualActive, 100);
});

console.log("\n— contractAmount —");
test("単価×数量", () => assert.strictEqual(core.contractAmount({ quantity: 10, unitPrice: 1000 }), 10000));
test("単価未設定は amount を使用", () =>
  assert.strictEqual(core.contractAmount({ quantity: 10, unitPrice: 0, amount: 50000 }), 50000));
test("どちらも空は 0", () => assert.strictEqual(core.contractAmount({}), 0));

console.log("\n— formatYen / formatDate —");
test("formatYen はカンマ区切り", () => assert.strictEqual(core.formatYen(1234567), "¥1,234,567"));
test("formatYen は 0 を扱える", () => assert.strictEqual(core.formatYen(undefined), "¥0"));
test("formatDate スラッシュ区切り", () => assert.strictEqual(core.formatDate("2026-06-13"), "2026/06/13"));
test("formatDate 空は —", () => assert.strictEqual(core.formatDate(""), "—"));

console.log("\n— annualAmount (ARR) —");
test("1年契約は金額そのまま", () =>
  assert.strictEqual(core.annualAmount({ startDate: "2025-01-01", endDate: "2025-12-31", quantity: 1, unitPrice: 365000 }), 365000));
test("2年契約は半分に年額換算", () =>
  assert.strictEqual(core.annualAmount({ startDate: "2025-01-01", endDate: "2026-12-31", quantity: 1, unitPrice: 730000 }), 365000));
test("期間不明は金額そのまま", () =>
  assert.strictEqual(core.annualAmount({ startDate: "", endDate: "", quantity: 2, unitPrice: 1000 }), 2000));

console.log("\n— taxIncluded —");
test("標準税率10%で税込計算", () => assert.strictEqual(core.taxIncluded(180000), 198000));
test("端数は四捨五入", () => assert.strictEqual(core.taxIncluded(1995), 2195)); // 1995*1.1=2194.5→2195
test("税率を指定できる", () => assert.strictEqual(core.taxIncluded(1000, 0.08), 1080));
test("0/未定義は0", () => assert.strictEqual(core.taxIncluded(undefined), 0));

console.log("\n— summarize —");
test("集計が正しい", () => {
  const cs = [
    { startDate: "2025-01-01", endDate: "2026-06-01", quantity: 1, unitPrice: 100 }, // expired
    { startDate: "2025-01-01", endDate: "2026-07-01", quantity: 2, unitPrice: 100 }, // expiring 200
    { startDate: "2025-01-01", endDate: "2027-06-01", quantity: 3, unitPrice: 100 }, // active 300
    { startDate: "2026-07-01", endDate: "2027-07-01", quantity: 9, unitPrice: 100 }, // upcoming
  ];
  const s = core.summarize(cs, TODAY);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.expired, 1);
  assert.strictEqual(s.expiring, 1);
  assert.strictEqual(s.active, 1);
  assert.strictEqual(s.upcoming, 1);
  assert.strictEqual(s.annualActive, 500); // active + expiring のみ
});

console.log("\n— parseTags —");
test("カンマ・読点で分割し重複/空白を除去", () => {
  assert.deepStrictEqual(core.parseTags("重要顧客, アップセル、 重要顧客 ,"), ["重要顧客", "アップセル"]);
});
test("空文字は空配列", () => assert.deepStrictEqual(core.parseTags(""), []));

console.log("\n— filterContracts —");
const companies = [{ id: "co1", name: "アルファ商事" }, { id: "co2", name: "ベータ" }];
const contracts = [
  { companyId: "co1", department: "営業", licenseType: "Sales Cloud", salesRep: "田中", note: "", startDate: "2025-01-01", endDate: "2027-06-01" },
  { companyId: "co2", department: "情シス", licenseType: "Platform", salesRep: "佐藤", note: "", startDate: "2025-01-01", endDate: "2026-06-01" },
];
test("キーワードで企業名検索", () => {
  const r = core.filterContracts(contracts, companies, { keyword: "アルファ", today: TODAY });
  assert.strictEqual(r.length, 1);
});
test("キーワードで担当営業検索", () => {
  const r = core.filterContracts(contracts, companies, { keyword: "佐藤", today: TODAY });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].companyId, "co2");
});
test("状態フィルタ expired", () => {
  const r = core.filterContracts(contracts, companies, { status: "expired", today: TODAY });
  assert.strictEqual(r.length, 1);
});
test("担当フィルタ", () => {
  const r = core.filterContracts(contracts, companies, { rep: "田中", today: TODAY });
  assert.strictEqual(r.length, 1);
});
test("企画担当フィルタ", () => {
  const cs = [
    { companyId: "co1", plannerRep: "山本", startDate: "2025-01-01", endDate: "2027-01-01" },
    { companyId: "co2", plannerRep: "中村", startDate: "2025-01-01", endDate: "2027-01-01" },
  ];
  const r = core.filterContracts(cs, companies, { planner: "中村", today: TODAY });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].companyId, "co2");
});
test("契約形態フィルタ", () => {
  const cs = [
    { companyId: "co1", billingType: "年額", startDate: "2025-01-01", endDate: "2027-01-01" },
    { companyId: "co2", billingType: "月額", startDate: "2025-01-01", endDate: "2027-01-01" },
  ];
  const r = core.filterContracts(cs, companies, { billing: "月額", today: TODAY });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].companyId, "co2");
});
test("タグフィルタ", () => {
  const cs = [
    { companyId: "co1", tags: ["重要顧客"], startDate: "2025-01-01", endDate: "2027-01-01" },
    { companyId: "co2", tags: ["新規"], startDate: "2025-01-01", endDate: "2027-01-01" },
  ];
  const r = core.filterContracts(cs, companies, { tag: "重要顧客", today: TODAY });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].companyId, "co1");
});

console.log("\n— sortContracts —");
test("金額降順", () => {
  const cs = [
    { companyId: "a", quantity: 1, unitPrice: 100 },
    { companyId: "b", quantity: 5, unitPrice: 100 },
  ];
  const r = core.sortContracts(cs, [], "amount", "desc", TODAY);
  assert.strictEqual(r[0].companyId, "b");
});
test("終了日昇順", () => {
  const cs = [
    { companyId: "a", endDate: "2027-01-01" },
    { companyId: "b", endDate: "2026-01-01" },
  ];
  const r = core.sortContracts(cs, [], "endDate", "asc", TODAY);
  assert.strictEqual(r[0].companyId, "b");
});

console.log("\n— repRanking —");
test("営業担当ごとに金額降順で集計し主な製品を出す", () => {
  const cs = [
    { salesRep: "田中", productName: "Salesforce", quantity: 1, unitPrice: 1000, startDate: "2025-01-01", endDate: "2030-01-01" },
    { salesRep: "田中", productName: "Salesforce", quantity: 1, unitPrice: 1000, startDate: "2025-01-01", endDate: "2030-01-01" },
    { salesRep: "佐藤", productName: "Box", quantity: 1, unitPrice: 5000, startDate: "2025-01-01", endDate: "2030-01-01" },
  ];
  const r = core.repRanking(cs, TODAY);
  assert.strictEqual(r[0].name, "佐藤"); // 金額5000で1位
  assert.strictEqual(r[1].name, "田中");
  assert.strictEqual(r[1].count, 2);
  assert.ok(r[1].topProducts[0].startsWith("Salesforce"));
  assert.strictEqual(r[1].status.active, 2);
});

console.log("\n— totals —");
test("件数・金額合計・税込を返す", () => {
  const cs = [
    { quantity: 10, unitPrice: 1000 }, // 10000
    { quantity: 2, unitPrice: 5000 }, // 10000
  ];
  const t = core.totals(cs);
  assert.strictEqual(t.count, 2);
  assert.strictEqual(t.amount, 20000);
  assert.strictEqual(t.taxIncluded, 22000);
});
test("空配列は0", () => {
  const t = core.totals([]);
  assert.strictEqual(t.count, 0);
  assert.strictEqual(t.amount, 0);
});

console.log("\n— addActivity —");
test("新しいメモを先頭に追加", () => {
  let list = [];
  list = core.addActivity(list, "初回連絡", "2026/06/13 10:00");
  list = core.addActivity(list, "見積提示", "2026/06/14 09:00");
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].text, "見積提示"); // 新しい順
  assert.strictEqual(list[1].text, "初回連絡");
});
test("空文字は追加しない", () => {
  const list = core.addActivity([{ at: "x", text: "a" }], "  ", "2026/06/13");
  assert.strictEqual(list.length, 1);
});
test("元配列を破壊しない", () => {
  const orig = [{ at: "x", text: "a" }];
  const list = core.addActivity(orig, "b", "y");
  assert.strictEqual(orig.length, 1);
  assert.strictEqual(list.length, 2);
});

console.log("\n— statusBreakdown —");
test("ステータスごとの件数と割合", () => {
  const cs = [
    { startDate: "2025-01-01", endDate: "2030-01-01" }, // active
    { startDate: "2025-01-01", endDate: "2030-01-01" }, // active
    { startDate: "2025-01-01", endDate: "2026-06-01" }, // expired
    { startDate: "2025-01-01", endDate: "2030-01-01", statusOverride: "cancelled" }, // cancelled
  ];
  const b = core.statusBreakdown(cs, TODAY);
  const active = b.find((x) => x.status === "active");
  assert.strictEqual(active.count, 2);
  assert.strictEqual(active.pct, 50);
  assert.strictEqual(b.find((x) => x.status === "cancelled").count, 1);
  assert.strictEqual(b.length, 5);
});

console.log("\n— fiscalYear / byFiscalYear —");
test("4月始まり: 3月は前年度", () => assert.strictEqual(core.fiscalYear("2026-03-31"), 2025));
test("4月始まり: 4月は当年度", () => assert.strictEqual(core.fiscalYear("2026-04-01"), 2026));
test("開始月を指定できる(1月始まり)", () => assert.strictEqual(core.fiscalYear("2026-03-31", 1), 2026));
test("会計年度ごとに集計", () => {
  const cs = [
    { startDate: "2025-05-01", quantity: 1, unitPrice: 100 }, // FY2025
    { startDate: "2026-03-01", quantity: 1, unitPrice: 200 }, // FY2025
    { startDate: "2026-04-01", quantity: 1, unitPrice: 300 }, // FY2026
  ];
  const r = core.byFiscalYear(cs, 4);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].fy, 2025);
  assert.strictEqual(r[0].amount, 300);
  assert.strictEqual(r[1].fy, 2026);
  assert.strictEqual(r[1].amount, 300);
});

console.log("\n— forecastByMonth —");
test("月数分のバケットを返す", () => {
  const r = core.forecastByMonth([], TODAY, 6);
  assert.strictEqual(r.length, 6);
  assert.strictEqual(r[0].ym, "2026-06");
  assert.strictEqual(r[1].ym, "2026-07");
});
test("終了月ごとに件数と金額を集計", () => {
  const cs = [
    { endDate: "2026-06-30", quantity: 2, unitPrice: 100 }, // 当月 200
    { endDate: "2026-07-15", quantity: 1, unitPrice: 500 }, // 翌月 500
    { endDate: "2026-07-20", quantity: 3, unitPrice: 100 }, // 翌月 300
    { endDate: "2026-12-01", quantity: 9, unitPrice: 100 }, // 範囲外(3ヶ月)
  ];
  const r = core.forecastByMonth(cs, TODAY, 3);
  assert.strictEqual(r[0].count, 1);
  assert.strictEqual(r[0].amount, 200);
  assert.strictEqual(r[1].count, 2);
  assert.strictEqual(r[1].amount, 800);
  assert.strictEqual(r[2].count, 0);
});
test("年跨ぎでも正しい月キー", () => {
  const r = core.forecastByMonth([], "2026-11-01", 3);
  assert.deepStrictEqual(r.map((b) => b.ym), ["2026-11", "2026-12", "2027-01"]);
});

console.log("\n— renewalEmail —");
test("件名に企業名と製品/ライセンスを含む", () => {
  const m = core.renewalEmail({ productName: "Salesforce", licenseType: "Sales Cloud", contractNo: "C-2026-0001" }, "アルファ商事", "田中");
  assert.ok(m.subject.includes("アルファ商事"));
  assert.ok(m.subject.includes("Sales Cloud"));
});
test("本文に契約番号・期間・宛名を含む", () => {
  const m = core.renewalEmail({ productName: "Salesforce", licenseType: "Sales Cloud", contractNo: "C-2026-0001", quantity: 10, startDate: "2026-01-01", endDate: "2026-12-31" }, "アルファ商事", "田中");
  assert.ok(m.body.includes("C-2026-0001"));
  assert.ok(m.body.includes("2026/01/01"));
  assert.ok(m.body.includes("田中 様"));
});
test("担当者未設定は『ご担当者様』", () => {
  const m = core.renewalEmail({ productName: "Box", licenseType: "Business" }, "ベータ", "");
  assert.ok(m.body.includes("ご担当者様"));
});

console.log("\n— renewalCopy —");
test("複製は翌日開始で同じ期間長", () => {
  const c = { companyId: "co1", licenseType: "Sales Cloud", quantity: 5, unitPrice: 1000, startDate: "2025-04-01", endDate: "2026-03-31" };
  const r = core.renewalCopy(c);
  assert.strictEqual(r.startDate, "2026-04-01"); // 旧終了日の翌日
  assert.strictEqual(r.endDate, "2027-03-31"); // 同じ期間長(364日)
  assert.strictEqual(r.licenseType, "Sales Cloud");
  assert.strictEqual(r.quantity, 5);
  assert.ok(!("id" in r), "id は持たない");
});
test("複製は元データを破壊しない", () => {
  const c = { startDate: "2025-01-01", endDate: "2025-12-31", quantity: 3 };
  const r = core.renewalCopy(c);
  assert.strictEqual(c.startDate, "2025-01-01");
  assert.notStrictEqual(r.startDate, c.startDate);
});
test("期間未設定なら日付は空", () => {
  const r = core.renewalCopy({ companyId: "x", licenseType: "Platform" });
  assert.strictEqual(r.startDate, "");
  assert.strictEqual(r.endDate, "");
});

console.log("\n— ganttRange / ganttBar —");
test("ganttRange は before+after+1 ヶ月を返す", () => {
  const r = core.ganttRange(TODAY, 2, 12);
  assert.strictEqual(r.months.length, 15);
  assert.strictEqual(r.months[0].ym, "2026-04"); // 2ヶ月前
  assert.strictEqual(r.months[2].ym, "2026-06"); // 当月
});
test("ganttBar 範囲内はバーを返す", () => {
  const r = core.ganttRange(TODAY, 1, 1); // 2026-05-01 〜 2026-08-01
  const bar = core.ganttBar({ startDate: "2026-06-01", endDate: "2026-07-01" }, r.startStr, r.endStr);
  assert.strictEqual(bar.visible, true);
  assert.ok(bar.leftPct > 0 && bar.leftPct < 100);
  assert.ok(bar.widthPct > 0);
});
test("ganttBar 範囲外は visible:false", () => {
  const r = core.ganttRange(TODAY, 1, 1);
  const bar = core.ganttBar({ startDate: "2030-01-01", endDate: "2030-02-01" }, r.startStr, r.endStr);
  assert.strictEqual(bar.visible, false);
});
test("datePct は範囲中央付近を返す", () => {
  const pct = core.datePct("2026-06-16", "2026-06-01", "2026-07-01");
  assert.ok(pct > 40 && pct < 60);
});

console.log("\n— ganttAxis —");
test("month スケールは月見出しと年バンドを持つ", () => {
  const a = core.ganttAxis("month", TODAY);
  assert.strictEqual(a.scale, "month");
  assert.ok(a.ticks.length >= 12);
  assert.ok(a.ticks.find((t) => t.label === "1月" && t.major), "1月が major");
  assert.ok(a.groups.some((g) => /年$/.test(g.label)), "年バンドがある");
});
test("day スケールは月スケールより目盛りが細かく曜日を持つ", () => {
  const d = core.ganttAxis("day", TODAY);
  const m = core.ganttAxis("month", TODAY);
  assert.strictEqual(d.scale, "day");
  assert.ok(d.ticks.length > m.ticks.length);
  assert.ok(d.ticks.every((t) => t.sub && t.sub.length === 1), "各目盛りに曜日");
  assert.ok(d.ticks.some((t) => t.weekend), "週末フラグがある");
});
test("不正スケールは month に正規化", () => {
  assert.strictEqual(core.ganttAxis("week", TODAY).scale, "month");
});
test("year スケールは4年分の年バンドを持つ", () => {
  const y = core.ganttAxis("year", TODAY);
  assert.strictEqual(y.scale, "year");
  assert.strictEqual(y.groups.length, 4);
  assert.ok(y.groups.every((g) => /^\d{4}年$/.test(g.label)));
});

console.log("\n— suggestRenewalTasks —");
test("更新間近/期限切れの契約からタスク草案を生成", () => {
  const cs = [
    { id: "c1", startDate: "2025-01-01", endDate: "2026-07-01", licenseType: "Sales Cloud" }, // expiring
    { id: "c2", startDate: "2025-01-01", endDate: "2026-06-01", licenseType: "Platform" }, // expired
    { id: "c3", startDate: "2025-01-01", endDate: "2030-01-01", licenseType: "Service Cloud" }, // active → 対象外
  ];
  const drafts = core.suggestRenewalTasks(cs, TODAY, []);
  assert.strictEqual(drafts.length, 2);
  assert.ok(drafts[0].title.includes("更新"));
});
test("既存タスクのある契約は除外", () => {
  const cs = [{ id: "c1", startDate: "2025-01-01", endDate: "2026-07-01", licenseType: "Sales Cloud" }];
  assert.strictEqual(core.suggestRenewalTasks(cs, TODAY, ["c1"]).length, 0);
});

console.log("\n— findDuplicates —");
test("同一企業×製品×ライセンスで期間が重なると重複検知", () => {
  const cs = [
    { id: "a", companyId: "co1", productName: "Salesforce", licenseType: "Sales Cloud", startDate: "2026-01-01", endDate: "2026-12-31" },
    { id: "b", companyId: "co1", productName: "Salesforce", licenseType: "Sales Cloud", startDate: "2026-06-01", endDate: "2027-05-31" },
  ];
  const d = core.findDuplicates(cs);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].length, 2);
});
test("期間が重ならなければ重複ではない", () => {
  const cs = [
    { id: "a", companyId: "co1", productName: "Salesforce", licenseType: "Sales Cloud", startDate: "2025-01-01", endDate: "2025-12-31" },
    { id: "b", companyId: "co1", productName: "Salesforce", licenseType: "Sales Cloud", startDate: "2026-01-01", endDate: "2026-12-31" },
  ];
  assert.strictEqual(core.findDuplicates(cs).length, 0);
});
test("製品/ライセンスが異なれば重複ではない", () => {
  const cs = [
    { id: "a", companyId: "co1", productName: "Salesforce", licenseType: "Sales Cloud", startDate: "2026-01-01", endDate: "2026-12-31" },
    { id: "b", companyId: "co1", productName: "Salesforce", licenseType: "Service Cloud", startDate: "2026-01-01", endDate: "2026-12-31" },
  ];
  assert.strictEqual(core.findDuplicates(cs).length, 0);
});
test("periodsOverlap 境界(隣接日)も重なり扱い", () => {
  assert.strictEqual(core.periodsOverlap({ startDate: "2026-01-01", endDate: "2026-06-30" }, { startDate: "2026-06-30", endDate: "2026-12-31" }), true);
  assert.strictEqual(core.periodsOverlap({ startDate: "2026-01-01", endDate: "2026-06-29" }, { startDate: "2026-06-30", endDate: "2026-12-31" }), false);
});

console.log("\n— nextContractNo —");
test("初回は 0001", () => assert.strictEqual(core.nextContractNo([], "2026"), "C-2026-0001"));
test("既存の最大+1", () => {
  const cs = [{ contractNo: "C-2026-0001" }, { contractNo: "C-2026-0007" }, { contractNo: "C-2025-0099" }];
  assert.strictEqual(core.nextContractNo(cs, "2026"), "C-2026-0008");
});

console.log("\n— マスタ既定値 —");
test("既定製品に Salesforce と Microsoft 365 を含む", () => {
  const names = core.defaultProducts().map((p) => p.name);
  assert.ok(names.includes("Salesforce"));
  assert.ok(names.includes("Microsoft 365"));
});
test("既定の契約形態に年額/月額/従量課金を含む", () => {
  const b = core.defaultBillingTypes();
  ["年額", "月額", "従量課金"].forEach((t) => assert.ok(b.includes(t), t + " が無い"));
});

console.log("\n— バックアップ —");
test("makeBackup → parseBackup でラウンドトリップ", () => {
  const data = { companies: [{ id: "co1", name: "A" }], contracts: [{ id: "c1" }, { id: "c2" }], products: [{ id: "p", name: "X", licenses: [] }], salesRepsList: ["田中"], tasks: [{ id: "t1" }] };
  const backup = core.makeBackup(data);
  assert.strictEqual(backup.app, "keiyaku-kanri");
  const text = JSON.stringify(backup);
  const parsed = core.parseBackup(text);
  assert.strictEqual(parsed.contracts.length, 2);
  assert.strictEqual(parsed.companies[0].name, "A");
  assert.strictEqual(parsed.salesRepsList[0], "田中");
  assert.strictEqual(parsed.tasks.length, 1);
});
test("data 直書きの形式も解析できる", () => {
  const parsed = core.parseBackup(JSON.stringify({ companies: [{ id: "x" }], contracts: [] }));
  assert.strictEqual(parsed.companies.length, 1);
});
test("不正JSONは例外", () => {
  assert.throws(() => core.parseBackup("{壊れた"));
});
test("配列を欠く形式は例外", () => {
  assert.throws(() => core.parseBackup(JSON.stringify({ foo: 1 })));
});

console.log("\n— CSV ラウンドトリップ —");
test("toCSV → parseCSV で値が保たれる (契約番号・製品を含む)", () => {
  const cs = [{ contractNo: "C-2026-0001", companyId: "co1", department: "営, 業", productName: "Salesforce", licenseType: 'Sales "Cloud"', quantity: 10, unitPrice: 1000, startDate: "2026-01-01", endDate: "2026-12-31", autoRenew: true, salesRep: "田中\n太郎", note: "備考" }];
  const csv = core.toCSV(cs, companies);
  const rows = core.parseCSV(csv);
  assert.strictEqual(rows.length, 2); // header + 1
  assert.deepStrictEqual(rows[0].slice(0, 5), ["契約番号", "企業名", "部署", "製品", "ライセンス種別"]);
  assert.strictEqual(rows[1][0], "C-2026-0001");
  assert.strictEqual(rows[1][1], "アルファ商事");
  assert.strictEqual(rows[1][2], "営, 業"); // カンマ含む
  assert.strictEqual(rows[1][3], "Salesforce");
  assert.strictEqual(rows[1][4], 'Sales "Cloud"'); // クォート含む
  assert.strictEqual(rows[1][10], "あり"); // 自動更新
  assert.strictEqual(rows[1][11], "田中\n太郎"); // 改行含む(担当営業)
});
test("parseCSV 空行は除去", () => {
  const rows = core.parseCSV("a,b\n\n1,2\n");
  assert.strictEqual(rows.length, 2);
});

console.log(`\n結果: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
