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
// 统一清洗
function normalize(s) {
  return s
    .replace(/\s+/g, " ")
    .replace(/[^\S\r\n]+/g, " ")
    .trim();
}

// 黑名单（不会当作主网）
const STOP_WORDS = new Set([
  "select a network",
  "connect wallet",
  "okb",
  "uni",
  "okx",
  "wallet",
  "bridge",
  "swap",
  "stake",
  "pool",
  "settings"
]);

// 拆分长串里的候选 “XXX Mainnet / XXX Network”
function extractFromBlob(text) {
  const out = [];
  const re = /([A-Za-z0-9][A-Za-z0-9\s\-]*(?:Mainnet|Network))(?![A-Za-z])/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(normalize(m[1]));
  }
  return out;
}

async function getNetworks(page) {
  try {
    await page.waitForSelector("body", { timeout: 15000 });

    // 点开右上角“主网选择”
    const toggleSelector =
      'div[class*="sc-de7e8801-1"][class*="sc-1080dffc-0"][class*="sc-ec57e2f1-0"]';
    const toggle = await page.$(toggleSelector);
    if (toggle) {
      await toggle.click();
      await new Promise(r => setTimeout(r, 800));
    }

    // 可能的菜单容器（role 或常见类名 / data-state）
    const menuRootSelectors = [
      '[role="menu"]',
      '[role="listbox"]',
      '[data-state="open"]',
      '.menu',
      '.dropdown',
      '.popover',
    ];
    let menuRoot = null;
    for (const sel of menuRootSelectors) {
      const el = await page.$(sel);
      if (el) { menuRoot = el; break; }
    }

    let texts = [];
    const itemSelectors = [
      '[role="menuitem"]',
      '[role="option"]',
      'li',
      'button',
      'a',
      'div'
    ];

    if (menuRoot) {
      // 在菜单容器里逐个抓取候选项
      const sel = itemSelectors.map(s => `${s}`).join(", ");
      texts = await menuRoot.$$eval(sel, nodes =>
        nodes
          .map(n => n.innerText || n.textContent || "")
          .map(t => t.trim())
          .filter(Boolean)
      );
    } else {
      // 兜底：全局扫一遍
      texts = await page.$$eval("body *", nodes =>
        nodes
          .map(n => n.innerText || n.textContent || "")
          .map(t => t.trim())
          .filter(Boolean)
      );
    }

    // 归一化、过滤噪声
    let candidates = [];
    for (const t of texts) {
      const clean = normalize(t);
      if (!clean) continue;

      // 优先短文本直接判定；长文本用正则拆片
      if (clean.length <= 40) {
        candidates.push(clean);
      } else {
        candidates.push(...clean.match(/.{1,120}/g)); // 防止超长文本阻塞，后续再正则提取
      }
    }

    // 仅保留“以 Mainnet/Network 结尾”的项；对长串做正则提取
    let picked = [];
    for (const c of candidates) {
      if (/(?:Mainnet|Network)$/i.test(c)) {
        picked.push(c);
      } else if (c.length > 40) {
        picked.push(...extractFromBlob(c));
      }
    }

    // 清洗：黑名单、去重、长度限制
    picked = picked
      .map(normalize)
      .filter(x => x && x.length >= 3 && x.length <= 40)
      .filter(x => !STOP_WORDS.has(x.toLowerCase()))
      .filter(x => !/^x layer mainnetokb$/i.test(x)) // 处理你日志里拼接的特殊噪声
      .filter(x => !/connect$/i.test(x));

    // 进一步拆解拼接项（防止多个主网连在一起）
    let splitExpanded = [];
    for (const item of picked) {
      if (/\s(Mainnet|Network)\s/i.test(item)) {
        const parts = item.split(/(?<=Mainnet|Network)\s+/i).filter(Boolean);
      splitExpanded.push(...parts);
      } else {
        splitExpanded.push(item);
      }
    }

    // 清理与去重
    const unique = Array.from(
      new Set(
        splitExpanded
          .map(normalize)
          .filter(x => x && !STOP_WORDS.has(x.toLowerCase()))
      )
    ).sort((a, b) => a.localeCompare(b, "en"));

    // 输出与推送
    console.log("📋 当前主网列表:", unique);
    if (unique.length) {
      const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
      const msg = `📋 当前主网列表（${stamp}）：\n${unique.map(n => `• ${n}`).join("\n")}`;
      await sendTelegramMessage(msg);
    }

    return unique;
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
      await new Promise(r => setTimeout(r, 2000));

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