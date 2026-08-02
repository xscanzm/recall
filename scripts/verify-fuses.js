// scripts/verify-fuses.js
//
// 验证打包产物的 ASAR 完整性 fuses 已开启（Electron 43 + @electron/fuses v2 API）。
//
// 用法:
//   node scripts/verify-fuses.js <path-to-electron-exe>
//   （Windows 打包产物: release/win-unpacked/Recall.exe）
//
// 退出码: 0 = 两个必需 fuse 均为 on；1 = 任一 fuse 未开启；2 = 参数错误。
// 必需 fuse 取自 @electron/fuses 导出的 FuseV1Options 常量（不使用字符串字面量）。
"use strict";

const path = require("node:path");
const { getCurrentFuseWire, FuseV1Options, FuseState } = require("@electron/fuses");

const REQUIRED_FUSES = [
  FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  FuseV1Options.OnlyLoadAppFromAsar,
];

async function main() {
  const exe = process.argv[2];
  if (!exe) {
    console.error("usage: node scripts/verify-fuses.js <path-to-electron-exe>");
    process.exit(2);
  }

  const state = await getCurrentFuseWire(path.resolve(exe));
  let ok = true;
  for (const fuse of REQUIRED_FUSES) {
    const value = state[fuse];
    const on = value === FuseState.ENABLE;
    if (!on) ok = false;
    const label =
      value === FuseState.ENABLE
        ? "on"
        : value === FuseState.DISABLE
          ? "off"
          : `other(${value})`;
    console.log(`${FuseV1Options[fuse]}=${label}`);
  }

  if (!ok) {
    console.error("FUSE VERIFICATION FAILED: required fuses are not enabled");
    process.exit(1);
  }
  console.log("FUSE VERIFICATION PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
