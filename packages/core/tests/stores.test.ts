import { describe, it, expect, beforeEach } from "vitest";
import { SettingsStore } from "../src/settings-store.js";
import { DEFAULT_APP_SETTINGS } from "../src/types.js";

// ---------------------------------------------------------------------------
// SettingsStore
// ---------------------------------------------------------------------------

describe("SettingsStore", () => {
  let store: SettingsStore;

  beforeEach(() => {
    store = new SettingsStore();
  });

  it("returns default settings initially", () => {
    const settings = store.get();
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("get returns a defensive copy", () => {
    const settings = store.get();
    settings.environmentsEnabled = !DEFAULT_APP_SETTINGS.environmentsEnabled;
    const refetch = store.get();
    expect(refetch.environmentsEnabled).toBe(DEFAULT_APP_SETTINGS.environmentsEnabled);
  });

  it("updates environmentsEnabled", () => {
    store.update({ environmentsEnabled: false });
    expect(store.get().environmentsEnabled).toBe(false);
  });

  it("merges agent settings without overwriting other fields", () => {
    store.update({ agent: { conflictPolicy: "strict" } as any });
    const settings = store.get();
    expect(settings.agent.conflictPolicy).toBe("strict");
    // Other agent fields preserved
    expect(settings.agent.defaultHealthCheckRetries).toBe(
      DEFAULT_APP_SETTINGS.agent.defaultHealthCheckRetries,
    );
    expect(settings.agent.defaultTimeoutMs).toBe(
      DEFAULT_APP_SETTINGS.agent.defaultTimeoutMs,
    );
  });

  it("merges deploymentDefaults without overwriting other fields", () => {
    const newConfig = { healthCheckRetries: 5 };
    store.update({
      deploymentDefaults: { defaultDeployConfig: newConfig as any },
    });
    const settings = store.get();
    // The defaultDeployConfig gets shallow-merged at the deploymentDefaults level
    expect(settings.deploymentDefaults.defaultDeployConfig).toEqual(newConfig);
  });

  it("merges envoy settings", () => {
    store.update({ envoy: { url: "http://envoy:4000" } as any });
    const settings = store.get();
    expect(settings.envoy.url).toBe("http://envoy:4000");
    expect(settings.envoy.timeoutMs).toBe(DEFAULT_APP_SETTINGS.envoy.timeoutMs);
  });

  it("update returns a defensive copy", () => {
    const result = store.update({ environmentsEnabled: false });
    result.environmentsEnabled = true;
    expect(store.get().environmentsEnabled).toBe(false);
  });

  it("multiple updates accumulate correctly", () => {
    store.update({ environmentsEnabled: false });
    store.update({ agent: { conflictPolicy: "strict" } as any });
    const settings = store.get();
    expect(settings.environmentsEnabled).toBe(false);
    expect(settings.agent.conflictPolicy).toBe("strict");
  });
});
