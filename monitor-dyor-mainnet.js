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

// === Telegram 通知 ===
async function sendTelegramMessage(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
    });
    console.log("📨 Telegram 推送成功:", msg);
  } catch (err) {
    console.warn("⚠️ Telegram 推送失败:", err.message);
  }
}

// === 确保 Chromium 可用 ===
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
  console.log("✅ Chromium 下载完成。");
  return chromePath;
}

// === 启动 Puppeteer ===
async function launchBrowser() {
  const chromePath = await ensureChromiumInstalled();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  return browser;
}

// === 核心抓取逻辑（新版选择器） ===
async function getNetworks(page) {
  console.log("🌐 正在访问页面...");
  await page.goto("https://dyorswap.org", { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
  await new Promise(r => setTimeout(r, 6000));

  console.log("🌐 尝试展开主网菜单...");
  // 模拟点击顶部网络选择区域
  await page.mouse.move(200, 100);
  await page.mouse.click(200, 100);
  await new Promise(r => setTimeout(r, 2000));

  console.log("🌐 抓取主网列表...");
  const networks = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button[data-testid^="rk-chain-option-"]');
    const result = [];
    buttons.forEach(btn => {
      const label =
        btn.querySelector("div:last-child")?.textContent.trim() ||
        btn.querySelector("[aria-label]")?.getAttribute("aria-label") ||
        "";
      if (label && /Mainnet|Network|Layer|Chain|Base|Ink/i.test(label)) result.push(label);
    });
    return Array.from(new Set(result.map(x => x.trim()))).sort((a, b) => a.localeCompare(b, "en"));
  });

  if (!networks.length) throw new Error("⚠️ 未检测到任何主网，请检查页面结构。");
  console.log("📋 当前主网列表:", networks);

  await sendTelegramMessage(
    `📋 当前主网列表（${new Date().toLocaleString("zh-CN", { hour12: false })}）：\n${networks
      .map(n => `• ${n}`)
      .join("\n")}`
  );

  return networks;
}

// === 主监控循环 ===
async function monitor() {
  console.log("🚀 DYOR 主网监控启动...");
  await sendTelegramMessage("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  while (true) {
    const now = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`🕒 ${now} - 检查主网变化中...`);
    let browser = null;

    try {
      browser = await launchBrowser();
      const page = await browser.newPage();

      const networks = await getNetworks(page);
      if (JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const newOnes = networks.filter(x => !lastNetworks.includes(x));
        if (newOnes.length)
          await sendTelegramMessage(`🚀 发现新主网：${newOnes.join(", ")}`);
        lastNetworks = networks;
      }

      failureCount = 0;
    } catch (err) {
      failureCount++;
      console.error("⚠️ 错误:", err.message);
      if (failureCount % 3 === 0) {
        await sendTelegramMessage(`⚠️ 网络异常（连续 ${failureCount} 次失败）`);
      }
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
    console.error("❌ 脚本终止:", err);
    process.exit(1);
  }
})();