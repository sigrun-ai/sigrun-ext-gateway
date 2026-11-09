/** Keep every test boot/read away from the developer's real sigrun config. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SIGRUN_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sigrun-ext-gateway-vitest-config-"));
