import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// drizzle-kit selects snapshots by filename, but merged ticket numbers are not chronological.
const journal = JSON.parse(await readFile("migrations/meta/_journal.json", "utf8"));
const latest = journal.entries.at(-1);
const temporary = await mkdtemp(".db-check-");
try {
  const meta = join(temporary, "meta");
  await mkdir(meta);
  await cp("migrations/meta/_journal.json", join(meta, "_journal.json"));
  await cp(
    `migrations/meta/${latest.tag.split("_")[0]}_snapshot.json`,
    join(meta, "0000_snapshot.json"),
  );
  const result = spawnSync(
    "bunx",
    [
      "drizzle-kit",
      "generate",
      "--schema",
      "./src/schema.ts",
      "--dialect",
      "sqlite",
      "--out",
      temporary,
    ],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 || !output.includes("No schema changes")) {
    console.error(output);
    throw new Error("Migration snapshot differs from the schema");
  }
  console.log("No schema changes (journal tip)");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
