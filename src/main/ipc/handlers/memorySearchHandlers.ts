import { ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import { handleValidated, ipcFail } from "../validated";

export function registerMemorySearchHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "memory:search", (_event, input) => {
    if (!deps.memorySearchRepo) ipcFail("not_ready", "MemorySearchRepository 未初始化");
    try {
      return deps.memorySearchRepo.search(input.query, input.limit ?? 50, input.offset ?? 0);
    } catch {
      return { results: [], total: 0 };
    }
  });
}
