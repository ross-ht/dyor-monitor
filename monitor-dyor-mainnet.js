import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// === 环境变量 ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL) : 30000;
const PAGE_TIMEOUT = process.env.PAGE_TIMEOUT ? parseInt(process.env.PAGE_TIMEOUT) : 15000;

let lastSent = 0;

// === Telegram 消息函数 ===
async function sendTelegramMessage(message) {
  try {
    const now = Date.now();
    if (now - lastSent < 1500) await new Promise((r) => setTimeout(r, 1500));
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

// === 调试函数：扫描页面结构（自动输出关键DOM信息） ===
async function debugDump(page) {
  console.log("🧪 调试：扫描页面结构中...");
  try {
    // 1️⃣ 查找包含 “Select a Network” 的元素
    const hits = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("*"));
      const arr = [];
      for (const el of els) {
        const txt = (el.innerText || el.textContent || "").trim();
        if (txt && /Select a Network/i.test(txt)) {
          arr.push({
            tag: el.tagName,
            role: el.getAttribute("role"),
            testid: el.getAttribute("data-testid"),
            classes: (el.className || "").toString().slice(0, 200),
            clickable: (getComputedStyle(el).cursor === "pointer") || !!el.onclick,
            outerHTML: el.outerHTML.slice(0, 400),
          });
        }
      }
      return arr.slice(0, 10);
    });

    console.log("🔎 包含“Select a Network”的元素：", hits);

    // 2️⃣ 查找主网项（带 data-testid 的按钮）
    const networks = await page.$$eval('button[data-testid^="rk-chain-option-"]', nodes =>
      nodes.slice(0, 5).map(n => n.outerHTML.slice(0, 300))
    );
    console.log("🔎 主网项 HTML 片段：", networks);
  } catch (e) {
    console.error("❌ 调试探测失败:", e.message);
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
  execSync(`PUPPETEER_CACHE_DIR=${chromeDir} npx puppeteer browsers install chrome`, { stdio: "inherit" });

  if (!fs.existsSync(chromePath)) {
    throw new Error("❌ Chromium 下载失败！");
  }

  console.log("✅ Chromium 下载完成。");
  return chromePath;
}

// === 启动浏览器 ===
async function launchBrowser() {
  const chromePath = await ensureChromiumInstalled();
  return puppeteer.launch({
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
}

// === 主程序 ===
async function monitor() {
  console.log("🚀 DYOR 主网调试模式启动...");
  await sendTelegramMessage("🧪 调试模式启动，开始扫描 DOM 结构...");

  try {
    const browser = await launchBrowser();
    const page = await browser.newPage();

    console.log("🌐 正在访问页面...");
    await page.goto("https://dyorswap.org", {
      timeout: 60000,
      waitUntil: "networkidle2",
    });

    await new Promise(r => setTimeout(r, 4000));
    await debugDump(page);

    await browser.close();
    console.log("✅ 调试任务完成。");
  } catch (err) {
    console.error("⚠️ 调试错误:", err.message);
    await sendTelegramMessage(`⚠️ 调试错误: ${err.message}`);
  }
}

monitor();