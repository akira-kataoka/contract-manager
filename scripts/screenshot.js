/* 実ブラウザ(Chromium)で各画面を撮影し、表示崩れを目視確認するためのスクリプト
   使い方: node scripts/screenshot.js  → out/ に PNG を出力 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "out");
const url = "file://" + path.join(ROOT, "index.html").replace(/\\/g, "/");

const VIEWS = [
  ["dashboard", "ダッシュボード"],
  ["contracts", "契約一覧"],
  ["gantt", "タイムライン"],
  ["companies", "企業一覧"],
  ["tasks", "更新タスク"],
  ["settings", "マスタ管理"],
];

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.on("dialog", (d) => d.accept());
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle0" });

  // サンプル投入
  await page.click("#btnSeed");
  await new Promise((r) => setTimeout(r, 300));
  // タスク自動生成
  await page.click('.nav-item[data-view="tasks"]');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("#topbarActions button")].find((x) => x.textContent.includes("自動生成"));
    if (b) b.click();
  });

  const shoot = async (theme) => {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
      localStorage.setItem("keiyaku_theme", t);
    }, theme);
    for (const [v, label] of VIEWS) {
      await page.click(`.nav-item[data-view="${v}"]`);
      await new Promise((r) => setTimeout(r, 250));
      const file = path.join(OUT, `${theme}-${v}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log("saved", file, `(${label})`);
    }
    // 契約詳細モーダル
    await page.click('.nav-item[data-view="contracts"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#contractTableBody .row-actions button")].find((x) => x.title === "詳細");
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(OUT, `${theme}-contract-detail.png`) });
    console.log("saved", path.join(OUT, `${theme}-contract-detail.png`));
    await page.evaluate(() => document.querySelector("#modalClose").click());
  };

  await shoot("light");
  await shoot("dark");

  await browser.close();
  console.log("DONE");
})().catch((e) => { console.error(e); process.exit(1); });
