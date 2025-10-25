/**
 * DyorSwap 主网监控脚本（自动发现最新 _app-*.js 文件）
 * ----------------------------------------------------
 * 运行示例：
 *   node monitor-dyor-mainnet.js          # 循环模式（每分钟检测）
 *   node monitor-dyor-mainnet.js --once   # 仅运行一次检测
 */

import fs from "fs";
import fetch from "node-fetch";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import dotenv from "dotenv";

dotenv.config();

const siteUrl = "https://dyorswap.org";
const outputFile = "./chains.json";
const intervalMs = 60 * 1000; // 每分钟检测一次
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const onceMode = process.argv.includes("--once");

/* ========== 🧩 Telegram 通知 ========== */
async function sendTelegram(message) {
  if (!botToken || !chatId) return console.warn("⚠️ 未配置 Telegram 推送参数，跳过发送。");
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    console.log("📨 Telegram 推送成功。");
  } catch (err) {
    console.error("⚠️ Telegram 推送失败:", err.message);
  }
}

/* ========== 🔍 自动获取最新 _app-*.js 链接 ========== */
async function getLatestAppJsUrl() {
  const html = await fetch(siteUrl).then((res) => res.text());
  const match = html.match(/\/_next\/static\/chunks\/pages\/_app-[a-z0-9]+\.js/);
  if (!match) throw new Error("未找到 _app-*.js 文件路径");
  return siteUrl + match[0];
}

/* ========== 📦 抓取 JS 并解析主网数据 ========== */
async function fetchJsFile(url) {
  console.log(`🕒 正在抓取主网配置: ${url}`);
  const res = await fetch(url, { headers: { "accept-encoding": "identity" } });
  if (!res.ok) throw new Error(`请求失败: ${res.status}`);
  return await res.text();
}

function extractChains(jsText) {
  const ast = acorn.parse(jsText, { ecmaVersion: "latest", sourceType: "module" });
  const results = [];

  walk.full(ast, (node) => {
    if (node.type === "ObjectExpression") {
      const keys = node.properties.map((p) => p.key?.name || p.key?.value).filter(Boolean);

      if (keys.includes("iconUrl") && keys.includes("nativeCurrency")) {
        const entry = {};
        for (const p of node.properties) {
          const key = p.key?.name || p.key?.value;
          if (!key) continue;

          if (p.value.type === "Literal") {
            entry[key] = p.value.value;
          } else if (p.value.type === "ObjectExpression") {
            entry[key] = {};
            for (const sub of p.value.properties || []) {
              const subKey = sub.key?.name || sub.key?.value;
              if (sub.value.type === "Literal") {
                entry[key][subKey] = sub.value.value;
              }
            }
          }
        }

        if (entry.id && entry.name && entry.iconUrl && entry.nativeCurrency) {
          results.push(entry);
        }
      }
    }
  });

  return results;
}

/* ========== 📊 比对变化 ========== */
function diffChains(oldChains, newChains) {
  const oldIds = oldChains.map((c) => c.id);
  const newIds = newChains.map((c) => c.id);

  const added = newChains.filter((c) => !oldIds.includes(c.id));
  const removed = oldChains.filter((c) => !newIds.includes(c.id));

  return { added, removed };
}

/* ========== 🧠 核心检测逻辑 ========== */
async function checkMainnets() {
  try {
    const latestJsUrl = await getLatestAppJsUrl();
    const jsText = await fetchJsFile(latestJsUrl);
    const newChains = extractChains(jsText);

    if (newChains.length === 0) {
      console.log("❌ 未提取到主网，请检查网页是否更新或内容被压缩。");
      return;
    }

    console.log(`✅ 共提取 ${newChains.length} 个主网。`);

    let oldChains = [];
    if (fs.existsSync(outputFile)) {
      oldChains = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    }

    const { added, removed } = diffChains(oldChains, newChains);

    if (added.length === 0 && removed.length === 0) {
      console.log("✅ 主网无变化。");
    } else {
      const message = [
        "🔔 主网变化检测到!",
        added.length ? `\n✅ 新增主网:\n• ${added.map((c) => c.name + " (" + c.id + ")").join("\n• ")}` : "",
        removed.length ? `\n❌ 删除主网:\n• ${removed.map((c) => c.name + " (" + c.id + ")").join("\n• ")}` : "",
      ].join("\n");

      console.log(message);
      await sendTelegram(message);
    }

    fs.writeFileSync(outputFile, JSON.stringify(newChains, null, 2));
    console.log(`💾 已更新 ${outputFile}`);
  } catch (err) {
    console.error("❌ 抓取失败:", err.message);
  }
}

/* ========== 🚀 启动循环或单次执行 ========== */
(async function main() {
  await checkMainnets();
  if (!onceMode) {
    console.log(`⏳ 下次检测将在 ${(intervalMs / 1000).toFixed(0)} 秒后进行...\n`);
    setInterval(checkMainnets, intervalMs);
  } else {
    console.log("🏁 单次检测完成 (--once 模式)。");
  }
})();