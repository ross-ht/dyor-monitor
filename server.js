import express from "express";
import { spawn } from "child_process";
import http from "http";

const app = express();
const PORT = process.env.PORT || 3000;

// 启动你的监控脚本
const monitor = spawn("node", ["monitor-dyor-mainnet.js"], { stdio: "inherit" });

// Render 会定期访问这个端口保持服务在线
app.get("/", (req, res) => {
  res.send("✅ DYOR Monitor is running on Render.");
});

app.listen(PORT, () => {
  console.log('🌐 Web service running on port ${PORT}');
});