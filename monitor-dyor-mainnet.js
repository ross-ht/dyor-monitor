/**
 * DYOR Swap 主网监控脚本（含推送验证与断线重连）
 * 
 * 功能：
 *  - Puppeteer 动态网页抓取
 *  - 自动重连与网络重试
 *  - Telegram 推送（包括健康检测）
 *  - 环境变量配置
 * 
 * 环境变量：
 *  TELEGRAM_BOT_TOKEN=xxx
 *  TELEGRAM_CHAT_ID=xxx
 *  CHECK_INTERVAL=60000
 *  PAGE_TIMEOUT=60000
 *  CHROME_PATH=/usr/bin/chromium-browser
 */

 import puppeteer from "puppeteer";
 import axios from "axios";
 
 const CONFIG = {
   url: "https://dyorswap.org",
   interval: Number(process.env.CHECK_INTERVAL) || 60000,
   pageTimeout: Number(process.env.PAGE_TIMEOUT) || 60000,
   telegram: {
     token: process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN",
     chatId: process.env.TELEGRAM_CHAT_ID || "YOUR_CHAT_ID",
   },
   chromePath:
     process.env.CHROME_PATH ||
     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
 };
 
 let previousNetworks = [];
 let failureCount = 0;
 
 /** Telegram 推送 */
 async function sendTelegramMessage(message) {
   const url = `https://api.telegram.org/bot${CONFIG.telegram.token}/sendMessage`;
   try {
     await axios.post(url, {
       chat_id: CONFIG.telegram.chatId,
       text: message,
       parse_mode: "Markdown",
       sender_chat_id: CONFIG.telegram.chatId
     });
     console.log("📨 Telegram 推送成功:", message);
   } catch (err) {
     console.error("⚠️ Telegram 推送失败:", err.message);
   }
 }
 
 /** 启动 Puppeteer */
 async function launchBrowser() {
   try {
     const browser = await puppeteer.launch({
       headless: true,
       executablePath: CONFIG.chromePath,
       args: ["--no-sandbox", "--disable-setuid-sandbox"],
     });
     return browser;
   } catch (err) {
     console.error("🚫 启动 Chrome 失败:", err.message);
     await sendTelegramMessage("🚨 无法启动 Puppeteer，请检查 Chrome 路径！");
     throw err;
   }
 }
 
 /** 获取主网列表（含重试） */
 async function getNetworks(retry = 0) {
   let browser;
   try {
     browser = await launchBrowser();
     const page = await browser.newPage();
 
     page.setDefaultNavigationTimeout(CONFIG.pageTimeout);
     page.setDefaultTimeout(CONFIG.pageTimeout);
 
     console.log("🌐 正在访问页面...");
     await page.goto(CONFIG.url, {
       waitUntil: "networkidle2",
       timeout: CONFIG.pageTimeout,
     });
 
     await page.waitForSelector(".sc-de7e8801-1.dUUCVU", {
       timeout: CONFIG.pageTimeout,
     });
     await new Promise((r) => setTimeout(r, 3000));
 
     const networks = await page.evaluate(() => {
       return Array.from(document.querySelectorAll(".sc-de7e8801-1.fSxDht"))
         .map((el) => el.textContent.trim())
         .filter(Boolean);
     });
 
     await browser.close();
     failureCount = 0;
     return networks;
   } catch (err) {
     if (browser) await browser.close();
     console.error(`⚠️ 抓取失败（第 ${retry + 1} 次尝试）:`, err.message);
 
     if (retry < 3) {
       console.log("⏳ 3 秒后重试...");
       await new Promise((r) => setTimeout(r, 3000));
       return getNetworks(retry + 1);
     }
 
     failureCount++;
     await sendTelegramMessage(`⚠️ 网络异常（连续 ${failureCount} 次失败），请检查服务。`);
     throw err;
   }
 }
 
 /** 主监控逻辑 */
 async function monitor() {
   const now = new Date().toLocaleString();
   console.log(`🕒 ${now} - 检查主网变化中...`);
 
   // ✅ 推送 Telegram 健康检测消息
   await sendTelegramMessage(`🕒 监控心跳：正在检查主网变化中... (${now})`);
 
   try {
     const currentNetworks = await getNetworks();
 
     if (!previousNetworks.length) {
       previousNetworks = currentNetworks;
       console.log("📋 初始主网列表:", currentNetworks);
       return;
     }
 
     const newOnes = currentNetworks.filter((n) => !previousNetworks.includes(n));
     const removed = previousNetworks.filter((n) => !currentNetworks.includes(n));
 
     if (newOnes.length || removed.length) {
       let msg = `🔔 *DYOR Swap 主网变化检测*\n\n`;
       if (newOnes.length) msg += `🟢 新增主网:\n${newOnes.join("\n")}\n\n`;
       if (removed.length) msg += `🔴 移除主网:\n${removed.join("\n")}`;
       await sendTelegramMessage(msg);
       console.log(msg);
       previousNetworks = currentNetworks;
     } else {
       console.log("✅ 无主网变动");
     }
   } catch (err) {
     console.error("❌ 监控循环错误:", err.message);
   }
 }
 
 /** 主循环：带自动重连与错误恢复 */
 async function startMonitor() {
   console.log("🚀 DYOR 主网监控已启动...");
   await sendTelegramMessage("✅ DYOR 主网监控脚本已启动，开始检测主网变化。");
 
   while (true) {
     try {
       await monitor();
     } catch (err) {
       console.error("💥 主循环异常:", err.message);
       await sendTelegramMessage(`💥 监控异常：${err.message}`);
     }
 
     await new Promise((r) => setTimeout(r, CONFIG.interval));
   }
 }
 
 startMonitor();