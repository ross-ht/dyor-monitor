import express from "express";
import http from "http";
import monitor from "./monitor-dyor-mainnet.js"; // 引入主脚本

const app = express();
const PORT = process.env.PORT || 10000;

// Render 会定期访问此端口保持实例存活
app.get("/", (req, res) => {
  res.send("✅ DYOR 主网监控服务正在运行中...");
});

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
  console.log("🚀 启动主网监控逻辑...");
  monitor(); // 启动主监控脚本
});

// 优雅关闭
process.on("SIGTERM", () => {
  console.log("🛑 收到 SIGTERM，正在关闭服务...");
  server.close(() => process.exit(0));
});