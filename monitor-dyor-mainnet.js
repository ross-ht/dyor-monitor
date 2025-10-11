import puppeteer from "puppeteer";
import axios from "axios";

const CONFIG = {
  url: "https://dyorswap.org",
  telegram: {
    token: "8043299867:AAGF9R60mEhvZyRM4RwT4YnCSQFT0L_nfdQ",  // 替换为你的 Telegram Bot Token
    chatId: "-1003104139469",   // 替换为你的 Chat ID
  },
  interval: 60000 // 检测间隔（毫秒），默认 60 秒
};

let previousNetworks = [];

/**
 * 获取当前主网列表
 */
async function getNetworks() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // ✅ 指定使用系统 Chrome
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  // ✅ 访问并延长超时
  await page.goto(CONFIG.url, { waitUntil: "networkidle2", timeout: 60000 });

  // ✅ 等待主网选择模块渲染完成
  await page.waitForSelector(".sc-de7e8801-1.dUUCVU", { timeout: 60000 });
  await new Promise(resolve => setTimeout(resolve, 5000));

  // 解析主网名称列表
  const networks = await page.evaluate(() => {
    const selector = document.querySelector(".sc-de7e8801-1.dUUCVU");
    if (!selector) return [];
    return Array.from(document.querySelectorAll(".sc-de7e8801-1.fSxDht"))
      .map(el => el.textContent.trim())
      .filter(Boolean);
  });

  await browser.close();
  return networks;
}

/**
 * 推送消息到 Telegram
 */
async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${CONFIG.telegram.token}/sendMessage`;
  await axios.post(url, {
    chat_id: CONFIG.telegram.chatId,
    text: message,
    parse_mode: "Markdown"
  });
}

/**
 * 主监控逻辑
 */
async function monitor() {
  console.log("🔍 正在监控主网列表变化...");
  const currentNetworks = await getNetworks();
  await sendTelegramMessage("🔍 正在监控主网列表变化...");

  if (previousNetworks.length === 0) {
    previousNetworks = currentNetworks;
    console.log("📋 初始主网列表:", currentNetworks);
    return;
  }

  const newNetworks = currentNetworks.filter(n => !previousNetworks.includes(n));
  if (newNetworks.length > 0) {
    const msg = `🆕 DyorSwap 新增主网：\n${newNetworks.join(", ")}`;
    console.log(msg);
    await sendTelegramMessage(msg);
  }

  previousNetworks = currentNetworks;
}

setInterval(monitor, CONFIG.interval);
monitor();