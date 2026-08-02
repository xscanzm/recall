// src/main/ipc/trustedWebContents.ts
// 受信任 webContents 注册表（codebase-audit todo 5：IPC sender 校验）。
//
// 只有加载了 preload 的应用自有窗口才能调用 IPC。窗口生命周期在
// app.ts / EndOfDayReviewService.ts 维护 add/remove；validated.ts 的
// handleValidated 放行前查询 has。fail-closed：未登记即拒绝。

const trustedIds = new Set<number>();

export function addTrustedWebContents(id: number): void {
  trustedIds.add(id);
}

export function removeTrustedWebContents(id: number): void {
  trustedIds.delete(id);
}

export function hasTrustedWebContents(id: number): boolean {
  return trustedIds.has(id);
}

export function resetTrustedWebContents(): void {
  trustedIds.clear();
}
