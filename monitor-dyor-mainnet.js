import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// ===== 环境变量 =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL     = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL, 10) : 60000;
const PAGE_TIMEOUT       = process.env.PAGE_TIMEOUT   ? parseInt(process.env.PAGE_TIMEOUT, 10)   : 60000;

let lastNetworks = [];
let failureCount = 0;

// ===== Telegram 推送 =====
async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ 未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，跳过推送。");
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    });
    console.log("📨 Telegram 推送成功:", message);
  } catch (err) {
    console.warn("⚠️ Telegram 推送失败:", err?.message || err);
  }
}

// ===== 自动安装 Chromium（与历史成功版一致）=====
async function ensureChromiumInstalled() {
  const chromeDir  = "./.local-chromium";
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

// ===== 启动 Puppeteer =====
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

// ===== 尝试展开“主网选择”下拉 =====
async function ensureMenuOpen(page) {
  // 如果已经能看到主网按钮，就不点开了
  const hasDirect = await page.evaluate(() => {
    return document.querySelectorAll('button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]').length > 0;
  });
  if (hasDirect) return;

  // 你提供过的 toggle 区域（右上角区域）的一些候选选择器
  const candidates = [
    // 典型组合类名容器（你曾贴的 dUUCVU / bHahRd / kaSfNO 类组合）
    'div[class*="sc-de7e8801-1"][class*="sc-1080dffc-0"][class*="sc-ec57e2f1-0"]',
    // 标题含“Select a Network”的父容器
    'div:has(> div[class*="sc-118b6623-0"]:matches-css-before(content))',
    // 直接用文本匹配（XPath）
  ];

  // 先尝试点击常见容器
  for (const sel of candidates) {
    const el = await page.$(sel);
    if (el) {
      await el.click().catch(() => {});
      await page.waitForTimeout ? await page.waitForTimeout(500) : await new Promise(r => setTimeout(r, 500));
      // 点击后再检测一次
      const opened = await page.evaluate(() => {
        return document.querySelectorAll('button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]').length > 0;
      });
      if (opened) return;
    }
  }

  // XPath 通过可见文本“Select a Network”寻找可点击区域
  const handles = await page.$x("//*[normalize-space(text())='Select a Network']");
  if (handles.length) {
    try {
      await handles[0].click();
      await page.waitForTimeout ? await page.waitForTimeout(500) : await new Promise(r => setTimeout(r, 500));
    } catch {}
  }
}

// ===== 抓取主网数据（保持历史成功的简洁提取策略）=====
async function getNetworks(page) {
  try {
    console.log("🌐 正在抓取主网列表...");

    // 等待基础 DOM
    await page.waitForSelector("body", { timeout: 60000 });

    // 确保下拉已展开（若已可见则不会多点）
    await ensureMenuOpen(page);

    // 最多 3 轮探测，给 React 一点渲染时间
    let found = false;
    for (let i = 1; i <= 3; i++) {
      const count = await page.evaluate(() => {
        return document.querySelectorAll('button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]').length;
      });
      if (count > 0) {
        found = true;
        break;
      }
      console.log(`⌛ 主网按钮未就绪，第 ${i} 次等待后重试...`);
      await new Promise(r => setTimeout(r, 1000 * i));
    }
    if (!found) throw new Error("未找到主网按钮元素，请检查页面结构。");

    // 直接从按钮内的文字提取（这是当时成功的关键）
    const texts = await page.$$eval(
      'button[class*="sc-d6870169-1"] div[class*="sc-118b6623-0"]',
      els => els.map(el => (el.textContent || "").trim()).filter(Boolean)
    );

    // 仅做最小清洗：保留包含关键字的项，去重、排序
    const normalize = s => s.replace(/\s+/g, " ").trim();
    const list = Array.from(new Set(
      texts
        .map(normalize)
        .filter(x => /(Mainnet|Network|Layer\s?\d+|Chain)/i.test(x))
    )).sort((a, b) => a.localeCompare(b, "en"));

    console.log("📋 当前主网列表:", list);

    if (list.length) {
      const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
      await sendTelegramMessage(`📋 当前主网列表（${stamp}）：\n${list.map(n => `• ${n}`).join("\n")}`);
    }

    return list;
  } catch (err) {
    console.error("❌ 主网抓取失败:", err.message);
    await sendTelegramMessage(`⚠️ 主网抓取失败: ${err.message}`);
    return [];
  }
}

// ===== 稳健的页面打开（最多 3 次）=====
async function openPage(browser, url) {
  const maxAttempts = 3;
  for (let i = 1; i <= maxAttempts; i++) {
    const page = await browser.newPage();
    try {
      console.log(`🌐 正在访问页面（第 ${i}/${maxAttempts} 次尝试）...`);
      await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: "domcontentloaded" });
      // 给首屏一点渲染时间
      await new Promise(r => setTimeout(r, 1500));
      return page;
    } catch (e) {
      console.warn(`⚠️ 加载失败（第 ${i} 次）：${e.message}`);
      await page.close().catch(() => {});
      if (i === maxAttempts) throw e;
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  throw new Error("无法打开页面");
}

// ===== 主监控循环（与历史成功版一致的节奏）=====
async function monitor() {
  console.log("🚀 DYOR 主网监控已启动...");
  await sendTelegramMessage("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  while (true) {
    let browser = null;
    try {
      browser = await launchBrowser();
      const page = await openPage(browser, "https://dyorswap.org");

      const networks = await getNetworks(page);
      await page.close().catch(() => {});

      if (networks.length && JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const added = networks.filter(n => !lastNetworks.includes(n));
        if (added.length) {
          await sendTelegramMessage(`🚀 发现新主网：${added.join(", ")}`);
        }
        lastNetworks = networks;
      }

      failureCount = 0;
    } catch (err) {
      failureCount++;
      console.error("⚠️ 监控循环错误:", err.message);
      if (failureCount === 1 || failureCount % 5 === 0) {
        await sendTelegramMessage(`⚠️ 网络/加载异常（连续 ${failureCount} 次失败），请检查服务或目标站点。`);
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }
}

// ===== 启动 =====
monitor();