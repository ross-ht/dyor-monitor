// server.js
import http from "http";
import "./monitor-dyor-mainnet.js"; // 直接运行监控脚本

const PORT = process.env.PORT || 10000;

// 1️⃣ 创建 HTTP 服务保持 Render 实例常驻
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("✅ DYOR Monitor is running on Render.\n");
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Web service running on port ${PORT}`);
});

// 2️⃣ 捕获异常，防止进程退出
process.on("unhandledRejection", (err) => {
  console.error("⚠️ 未处理的 Promise 拒绝:", err);
});

process.on("uncaughtException", (err) => {
  console.error("💥 未捕获的异常:", err);
});

// 3️⃣ 优雅退出
process.on("SIGTERM", () => {
  console.log("🛑 收到 SIGTERM，正在关闭服务...");
  server.close(() => process.exit(0));
});