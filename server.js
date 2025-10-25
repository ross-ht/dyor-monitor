import express from "express";
import { exec } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;

// 启动主监控脚本（后台执行，日志继承）
const monitorProcess = exec("node monitor-dyor-mainnet.js", {
  stdio: "inherit",
  env: process.env,
});

// 输出监控脚本的日志到控制台（方便在 Render Logs 里查看）
monitorProcess.stdout?.on("data", (data) => console.log(data.toString()));
monitorProcess.stderr?.on("data", (data) => console.error(data.toString()));

// Render 需要一个 Web 端口保持在线
app.get("/", (req, res) => {
  res.send("✅ DYOR Monitor Background Service is running.");
});

app.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
});

// 捕获退出信号并优雅关闭
process.on("SIGTERM", () => {
  console.log("🛑 收到 SIGTERM，正在关闭服务...");
  monitorProcess.kill("SIGTERM");
  process.exit(0);
});