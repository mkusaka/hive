import { Hono } from "hono";
import type { AppEnv } from "./app.ts";

const androidPackage = /^(?:[A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*$/;
const sha256Fingerprint = /^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/;
const htmlAttributeEscapes: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

const mobileConfig = (env: object) => {
  if (!("MOBILE_APP_PACKAGE" in env) || !("MOBILE_APP_SHA256" in env)) return undefined;
  const packageName = env.MOBILE_APP_PACKAGE;
  const fingerprints =
    typeof env.MOBILE_APP_SHA256 === "string"
      ? env.MOBILE_APP_SHA256.split(",").map((fingerprint) => fingerprint.trim())
      : [];
  if (
    typeof packageName !== "string" ||
    !androidPackage.test(packageName) ||
    fingerprints.length === 0 ||
    fingerprints.some((fingerprint) => !sha256Fingerprint.test(fingerprint))
  ) {
    return undefined;
  }
  return { packageName, fingerprints };
};

/** Public Android App Link association and an intentional, user-activated OAuth callback handoff. */
export const mobileLinks = new Hono<AppEnv>();

mobileLinks.get("/.well-known/assetlinks.json", (c) => {
  const config = mobileConfig(c.env);
  if (!config) return c.notFound();
  return c.json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: config.packageName,
        sha256_cert_fingerprints: config.fingerprints,
      },
    },
  ]);
});

mobileLinks.get("/mobile/callback", (c) => {
  const callback = new URL(c.req.url);
  const devScheme = "MOBILE_DEV_SCHEME" in c.env && c.env.MOBILE_DEV_SCHEME === "true";
  const config = mobileConfig(c.env);
  let destination: string;
  if (devScheme) {
    destination = `hive://callback${callback.search}`;
  } else {
    if (!config) return c.notFound();
    destination = `intent://${callback.host}${callback.pathname}${callback.search}#Intent;scheme=https;package=${config.packageName};end`;
  }
  const href = destination.replace(/[&<>"']/g, (character) => htmlAttributeEscapes[character]!);
  c.header("Cache-Control", "no-store");
  c.header("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  return c.html(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Continue to Hive</title><p><a href="${href}">Continue to Hive</a></p></html>`,
  );
});
