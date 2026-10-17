// Env bootstrap for dev-check-dualwrite.ts — must be imported BEFORE any
// src/ module that resolves DATA_DIR (src/paths.ts) or DATABASE_URL at load.
// src/paths.ts defaults DATA_DIR to "." when AUTO_SCHOOL_DATA is unset, which
// would make setSettings() write settings.json into the repo root. dev-data is
// the dev checkout's data root (same default as import-fs-to-pg / parity-queries).
import { resolve } from "node:path";

process.env.AUTO_SCHOOL_DATA ??= resolve("dev-data");
process.env.DATABASE_URL ??=
  "postgres://autoschool:bddf68ayd8812c569d7bfea2b2126245860afc2a9050@127.0.0.1:15432/autoschool";
