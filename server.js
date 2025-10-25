import express from "express";
import { exec } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;

// 启动主监控脚本
const monitorProcess = exec("node monitor-dyor-mainnet.js", {
  stdio: "inherit",
  env: process.env,
});

// 输出监控脚本日志到 Render 控制台
monitorProcess.stdout?.on("data", (data) => console.log(data.toString()));
monitorProcess.stderr?.on("data", (data) => console.error(data.toString()));

// Render 用来保活的 Web 服务
app.get("/", (req, res) => {
  res.send("✅ DYOR Monitor Background Service is running.");
});

app.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
});

// 优雅关闭
process.on("SIGTERM", () => {
  console.log("🛑 收到 SIGTERM，正在关闭服务...");
  monitorProcess.kill("SIGTERM");
  process.exit(0);
});