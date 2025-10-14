import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// === 环境变量 ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "60000");
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "60000");

let lastNetworks = [];
let failureCount = 0;
let lastSent = 0;

// === Telegram 推送函数 ===
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
  if (fs.existsSync(chromePath)) return chromePath;

  console.log("⬇️ 正在下载 Chromium...");
  execSync(`mkdir -p ${chromeDir}`, { stdio: "inherit" });
  execSync(`PUPPETEER_CACHE_DIR=${chromeDir} npx puppeteer browsers install chrome`, { stdio: "inherit" });
  if (!fs.existsSync(chromePath)) throw new Error("❌ Chromium 下载失败！");
  console.log("✅ Chromium 下载完成。");
  return chromePath;
}

// === 启动 Puppeteer 浏览器 ===
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

// === 尝试展开“主网选择”菜单 ===
async function ensureMenuOpen(page) {
  const hasButtons = await page.evaluate(() => {
    return document.querySelectorAll('button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]').length > 0;
  });
  if (hasButtons) return;

  const candidates = [
    'div[class*="sc-de7e8801-1"][class*="sc-1080dffc-0"][class*="sc-ec57e2f1-0"]',
    'div[class*="dUUCVU"]',
    'div[class*="sc-2371b370-0"]',
    'div:has-text("Select a Network")',
  ];

  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click().catch(() => {});
        await new Promise(r => setTimeout(r, 800));
        const opened = await page.evaluate(() => {
          return document.querySelectorAll('button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]').length > 0;
        });
        if (opened) return;
      }
    } catch (_) {}
  }

  // === XPath 兜底方案 ===
  const clicked = await page.evaluate(() => {
    try {
      const xpath = "//*[contains(normalize-space(text()), 'Select a Network')]";
      const it = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      if (it.snapshotLength > 0) {
        const node = it.snapshotItem(0);
        if (node instanceof HTMLElement) {
          node.click();
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  });
  if (clicked) await new Promise(r => setTimeout(r, 800));
}

// === 抓取主网列表 ===
async function getNetworks(page) {
  try {
    console.log("🌐 正在访问页面（最多 3 次尝试）...");
    let success = false;
    for (let i = 1; i <= 3; i++) {
      try {
        console.log(`🌐 正在访问页面（第 ${i}/3 次尝试）...`);
        await page.goto("https://dyorswap.org", {
          waitUntil: ["domcontentloaded"], // 更宽松
          timeout: 90000, // 90 秒
        });
        success = true;
        break;
      } catch (e) {
        console.warn(`⚠️ 第 ${i} 次访问失败: ${e.message}`);
        if (i < 3) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        } else {
          throw e;
        }
      }
    }

    if (!success) throw new Error("无法访问 dyorswap.org");

    console.log("🌐 正在等待页面元素渲染...");
    await page.waitForSelector("body", { timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    await ensureMenuOpen(page);
    console.log("🌐 正在抓取主网列表...");

    const networks = await page.evaluate(() => {
      const items = Array.from(
        document.querySelectorAll('button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]')
      );
      return items.map(el => el.textContent.trim()).filter(Boolean);
    });

    const cleaned = Array.from(new Set(networks))
      .map(n => n.replace(/\s+/g, " ").trim())
      .filter(n => /Mainnet|Network/i.test(n))
      .sort((a, b) => a.localeCompare(b, "en"));

    if (!cleaned.length) throw new Error("⚠️ 未检测到任何主网，请检查页面结构。");

    console.log("📋 当前主网列表:", cleaned);
    await sendTelegramMessage(
      `📋 当前主网列表（${new Date().toLocaleString("zh-CN", { hour12: false })}）：\n${cleaned
        .map(x => `• ${x}`)
        .join("\n")}`
    );
    return cleaned;
  } catch (err) {
    console.error("❌ 主网抓取失败:", err.message);
    await sendTelegramMessage(`⚠️ 主网抓取失败: ${err.message}`);
    return [];
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

// === 启动主程序 ===
(async () => {
  try {
    await monitor();
  } catch (err) {
    console.error("❌ 脚本异常终止:", err);
    process.exit(1);
  }
})();