// monitor-dyor-mainnet.js (v2.2)
import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// === 环境变量 ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "30000", 10);
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "15000", 10);

let lastSent = 0;
let lastNetworks = [];
let failureCount = 0;

// === Telegram 推送（带限流） ===
async function sendTelegramMessage(message) {
  try {
    const now = Date.now();
    if (now - lastSent < 1500) await new Promise((r) => setTimeout(r, 1500));
    lastSent = now;
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message }
    );
    console.log("📨 Telegram 推送成功:", message);
  } catch (err) {
    console.warn("⚠️ Telegram 推送失败:", err.message || err);
  }
}

// === 确保 Chromium 已安装 ===
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

  if (!fs.existsSync(chromePath)) throw new Error("❌ Chromium 下载失败！");
  console.log("✅ Chromium 下载完成。");
  return chromePath;
}

// === 启动 Puppeteer ===
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

// === 抓取主网列表（v2.2） ===
async function getNetworks(page) {
  try {
    console.log("🌐 正在等待主网菜单渲染...");
    // 等待网页主框架加载完成
    await page.waitForSelector("div.sc-de7e8801-1", { timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000)); // 延迟以等待 React 渲染

    // 等待主网按钮加载（类名支持模糊匹配）
    await page.waitForFunction(() => {
      return document.querySelectorAll(
        'button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]'
      ).length > 0;
    }, { timeout: 60000 });

    // 抓取主网名称文本
    const rawList = await page.$$eval(
      'button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]',
      els => els.map(el => el.textContent.trim()).filter(Boolean)
    );

    if (!rawList.length) {
      console.warn("⚠️ 未检测到任何主网项。");
      await sendTelegramMessage("⚠️ 未检测到任何主网，请检查页面结构是否有更新。");
      return [];
    }

    // === 数据清洗 ===
    const normalize = s => s.replace(/\s+/g, " ").trim();
    const STOP_WORDS = new Set(["select a network", "okb", "wallet", "bridge", "swap", "connect"]);

    // 正则提取合法主网名称
    const extracted = [];
    const re = /([A-Za-z0-9\- ]+(?:Mainnet|Network|Layer\s?\d+|Chain))/gi;
    for (const line of rawList) {
      const clean = normalize(line);
      if (!clean) continue;

      let matches = clean.match(re);
      if (matches) extracted.push(...matches.map(m => normalize(m)));
      else if (!STOP_WORDS.has(clean.toLowerCase())) extracted.push(clean);
    }

    // 去重、排序
    const unique = Array.from(new Set(extracted)).sort((a, b) =>
      a.localeCompare(b, "en")
    );

    console.log("📋 当前主网列表:", unique);
    if (unique.length) {
      const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
      const msg =
        `📋 当前主网列表（${stamp}）：\n` +
        unique.map(n => `• ${n}`).join("\n");
      await sendTelegramMessage(msg);
    }

    return unique;
  } catch (err) {
    console.error("❌ 主网抓取失败:", err.message);
    await sendTelegramMessage(`⚠️ 启动时未检测到主网，请检查网页结构。\n错误：${err.message}`);
    return [];
  }
}

// === 主监控逻辑 ===
async function monitor() {
  console.log("🚀 DYOR 主网监控已启动...");
  await sendTelegramMessage("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  // 启动时先抓一次并推送汇总
  try {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto("https://dyorswap.org", {
      timeout: PAGE_TIMEOUT * 2,          // 双倍超时，提升容错
      waitUntil: "domcontentloaded",      // 改为更宽容的事件
    });

    // 等待主内容渲染完成（网站框架加载完成的标志）
    await page.waitForSelector("div.sc-de7e8801-1", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
    const initialNetworks = await getNetworks(page);
    if (initialNetworks.length > 0) {
      await sendTelegramMessage(
        `✅ 初始检测成功，共发现 ${initialNetworks.length} 个主网：\n${initialNetworks
          .map((n) => `• ${n}`)
          .join("\n")}`
      );
      lastNetworks = initialNetworks;
    } else {
      await sendTelegramMessage("⚠️ 启动时未检测到主网，请检查网页结构。");
    }
    await browser.close();
  } catch (err) {
    console.error("⚠️ 启动初次检测失败:", err.message);
  }

  // === 进入循环监控 ===
  while (true) {
    const now = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`🕒 ${now} - 检查主网变化中...`);
    // await sendTelegramMessage(`🕒 监控心跳：正在检查主网变化中... (${now})`);

    let browser = null;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.goto("https://dyorswap.org", {
        timeout: 60000,
        waitUntil: "networkidle2",
      });
      await new Promise((r) => setTimeout(r, 2000));

      const networks = await getNetworks(page);

      // 检测新增主网
      if (
        networks.length &&
        JSON.stringify(networks) !== JSON.stringify(lastNetworks)
      ) {
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
        await sendTelegramMessage(
          `⚠️ 网络异常（连续 ${failureCount} 次失败），请检查服务。`
        );
      }
    } finally {
      if (browser) await browser.close();
    }

    await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
  }
}

// === 启动 ===
monitor();