import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "30000");
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || "15000");

let lastSent = 0;
let lastNetworks = [];
let failureCount = 0;

// === Telegram ===
async function sendTelegramMessage(message) {
  try {
    const now = Date.now();
    if (now - lastSent < 1500) await delay(1500);
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

// === 确保 Chromium ===
async function ensureChromiumInstalled() {
  const chromeDir = "./.local-chromium";
  const chromePath = `${chromeDir}/chrome/linux-141.0.7390.76/chrome-linux64/chrome`;
  if (fs.existsSync(chromePath)) return chromePath;

  console.log("⬇️ 正在下载 Chromium...");
  execSync(`mkdir -p ${chromeDir}`, { stdio: "inherit" });
  execSync(`PUPPETEER_CACHE_DIR=${chromeDir} npx puppeteer browsers install chrome`, {
    stdio: "inherit",
  });
  if (!fs.existsSync(chromePath)) throw new Error("❌ Chromium 下载失败！");
  console.log("✅ Chromium 下载完成。");
  return chromePath;
}

// === 启动 Puppeteer ===
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

// === 页面访问重试 ===
async function safeGoto(page, url, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`🌐 正在访问页面（第 ${i + 1} 次尝试）...`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForSelector("body", { timeout: 20000 });
      console.log("✅ 页面加载成功");
      await delay(4000);
      return true;
    } catch (err) {
      console.warn(`⚠️ 加载失败（第 ${i + 1} 次尝试）: ${err.message}`);
      if (i < maxRetries - 1) {
        console.log("⏳ 3 秒后重试...");
        await delay(3000);
      } else {
        await sendTelegramMessage("⚠️ 页面加载失败，无法访问目标网站。");
        return false;
      }
    }
  }
}

// === 主网抓取逻辑 ===
async function getNetworks(page) {
  try {
    await page.waitForSelector("body", { timeout: 15000 });

    // 打开右上角选择框
    const toggleSelector =
      'div[class*="sc-de7e8801-1"][class*="sc-1080dffc-0"][class*="sc-ec57e2f1-0"]';
    const toggle = await page.$(toggleSelector);
    if (toggle) {
      await toggle.click();
      await delay(1500); // 增加延迟以确保菜单加载完毕
    }

    // 提取所有文本（处理换行+拼接）
    let texts = await page.$$eval("*", (nodes) =>
      nodes
        .map((n) => (n.innerText || n.textContent || "").replace(/\n+/g, " "))
        .map((t) => t.trim())
        .filter(Boolean)
    );

    // 处理驼峰与数字粘连（GateLayerL2 / NetworkL1）
    texts = texts
      .flatMap((t) =>
        t.split(
          /(?<=[a-z0-9])(?=[A-Z])|(?<=Layer)(?=\d)|(?<=Network)(?=L\d)/
        )
      )
      .filter(Boolean);

    function normalize(s) {
      return s.replace(/\s+/g, " ").trim();
    }

    // === 改进版正则 ===
    const regex =
      /\b([A-Za-z0-9][A-Za-z0-9\s\-]*(?:Layer\s?\d+\s*)?(?:Mainnet|Network|Chain)(?:\s*L\d+)?|X\s*Layer\s*Mainnet|Gate\s*Layer\s*L2|Gate\s*Network\s*L1)\b/gi;

    let results = [];
    for (const text of texts) {
      let match;
      while ((match = regex.exec(text)) !== null) {
        results.push(normalize(match[1]));
      }
    }

    // === 动态过滤配置 ===
    const STOP_WORDS = [
      "select a network", "connect wallet", "okb", "uni", "okx", "wallet",
      "bridge", "swap", "stake", "pool", "settings", "dyor", "home", "launch",
      "create", "try", "install", "with", "click", "works", "to", "extension",
      "data", "crypto", "me", "involve", "fun", "listed", "private key", "apps",
      "scan", "connect", "coinbase"
    ];

    // ✅ 白名单
    const SAFE_WORDS = [
      "okb network",
      "uni network",
      "dyor network",
      "gate layer l2",
      "gate network l1",
      "x layer mainnet"
    ];

    // === 动态安全过滤 ===
    let filtered = results
      .map(normalize)
      .filter(
        (x) =>
          x &&
          x.length >= 3 &&
          x.length <= 40 &&
          (
            SAFE_WORDS.some((s) => x.toLowerCase().includes(s)) ||
            !STOP_WORDS.some((w) => new RegExp(`\\b${w}\\b`, "i").test(x))
          )
      )
      .filter((x) => /(Mainnet|Network|Layer\s?\d+|Chain)$/i.test(x))
      .filter((x) => !/[|,.:;@]/.test(x))
      .filter((x) => !/\b(with|to|and|for)\b/i.test(x));

    const unique = Array.from(new Set(filtered)).sort((a, b) =>
      a.localeCompare(b, "en")
    );

    console.log("📋 当前主网列表:", unique);

    if (unique.length) {
      const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
      const msg = `📋 当前主网列表（${stamp}）：\n${unique
        .map((n) => `• ${n}`)
        .join("\n")}`;
      await sendTelegramMessage(msg);
    } else {
      await sendTelegramMessage("⚠️ 未检测到任何主网，请检查页面结构是否有更新。");
    }

    return unique;
  } catch (err) {
    console.error("❌ 主网抓取失败:", err.message);
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
    await sendTelegramMessage(`🕒 监控心跳：正在检查主网变化中... (${now})`);

    let browser = null;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      const ok = await safeGoto(page, "https://dyorswap.org");
      if (!ok) continue;

      const networks = await getNetworks(page);
      if (!lastNetworks.length && networks.length) {
        await sendTelegramMessage(
          `✅ 当前检测到 ${networks.length} 个主网：\n${networks
            .map((n) => `• ${n}`)
            .join("\n")}`
        );
      }

      if (networks.length && JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const newOnes = networks.filter((n) => !lastNetworks.includes(n));
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

    await delay(CHECK_INTERVAL);
  }
}

monitor();