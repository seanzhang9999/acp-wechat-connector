import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
export interface DesktopProcess { pid: number; ppid: number; executable: string }
export interface DesktopQuitDeps {
  platform: string;
  bridgePid: number;
  snapshot(): Promise<DesktopProcess[]>;
  identity(appPath: string): Promise<{ bundleId: string; executable: string }>;
  requestQuit(appPath: string, pid: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}
const defaults: DesktopQuitDeps = {
  platform: process.platform,
  bridgePid: process.pid,
  async snapshot() {
    const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,comm="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.split("\n").flatMap(line => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), executable: m[3] }] : [];
    });
  },
  async identity(appPath) {
    const plist = path.join(appPath, "Contents/Info.plist");
    const { stdout: bundleId } = await exec("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { timeout: 5000 });
    const { stdout: executable } = await exec("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist], { timeout: 5000 });
    return { bundleId: bundleId.trim(), executable: executable.trim() };
  },
  async requestQuit(appPath, pid) {
    // NSRunningApplication.terminate requests a normal quit without launching an
    // absent app or requiring Apple Events access. Never forceTerminate/pkill.
    const script = `ObjC.import("AppKit");
      var apps = ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications);
      var app = apps.find(function(a) {
        return Number(a.processIdentifier) === ${pid} &&
          ObjC.unwrap(a.bundleIdentifier) === "com.openai.codex" &&
          ObjC.unwrap(a.bundleURL.path) === ${JSON.stringify(appPath)};
      });
      app ? String(Boolean(app.terminate)) : "absent";`;
    const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 5000 });
    return stdout.trim() === "true" || stdout.trim() === "absent";
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

function descendants(rows: DesktopProcess[], roots: Set<number>): Set<number> {
  const ids = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of rows) if (ids.has(p.ppid) && !ids.has(p.pid)) {
      ids.add(p.pid); changed = true;
    }
  }
  return ids;
}

/** Restricted to the bundle-identified Codex app used by the configured binary.
 * All OS interactions can be replaced in tests; tests never quit the real app.
 */
export async function quitCodexDesktop(
  codexCommand: string,
  deps: DesktopQuitDeps = defaults,
  attempts = 40,
): Promise<string> {
  if (deps.platform !== "darwin") throw new Error("此命令目前仅支持 macOS Codex 桌面 App。");
  const suffix = "/Contents/Resources/codex";
  if (!path.isAbsolute(codexCommand) || !codexCommand.endsWith(suffix))
    throw new Error("需要配置 Codex 桌面 App 内的绝对 codex 路径，未退出任何程序。");
  const appPath = codexCommand.slice(0, -suffix.length);
  const identity = await deps.identity(appPath);
  if (!appPath.endsWith(".app") || identity.bundleId !== "com.openai.codex" || path.basename(identity.executable) !== identity.executable)
    throw new Error("目标不是已识别的 Codex 桌面 App，未退出任何程序。");
  const mainPath = path.join(appPath, "Contents/MacOS", identity.executable);
  const before = await deps.snapshot();
  const apps = before.filter(p => p.executable === mainPath);
  if (!apps.length)
    return "Codex 桌面主进程当前未运行，未执行退出操作。可用 /acp list 和 /acp use 选择会话；若仍提示占用，说明还有其他服务持有它。";
  const roots = new Set(apps.map(p => p.pid));
  const tree = descendants(before, roots);
  if (tree.has(deps.bridgePid))
    throw new Error("桥接仍属于桌面 App 的进程树，退出可能同时断开微信桥接；请先将桥接独立运行。");
  const watched = new Map(before.filter(p => tree.has(p.pid) && p.executable === codexCommand).map(p => [p.pid, p.executable]));
  for (const app of apps) if (!await deps.requestQuit(appPath, app.pid))
    throw new Error("Codex 桌面 App 未接受正常退出请求，未强制结束进程。");
  // Keep tracking the original server PIDs after reparenting; also notice
  // newly spawned servers while the desktop is still exiting.
  for (let i = 0; i < attempts; i++) {
    const rows = await deps.snapshot();
    const liveApps = rows.filter(p => p.executable === mainPath);
    const liveTree = descendants(rows, new Set(liveApps.map(p => p.pid)));
    for (const p of rows) if (liveTree.has(p.pid) && p.executable === codexCommand) watched.set(p.pid, p.executable);
    const servers = rows.filter(p => watched.get(p.pid) === p.executable);
    if (!liveApps.length && !servers.length)
      return "Codex 桌面 App 已退出，已确认其 App Server 进程停止。微信桥接继续运行。现在可 /acp list → /acp use 编号，继续原会话；回到电脑前先 /acp release-all。";
    await deps.sleep(500);
  }
  throw new Error("正常退出等待超时：桌面 App 或其 App Server 仍在运行，不能确认会话已释放。可能有退出确认窗口或尚未结束的任务；未强制结束进程。");
}

export interface DesktopStartDeps {
  platform: string;
  snapshot(): Promise<DesktopProcess[]>;
  identity(appPath: string): Promise<{ bundleId: string; executable: string }>;
  launch(appPath: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}
const startDefaults: DesktopStartDeps = {
  platform: defaults.platform, snapshot: defaults.snapshot, identity: defaults.identity, sleep: defaults.sleep,
  async launch(appPath) { await exec('/usr/bin/open', ['-g', appPath], { timeout: 10000 }); },
};
/** Launch only the configured, bundle-verified app; never enable Remote or change login settings. */
export async function startCodexDesktop(command: string, deps: DesktopStartDeps = startDefaults, attempts = 40): Promise<string> {
  if (deps.platform !== 'darwin') throw new Error('此命令目前仅支持 macOS Codex 桌面 App。');
  const suffix = '/Contents/Resources/codex';
  if (!path.isAbsolute(command) || !command.endsWith(suffix)) throw new Error('需要配置 Codex 桌面 App 内的绝对 codex 路径，未启动任何程序。');
  const appPath = command.slice(0, -suffix.length), identity = await deps.identity(appPath);
  if (!appPath.endsWith('.app') || identity.bundleId !== 'com.openai.codex' || !identity.executable || path.basename(identity.executable) !== identity.executable)
    throw new Error('目标不是已识别的 Codex 桌面 App，未启动任何程序。');
  const mainPath = path.join(appPath, 'Contents/MacOS', identity.executable);
  const before = await deps.snapshot();
  const alreadyRunning = before.some(p => p.executable === mainPath);
  if (!alreadyRunning) await deps.launch(appPath);
  for (let i = 0; i < attempts; i++) {
    const rows = await deps.snapshot();
    const apps = rows.filter(p => p.executable === mainPath);
    const tree = descendants(rows, new Set(apps.map(p => p.pid)));
    if (apps.length && rows.some(p => p.executable === command && tree.has(p.pid)))
      return `${alreadyRunning ? 'Codex 桌面已在运行，未重复启动' : 'Codex 桌面已启动'}，已确认桌面及其 App Server 进程存在。微信桥接继续运行。Remote 是否可连接仍取决于既有配对、登录和网络；本操作未修改远程访问设置，也未核验定时任务执行。`;
    await deps.sleep(500);
  }
  throw new Error('桌面启动等待超时：尚未确认桌面及其 App Server 就绪。请检查电脑上的启动或登录窗口；未重复启动实例。');
}
