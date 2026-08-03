#!/bin/bash
# ==========================================================
#  回声 Recall - macOS 安装权限修复助手
# ==========================================================
#  用途：解决 macOS 对未签名 / 未公证 App 的隔离拦截
#        （提示"无法打开，因为它来自身份不明的开发者" 或
#         "应用已损坏，无法打开。你应该将它移到废纸篓"）。
#
#  原理：移除 macOS 隔离标记 (com.apple.quarantine)。
#
#  ⚠️ 如果双击本脚本没有任何窗口弹出，说明脚本自身也被 Gatekeeper 拦截
#     （脚本从网络下载的 DMG 中继承了隔离标记）：
#      → 右键点击本文件 → 打开（只授予一次权限），然后再双击即可；
#      → 或把本脚本复制到【桌面】后再双击运行；
#      → 或在「终端」中直接执行：
#            sudo xattr -rd com.apple.quarantine "/Applications/Recall.app"
# ==========================================================

echo "=========================================================="
echo "          回声 Recall - Mac 权限修复助手"
echo "=========================================================="
echo ""
echo "正在检查并移除 macOS 隔离标记 (com.apple.quarantine)..."
echo ""
echo "ℹ️  提示：如果双击本脚本时没有打开任何窗口，说明它被 Gatekeeper 拦截。"
echo "    请右键点击本文件 → 打开（只需一次授权）；"
echo "    或复制到【桌面】后再双击运行。"
echo "    也可以在终端中手动执行："
echo "        sudo xattr -rd com.apple.quarantine \"/Applications/Recall.app\""
echo ""

# ---- 自动查找所有可能位置的 Recall.app（去重后逐个修复）----
CANDIDATES=(
    "/Applications/Recall.app"
    "$HOME/Applications/Recall.app"
    "$HOME/Desktop/Recall.app"
)
for vol in /Volumes/Recall*/Recall.app; do
    [ -d "$vol" ] && CANDIDATES+=("$vol")
done

FOUND=()
for app in "${CANDIDATES[@]}"; do
    [ -d "$app" ] || continue
    dup=0
    for f in "${FOUND[@]}"; do
        [ "$f" = "$app" ] && dup=1
    done
    [ $dup -eq 0 ] && FOUND+=("$app")
done

if [ ${#FOUND[@]} -eq 0 ]; then
    echo "⚠️  未找到 Recall.app！"
    echo "请先将 Recall.app 拖入【应用程序 (Applications)】文件夹后重新运行本脚本。"
    echo ""
    read -p "按回车键退出..."
    exit 1
fi

# ---- 逐个修复找到的 Recall.app ----
FIXED=0
for app in "${FOUND[@]}"; do
    echo ""
    echo "------------------------------------------"
    echo "正在修复: $app"

    # 第一步：不使用 sudo（用户拖拽安装的 .app owner 就是当前用户，
    # xattr 可以直接修改扩展属性，避免用户被密码弹窗吓退）
    xattr -rd com.apple.quarantine "$app" 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "✅ 已清除隔离标记: $app"
        FIXED=1
    else
        # 第二步：权限不足时改用 sudo 重试（会要求输入 Mac 开机密码，属正常现象）
        echo "⚠️  当前用户权限不足，改用 sudo 重试（将要求输入 Mac 开机密码）..."
        sudo xattr -rd com.apple.quarantine "$app"
        SUDO_EXIT=$?
        if [ $SUDO_EXIT -eq 0 ]; then
            echo "✅ 已通过 sudo 清除隔离标记: $app"
            FIXED=1
        else
            echo "❌ sudo 方式也失败 (exit code: $SUDO_EXIT)：$app"
            echo "   请手动执行：sudo xattr -rd com.apple.quarantine \"$app\""
        fi
    fi
done

# ---- 尝试清除本脚本自身的隔离标记（可选）----
echo ""
echo "------------------------------------------"
echo "最后，尝试清除本脚本自身的隔离标记..."
SCRIPT=$(readlink -f "$0" 2>/dev/null || echo "$0")
if xattr -rd com.apple.quarantine "$SCRIPT" 2>/dev/null; then
    echo "✅ 本脚本自身的隔离标记已清除，今后可直接双击运行。"
else
    echo "ℹ️  未能清除本脚本自身的隔离标记（常见原因：脚本位于只读的 DMG 挂载盘内）。"
    echo "   这不影响修复结果。若希望以后直接双击运行，请把本脚本复制到【桌面】再运行一次。"
fi

# ---- 汇总 ----
echo ""
echo "----------------------------------------------------------"
if [ $FIXED -eq 1 ]; then
    echo "✅ 修复完成！现在可以正常双击打开 Recall 了。"
    echo "   （若 Finder 仍拦截，请右键点击 Recall.app → 打开 → 确认一次即可）"
else
    echo "❌ 未能自动完成修复。请任选一种方式："
    echo "   · 终端执行：sudo xattr -rd com.apple.quarantine /Applications/Recall.app"
    echo "   · 右键点击 Recall.app → 打开 → 确认（只需一次授权）"
fi
echo "----------------------------------------------------------"

echo ""
read -p "按回车键关闭此窗口..."
exit 0
