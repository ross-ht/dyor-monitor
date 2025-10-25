import puppeteer from "puppeteer";
import axios from "axios";
import fs from "fs";
import { execSync } from "child_process";

// ===== 环境变量 =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL     = parseInt(process.env.CHECK_INTERVAL || "60000", 10);  // 60s
const PAGE_TIMEOUT_MS    = parseInt(process.env.PAGE_TIMEOUT  || "90000", 10);   // 90s
const TARGET_URL         = "https://dyorswap.org";

let lastNetworks = [];
let failureCount = 0;
let lastSentAt = 0;

// ===== 工具 =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendTelegram(text) {
  try {
    const now = Date.now();
    if (now - lastSentAt < 1500) await sleep(1500);
    lastSentAt = now;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
    });
    console.log("📨 Telegram 推送成功:", text);
  } catch (e) {
    console.warn("⚠️ Telegram 推送失败:", e?.message || e);
  }
}

// ===== 自动安装 Chromium（沿用你稳定的缓存路径）=====
async function ensureChromiumInstalled() {
  const cacheDir  = "./.local-chromium";
  const chromeBin = `${cacheDir}/chrome/linux-141.0.7390.76/chrome-linux64/chrome`;
  if (fs.existsSync(chromeBin)) {
    console.log("✅ Chromium 已存在，无需重新下载。");
    return chromeBin;
  }
  console.log("⬇️ 正在下载 Chromium...");
  execSync(`mkdir -p ${cacheDir}`, { stdio: "inherit" });
  execSync(`PUPPETEER_CACHE_DIR=${cacheDir} npx puppeteer browsers install chrome`, { stdio: "inherit" });
  if (!fs.existsSync(chromeBin)) throw new Error("❌ Chromium 下载失败！");
  console.log("✅ Chromium 下载完成。");
  return chromeBin;
}

// ===== 启动浏览器 =====
async function launchBrowser() {
  const executablePath = await ensureChromiumInstalled();
  return puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
    ],
  });
}

// ===== 只在这里做 goto（避免重复访问导致双重超时）=====
async function openPage(browser) {
  const page = await browser.newPage();

  // 设定 UA / 语言 / 视口，提升稳定性
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" });
  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });

  // 只拦截图片/字体/媒体，保留脚本与样式（菜单需要脚本渲染）
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "media" || type === "font") req.abort();
    else req.continue();
  });

  const maxAttempts = 3;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      console.log(`🌐 正在访问页面（第 ${i}/${maxAttempts} 次尝试）...`);
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      await sleep(1500 * i); // 给首屏/脚本一点渲染时间
      return page;
    } catch (e) {
      console.warn(`⚠️ 访问失败（第 ${i} 次）: ${e.message}`);
      if (i === maxAttempts) throw e;
      await sleep(2000 * i);
    }
  }
  throw new Error("无法打开页面");
}

// ===== 展开主网菜单（新版 RainbowKit 选择器优先）=====
async function ensureMenuOpen(page) {
  console.log("🌐 尝试展开主网菜单...");
  const openSelectors = [
    'button[data-testid="rk-chain-button"]',      // RainbowKit 切换网络按钮（常见）
    'button[aria-haspopup="dialog"]',             // 可能的通用弹窗触发
    'button:has(div:has-text("Select a Network"))'// 文本兜底（Puppeteer 支持 :has-text）
  ];

  // 如果主网项已出现，直接返回
  const alreadyVisible = await page.$('button[data-testid^="rk-chain-option-"]');
  if (alreadyVisible) return true;

  for (let i = 1; i <= 5; i++) {
    try {
      let clicked = false;
      for (const sel of openSelectors) {
        const handle = await page.$(sel);
        if (handle) {
          await handle.click().catch(() => {});
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        // 再尝试一次：页面任何可见按钮里是否包含“Select a Network”
        const clickedByEval = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          for (const b of buttons) {
            const t = (b.innerText || b.textContent || "").trim();
            if (/Select a Network/i.test(t)) { b.click(); return true; }
          }
          return false;
        });
        if (!clickedByEval) {
          await sleep(700);
        }
      }

      // 检查是否出现主网项
      const ok = await page.$('button[data-testid^="rk-chain-option-"]');
      if (ok) {
        console.log(`✅ 菜单已展开（第 ${i} 次尝试）`);
        return true;
      }
    } catch (e) {
      console.warn(`⚠️ 展开菜单失败（第 ${i} 次）: ${e.message}`);
    }
    await sleep(600 * i);
  }
  console.warn("⚠️ 未能确认菜单已展开");
  return false;
}

