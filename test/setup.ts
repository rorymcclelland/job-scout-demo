// Loaded before every test file (package.json "test"): the tests use their own fixed
// configuration in test/fixtures/config, never the owner's config/ (H22).
import path from "node:path";

process.env.JOB_SCOUT_CONFIG_DIR ??= path.join(import.meta.dirname, "fixtures", "config");
