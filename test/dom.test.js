/* 動的テスト: jsdom で実際に index.html を読み込み、UI を操作して検証 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.error("  ✗ " + name + "\n      " + (e.stack || e.message)); }
}
function waitLoaded(window) {
  return new Promise((resolve) => {
    if (window.document.readyState !== "loading") resolve();
    else window.document.addEventListener("DOMContentLoaded", () => resolve());
  });
}

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

// script タグを除いた HTML を読み込み、app.js は window スコープで eval する
// (こうすると bare な localStorage / document / setTimeout が window のものに解決される)
const htmlNoScript = html.replace(/<script[^>]*><\/script>/g, "");
const dom = new JSDOM(htmlNoScript, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
const { window } = dom;
window.confirm = () => true;
window.alert = () => {};
window.prompt = () => "テスト企業";
window.URL.createObjectURL = () => "blob:mock";
window.URL.revokeObjectURL = () => {};

// app.js を window のグローバルスコープで実行 (DOMContentLoaded 後に init() が走る)
window.eval(appJs);

const doc = window.document;

(async function main() {
await waitLoaded(window);
const app = window.__app;

console.log("\n— CSS 表示制御 (回帰) —");
test("モーダルは hidden 属性で確実に非表示 (display:flex に上書きされない)", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  assert.ok(/\.modal-overlay\[hidden\]\s*\{\s*display:\s*none/.test(css),
    ".modal-overlay[hidden]{display:none} の明示が必要 (display:flex が [hidden] を上書きするため)");
});
test("起動直後はモーダルが閉じている", () => {
  assert.strictEqual(doc.querySelector("#modalOverlay").hasAttribute("hidden"), true);
});

console.log("\n— 初期描画 —");
test("初期ビューはダッシュボード", () => {
  assert.ok(doc.querySelector("#pageTitle").textContent.includes("ダッシュボード"));
});
test("ダッシュボードは全体/有効契約/アラートの3セクション", () => {
  const titles = [...doc.querySelectorAll("#content .section-title")].map((s) => s.textContent);
  assert.ok(titles.includes("全体"), "全体セクション");
  assert.ok(titles.includes("有効契約"), "有効契約セクション");
  assert.ok(titles.includes("アラート"), "アラートセクション");
});
test("全体に累計KPIがある", () => {
  const txt = doc.querySelector("#content").textContent;
  assert.ok(txt.includes("累計契約金額"));
  assert.ok(txt.includes("累計契約数"));
  assert.ok(txt.includes("累計契約企業数"));
});
test("重複の疑いパネルは廃止されている", () => {
  assert.ok(!doc.querySelector("#content").textContent.includes("重複の疑い"));
});

console.log("\n— ナビゲーション —");
test("契約一覧へ遷移できる", () => {
  doc.querySelector('.nav-item[data-view="contracts"]').click();
  assert.ok(doc.querySelector("#pageTitle").textContent.includes("契約一覧"));
});
test("空状態が表示される", () => {
  assert.ok(doc.querySelector("#content").textContent.includes("該当する契約がありません"));
});

console.log("\n— データ操作 (programmatic) —");
test("企業と契約を追加すると一覧に出る", () => {
  const { db, core } = app;
  const co = { id: "co_test", name: "テスト商事", note: "" };
  db.companies.push(co);
  db.contracts.push({
    id: "ct_test", companyId: "co_test", department: "営業部", licenseType: "Sales Cloud",
    quantity: 10, unitPrice: 18000, startDate: "2026-01-01", endDate: "2099-12-31",
    salesRep: "山田 太郎", autoRenew: true, note: "",
  });
  db.save();
  // 再描画
  doc.querySelector('.nav-item[data-view="dashboard"]').click();
  doc.querySelector('.nav-item[data-view="contracts"]').click();
  const body = doc.querySelector("#contractTableBody");
  assert.ok(body.textContent.includes("テスト商事"));
  assert.ok(body.textContent.includes("山田 太郎"));
  assert.ok(body.textContent.includes("¥180,000"));
});

test("localStorage に永続化されている", () => {
  const raw = window.localStorage.getItem("keiyaku_kanri_v1");
  assert.ok(raw, "保存データが存在する");
  const d = JSON.parse(raw);
  assert.strictEqual(d.contracts.length, 1);
  assert.strictEqual(d.companies.length, 1);
});

console.log("\n— 合計フッター —");
test("契約一覧に合計フッターが表示される", () => {
  doc.querySelector('.nav-item[data-view="dashboard"]').click();
  doc.querySelector('.nav-item[data-view="contracts"]').click();
  const search = doc.querySelector(".search input");
  search.value = "";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const foot = doc.querySelector("#contractTableBody .table-total");
  assert.ok(foot, "合計フッターがある");
  assert.ok(foot.textContent.includes("金額合計"));
  assert.ok(foot.textContent.includes("件"));
});

console.log("\n— 検索フィルタ (UI) —");
test("検索ボックスで絞り込める", () => {
  const input = doc.querySelector(".search input");
  input.value = "存在しない企業XYZ";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.ok(doc.querySelector("#contractTableBody").textContent.includes("該当する契約がありません"));
  // 戻す
  input.value = "テスト";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.ok(doc.querySelector("#contractTableBody").textContent.includes("テスト商事"));
});

console.log("\n— ダッシュボードのアラート統合 —");
test("期限切れ契約がダッシュボードの対応が必要な契約に出る", () => {
  const { db } = app;
  db.contracts.push({
    id: "ct_exp", companyId: "co_test", department: "経理部", productName: "Salesforce", licenseType: "Platform",
    quantity: 5, unitPrice: 12000, startDate: "2024-01-01", endDate: "2025-01-01",
    salesRep: "鈴木", autoRenew: false, note: "",
  });
  db.save();
  doc.querySelector('.nav-item[data-view="dashboard"]').click();
  const txt = doc.querySelector("#content").textContent;
  assert.ok(txt.includes("対応が必要な契約"));
  assert.ok(txt.includes("テスト商事"), "期限切れ契約の企業が表示される");
});

console.log("\n— モーダル —");
test("契約追加モーダルが開く", () => {
  doc.querySelector('.nav-item[data-view="contracts"]').click();
  const addBtn = [...doc.querySelectorAll("#topbarActions .btn")].find((b) => b.textContent.includes("追加"));
  addBtn.click();
  assert.strictEqual(doc.querySelector("#modalOverlay").hidden, false);
  assert.ok(doc.querySelector("#modalTitle").textContent.includes("契約を追加"));
  // 担当営業フィールドが存在
  assert.ok(doc.querySelector("#f_rep"), "担当営業入力欄がある");
  // 契約形態・検索可能な製品/ライセンス入力
  assert.ok(doc.querySelector("#f_billing"), "契約形態フィールドがある");
  assert.ok(doc.querySelector("#f_product") && doc.querySelector("#prodlist"), "製品が datalist 検索対応");
  assert.ok(doc.querySelector("#f_license") && doc.querySelector("#liclist"), "ライセンスが datalist 検索対応");
});
test("開始日入力で終了日が自動補完される", () => {
  const start = doc.querySelector("#f_start");
  const end = doc.querySelector("#f_end");
  end.value = "";
  start.value = "2026-04-01";
  start.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.strictEqual(end.value, "2027-03-31");
});
test("期間プリセット(3年)で終了日が設定される", () => {
  const start = doc.querySelector("#f_start");
  start.value = "2026-04-01";
  const btn3 = [...doc.querySelectorAll(".term-presets .chip-btn")].find((b) => b.textContent === "3年");
  assert.ok(btn3, "3年プリセットがある");
  btn3.click();
  assert.strictEqual(doc.querySelector("#f_end").value, "2029-03-31");
});
test("必須未入力で登録するとバリデーションエラー", () => {
  const submit = [...doc.querySelectorAll("#modalFoot .btn")].find((b) => b.textContent === "登録");
  submit.click();
  // モーダルは閉じない (エラーのため)
  assert.strictEqual(doc.querySelector("#modalOverlay").hidden, false);
  assert.ok(doc.querySelector("#modalBody .field.invalid"), "invalid クラスが付与される");
});

console.log("\n— 複製して更新 —");
test("詳細から複製すると新規契約モーダルが期間更新済みで開く", () => {
  doc.querySelector("#modalClose").click();
  const before = app.db.contracts.length;
  // 検索条件をクリアして全件表示
  const search = doc.querySelector(".search input");
  search.value = "Sales Cloud";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  doc.querySelector('.nav-item[data-view="contracts"]').click();
  search.value = "Sales Cloud";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  // Sales Cloud (ct_test, 終了日 2099-12-31) の行の詳細ボタンを押す
  const targetRow = [...doc.querySelectorAll("#contractTableBody tbody tr")].find((tr) => tr.textContent.includes("Sales Cloud"));
  assert.ok(targetRow, "対象行が見つかる");
  [...targetRow.querySelectorAll(".row-actions button")].find((b) => b.title === "詳細").click();
  const dupBtn = [...doc.querySelectorAll("#modalFoot .btn")].find((b) => b.textContent === "複製して更新");
  assert.ok(dupBtn, "複製して更新ボタンがある");
  dupBtn.click();
  assert.ok(doc.querySelector("#modalTitle").textContent.includes("契約を追加"), "新規追加モードで開く");
  // 元 ct_test は endDate 2099-12-31 → 翌日開始
  assert.strictEqual(doc.querySelector("#f_start").value, "2100-01-01");
  assert.strictEqual(app.db.contracts.length, before, "まだ保存はされていない");
  doc.querySelector("#modalClose").click();
});

console.log("\n— 新ビュー (タイムライン/マスタ管理) —");
test("タイムラインビューがガントを描画する", () => {
  doc.querySelector("#modalClose").click();
  doc.querySelector('.nav-item[data-view="gantt"]').click();
  assert.ok(doc.querySelector("#pageTitle").textContent.includes("タイムライン"));
  assert.ok(doc.querySelector(".gantt"), "ガント要素が描画される");
  assert.ok(doc.querySelector(".gantt-bar"), "契約バーが少なくとも1本ある");
});
test("マスタ管理に既定製品が表示される", () => {
  doc.querySelector('.nav-item[data-view="settings"]').click();
  const txt = doc.querySelector("#content").textContent;
  assert.ok(txt.includes("製品・ライセンス"));
  assert.ok(txt.includes("Salesforce"));
  assert.ok(txt.includes("営業担当"));
  assert.ok(txt.includes("企画担当"));
});
test("ガントのスケール切替(日/月/年)が効く", () => {
  doc.querySelector('.nav-item[data-view="gantt"]').click();
  const segBtns = [...doc.querySelectorAll(".segmented .seg-btn")];
  assert.strictEqual(segBtns.length, 3);
  const dayBtn = segBtns.find((b) => b.textContent === "日");
  dayBtn.click();
  assert.ok(doc.querySelector(".gantt.gantt-day"), "日スケールが適用される");
  assert.strictEqual(app.state.ganttScale, "day");
});

console.log("\n— 更新タスク —");
test("自動生成で期限切れ契約のタスクが作られる", () => {
  doc.querySelector('.nav-item[data-view="tasks"]').click();
  const before = app.db.tasks.length;
  const gen = [...doc.querySelectorAll("#topbarActions button")].find((b) => b.textContent.includes("自動生成"));
  assert.ok(gen, "自動生成ボタンがある");
  gen.click();
  assert.ok(app.db.tasks.length > before, "タスクが生成された");
  assert.ok(doc.querySelector("#content").textContent.includes("更新"));
});
test("タスクのチェックで完了に切り替わる", () => {
  const chk = doc.querySelector("#content tbody input[type=checkbox]");
  assert.ok(chk, "チェックボックスがある");
  chk.checked = true;
  chk.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.ok(app.db.tasks.some((t) => t.status === "done"), "完了タスクが存在する");
});
test("ナビにタスクバッジが表示される", () => {
  // 未完了タスクを1件残す
  app.db.tasks.push({ id: "tk_x", title: "残タスク", status: "open", dueDate: "", assignee: "", contractId: null });
  app.db.save();
  app.state.view = "dashboard";
  doc.querySelector('.nav-item[data-view="dashboard"]').click();
  const badge = doc.querySelector("#navTaskBadge");
  assert.ok(badge && !badge.hidden, "タスクバッジが表示される");
});

console.log("\n— 契約番号 自動採番 —");
test("新規契約に契約番号が自動付与される", () => {
  const { db, core } = app;
  const before = db.contracts.length;
  const year = "2026";
  db.contracts.push({
    id: "ct_no", contractNo: core.nextContractNo(db.contracts, year),
    companyId: "co_test", productName: "Salesforce", licenseType: "Sales Cloud",
    quantity: 1, unitPrice: 1000, startDate: "2026-04-01", endDate: "2027-03-31",
    salesRep: "", autoRenew: false, note: "",
  });
  db.save();
  assert.strictEqual(db.contracts.length, before + 1);
  assert.ok(/^C-2026-\d{4}$/.test(db.contracts[db.contracts.length - 1].contractNo));
});

console.log("\n— 絞り込み結果のCSV出力 —");
test("契約一覧の CSV出力 ボタンが絞り込み結果を書き出す", () => {
  doc.querySelector("#modalClose").click();
  doc.querySelector('.nav-item[data-view="contracts"]').click();
  // 検索をクリア
  const search = doc.querySelector(".search input");
  search.value = "";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const btn = [...doc.querySelectorAll(".toolbar button")].find((b) => b.textContent === "CSV出力");
  assert.ok(btn, "CSV出力ボタンがある");
  let clicked = false;
  const origCreate = doc.createElement.bind(doc);
  doc.createElement = function (tag) { const n = origCreate(tag); if (tag === "a") n.click = () => { clicked = true; }; return n; };
  btn.click();
  doc.createElement = origCreate;
  assert.ok(clicked, "ダウンロードがトリガーされる");
});

console.log("\n— 企業詳細 —");
test("企業詳細にその企業の契約一覧と合計が表示される", () => {
  doc.querySelector("#modalClose").click();
  doc.querySelector('.nav-item[data-view="companies"]').click();
  const detailBtn = [...doc.querySelectorAll("#content .row-actions button")].find((b) => b.title === "詳細");
  assert.ok(detailBtn, "企業の詳細ボタンがある");
  detailBtn.click();
  const body = doc.querySelector("#modalBody");
  assert.ok(body.textContent.includes("契約一覧"));
  assert.ok(body.textContent.includes("金額合計"));
  doc.querySelector("#modalClose").click();
});

console.log("\n— キーボードショートカット —");
test("数字キーでビュー切替", () => {
  doc.querySelector("#modalClose").click();
  doc.querySelector('.nav-item[data-view="dashboard"]').click();
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "3", bubbles: true }));
  assert.strictEqual(app.state.view, "gantt");
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "1", bubbles: true }));
  assert.strictEqual(app.state.view, "dashboard");
});
test("n キーで新規契約モーダルが開く", () => {
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "n", bubbles: true }));
  assert.strictEqual(doc.querySelector("#modalOverlay").hidden, false);
  assert.ok(doc.querySelector("#modalTitle").textContent.includes("契約を追加"));
  doc.querySelector("#modalClose").click();
});
test("モーダル表示中はショートカット無効", () => {
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "n", bubbles: true }));
  const before = app.state.view;
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "4", bubbles: true }));
  assert.strictEqual(app.state.view, before, "モーダル中は数字キーが効かない");
  doc.querySelector("#modalClose").click();
});

console.log("\n— 表示設定の永続化 —");
test("画面とガント設定が localStorage に保存される", () => {
  doc.querySelector("#modalClose").click();
  doc.querySelector('.nav-item[data-view="settings"]').click();
  let prefs = JSON.parse(window.localStorage.getItem("keiyaku_prefs"));
  assert.strictEqual(prefs.view, "settings");
  doc.querySelector('.nav-item[data-view="gantt"]').click();
  const dayBtn = [...doc.querySelectorAll(".segmented .seg-btn")].find((b) => b.textContent === "日");
  dayBtn.click();
  prefs = JSON.parse(window.localStorage.getItem("keiyaku_prefs"));
  assert.strictEqual(prefs.view, "gantt");
  assert.strictEqual(prefs.ganttScale, "day");
});

console.log("\n— ダークモード —");
test("テーマ切替で data-theme と localStorage が変わる", () => {
  const btn = doc.querySelector("#btnTheme");
  assert.ok(btn, "テーマボタンがある");
  btn.click();
  assert.strictEqual(doc.documentElement.getAttribute("data-theme"), "dark");
  assert.strictEqual(window.localStorage.getItem("keiyaku_theme"), "dark");
  assert.ok(btn.textContent.includes("ライト"), "ラベルが切り替わる");
  btn.click();
  assert.strictEqual(doc.documentElement.getAttribute("data-theme"), "light");
});

console.log("\n— 活動メモ —");
test("契約詳細でメモを追加すると履歴に表示される", () => {
  doc.querySelector("#modalClose").click();
  doc.querySelector('.nav-item[data-view="contracts"]').click();
  const search = doc.querySelector(".search input");
  search.value = ""; search.dispatchEvent(new window.Event("input", { bubbles: true }));
  const detailBtn = [...doc.querySelectorAll("#contractTableBody .row-actions button")].find((b) => b.title === "詳細");
  detailBtn.click();
  const inp = doc.querySelector(".activity-add input");
  assert.ok(inp, "メモ入力欄がある");
  inp.value = "更新交渉中：見積提示済み";
  [...doc.querySelectorAll("#modalFoot .btn")]; // no-op
  const addBtn = [...doc.querySelectorAll(".activity-add button")].find((b) => b.textContent === "追加");
  addBtn.click();
  assert.ok(doc.querySelector("#modalBody .activity-item"), "活動メモ項目が表示される");
  assert.ok(doc.querySelector("#modalBody").textContent.includes("見積提示済み"));
});

console.log("\n— 行ハイライト —");
test("期限切れ契約の行に row-expired クラスが付く", () => {
  doc.querySelector("#modalClose").click();
  doc.querySelector('.nav-item[data-view="contracts"]').click();
  const search = doc.querySelector(".search input");
  search.value = ""; search.dispatchEvent(new window.Event("input", { bubbles: true }));
  // ct_exp (Platform, 終了 2025-01-01) は期限切れ
  const rows = [...doc.querySelectorAll("#contractTableBody tbody tr")];
  assert.ok(rows.some((r) => r.classList.contains("row-expired")), "期限切れ行がハイライトされる");
});

console.log("\n— ステータス構成バー —");
test("ダッシュボードにステータス構成バーが描画される", () => {
  doc.querySelector("#modalClose").click();
  // この時点で契約は複数存在する
  doc.querySelector('.nav-item[data-view="dashboard"]').click();
  assert.ok(doc.querySelector("#content").textContent.includes("契約ステータス"));
  assert.ok(doc.querySelector(".stack-bar"), "積み上げバーがある");
  assert.ok(doc.querySelector(".stack-seg"), "セグメントがある");
});

console.log("\n— CSV エクスポート —");
test("エクスポートでエラーが起きない", () => {
  doc.querySelector("#modalClose").click();
  let clicked = false;
  const origCreate = doc.createElement.bind(doc);
  doc.createElement = function (tag) {
    const n = origCreate(tag);
    if (tag === "a") n.click = () => { clicked = true; };
    return n;
  };
  doc.querySelector("#btnExport").click();
  doc.createElement = origCreate;
  assert.ok(clicked, "ダウンロードがトリガーされる");
});

console.log(`\n結果: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
})();
