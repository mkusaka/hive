// Local dev Access assertions (docs/architecture.md §18.1 is the real path; gate G-02 is not executed yet).
//   bun scripts/dev-token.ts --dev-vars > .dev.vars   # ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_DEV_JWKS
//   export HIVE_ACCESS_JWT=$(bun scripts/dev-token.ts [--sub dev] [--email dev@example.test])
// The ES256 keypair is generated once into .dev-keys.json (gitignored) and reused.
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";

/** Mints an Access-shaped assertion (iss `https://<teamDomain>`, aud, sub, email) valid for 12 h. */
export const mintDevToken = async (
  privateJwk: JWK,
  claims: { teamDomain: string; aud: string; sub: string; email: string },
) =>
  new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: "ES256", kid: privateJwk.kid })
    .setSubject(claims.sub)
    .setIssuer(`https://${claims.teamDomain}`)
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(await importJWK(privateJwk, "ES256"));

/** A fresh keypair: the private JWK to sign with and the public JWKS JSON for ACCESS_DEV_JWKS. */
export const devKeys = async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = "hive-dev";
  return {
    privateJwk: { ...(await exportJWK(privateKey)), kid },
    jwks: JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid, alg: "ES256" }] }),
  };
};

if (import.meta.main) {
  // Dynamic: the module is also imported by workerd tests, which have no node:fs.
  const { readFile, writeFile } = await import("node:fs/promises");
  const { parseArgs } = await import("node:util");
  const { values } = parseArgs({
    options: {
      "dev-vars": { type: "boolean", default: false },
      sub: { type: "string", default: "dev" },
      email: { type: "string", default: "dev@example.test" },
    },
  });
  const file = `${import.meta.dirname}/../.dev-keys.json`;
  const keys: Awaited<ReturnType<typeof devKeys>> = await readFile(file, "utf8").then(
    (text) => JSON.parse(text),
    async () => {
      const fresh = await devKeys();
      await writeFile(file, JSON.stringify(fresh), { mode: 0o600 });
      return fresh;
    },
  );
  // Must match .dev.vars; the defaults are what --dev-vars writes.
  const teamDomain = process.env.ACCESS_TEAM_DOMAIN ?? "hive-dev.cloudflareaccess.com";
  const aud = process.env.ACCESS_AUD ?? "hive-dev";
  console.log(
    values["dev-vars"]
      ? `ACCESS_TEAM_DOMAIN=${teamDomain}\nACCESS_AUD=${aud}\nACCESS_DEV_JWKS='${keys.jwks}'`
      : await mintDevToken(keys.privateJwk, {
          teamDomain,
          aud,
          sub: values.sub,
          email: values.email,
        }),
  );
}
