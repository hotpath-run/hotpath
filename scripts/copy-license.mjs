// prepack helper: npm only packs a LICENSE that sits in the package folder.
/* global process */
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await copyFile(path.join(root, "LICENSE"), path.join(process.cwd(), "LICENSE"));
