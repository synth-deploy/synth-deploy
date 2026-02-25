import type { AppSettings } from "./types.js";
import { DEFAULT_APP_SETTINGS } from "./types.js";

/**
 * In-memory settings store. Returns deep clones to prevent external mutation.
 * Interface designed for later migration to persistent storage.
 */
export class SettingsStore {
  private settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  update(partial: Partial<AppSettings>): AppSettings {
    if (partial.agent) {
      this.settings.agent = { ...this.settings.agent, ...partial.agent };
    }
    if (partial.deploymentDefaults) {
      this.settings.deploymentDefaults = {
        ...this.settings.deploymentDefaults,
        ...partial.deploymentDefaults,
      };
    }
    if (partial.tentacle) {
      this.settings.tentacle = { ...this.settings.tentacle, ...partial.tentacle };
    }
    return structuredClone(this.settings);
  }
}
