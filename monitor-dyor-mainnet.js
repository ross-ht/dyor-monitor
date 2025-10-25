import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "60000", 10);
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "90000", 10);
const TARGET_URL = "https://dyorswap.org";

let lastNetworks = [];
let failureCount = 0;
let lastSent = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text) {
  try {
    const now = Date.now();
    if (now - lastSent < 1500) await sleep(1500);
    lastSent = now;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
    });
    console.log("📨 Telegram 推送成功:", text.split("\n")[0]);
  } catch (err) {
    console.warn("⚠️ Telegram 推送失败:", err.message || err);
  }
}

async function ensureChromiumInstalled() {
  const cacheDir = "./.local-chromium";
  const chromePath = `${cacheDir}/chrome/linux-141.0.7390.76/chrome-linux64/chrome`;
  if (fs.existsSync(chromePath)) {
    console.log("✅ Chromium 已存在，无需重新下载。");
    return chromePath;
  }
  console.log("⬇️ 正在下载 Chromium...");
  execSync(`mkdir -p ${cacheDir}`, { stdio: "inherit" });
  execSync(`PUPPETEER_CACHE_DIR=${cacheDir} npx puppeteer browsers install chrome`, {
    stdio: "inherit",
  });
  if (!fs.existsSync(chromePath)) throw new Error("❌ Chromium 下载失败！");
  console.log("✅ Chromium 下载完成。");
  return chromePath;
}

async function launchBrowser() {
  const chromePath = await ensureChromiumInstalled();
  return puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
    ],
  });
}

async function openPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (["image", "font", "media"].includes(t)) req.abort();
    else req.continue();
  });

  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`🌐 正在访问页面（第 ${i}/3 次）...`);
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
      await sleep(1500 * i);
      return page;
    } catch (err) {
      console.warn(`⚠️ 加载失败（第 ${i} 次）: ${err.message}`);
      if (i === 3) throw err;
      await sleep(2000 * i);
    }
  }
}

async function ensureMenuOpen(page) {
  console.log("🌐 尝试展开主网菜单...");

  // 若菜单已出现，直接跳过
  if (await page.$('button[data-testid^="rk-chain-option-"]')) return true;

  for (let attempt = 1; attempt <= 5; attempt++) {
    // 1️⃣ 先尝试点击常见按钮
    const selectors = [
      'button[data-testid="rk-chain-button"]',
      'div[role="button"][aria-haspopup="dialog"]',
      'button[aria-haspopup="dialog"]',
    ];
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          console.log(`✅ 点击菜单触发器（${sel}）`);
          await sleep(700 * attempt);
          if (await page.$('button[data-testid^="rk-chain-option-"]')) return true;
        }
      } catch {}
    }

    // 2️⃣ 如果没找到按钮，尝试文本匹配方式（兼容无 button 的情况）
    try {
      const clicked = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("*"));
        for (const el of elements) {
          const txt = (el.innerText || el.textContent || "").trim();
          if (/Select a Network/i.test(txt)) {
            el.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        console.log("✅ 已通过文本点击展开菜单");
        await sleep(800 * attempt);
        if (await page.$('button[data-testid^="rk-chain-option-"]')) return true;
      }
    } catch {}

    await sleep(500 * attempt);
  }

  console.warn("⚠️ 未能确认菜单已展开");
  return false;
}

async function extractNetworks(page) {
  console.log("🌐 抓取主网列表...");
  const buttons = await page.$$('button[data-testid^="rk-chain-option-"]');
  if (!buttons || !buttons.length) throw new Error("⚠️ 未检测到主网选项结点。");

  const list = await page.$$eval('button[data-testid^="rk-chain-option-"]', (btns) =>
    Array.from(
      new Set(
        btns
          .map((b) => {
            const lastDiv = b.querySelector("div:last-child");
            const label =
              (lastDiv && (lastDiv.innerText || lastDiv.textContent || "").trim()) ||
              b.getAttribute("aria-label") ||
              "";
            return label
              .replace(/\s+/g, " ")
              .trim()
              .replace(/已连接|Connect|Select a Network/gi, "");
          })
          .filter(
            (x) =>
              x &&
              x.length > 2 &&
              /Mainnet|Network|Layer|Chain|Base|Ink|Linea|Berachain|Cronos|Uni|Sonic|Hyper|Morph|Plasma|Gate|X Layer/i.test(
                x
              )
          )
      )
    ).sort((a, b) => a.localeCompare(b, "en"))
  );

  if (!list.length) throw new Error("⚠️ 页面已加载但未解析到主网文本。");
  return list;
}

async function getNetworks(page) {
  for (let i = 1; i <= 3; i++) {
    try {
      await ensureMenuOpen(page);
      const nets = await extractNetworks(page);
      return nets;
    } catch (err) {
      console.warn(`⚠️ 第 ${i} 轮抓取失败：${err.message}`);
      if (i === 3) throw err;
      await sleep(1000 * i);
    }
  }
  return [];
}

async function monitor() {
  console.log("🚀 DYOR 主网监控已启动...");
  await sendTelegram("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  while (true) {
    const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`🕒 ${stamp} - 检查主网变化中...`);

    let browser = null;
    try {
      browser = await launchBrowser();
      const page = await openPage(browser);
      const networks = await getNetworks(page);

      if (networks.length) {
        const msg = `📋 当前主网列表（${stamp}）：\n${networks.map((n) => `• ${n}`).join("\n")}`;
        await sendTelegram(msg);
      } else {
        await sendTelegram("⚠️ 未检测到任何主网，请检查页面结构。");
      }

      // 新增检测
      if (JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const added = networks.filter((x) => !lastNetworks.includes(x));
        if (added.length) await sendTelegram(`🚀 发现新主网：${added.join(", ")}`);
        lastNetworks = networks;
      }

      failureCount = 0;
    } catch (err) {
      failureCount++;
      console.error("⚠️ 监控循环错误:", err.message);
      if (failureCount === 1 || failureCount % 5 === 0) {
        await sendTelegram(`⚠️ 网络异常（连续 ${failureCount} 次失败），请检查服务。`);
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    await sleep(CHECK_INTERVAL);
  }
}

monitor();