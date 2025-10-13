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
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }
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

// === 主网抓取逻辑（自动展开 + 防止哈希变动） ===
async function getNetworks(page) {
  try {
    await page.waitForSelector("body", { timeout: PAGE_TIMEOUT });

    // 尝试展开主网选择菜单
    const toggleSelector =
      'div[class*="sc-de7e8801-1"][class*="sc-1080dffc-0"][class*="sc-ec57e2f1-0"]';
    const exists = await page.$(toggleSelector);
    if (exists) {
      await page.click(toggleSelector);
      await page.waitForTimeout(1000); // 等待动画
    }

    // 获取主网名
    const networks = await page.$$eval('div[class*="sc-de7e8801-1"]', (els) => {
      return Array.from(
        new Set(
          els
            .map((el) => el.textContent?.trim())
            .filter((t) => t && t.length > 2 && /mainnet/i.test(t))
        )
      );
    });

    if (!networks.length) {
      console.warn("⚠️ 未抓取到主网，可能 DOM 结构变更。");
      return [];
    }

    console.log("📋 当前主网列表:", networks);
    return networks;
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
      await page.goto("https://dyorswap.org", { timeout: PAGE_TIMEOUT });
      await page.waitForTimeout(2000);

      const networks = await getNetworks(page);

      // 检测变化
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