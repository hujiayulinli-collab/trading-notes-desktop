@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 请先安装 Node.js 22.18 或更新的官方 LTS 版本。 & pause & exit /b 1)
where pnpm >nul 2>nul || (echo 请先安装 pnpm 11。 & pause & exit /b 1)
call pnpm install --frozen-lockfile
if errorlevel 1 (pause & exit /b 1)
call pnpm desktop:win
if errorlevel 1 (pause & exit /b 1)
echo 安装包已生成在 release 文件夹。首次分发前请完成 docs\DESKTOP.md 的 Windows 验证清单。
pause
