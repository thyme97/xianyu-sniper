# 便携包打包脚本：生成「解压即用」的 xianyu-sniper 便携版 zip
# 用法：在项目根目录执行  powershell -ExecutionPolicy Bypass -File scripts\package.ps1
#       加 -Light 生成 30MB 轻量版（不带 node_modules，首次运行需联网装依赖）
# 产物：dist\xianyu-sniper-portable-<版本>[-light].zip
#
# 说明：项目依赖 Playwright（原生模块 + 浏览器内核），pkg / Node SEA 单文件 exe 方案不可行。
#       参考项目 Xianyu-Supply-Monitor 的 exe 是 Electron 打包（自带 Chromium）。
#       本项目采用「Node 便携版 + 源码(+依赖)」的绿色包形态，详见 docs/02 分发与打包计划。

param(
  [string]$NodeVersion = "v20.19.0",   # 便携版 Node 版本
  [switch]$Light                       # 轻量模式：不打包 node_modules
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # 项目根目录（scripts 的上一级）
$dist = Join-Path $root "dist"
$stageName = "xianyu-sniper-portable"
$stage = Join-Path $dist $stageName

# ---- 1. 读取版本号 ----
$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$suffix = if ($Light) { "-light" } else { "" }
$zipPath = Join-Path $dist "$stageName-$($pkg.version)$suffix.zip"
Write-Host "[打包] 版本 $($pkg.version)$(if ($Light) { '（轻量版）' } else { '（全量版：内置依赖，首次运行免联网免 npm）' })"

# ---- 2. 清理并搭建暂存目录 ----
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dist ".tmp-node") -ErrorAction SilentlyContinue | Out-Null

# ---- 3. 拷贝项目文件（排除运行时数据与本机配置）----
$copyItems = @("src", "package.json", "config.example.json", "README.md", "AGENTS.md", "docs")
foreach ($item in $copyItems) {
  $src = Join-Path $root $item
  if (Test-Path $src) { Copy-Item $src -Destination $stage -Recurse -Force }
}
if (-not $Light) {
  # 全量版：依赖直接打进包，用户首次双击即可运行，全程不需要 npm / 网络
  Copy-Item (Join-Path $root "node_modules") -Destination $stage -Recurse -Force
  Write-Host "[打包] node_modules 已内置（约 93MB，解压即用）"
}
Write-Host "[打包] 源码已复制（已排除 state/data/config.json/dist）"

# ---- 4. 获取 Node 便携版（优先 npmmirror 镜像，失败回退官网/本地缓存）----
$nodeDir = Join-Path $stage "node"
$nodeZip = Join-Path $dist ".tmp-node\node-$NodeVersion-win-x64.zip"
$mirrors = @(
  "https://cdn.npmmirror.com/binaries/node/$NodeVersion/node-$NodeVersion-win-x64.zip",
  "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
)
$downloaded = $false
foreach ($url in $mirrors) {
  try {
    Write-Host "[打包] 下载 Node 便携版：$url"
    Invoke-WebRequest -Uri $url -OutFile $nodeZip -TimeoutSec 120
    $downloaded = $true
    break
  } catch {
    Write-Warning "[打包] 该源下载失败：$($_.Exception.Message)"
  }
}
if (-not $downloaded -and -not (Test-Path $nodeZip)) {
  Write-Warning "[打包] Node 便携版获取失败。请手动下载 node-$NodeVersion-win-x64.zip 放到 $nodeZip 后重跑。"
  Write-Warning "[打包] 本次仅打包源码（用户机器需自装 Node.js）。"
}
if (Test-Path $nodeZip) {
  Expand-Archive -Path $nodeZip -DestinationPath (Join-Path $dist ".tmp-node") -Force
  $extracted = Join-Path $dist ".tmp-node\node-$NodeVersion-win-x64"
  Move-Item $extracted $nodeDir -Force
  Write-Host "[打包] Node 便携版已就位 node\"
}

# ---- 5. 生成启动器 start.bat ----
# 注意：bat 必须以 ANSI(GBK) 无 BOM 编码写入。UTF-8 BOM 会导致 cmd 首行报错、窗口闪退；
#       chcp 65001 也会让 GBK 内容乱码，因此不切换代码页（中文 Windows 控制台默认 GBK）。
# 便携 node 目录被前置到 PATH：node 与 npm（便携包自带）都可直接调用。
$launcher = @"
@echo off
title xianyu-sniper 闲鱼蹲价助手
cd /d %~dp0

rem 包内便携版 Node 前置到 PATH（node 与 npm 都在其中）
set "PATH=%~dp0node;%PATH%"
set "NODE_EXE=%~dp0node\node.exe"
if exist "%NODE_EXE%" goto run

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 包内 node 目录缺失，且系统未安装 Node.js，请重新解压完整压缩包。
  pause
  exit /b 1
)
set "NODE_EXE=node"

:run
if not exist node_modules (
  echo [首次运行] 轻量版需要先安装依赖，请保持网络畅通，约 1-2 分钟...
  set "npm_config_better_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/better-sqlite3"
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重新运行。
    pause
    exit /b 1
  )
)

if not exist config.json copy config.example.json config.json >nul

echo [闲鱼蹲价] 正在启动，稍后会自动打开控制台网页...
echo            关闭本窗口即停止监控。
"%NODE_EXE%" src\index.js run
pause
"@
$batPath = Join-Path $stage "start.bat"
# 行尾必须是 CRLF：cmd 对 LF-only 的 bat 解析会错乱（括号块/标签失效，命令被截断）
$launcher = $launcher -replace "`r`n", "`n"
$launcher = $launcher -replace "`n", "`r`n"
[System.IO.File]::WriteAllText($batPath, $launcher, [System.Text.Encoding]::GetEncoding(936))
Write-Host "[打包] 启动器已生成（ANSI 无 BOM）"

# ---- 6. 压缩为 zip ----
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $stage -DestinationPath $zipPath -Force
$sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "[打包] 完成：$zipPath（$sizeMb MB）"
Write-Host "[打包] 使用方式：解压到任意目录 → 双击 start.bat"
