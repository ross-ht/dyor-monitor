import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// === 环境变量 ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "60000");
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "60000");
const CHROME_PATH = process.env.CHROME_PATH || null;

let lastNetworks = [];
let failureCount = 0;
let lastSent = 0;

// === Telegram 推送 ===
async function sendTelegram(message) {
  try {
    const now = Date.now();
    if (now - lastSent < 2000) await new Promise((r) => setTimeout(r, 2000));
    lastSent = now;

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    });
    console.log("📨 Telegram 推送成功:", message);
  } catch (e) {
    console.warn("⚠️ Telegram 推送失败:", e.message);
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

// === 启动 Puppeteer ===
async function launchBrowser() {
  const executablePath = CHROME_PATH || (await ensureChromiumInstalled());
  return await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-zygote",
      "--single-process",
    ],
  });
}

// === 抓取主网逻辑（新版本）===
async function getNetworks(page) {
  console.log("🌐 抓取主网列表...");
  try {
    await page.waitForSelector('button[data-testid^="rk-chain-option"] div', { timeout: 15000 });
    const networks = await page.$$eval('button[data-testid^="rk-chain-option"] div', (nodes) =>
      nodes
        .map((n) => n.innerText || n.textContent || "")
        .map((t) => t.trim())
        .filter((t) => t && !t.toLowerCase().includes("已连接"))
    );

    if (!networks.length) throw new Error("⚠️ 未检测到任何主网，请检查页面结构。");

    const unique = Array.from(new Set(networks)).sort((a, b) => a.localeCompare(b, "en"));
    console.log("📋 当前主网列表:", unique);

    const msg =
      `📋 当前主网列表（${new Date().toLocaleString("zh-CN", { hour12: false })}）：\n` +
      unique.map((n) => `• ${n}`).join("\n");
    await sendTelegram(msg);

    return unique;
  } catch (err) {
    console.error("❌ 主网抓取失败:", err.message);
    await sendTelegram(`⚠️ 主网抓取失败: ${err.message}`);
    return [];
  }
}

// === 主流程 ===
async function monitor() {
  await sendTelegram("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  while (true) {
    const now = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`🕒 ${now} - 检查主网变化中...`);

    let browser;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();

      console.log("🌐 正在访问页面...");
      await page.goto("https://dyorswap.org", {
        timeout: PAGE_TIMEOUT,
        waitUntil: "networkidle2",
      });

      await new Promise((r) => setTimeout(r, 4000));

      const networks = await getNetworks(page);

      if (networks.length && JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const newOnes = networks.filter((n) => !lastNetworks.includes(n));
        if (newOnes.length) {
          await sendTelegram(`🚀 发现新主网：${newOnes.join(", ")}`);
        }
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
      if (browser) await browser.close();
    }

    await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
  }
}

// === 启动 ===
(async () => {
  try {
    await monitor();
  } catch (e) {
    console.error("❌ 脚本终止:", e);
    process.exit(1);
  }
})();

export default monitor;