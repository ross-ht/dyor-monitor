import express from "express";
import { exec } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;

// 启动主监控脚本
const monitorProcess = exec("node monitor-dyor-mainnet.js", {
  stdio: "inherit",
  env: process.env,
});

monitorProcess.stdout?.on("data", (d) => process.stdout.write(d));
monitorProcess.stderr?.on("data", (d) => process.stderr.write(d));

// Render 保活端口
app.get("/", (_req, res) => {
  res.send("✅ DYOR Monitor Background Service is running.");
});

app.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("🛑 收到 SIGTERM，正在关闭服务...");
  monitorProcess.kill("SIGTERM");
  process.exit(0);
});