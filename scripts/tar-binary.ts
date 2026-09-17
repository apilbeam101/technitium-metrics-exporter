import { join } from "node:path";

// Windows ships a real bsdtar (which, unlike GNU tar, extracts .zip as well
// as .tar.gz) at a fixed path in System32. A bare "tar" on PATH is not
// reliable: MSYS2/Git-for-Windows installs put their own GNU tar ahead of
// it, and GNU tar cannot read a .zip archive at all.
export function tarBinary(): string {
  if (process.platform !== "win32") return "tar";
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}
