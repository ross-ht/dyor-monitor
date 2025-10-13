import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// === 环境变量 ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL
  ? parseInt(process.env.CHECK_INTERVAL)
  : 30000;
const PAGE_TIMEOUT = process.env.PAGE_TIMEOUT
  ? parseInt(process.env.PAGE_TIMEOUT)
  : 15000;

let lastSent = 0;
let lastNetworks = [];
let failureCount = 0;

// === Telegram 消息函数（带限流） ===
async function sendTelegramMessage(message) {
  try {
    const now = Date.now();
    if (now - lastSent < 1500) await new Promise((r) => setTimeout(r, 1500));
    lastSent = now;
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message }
    );
    console.log("📨 Telegram 推送成功:", message);
  } catch (err) {
    console.warn("⚠️ Telegram 推送失败:", err.message || err);
  }
}

// === Chromium 自动下载检测 ===
async function ensureChromiumInstalled() {
  const chromeDir = "./.local-chromium";
  const chromePath = `${chromeDir}/chrome/linux-141.0.7390.76/chrome-linux64/chrome`;

  if (fs.existsSync(chromePath)) {
    console.log("✅ Chromium 已存在，无需重新下载。");
    return chromePath;
  }

  console.log("⬇️ 正在下载 Chromium...");
  execSync(`mkdir -p ${chromeDir}`, { stdio: "inherit" });
  execSync(
    `PUPPETEER_CACHE_DIR=${chromeDir} npx puppeteer browsers install chrome`,
    { stdio: "inherit" }
  );

  if (!fs.existsSync(chromePath)) {
    throw new Error("❌ Chromium 下载失败！");
  }

  console.log("✅ Chromium 下载完成。");
  return chromePath;
}

// === Puppeteer 启动函数 ===
async function launchBrowser() {
  try {
    const chromePath = await ensureChromiumInstalled();
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--no-zygote",
        "--single-process",
      ],
    });
    return browser;
  } catch (err) {
    console.error("🚫 启动 Chrome 失败:", err.message);
    await sendTelegramMessage("🚨 无法启动 Puppeteer，请检查 Chromium 路径配置！");
    throw err;
  }
}

// === 安全访问页面（带重试与超时扩展） ===
async function safeGoto(page, url, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`🌐 正在访问页面（第 ${i + 1} 次尝试）...`);
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      await page.waitForSelector("body", { timeout: 20000 });
      console.log("✅ 页面加载成功");
      return true;
    } catch (err) {
      console.warn(`⚠️ 加载失败（第 ${i + 1} 次尝试）: ${err.message}`);
      if (i < maxRetries - 1) {
        console.log("⏳ 3 秒后重试...");
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        console.error("❌ 多次尝试后仍无法加载页面");
        await sendTelegramMessage("⚠️ 页面加载失败，无法访问目标网站。");
        return false;
      }
    }
  }
}

// === 主网抓取逻辑 ===
function normalize(s) {
  return s.replace(/\s+/g, " ").replace(/[^\S\r\n]+/g, " ").trim();
}

const STOP_WORDS = new Set([
  "select a network", "connect wallet", "okb", "uni", "okx", "wallet",
  "bridge", "swap", "stake", "pool", "settings"
]);

function extractFromBlob(text) {
  const out = [];
  const re = /([A-Za-z0-9][A-Za-z0-9\s\-]*(?:Mainnet|Network|Layer\s?\d+|Chain))(?![A-Za-z])/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push(normalize(m[1]));
  return out;
}

