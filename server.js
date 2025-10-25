import express from "express";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;

// 启动监控脚本（子进程模式，独立日志输出）
console.log("🚀 启动主监控进程 monitor-dyor-mainnet.js ...");
const monitorProcess = spawn("node", ["monitor-dyor-mainnet.js"], {
  stdio: "inherit",
  env: process.env,
});

// 捕获退出信号（Render 会在重启或部署时发送 SIGTERM）
process.on("SIGTERM", () => {
  console.log("🛑 收到 SIGTERM，正在关闭服务...");
  monitorProcess.kill("SIGTERM");
  process.exit(0);
});

process.on("exit", () => {
  console.log("👋 服务已正常退出。");
});

// Render 保活心跳路由
app.get("/", (req, res) => {
  res.send("✅ DYOR Monitor Background Service is running.");
});

app.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
});