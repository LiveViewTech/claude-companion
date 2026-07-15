import { spawn } from "node:child_process";
import process from "node:process";
import { loadConfig } from "@ccc/daemon/config";

export async function openDashboard(): Promise<number> {
  const cfg = loadConfig();
  const url = `http://127.0.0.1:${cfg.port}/`;
  console.log(url);
  const platform = process.platform;
  const [cmd, args] =
    platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* URL already printed; user can open manually */
  }
  return 0;
}
