import { describe, expect, it, vi } from "vitest";
import { DefaultModelConsentService } from "./DefaultModelConsentService";

describe("DefaultModelConsentService", () => {
  it("deduplicates concurrent confirmation requests and resumes all callers", async () => {
    const state = { defaultModelService: { consent: "pending" as const, acceptedAt: null } };
    const update = vi.fn();
    const requestDecision = vi.fn();
    const service = new DefaultModelConsentService({ getAll: () => state, update } as never, requestDecision);

    const first = service.ensureAccepted();
    const second = service.ensureAccepted();
    expect(requestDecision).toHaveBeenCalledTimes(1);
    service.resolve(true);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      defaultModelService: expect.objectContaining({ consent: "accepted" }),
    }));
  });

  it("returns false immediately after a stored decline", async () => {
    const service = new DefaultModelConsentService({
      getAll: () => ({ defaultModelService: { consent: "declined", acceptedAt: null } }),
      update: vi.fn(),
    } as never, vi.fn());
    await expect(service.ensureAccepted()).resolves.toBe(false);
  });
});
