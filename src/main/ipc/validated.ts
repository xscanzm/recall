import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { ipcContracts, type IpcRequest, type IpcResponse, type ValidatedIpcChannel } from "../../shared/ipcContracts";
import { hasTrustedWebContents } from "./trustedWebContents";

export class IpcValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "IpcValidationError";
  }
}

export function ipcFail(code: string, message: string): never {
  throw new IpcValidationError(code, message);
}

interface TrustedSenderEventLike {
  sender: { id: number; mainFrame: unknown };
  senderFrame: unknown;
}

/**
 * sender 校验（fail-closed）：
 * - senderFrame 为 null（窗口销毁/导航间隙）→ 拒绝；
 * - senderFrame 不是主 frame（iframe/子 frame 注入）→ 拒绝；
 * - webContents.id 不在受信任集合 → 拒绝。
 */
export function isTrustedSender(event: TrustedSenderEventLike | null | undefined): boolean {
  if (!event || !event.sender || event.senderFrame == null) return false;
  if (event.senderFrame !== event.sender.mainFrame) return false;
  return hasTrustedWebContents(event.sender.id);
}

export function handleValidated<C extends ValidatedIpcChannel>(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: C,
  handler: (event: IpcMainInvokeEvent, input: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
): void {
  const contract = ipcContracts[channel];
  ipc.removeHandler(channel);
  ipc.handle(channel, async (event, rawInput?: unknown) => {
    if (!isTrustedSender(event)) ipcFail("untrusted_sender", `${channel} rejected: sender is not a trusted main frame`);
    const request = contract.request.safeParse(rawInput);
    if (!request.success) ipcFail("schema_invalid", `${channel} request validation failed: ${request.error.message}`);
    try {
      const value = await handler(event, request.data as IpcRequest<C>);
      const response = contract.response.safeParse(value);
      if (!response.success) ipcFail("schema_invalid", `${channel} response validation failed: ${response.error.message}`);
      return response.data;
    } catch (error) {
      if (error instanceof IpcValidationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      ipcFail("internal_error", `${channel}: ${message}`);
    }
  });
}
