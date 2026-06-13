/* スモークテスト: 全画面・全モーダルを巡回し、実行時エラー0 と
   構造CSSクラスの欠落（=表示崩れの主因）が無いことを検証する */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.error("  ✗ " + name + "\n      " + (e.stack || e.message)); }
}

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace(/<script[^>]*><\/script>/g, "");
const appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e && (e.detail || e.message) || e)));

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/", virtualConsole: vc });
const { window } = dom;
window.confirm = () => true;
window.alert = () => {};
window.prompt = () => "テスト";
window.URL.createObjectURL = () => "blob:mock";
window.URL.revokeObjectURL = () => {};
window.console.error = (...a) => errors.push("console.error: " + a.join(" "));

window.eval(appJs);
const doc = window.document;
const VIEWS = ["dashboard", "contracts", "gantt", "companies", "tasks", "renewals", "settings"];

(async function main() {
  await new Promise((r) => { if (doc.readyState !== "loading") r(); else doc.addEventListener("DOMContentLoaded", () => r()); });
  const app = window.__app;

  // サンプルデータを投入（全パネル/ガント/タスクを埋める）
  doc.querySelector("#btnSeed").click();
  // タスク自動生成
  doc.querySelector('.nav-item[data-view="tasks"]').click();
  const gen = [...doc.querySelectorAll("#topbarActions button")].find((b) => b.textContent.includes("自動生成"));
  if (gen) gen.click();

  console.log("\n— 全画面巡回（実行時エラー検出 / 空画面検出）—");
  VIEWS.forEach((v) => {
    test(`${v} がエラーなく内容を描画する`, () => {
      doc.querySelector(`.nav-item[data-view="${v}"]`).click();
      const content = doc.querySelector("#content");
      assert.ok(content.textContent.trim().length > 0, `${v} の内容が空`);
    });
  });

  console.log("\n— ダークモードで全画面巡回 —");
  doc.querySelector("#btnTheme").click();
  assert.strictEqual(doc.documentElement.getAttribute("data-theme"), "dark");
  VIEWS.forEach((v) => {
    test(`dark: ${v} がエラーなく描画`, () => {
      doc.querySelector(`.nav-item[data-view="${v}"]`).click();
      assert.ok(doc.querySelector("#content").textContent.trim().length > 0);
    });
  });
  doc.querySelector("#btnTheme").click(); // light へ戻す

  console.log("\n— 全モーダルの開閉 —");
  test("契約追加モーダル", () => {
    doc.querySelector('.nav-item[data-view="contracts"]').click();
    [...doc.querySelectorAll("#topbarActions .btn")].find((b) => b.textContent.includes("契約")).click();
    assert.strictEqual(doc.querySelector("#modalOverlay").hidden, false);
    assert.ok(doc.querySelector("#f_company") && doc.querySelector("#f_product") && doc.querySelector("#f_license"));
    doc.querySelector("#modalClose").click();
  });
  test("契約詳細モーダル（活動メモ欄あり）", () => {
    const d = [...doc.querySelectorAll("#contractTableBody .row-actions button")].find((b) => b.title === "詳細");
    d.click();
    assert.ok(doc.querySelector(".activity-add input"), "活動メモ入力欄");
    doc.querySelector("#modalClose").click();
  });
  test("企業追加・企業詳細モーダル", () => {
    doc.querySelector('.nav-item[data-view="companies"]').click();
    [...doc.querySelectorAll("#topbarActions .btn")].find((b) => b.textContent.includes("企業")).click();
    assert.strictEqual(doc.querySelector("#modalOverlay").hidden, false);
    doc.querySelector("#modalClose").click();
    const d = [...doc.querySelectorAll("#content .row-actions button")].find((b) => b.title === "詳細");
    d.click();
    assert.ok(doc.querySelector("#modalBody").textContent.includes("契約一覧"));
    doc.querySelector("#modalClose").click();
  });
  test("タスク追加モーダル", () => {
    doc.querySelector('.nav-item[data-view="tasks"]').click();
    [...doc.querySelectorAll("#topbarActions .btn")].find((b) => b.textContent.includes("タスク追加")).click();
    assert.strictEqual(doc.querySelector("#modalOverlay").hidden, false);
    doc.querySelector("#modalClose").click();
  });

  console.log("\n— 構造CSSクラスの欠落検査（表示崩れ防止）—");
  // styles.css で定義されているクラス名を収集
  const defined = new Set();
  const re = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let m;
  while ((m = re.exec(css))) defined.add(m[1]);
  const REQUIRED = [
    "sidebar", "nav", "nav-item", "nav-section", "nav-badge", "brand", "brand-mark", "brand-text",
    "main", "topbar", "page-title", "content",
    "kpi-grid", "kpi", "kpi-ico", "kpi-body", "kpi-hero",
    "panel", "panel-head", "panel-title", "panel-body", "panel-warn",
    "stack-bar", "stack-seg", "stack-legend", "dot",
    "toolbar", "search", "select", "segmented", "seg-btn", "switch-label",
    "table-total", "tag-pill", "term-presets", "chip-btn",
    "data", "num", "badge", "days-left", "row-actions", "cell-strong", "cell-sub",
    "gantt", "gantt-row", "gantt-label", "gantt-track", "gantt-tick", "gantt-grid", "gantt-bar", "gantt-today", "gantt-group", "gantt-group-head",
    "chip", "chip-x", "master-prod", "master-prod-head",
    "modal", "modal-overlay", "modal-head", "modal-body", "modal-foot",
    "form-grid", "field", "detail-grid", "detail-item", "detail-label", "detail-value",
    "activity-list", "activity-item", "activity-at", "activity-add",
    "btn", "btn-sec", "btn-danger", "btn-icon", "btn-ghost",
    "toast", "bar-track", "bar-fill", "empty",
  ];
  REQUIRED.forEach((cls) => {
    test(`.${cls} が styles.css に定義されている`, () => {
      assert.ok(defined.has(cls), `.${cls} の CSS 定義が無い（表示崩れの恐れ）`);
    });
  });

  console.log("\n— ダークモード変数の網羅 —");
  test("ダークテーマで主要カラー変数を上書きしている", () => {
    const darkBlock = css.match(/html\[data-theme="dark"\]\s*\{([^}]*)\}/);
    assert.ok(darkBlock, "ダークテーマ定義がある");
    ["--bg", "--surface", "--border", "--text"].forEach((v) => assert.ok(darkBlock[1].includes(v), `${v} が未定義`));
  });

  console.log("\n— 実行時エラーの集計 —");
  test("巡回中に実行時エラー / console.error が発生していない", () => {
    assert.strictEqual(errors.length, 0, "検出されたエラー:\n" + errors.join("\n"));
  });

  console.log(`\n結果: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
