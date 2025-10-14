import express from "express";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;

console.log("🌐 Web service initializing...");

// 启动主监控脚本
let monitor = spawn("node", ["monitor-dyor-mainnet.js"], {
  stdio: "inherit",
  shell: true,
});

// 错误捕获
monitor.on("error", (err) => {
  console.error("❌ 启动监控脚本失败:", err.message);
});

// 子进程意外退出自动重启
monitor.on("exit", (code) => {
  console.warn(`⚠️ 监控脚本退出（代码: ${code}），10 秒后自动重启...`);
  setTimeout(() => {
    monitor = spawn("node", ["monitor-dyor-mainnet.js"], { stdio: "inherit", shell: true });
  }, 10000);
});

// Render 保活路由
app.get("/", (req, res) => {
  res.send("✅ DYOR 主网监控服务正在运行中。");
});

app.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
});