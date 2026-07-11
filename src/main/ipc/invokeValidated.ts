import type { IpcRenderer } from "electron";
import { ipcContracts, type IpcRequest, type IpcResponse, type ValidatedIpcChannel } from "../../shared/ipcContracts";

export async function invokeValidated<C extends ValidatedIpcChannel>(
  ipc: Pick<IpcRenderer, "invoke">,
  channel: C,
  ...args: undefined extends IpcRequest<C> ? [input?: IpcRequest<C>] : [input: IpcRequest<C>]
): Promise<IpcResponse<C>> {
  const contract = ipcContracts[channel];
  const input = args[0];
  const request = contract.request.parse(input);
  const response = await ipc.invoke(channel, request);
  return contract.response.parse(response) as IpcResponse<C>;
}
