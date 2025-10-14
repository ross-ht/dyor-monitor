import express from "express";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;

console.log("🌐 Web service initializing...");

// 启动主监控脚本（子进程方式）
const monitor = spawn("node", ["monitor-dyor-mainnet.js"], {
  stdio: "inherit",
  shell: true,
});

// 捕获错误事件
monitor.on("error", (err) => {
  console.error("❌ 启动监控脚本失败:", err.message);
});

// 当子进程退出时自动重启
monitor.on("exit", (code) => {
  console.warn(`⚠️ 监控脚本退出，退出码: ${code}。10 秒后重启...`);
  setTimeout(() => {
    spawn("node", ["monitor-dyor-mainnet.js"], { stdio: "inherit", shell: true });
  }, 10000);
});

// Render 保持在线接口
app.get("/", (req, res) => {
  res.send("✅ DYOR 主网监控服务正在运行中。");
});

app.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
});