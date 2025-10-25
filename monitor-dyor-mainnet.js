import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL) : 60000;
const PAGE_TIMEOUT = process.env.PAGE_TIMEOUT ? parseInt(process.env.PAGE_TIMEOUT) : 90000;

let lastNetworks = [];
let failureCount = 0;

async function sendTelegramMessage(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    });
    console.log("📨 Telegram 推送成功:", message);
  } catch (err) {
    console.warn("⚠️ Telegram 推送失败:", err.message || err);
  }
}

async function ensureChromiumInstalled() {
  const chromeDir = "./.local-chromium";
  const chromePath = `${chromeDir}/chrome/linux-141.0.7390.76/chrome-linux64/chrome`;

  if (fs.existsSync(chromePath)) {
    console.log("✅ Chromium 已存在，无需重新下载。");
    return chromePath;
  }

  console.log("⬇️ 正在下载 Chromium...");
  execSync(`mkdir -p ${chromeDir}`, { stdio: "inherit" });
  execSync(`PUPPETEER_CACHE_DIR=${chromeDir} npx puppeteer browsers install chrome`, {
    stdio: "inherit",
  });

  if (!fs.existsSync(chromePath)) {
    throw new Error("❌ Chromium 下载失败！");
  }

  console.log("✅ Chromium 下载完成。");
  return chromePath;
}

async function launchBrowser() {
  try {
    const chromePath = await ensureChromiumInstalled();
    return await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
      ],
    });
  } catch (err) {
    console.error("🚫 启动 Chrome 失败:", err.message);
    await sendTelegramMessage("🚨 无法启动 Puppeteer，请检查 Chromium 路径配置！");
    throw err;
  }
}

// ✅ 替换版：确保菜单展开（兼容所有 Puppeteer）
async function ensureMenuOpen(page) {
  console.log("🌐 尝试展开主网菜单...");

  const selectors = [
    'button[data-testid="rk-chain-button"]',
    'button[aria-haspopup="dialog"]'
  ];

  const alreadyOpen = await page.$('button[data-testid^="rk-chain-option-"]');
  if (alreadyOpen) {
    console.log("✅ 菜单已展开（检测到主网选项）");
    return true;
  }

  for (let i = 1; i <= 4; i++) {
    let clicked = false;
    try {
      // 优先查找已知按钮
      for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          clicked = true;
          break;
        }
      }

      // 回退：在浏览器端按文本匹配
      if (!clicked) {
        clicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          for (const b of btns) {
            const txt = (b.innerText || b.textContent || "").trim();
            if (/Select a Network/i.test(txt)) {
              b.click();
              return true;
            }
          }
          return false;
        });
      }

      if (clicked) {
        await new Promise((r) => setTimeout(r, 800 * i));
        const ok = await page.$('button[data-testid^="rk-chain-option-"]');
        if (ok) {
          console.log(`✅ 菜单已展开（第 ${i} 次尝试）`);
          return true;
        }
      }
    } catch (e) {
      console.warn(`⚠️ 展开菜单失败（第 ${i} 次）: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 600 * i));
  }

  console.warn("⚠️ 未能确认菜单已展开");
  return false;
}

// ✅ 抓取主网名称
async function getNetworks(page) {
  console.log("🌐 抓取主网列表...");

  const networks = await page.$$eval(
    'button[data-testid^="rk-chain-option-"] div[class*="ju367v1h"] div:last-child',
    (nodes) =>
      Array.from(nodes)
        .map((n) => (n.innerText || n.textContent || "").trim())
        .filter(Boolean)
  );

  if (!networks.length) throw new Error("⚠️ 未检测到任何主网，请检查页面结构。");
  return [...new Set(networks)];
}

// ✅ 主流程
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

      console.log("🌐 正在访问页面...");
      await page.goto("https://dyorswap.org", { timeout: PAGE_TIMEOUT, waitUntil: "domcontentloaded" });

      await ensureMenuOpen(page);

      const networks = await getNetworks(page);
      console.log("📋 当前主网列表:", networks);

      if (JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
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
      if (failureCount === 1 || failureCount % 5 === 0)
        await sendTelegramMessage(`⚠️ 网络异常（连续 ${failureCount} 次失败），请检查服务。`);
    } finally {
      if (browser) await browser.close();
    }

    await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
  }
}

monitor();