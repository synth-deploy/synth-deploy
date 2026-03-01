import { describe, it, expect } from "vitest";
import { UpdateSettingsSchema } from "../src/api/schemas.js";

describe("SSRF URL validation", () => {
  function validateEnvoyUrl(url: string) {
    return UpdateSettingsSchema.safeParse({
      envoy: { url },
    });
  }

  it("accepts valid external URLs", () => {
    expect(validateEnvoyUrl("https://envoy.example.com").success).toBe(true);
    expect(validateEnvoyUrl("http://deploy.company.com:8080").success).toBe(true);
    expect(validateEnvoyUrl("https://203.0.113.50:3000").success).toBe(true);
  });

  it("rejects localhost", () => {
    expect(validateEnvoyUrl("http://localhost:3000").success).toBe(false);
    expect(validateEnvoyUrl("http://127.0.0.1:8080").success).toBe(false);
  });

  it("rejects private 10.x.x.x range", () => {
    expect(validateEnvoyUrl("http://10.0.0.1:8080").success).toBe(false);
    expect(validateEnvoyUrl("http://10.255.255.255").success).toBe(false);
  });

  it("rejects private 172.16-31.x.x range", () => {
    expect(validateEnvoyUrl("http://172.16.0.1").success).toBe(false);
    expect(validateEnvoyUrl("http://172.31.255.255").success).toBe(false);
    // 172.15.x.x should be allowed
    expect(validateEnvoyUrl("http://172.15.0.1").success).toBe(true);
    // 172.32.x.x should be allowed
    expect(validateEnvoyUrl("http://172.32.0.1").success).toBe(true);
  });

  it("rejects private 192.168.x.x range", () => {
    expect(validateEnvoyUrl("http://192.168.1.1").success).toBe(false);
    expect(validateEnvoyUrl("http://192.168.0.100").success).toBe(false);
  });

  it("rejects link-local / AWS metadata (169.254.x.x)", () => {
    expect(validateEnvoyUrl("http://169.254.169.254/latest/meta-data/").success).toBe(false);
  });

  it("rejects non-http protocols", () => {
    expect(validateEnvoyUrl("ftp://envoy.example.com").success).toBe(false);
    expect(validateEnvoyUrl("file:///etc/passwd").success).toBe(false);
  });

  it("validates MCP server URLs too", () => {
    const result = UpdateSettingsSchema.safeParse({
      mcpServers: [{ name: "evil", url: "http://169.254.169.254" }],
    });
    expect(result.success).toBe(false);
  });
});
