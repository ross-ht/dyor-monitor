import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// === 环境变量 ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL) : 60000;
const PAGE_TIMEOUT = process.env.PAGE_TIMEOUT ? parseInt(process.env.PAGE_TIMEOUT) : 60000;

let lastNetworks = [];

// === Telegram 推送 ===
async function sendTelegramMessage(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    });
    console.log("📨 Telegram 推送成功:", message);
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

// === 启动 Puppeteer ===
async function launchBrowser() {
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
}

// === 抓取主网数据 ===
async function getNetworks(page) {
  try {
    console.log("🌐 正在抓取主网列表...");
    await page.waitForSelector("div.sc-de7e8801-1", { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3000));

    const texts = await page.$$eval(
      'button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]',
      (els) => els.map((el) => el.textContent.trim()).filter(Boolean)
    );

    const normalize = (s) => s.replace(/\s+/g, " ").trim();
    const STOP_WORDS = new Set([
      "select a network",
      "okb",
      "wallet",
      "bridge",
      "swap",
      "connect",
    ]);

    const extracted = [];
    const re = /([A-Za-z0-9\- ]+(?:Mainnet|Network|Layer\s?\d+|Chain))/gi;
    for (const line of texts) {
      const clean = normalize(line);
      if (!clean) continue;
      let matches = clean.match(re);
      if (matches) extracted.push(...matches.map((m) => normalize(m)));
      else if (!STOP_WORDS.has(clean.toLowerCase())) extracted.push(clean);
    }

    const unique = Array.from(new Set(extracted)).sort((a, b) => a.localeCompare(b, "en"));

    console.log("📋 当前主网列表:", unique);
    if (unique.length) {
      const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
      await sendTelegramMessage(
        `📋 当前主网列表（${stamp}）：\n${unique.map((n) => `• ${n}`).join("\n")}`
      );
    }

    return unique;
  } catch (err) {
    console.error("❌ 主网抓取失败:", err.message);
    await sendTelegramMessage(`⚠️ 主网抓取失败: ${err.message}`);
    return [];
  }
}

// === 主监控逻辑 ===
async function monitor() {
  console.log("🚀 DYOR 主网监控已启动...");
  await sendTelegramMessage("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  while (true) {
    let browser = null;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto("https://dyorswap.org", { timeout: PAGE_TIMEOUT });
      await new Promise((r) => setTimeout(r, 4000));

      const networks = await getNetworks(page);

      if (networks.length && JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const newOnes = networks.filter((n) => !lastNetworks.includes(n));
        if (newOnes.length) {
          await sendTelegramMessage(`🚀 发现新主网：${newOnes.join(", ")}`);
        }
        lastNetworks = networks;
      }
    } catch (err) {
      console.error("⚠️ 监控循环错误:", err.message);
    } finally {
      if (browser) await browser.close();
    }

    await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
  }
}

monitor();