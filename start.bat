@echo off
chcp 65001 >nul
title 闲鱼蹲价助手 xianyu-sniper
cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
  echo [闲鱼蹲价] 未检测到 Node.js，请先安装 Node.js 20+：https://nodejs.org
  echo           安装完成后重新双击本文件即可。
  pause
  exit /b 1
)

if not exist node_modules (
  echo [闲鱼蹲价] 首次运行，正在安装依赖（约 1-2 分钟），请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [闲鱼蹲价] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

if not exist config.json (
  echo [闲鱼蹲价] 检测到首次使用，已生成默认配置 config.json
  copy config.example.json config.json >nul
)

echo [闲鱼蹲价] 正在启动，稍后会自动打开控制台网页...
echo            关闭本窗口即停止监控。
node src/index.js run
pause
