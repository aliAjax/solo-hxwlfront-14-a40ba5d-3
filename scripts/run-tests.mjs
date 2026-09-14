// 端到端测试启动器：在非 root、无法 apt 安装 Chromium 依赖库的环境里，
// 自动把 .syslib/root 下解包的本地共享库加入 LD_LIBRARY_PATH 后再启动 Playwright。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(root, "..");

function collectLibDirs(dir, acc) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "debs" || entry === "lists" || entry === "partial") continue;
      collectLibDirs(full, acc);
    } else if (entry.endsWith(".so") || entry.includes(".so.")) {
      acc.add(dirname(full));
    }
  }
  return acc;
}

const localLibDirs = [...collectLibDirs(join(projectRoot, ".syslib", "root"), new Set())];
const env = { ...process.env };
if (localLibDirs.length) {
  env.LD_LIBRARY_PATH = [...localLibDirs, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}

const args = process.argv.slice(2);
const res = spawnSync("playwright", ["test", ...args], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(res.status ?? 1);
