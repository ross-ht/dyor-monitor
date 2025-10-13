import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// === 环境变量 ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "30000");
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "15000");

let lastSent = 0;
let lastNetworks = [];
let failureCount = 0;

// === Telegram 推送 ===
async function sendTelegramMessage(message) {
  try {
    const now = Date.now();
    if (now - lastSent < 1500) await new Promise(r => setTimeout(r, 1500));
    lastSent = now;

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    });
    console.log("📨 Telegram 推送成功:", message);
  } catch (err) {
    console.warn("⚠️ Telegram 推送失败:", err.message || err);
  }
}

// === 自动安装 Chromium ===
async function ensureChromiumInstalled() {
  const chromeDir = "./.local-chromium";
  const chromePath = `${chromeDir}/chrome/linux-141.0.7390.76/chrome-linux64/chrome`;

  if (fs.existsSync(chromePath)) {
    console.log("✅ Chromium 已存在，无需重新下载。");
    return chromePath;
  }

  console.log("⬇️ 正在下载 Chromium...");
  execSync(`mkdir -p ${chromeDir}`, { stdio: "inherit" });
  execSync(`PUPPETEER_CACHE_DIR=${chromeDir} npx puppeteer browsers install chrome`, { stdio: "inherit" });
  if (!fs.existsSync(chromePath)) throw new Error("❌ Chromium 下载失败！");
  console.log("✅ Chromium 下载完成。");
  return chromePath;
}

// === 启动浏览器 ===
async function launchBrowser() {
  try {
    const chromePath = await ensureChromiumInstalled();
    return await puppeteer.launch({
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
  } catch (err) {
    console.error("🚫 启动 Chrome 失败:", err.message);
    await sendTelegramMessage("🚨 无法启动 Puppeteer，请检查 Chromium 路径配置！");
    throw err;
  }
}

// === 安全访问页面 ===
async function safeGoto(page, url, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`🌐 正在访问页面（第 ${i + 1} 次尝试）...`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
      await page.waitForSelector("body", { timeout: 20000 });
      console.log("✅ 页面加载成功");
      await new Promise(r => setTimeout(r, 5000));
      return true;
    } catch (err) {
      console.warn(`⚠️ 加载失败（第 ${i + 1} 次尝试）: ${err.message}`);
      if (i < maxRetries - 1) {
        console.log("⏳ 3 秒后重试...");
        await new Promise(r => setTimeout(r, 3000));
      } else {
        await sendTelegramMessage("⚠️ 页面加载失败，无法访问目标网站。");
        return false;
      }
    }
  }
}

// === 文本清洗 ===
function normalize(s) {
  return s.replace(/\s+/g, " ").replace(/[^\S\r\n]+/g, " ").trim();
}

const STOP_WORDS = new Set([
  "select a network", "connect wallet", "okb", "uni", "okx", "wallet",
  "bridge", "swap", "stake", "pool", "settings", "dyor", "launch", "home"
]);

// === 递归提取主网文本 ===
function extractFromBlob(text) {
  const out = [];
  const re = /\b([A-Z][A-Za-z0-9\s\-]*(?:Mainnet|Network|Layer\s?(?:L\d+|\d+)|Chain|Hub|Verse))\b/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(normalize(m[1]));
  return out;
}

// === 抓取主网 ===
async function getNetworks(page) {
  try {
    await page.waitForSelector("body", { timeout: 15000 });

    // 点击主网菜单按钮
    const toggleSelector =
      'div[class*="sc-de7e8801-1"][class*="sc-1080dffc-0"][class*="sc-ec57e2f1-0"]';
    const toggle = await page.$(toggleSelector);
    if (toggle) {
      await toggle.click();
      await page.waitForTimeout(2000); // 等待动画结束

      // ✅ 强制展开所有隐藏项
      await page.evaluate(() => {
        document.querySelectorAll('*').forEach(el => {
          if (el.textContent && /Mainnet|Network|Layer|Chain/i.test(el.textContent)) {
            el.style.display = 'block';
            el.style.visibility = 'visible';
            el.style.opacity = '1';
          }
        });
      });
    }

    // ✅ 递归遍历 DOM + Shadow DOM
    const texts = await page.evaluate(() => {
      const collectTexts = (root) => {
        let out = [];
        root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) out.push(...collectTexts(el.shadowRoot));
          const txt = el.innerText || el.textContent || '';
          if (txt && /(Mainnet|Network|Layer|Chain)/i.test(txt)) out.push(txt.trim());
        });
        return out;
      };
      return collectTexts(document);
    });

    // === 提取与清洗 ===
    let picked = [];
    for (const t of texts) {
      const clean = normalize(t);
      if (!clean || STOP_WORDS.has(clean.toLowerCase())) continue;
      if (clean.length <= 50 && /(Mainnet|Network|Layer|Chain)/i.test(clean))
        picked.push(clean);
      else picked.push(...extractFromBlob(clean));
    }

    const splitExpanded = [];
    for (const item of picked) {
      const parts = item.split(/(?<=Mainnet|Network|Layer\s?(?:L\d+|\d+)|Chain|Hub|Verse)\b\s*/i).filter(Boolean);
      splitExpanded.push(...parts);
    }

    const unique = Array.from(
      new Set(splitExpanded
        .map(normalize)
        .filter(x => x && x.length >= 4 && x.length <= 40)
        .filter(x => !STOP_WORDS.has(x.toLowerCase()))
        .filter(x => /^[A-Z]/.test(x))
      )
    ).sort((a, b) => a.localeCompare(b, "en"));

    console.log("📋 当前主网列表:", unique);
    if (unique.length) {
      const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
      await sendTelegramMessage(`📋 当前主网列表（${stamp}）：\n${unique.map(n => `• ${n}`).join("\n")}`);
    }

    return unique;
  } catch (err) {
    console.error("❌ 主网抓取失败:", err.message);
    return [];
  }
}

// === 主监控循环 ===
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
      const ok = await safeGoto(page, "https://dyorswap.org");
      if (!ok) continue;

      const networks = await getNetworks(page);

      if (!lastNetworks.length && networks.length) {
        await sendTelegramMessage(`✅ 当前检测到 ${networks.length} 个主网：\n${networks.map(n => `• ${n}`).join("\n")}`);
      }

      if (networks.length && JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const newOnes = networks.filter(n => !lastNetworks.includes(n));
        if (newOnes.length)
          await sendTelegramMessage(`🚀 发现新主网：${newOnes.join(", ")}`);
        lastNetworks = networks;
      }

      failureCount = 0;
    } catch (err) {
      failureCount++;
      console.error("⚠️ 监控循环错误:", err.message);
      if (failureCount === 1 || failureCount % 5 === 0)
        await sendTelegramMessage(`⚠️ 网络异常（连续 ${failureCount} 次失败），请检查服务。`);
    } finally {
      if (browser) await browser.close();
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }
}

monitor();