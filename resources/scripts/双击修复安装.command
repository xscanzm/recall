#!/bin/bash
# ==========================================================
#  回声 Recall - macOS 安装权限修复助手
# ==========================================================
#  用途：解决非 App Store 应用未经过苹果官方签名公证时，
#        macOS 提示"应用已损坏，无法打开。你应该将它移到废纸篓"的问题。
#
#  原理：移除 macOS 隔离标记 (com.apple.quarantine)。
#
#  说明：
#  - xattr 操作 /Applications 下由当前用户拖拽安装的 .app，不需要 sudo。
#    拖拽到 /Applications 时 Finder 用当前用户权限写入，文件 owner 就是当前用户，
#    xattr 可以直接修改扩展属性。原来的 sudo 是历史遗留，会让用户被密码弹窗吓退。
#  - 仅当 .app 被放在系统目录（罕见）或由其他用户安装时才需要 sudo，
#    此时脚本会检测到权限不足并提示用户改用 sudo 手动执行。
# ==========================================================

echo "=========================================================="
echo "          回声 Recall - Mac 权限修复助手"
echo "=========================================================="
echo ""
echo "正在检查并移除 macOS 隔离标记 (com.apple.quarantine)..."
echo ""

APP_PATH="/Applications/Recall.app"

if [ ! -d "$APP_PATH" ]; then
    echo "⚠️ 未在【应用程序】中找到 Recall.app！"
    echo "请先将 Recall.app 拖拽放到系统的【应用程序 (Applications)】文件夹中再运行本脚本。"
    echo ""
    read -p "按回车键退出..."
    exit 1
fi

# 不使用 sudo：用户拖拽安装的 .app owner 就是当前用户，xattr 可以直接修改
xattr -rd com.apple.quarantine "$APP_PATH"

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "----------------------------------------------------------"
    echo "✅ 修复成功！已成功解锁 Recall 的运行权限。"
    echo "现在你可以在【访达 (Finder)】或【启动台 (Launchpad)】中正常双击打开 Recall。"
    echo "----------------------------------------------------------"
else
    echo ""
    echo "----------------------------------------------------------"
    echo "❌ 修复遇到问题（exit code: $EXIT_CODE）。"
    echo ""
    echo "常见原因："
    echo "  1) Recall.app 由其他用户安装，当前用户无权修改其扩展属性"
    echo "  2) Recall.app 所在目录权限异常"
    echo ""
    echo "可手动执行以下命令（会要求输入 Mac 开机密码）："
    echo ""
    echo "    sudo xattr -rd com.apple.quarantine \"$APP_PATH\""
    echo ""
    echo "----------------------------------------------------------"
fi

echo ""
read -p "按回车键关闭此窗口..."
