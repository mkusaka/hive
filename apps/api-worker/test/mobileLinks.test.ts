import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mobileLinks } from "../src/mobileLinks.ts";

const android = {
  MOBILE_APP_PACKAGE: "com.hive.mobile",
  MOBILE_APP_SHA256:
    "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
};

const request = (path: string, bindings: Record<string, string> = {}) =>
  mobileLinks.request(`https://api.example.test${path}`, undefined, { ...env, ...bindings });

describe("mobile app links", () => {
  it("serves only validated Android association settings", async () => {
    const response = await request("/.well-known/assetlinks.json", android);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: android.MOBILE_APP_PACKAGE,
          sha256_cert_fingerprints: [android.MOBILE_APP_SHA256],
        },
      },
    ]);
    expect((await request("/.well-known/assetlinks.json")).status).toBe(404);
    expect(
      (
        await request("/.well-known/assetlinks.json", {
          MOBILE_APP_PACKAGE: 'com.hive.mobile"><script>',
          MOBILE_APP_SHA256: android.MOBILE_APP_SHA256,
        })
      ).status,
    ).toBe(404);
  });

  it("provides a no-store, user-activated verified-link handoff without raw callback input", async () => {
    const response = await request(
      "/mobile/callback?code=%22%3E%3Cscript%3E&state=one%26two",
      android,
    );
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(page).toContain("intent://api.example.test/mobile/callback?");
    expect(page).toContain("package=com.hive.mobile;end");
    expect(page).toContain("&amp;state=one%26two");
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("hive://");
  });

  it("uses the custom scheme only when the explicit development flag is true", async () => {
    const response = await request("/mobile/callback?code=dev&state=s", {
      MOBILE_DEV_SCHEME: "true",
    });
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain('href="hive://callback?code=dev&amp;state=s"');
    expect(page).not.toContain("intent://");
    expect((await request("/mobile/callback", { MOBILE_DEV_SCHEME: "TRUE" })).status).toBe(404);
  });
});
