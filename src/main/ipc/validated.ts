import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { ipcContracts, type IpcRequest, type IpcResponse, type ValidatedIpcChannel } from "../../shared/ipcContracts";

export class IpcValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "IpcValidationError";
  }
}

export function ipcFail(code: string, message: string): never {
  throw new IpcValidationError(code, message);
}

export function handleValidated<C extends ValidatedIpcChannel>(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: C,
  handler: (event: IpcMainInvokeEvent, input: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
): void {
  const contract = ipcContracts[channel];
  ipc.removeHandler(channel);
  ipc.handle(channel, async (event, rawInput?: unknown) => {
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
