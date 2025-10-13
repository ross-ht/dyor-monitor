import puppeteer from "puppeteer";
import axios from "axios";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "60000", 10);
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "30000", 10);

let previousNetworks = [];
let failureCount = 0;

// Telegram 推送函数
let lastSent = 0;

async function sendTelegramMessage(message) {
  const now = Date.now();
  if (now - lastSent < 1500) {
    await new Promise((r) => setTimeout(r, 1500)); // 每条间隔 ≥1.5 秒
  }
  lastSent = now;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    });
    console.log("📨 Telegram 推送成功:", message);
  } catch (err) {
    console.error("⚠️ Telegram 推送失败:", err.message);
  }
}

// 启动 Puppeteer
async function launchBrowser() {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: puppeteer.executablePath(), // 自动根据缓存定位浏览器
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--no-zygote",
        "--single-process"
      ]
    });
    return browser;
  } catch (err) {
    console.error("🚫 启动 Chrome 失败:", err.message);
    await sendTelegramMessage("🚨 无法启动 Puppeteer，请检查 Chromium 路径配置！");
    throw err;
  }
}

// 抓取主网列表
async function getNetworks() {
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.goto("https://dyorswap.org", { waitUntil: "networkidle2", timeout: PAGE_TIMEOUT });

  const networks = await page.$$eval("div.sc-de7e8801-1.fSxDht", (elements) =>
    elements.map((el) => el.textContent.trim()).filter(Boolean)
  );

  await browser.close();
  return networks;
}

// 监控循环
async function monitor() {
  console.log("🚀 DYOR 主网监控已启动...");
  await sendTelegramMessage("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  while (true) {
    try {
      const now = new Date().toLocaleString();
      console.log(`🕒 ${now} - 检查主网变化中...`);
      await sendTelegramMessage(`🕒 监控心跳：正在检查主网变化中... (${now})`);

      const networks = await getNetworks();

      if (previousNetworks.length === 0) {
        previousNetworks = networks;
        console.log("📋 初始主网列表:", networks);
      } else if (JSON.stringify(networks) !== JSON.stringify(previousNetworks)) {
        const added = networks.filter((n) => !previousNetworks.includes(n));
        const removed = previousNetworks.filter((n) => !networks.includes(n));

        let msg = "🚨 检测到主网变化！\n";
        if (added.length) msg += `🟢 新增主网: ${added.join(", ")}\n`;
        if (removed.length) msg += `🔴 移除主网: ${removed.join(", ")}\n`;

        await sendTelegramMessage(msg);
        previousNetworks = networks;
      }

      failureCount = 0;
      await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
    } catch (err) {
      console.error("⚠️ 监控循环错误:", err.message);
      failureCount++;
      if (failureCount >= 5) {
        await sendTelegramMessage(`⚠️ 网络异常（连续 ${failureCount} 次失败），请检查服务。`);
        failureCount = 0;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// 启动监控
monitor();