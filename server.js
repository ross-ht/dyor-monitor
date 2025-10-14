import express from "express";
import http from "http";

// === 直接导入并执行主监控脚本 ===
// 注意：它会在导入时立即启动 monitor() 循环。
import "./monitor-dyor-mainnet.js";

const app = express();
const PORT = process.env.PORT || 10000;

// Render 会定期 ping 这个端口保持服务常驻
app.get("/", (req, res) => {
  res.send("✅ DYOR Monitor is running and monitoring mainnets.");
});

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
});

// Render 在重启或关停时可能发 SIGTERM，这里优雅关闭
process.on("SIGTERM", () => {
  console.log("🛑 收到 SIGTERM，正在关闭服务...");
  server.close(() => process.exit(0));
});