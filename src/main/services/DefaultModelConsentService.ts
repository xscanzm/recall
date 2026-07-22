import type { SettingsService } from "./SettingsService";

export class DefaultModelConsentService {
  private pending: Promise<boolean> | null = null;
  private resolvePending: ((accepted: boolean) => void) | null = null;

  constructor(
    private readonly settingsService: SettingsService,
    private readonly requestDecision: () => void
  ) {}

  async ensureAccepted(): Promise<boolean> {
    const state = this.settingsService.getAll().defaultModelService.consent;
    if (state === "accepted") return true;
    if (state === "declined") return false;
    if (this.pending) return this.pending;

    this.pending = new Promise<boolean>((resolve) => {
      this.resolvePending = resolve;
    });
    this.requestDecision();
    return this.pending;
  }

  resolve(accepted: boolean): void {
    this.settingsService.update({
      defaultModelService: {
        consent: accepted ? "accepted" : "declined",
        acceptedAt: accepted ? new Date().toISOString() : null,
      },
    });
    const resolve = this.resolvePending;
    this.resolvePending = null;
    this.pending = null;
    resolve?.(accepted);
  }
}
