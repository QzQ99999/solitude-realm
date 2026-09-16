@echo off
chcp 65001 >nul
title 孤独领域 - 元素竞技场
cd /d "%~dp0"
echo 正在启动游戏服务器...
echo 启动后请不要关闭本窗口（可以最小化）
echo 游戏地址: http://127.0.0.1:5180/
start "" http://127.0.0.1:5180/
set "PATH=%PATH%;C:\Program Files\nodejs"
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run dev
pause
