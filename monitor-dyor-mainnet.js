import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// === 环境变量 ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "60000");
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "90000");

let lastNetworks = [];
let failureCount = 0;
let lastSent = 0;

// === Telegram 推送 ===
async function sendTelegramMessage(msg) {
  try {
    const now = Date.now();
    if (now - lastSent < 1500) await new Promise(r => setTimeout(r, 1500));
    lastSent = now;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
    });
    console.log("📨 Telegram 推送成功:", msg);
  } catch (err) {
    console.warn("⚠️ Telegram 推送失败:", err.message);
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
    await sendTelegramMessage("🚨 无法启动 Puppeteer，请检查 Chromium 配置！");
    throw err;
  }
}

// === 确保菜单展开 ===
async function ensureMenuOpen(page) {
  console.log("🌐 尝试展开主网选择菜单...");
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const toggle = await page.$('div[class*="dUUCVU"], div[class*="sc-2371b370-0"]');
      if (toggle) {
        await toggle.click();
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }

      const visible = await page.evaluate(() => {
        const items = document.querySelectorAll(
          'button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]'
        );
        return Array.from(items).map(x => x.textContent.trim()).filter(Boolean).length;
      });
      if (visible > 10) {
        console.log(`✅ 菜单展开成功（第 ${attempt} 次尝试）`);
        return;
      }
    } catch (err) {
      console.warn(`⚠️ 展开菜单失败（第 ${attempt} 次）: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.warn("⚠️ 未能成功展开主网菜单！");
}

// === 抓取主网列表（带容错与重试） ===
async function getNetworks(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🌐 正在访问页面（第 ${attempt}/3 次尝试）...`);
      await page.goto("https://dyorswap.org", {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT,
      });
      await page.waitForSelector("body", { timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));

      await ensureMenuOpen(page);
      console.log("🌐 正在抓取主网列表...");

      const networks = await page.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll(
            'button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]'
          )
        );
        return items.map(el => el.textContent.trim()).filter(Boolean);
      });

      const cleaned = Array.from(new Set(networks))
        .map(n => n.replace(/\s+/g, " ").trim())
        .filter(n => /Mainnet|Network/i.test(n))
        .sort((a, b) => a.localeCompare(b, "en"));

      if (!cleaned.length) throw new Error("⚠️ 页面已加载但未检测到主网元素。");

      console.log("📋 当前主网列表:", cleaned);
      await sendTelegramMessage(
        `📋 当前主网列表（${new Date().toLocaleString("zh-CN", { hour12: false })}）：\n${cleaned
          .map(x => `• ${x}`)
          .join("\n")}`
      );
      return cleaned;
    } catch (err) {
      console.warn(`⚠️ 第 ${attempt} 次抓取失败: ${err.message}`);
      if (attempt < 3) {
        console.log("⏳ 5 秒后重试...");
        await new Promise(r => setTimeout(r, 5000));
      } else {
        await sendTelegramMessage(`⚠️ 主网抓取失败: ${err.message}`);
        return [];
      }
    }
  }
}

// === 主循环 ===
async function monitor() {
  console.log("🚀 DYOR 主网监控已启动...");
  await sendTelegramMessage("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  while (true) {
    const now = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`🕒 ${now} - 检查主网变化中...`);

    let browser = null;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();

      const networks = await getNetworks(page);
      if (networks.length && JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const newOnes = networks.filter(x => !lastNetworks.includes(x));
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

// === 启动 ===
(async () => {
  try {
    await monitor();
  } catch (err) {
    console.error("❌ 脚本异常终止:", err);
    process.exit(1);
  }
})();