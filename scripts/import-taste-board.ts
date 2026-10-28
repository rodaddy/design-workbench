import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { openDatabase } from "../src/server/database";
import {
  TasteBoardImportError,
  importTasteBoard,
} from "../src/server/taste-board";

const cliSchema = z.object({
  db: z.string().min(1),
  repoRoot: z.string().min(1),
});

function parseArguments(
  arguments_: readonly string[],
): z.infer<typeof cliSchema> {
  let db = "data/design-workbench.sqlite";
  let repoRoot = resolve(import.meta.dir, "..");
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--db" && value) {
      db = value;
      index += 1;
    } else if (argument === "--repo-root" && value) {
      repoRoot = value;
      index += 1;
    } else {
      throw new TasteBoardImportError(`invalid_cli_argument:${argument}`);
    }
  }
  return cliSchema.parse({ db, repoRoot });
}

try {
  const options = parseArguments(Bun.argv.slice(2));
  const databasePath = resolve(options.db);
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = openDatabase(databasePath);
  try {
    const result = importTasteBoard(database, resolve(options.repoRoot));
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } finally {
    database.close();
  }
} catch (error) {
  const code =
    error instanceof TasteBoardImportError
      ? error.code
      : "TASTE_BOARD_IMPORT_FAILED";
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: code, message })}\n`,
  );
  process.exitCode = 1;
}