async function getNetworks(page) {
  try {
    await page.waitForSelector("body", { timeout: 15000 });
    const toggleSelector =
      'div[class*="sc-de7e8801-1"][class*="sc-1080dffc-0"][class*="sc-ec57e2f1-0"]';
    const toggle = await page.$(toggleSelector);
    if (toggle) {
      await toggle.click();
      await new Promise((r) => setTimeout(r, 800));
    }

    const menuRootSelectors = [
      '[role="menu"]', '[role="listbox"]', '[data-state="open"]',
      '.menu', '.dropdown', '.popover'
    ];
    let menuRoot = null;
    for (const sel of menuRootSelectors) {
      const el = await page.$(sel);
      if (el) { menuRoot = el; break; }
    }

    let texts = [];
    const itemSelectors = [
      '[role="menuitem"]', '[role="option"]', 'li', 'button', 'a', 'div'
    ];

    if (menuRoot) {
      const sel = itemSelectors.join(", ");
      texts = await menuRoot.$$eval(sel, nodes =>
        nodes.map(n => n.innerText || n.textContent || "")
          .map(t => t.trim())
          .filter(Boolean)
      );
    } else {
      texts = await page.$$eval("body *", nodes =>
        nodes.map(n => n.innerText || n.textContent || "")
          .map(t => t.trim())
          .filter(Boolean)
      );
    }

    let candidates = [];
    for (const t of texts) {
      const clean = normalize(t);
      if (!clean) continue;
      if (clean.length <= 40) candidates.push(clean);
      else candidates.push(...clean.match(/.{1,120}/g));
    }

    let picked = [];
    for (const c of candidates) {
      if (/(Mainnet|Network|Layer\s?\d+|Chain)$/i.test(c)) picked.push(c);
      else if (c.length > 40) picked.push(...extractFromBlob(c));
    }

    picked = picked
      .map(normalize)
      .filter(x => x && x.length >= 3 && x.length <= 40)
      .filter(x => !STOP_WORDS.has(x.toLowerCase()))
      .filter(x => !/^x layer mainnetokb$/i.test(x))
      .filter(x => !/connect$/i.test(x));

    let splitExpanded = [];
    for (const item of picked) {
      if (/\s(Mainnet|Network|Layer\s?\d+|Chain)\s/i.test(item)) {
        const parts = item.split(/(?<=Mainnet|Network|Layer\s?\d+|Chain)\s+/i).filter(Boolean);
        splitExpanded.push(...parts);
      } else splitExpanded.push(item);
    }

    const unique = Array.from(
      new Set(splitExpanded.map(normalize).filter(x => x && !STOP_WORDS.has(x.toLowerCase())))
    ).sort((a, b) => a.localeCompare(b, "en"));

    console.log("📋 当前主网列表:", unique);
    if (unique.length) {
      const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
      const msg = `📋 当前主网列表（${stamp}）：\n${unique.map(n => `• ${n}`).join("\n")}`;
      await sendTelegramMessage(msg);
    }

    return unique;
  } catch (err) {
    console.error("❌ 主网抓取失败:", err.message);
    return [];
  }
}

// === 主监控逻辑 ===
async function monitor() {
  console.log("🚀 DYOR 主网监控已启动...");
  await sendTelegramMessage("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  while (true) {
    const now = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`🕒 ${now} - 检查主网变化中...`);
    await sendTelegramMessage(`🕒 监控心跳：正在检查主网变化中... (${now})`);

    let browser = null;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();

      const pageLoaded = await safeGoto(page, "https://dyorswap.org");
      if (!pageLoaded) continue;

      await new Promise((r) => setTimeout(r, 2000));
      const networks = await getNetworks(page);

      // ✅ 首次启动：推送主网数量统计
      if (!lastNetworks.length && networks.length) {
        await sendTelegramMessage(
          `✅ 当前检测到 ${networks.length} 个主网：\n${networks.map(n => `• ${n}`).join("\n")}`
        );
      }

      // 🚀 检测主网变化
      if (networks.length && JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const newOnes = networks.filter((n) => !lastNetworks.includes(n));
        if (newOnes.length) {
          await sendTelegramMessage(`🚀 发现新主网：${newOnes.join(", ")}`);
        }
        lastNetworks = networks;
      }

      failureCount = 0;
    } catch (err) {
      failureCount++;
      console.error("⚠️ 监控循环错误:", err.message);
      if (failureCount === 1 || failureCount % 5 === 0) {
        await sendTelegramMessage(`⚠️ 网络异常（连续 ${failureCount} 次失败），请检查服务。`);
      }
    } finally {
      if (browser) await browser.close();
    }

    await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
  }
}

// === 启动主程序 ===
monitor();