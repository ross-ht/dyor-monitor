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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===== Telegram 推送（带轻限流）=====
async function sendTelegram(text) {
  try {
    const now = Date.now();
    if (now - lastSentAt < 1500) await sleep(1500);
    lastSentAt = now;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
    });
    console.log("📨 Telegram 推送成功:", text.split("\n")[0]);
  } catch (e) {
    console.warn("⚠️ Telegram 推送失败:", e?.message || e);
  }
}

// ===== 自动安装 Chromium（使用 Puppeteer 自带浏览器；不要配 CHROME_PATH）=====
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

// ===== 只在这里 goto（避免重复访问导致超时）=====
async function openPage(browser) {
  const page = await browser.newPage();

  // 稳定性：UA / 语言 / 视口
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" });
  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });

  // 仅拦截图片/字体/媒体，保留脚本与样式，保证菜单能渲染
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "image" || t === "media" || t === "font") req.abort();
    else req.continue();
  });

  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`🌐 正在访问页面（第 ${i}/3 次）...`);
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      await sleep(1200 * i); // 给首屏/脚本一点渲染时间
      return page;
    } catch (e) {
      console.warn(`⚠️ 访问失败（第 ${i} 次）: ${e.message}`);
      if (i === 3) throw e;
      await sleep(1800 * i);
    }
  }
  throw new Error("无法打开页面");
}

// ===== 展开主网菜单（兼容旧版选择器能力）=====
async function ensureMenuOpen(page) {
  console.log("🌐 尝试展开主网菜单...");

  // 如果已经能看到主网项，这一步跳过
  if (await page.$('button[data-testid^="rk-chain-option-"]')) return true;

  // 首选可能的触发按钮（RainbowKit / 通用 modal 触发）
  const selectors = [
    'button[data-testid="rk-chain-button"]',
    'button[aria-haspopup="dialog"]'
  ];

  for (let i = 1; i <= 5; i++) {
    let clicked = false;

    // 1) 已知选择器尝试
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click(); clicked = true; break; }
      } catch {}
    }

    // 2) 文本兜底（不使用 :has / :has-text；用 evaluate 遍历）
    if (!clicked) {
      try {
        clicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          for (const b of btns) {
            const txt = (b.innerText || b.textContent || "").trim();
            if (/Select a Network/i.test(txt)) { b.click(); return true; }
          }
          return false;
        });
      } catch {}
    }

    // 检查是否已出现主网项
    if (clicked) {
      await sleep(700 * i);
      if (await page.$('button[data-testid^="rk-chain-option-"]')) {
        console.log(`✅ 菜单已展开（第 ${i} 次尝试）`);
        return true;
      }
    }

    await sleep(500 * i);
  }

  console.warn("⚠️ 未能确认菜单已展开");
  return false;
}

// ===== 提取主网列表（基于你提供的新 HTML 结构）=====
async function extractNetworks(page) {
  console.log("🌐 抓取主网列表...");
  // 先确保至少有一个主网按钮可见
  if (!(await page.$('button[data-testid^="rk-chain-option-"]'))) {
    throw new Error("⚠️ 未检测到主网选项结点。");
  }

  const list = await page.$$eval('button[data-testid^="rk-chain-option-"]', (buttons) => {
    const results = [];
    for (const btn of buttons) {
      // 文本优先取最后一个 div 的内容；兜底读 aria-label
      const textDiv = btn.querySelector("div:last-child");
      const label =
        (textDiv && (textDiv.textContent || "").trim()) ||
        (btn.querySelector("[aria-label]")?.getAttribute("aria-label") || "").trim();

      // 过滤“已连接”等状态；保留没有 Mainnet/Network 但确属主网名的关键名字
      if (
        label &&
        !/已连接/i.test(label) &&
        /Mainnet|Network|Layer|Chain|Base|Ink|Linea|Berachain|Cronos|Uni|Sonic|Hyper|Morph|Plasma|Gate|X Layer/i.test(label)
      ) {
        results.push(label.replace(/\s+/g, " ").trim());
      }
    }
    return Array.from(new Set(results)).sort((a, b) => a.localeCompare(b, "en"));
  });

  if (!list.length) throw new Error("⚠️ 页面已加载但未解析到主网文本。");
  return list;
}

// ===== 封装：只做展开 + 提取，不做 goto =====
async function getNetworks(page) {
  for (let round = 1; round <= 3; round++) {
    try {
      const opened = await ensureMenuOpen(page);
      if (!opened) await sleep(600 * round);

      const networks = await extractNetworks(page);
      return networks;
    } catch (e) {
      console.warn(`⚠️ 第 ${round} 轮抓取失败：${e.message}`);
      if (round === 3) throw e;
      await sleep(1200 * round);
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
      const page = await openPage(browser);              // 只在这里 goto
      const networks = await getNetworks(page);          // 只展开 + 提取
      await page.close().catch(() => {});

      // 每次都推送完整主网列表（你要求“包含推送”）
      if (networks.length) {
        const msg = `📋 当前主网列表（${new Date().toLocaleString("zh-CN", { hour12: false })}）：\n` +
                    networks.map(n => `• ${n}`).join("\n");
        await sendTelegram(msg);
      }

      // 若有新增，再单独推送“发现新主网”
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