// ===== 从已展开的菜单中提取主网列表（基于你提供的最新 HTML）=====
async function extractNetworks(page) {
  console.log("🌐 抓取主网列表...");
  const found = await page.$('button[data-testid^="rk-chain-option-"]');
  if (!found) throw new Error("⚠️ 未检测到主网选项结点。");

  const list = await page.$$eval('button[data-testid^="rk-chain-option-"]', (buttons) => {
    const out = [];
    for (const btn of buttons) {
      // 文本优先取最后一个 div 的文字，兜底读 aria-label
      const label =
        btn.querySelector("div:last-child")?.textContent?.trim() ||
        btn.querySelector("[aria-label]")?.getAttribute("aria-label") ||
        "";
      // 过滤“已连接”等杂项；保留没有 Mainnet/Network 但确为主网名的（Ink、Base、Linea、Berachain）
      if (
        label &&
        !/已连接/i.test(label) &&
        /Mainnet|Network|Layer|Chain|Base|Ink|Linea|Berachain/i.test(label)
      ) {
        out.push(label.replace(/\s+/g, " ").trim());
      }
    }
    return Array.from(new Set(out)).sort((a, b) => a.localeCompare(b, "en"));
  });

  if (!list.length) throw new Error("⚠️ 页面已加载但未解析到主网文本。");
  return list;
}

// ===== 统一的抓取流程（不再调用 goto，这里只做展开 + 提取）=====
async function getNetworks(page) {
  // 最多 3 轮：每轮尝试展开 + 提取
  for (let round = 1; round <= 3; round++) {
    try {
      const opened = await ensureMenuOpen(page);
      if (!opened) {
        await sleep(800 * round);
      }
      const networks = await extractNetworks(page);
      console.log("📋 当前主网列表:", networks);

      const msg = `📋 当前主网列表（${new Date().toLocaleString("zh-CN", { hour12: false })}）：\n` +
                  networks.map(n => `• ${n}`).join("\n");
      await sendTelegram(msg);

      return networks;
    } catch (e) {
      console.warn(`⚠️ 第 ${round} 轮抓取失败：${e.message}`);
      if (round === 3) {
        await sendTelegram(`⚠️ 主网抓取失败：${e.message}`);
        return [];
      }
      await sleep(1500 * round);
    }
  }
  return [];
}

// ===== 主循环 =====
async function monitor() {
  console.log("🚀 DYOR 主网监控已启动...");
  await sendTelegram("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");

  while (true) {
    const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
    console.log(`🕒 ${stamp} - 检查主网变化中...`);

    let browser = null;
    try {
      browser = await launchBrowser();
      const page = await openPage(browser);       // 只在这里 goto 一次
      const networks = await getNetworks(page);   // 不再 goto，只负责展开+提取
      await page.close().catch(() => {});

      if (networks.length && JSON.stringify(networks) !== JSON.stringify(lastNetworks)) {
        const added = networks.filter(n => !lastNetworks.includes(n));
        if (added.length) {
          await sendTelegram(`🚀 发现新主网：${added.join(", ")}`);
        }
        lastNetworks = networks;
      }

      failureCount = 0;
    } catch (err) {
      failureCount++;
      console.error("⚠️ 监控循环错误:", err.message);
      if (failureCount === 1 || failureCount % 5 === 0) {
        await sendTelegram(`⚠️ 网络/加载异常（连续 ${failureCount} 次失败），请检查服务或目标站点。`);
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    await sleep(CHECK_INTERVAL);
  }
}

// ===== 启动 =====
(async () => {
  try {
    await monitor();
  } catch (e) {
    console.error("❌ 脚本异常终止：", e);
    process.exit(1);
  }
})();

export default monitor;