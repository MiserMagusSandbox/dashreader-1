let cached: string[] | null = null;

function uniqSorted(arr: string[]): string[] {
  return Array.from(new Set(arr)).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function parseWindowsReg(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    // Example line: "    Arial (TrueType)    REG_SZ    arial.ttf"
    const m = line.match(/^\s*(.+?)\s+REG_\w+\s+/);
    if (!m) continue;
    let name = m[1].trim();
    name = name.replace(/\s*\((TrueType|OpenType|Type 1)\)\s*$/i, "");
    out.push(name);
  }
  return out;
}

function execCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { exec } = require("child_process") as typeof import("child_process");
    exec(cmd, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err: any, stdout: string) => {
      if (err) reject(err);
      else resolve(stdout ?? "");
    });
  });
}

export async function getInstalledFontFamilies(): Promise<string[]> {
  if (cached) return cached;

  // 1) Best-case: Chromium local fonts API (if available in your Obsidian build)
  const qlf = (window as any).queryLocalFonts;
  if (typeof qlf === "function") {
    try {
      const fonts = await qlf();
      const families = uniqSorted(fonts.map((f: any) => f.family));
      if (families.length) return (cached = families);
    } catch {
      // fall through
    }
  }

  // 2) OS-level fallback (desktop only)
  try {
    const platform = (process as any)?.platform as string | undefined;
    if (!platform) return (cached = []);

    if (platform === "win32") {
      const a = await execCmd(`reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"`);
      let b = "";
      try {
        b = await execCmd(`reg query "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"`);
      } catch {
        // ignore if missing
      }
      return (cached = uniqSorted([...parseWindowsReg(a), ...parseWindowsReg(b)]));
    }

    if (platform === "darwin") {
      const sp = await execCmd(`system_profiler SPFontsDataType -detailLevel basic`);
      const families: string[] = [];
      for (const line of sp.split(/\r?\n/)) {
        const m = line.match(/^\s*Family:\s*(.+)\s*$/);
        if (m) families.push(m[1].trim());
      }
      return (cached = uniqSorted(families));
    }

    // linux
    const fc = await execCmd(`fc-list : family`);
    const families = fc
      .split(/\r?\n/)
      .flatMap(l => l.split(":").pop()?.split(",") ?? [])
      .map(s => s.trim());
    return (cached = uniqSorted(families));
  } catch {
    return (cached = []);
  }
}
