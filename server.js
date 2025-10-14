import express from "express";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;

console.log("🌐 Web service initializing...");

// 启动监控脚本（子进程形式，保持后台运行）
const monitor = spawn("node", ["monitor-dyor-mainnet.js"], {
  stdio: "inherit",
  shell: true,
});

// 捕获子进程错误
monitor.on("error", (err) => {
  console.error("❌ 启动监控脚本失败:", err.message);
});

// 当子进程退出时重新启动
monitor.on("exit", (code) => {
  console.warn(`⚠️ 监控脚本退出，退出码: ${code}。10 秒后重启...`);
  setTimeout(() => {
    spawn("node", ["monitor-dyor-mainnet.js"], { stdio: "inherit", shell: true });
  }, 10000);
});

// Web 服务接口（Render 会定期 ping 用于保持在线）
app.get("/", (req, res) => {
  res.send("✅ DYOR 主网监控服务正在运行中。");
});

app.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
});