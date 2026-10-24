import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const execHidden = (file, args, options = {}) =>
  execute(file, args, { ...options, windowsHide: true, shell: false });
export const spawnHidden = (file, args, options = {}) =>
  spawn(file, args, { ...options, windowsHide: true, shell: false });
export async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    try {
      await execHidden('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 });
    } catch (e) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
  } else child.kill();
  await Promise.race([
    exit,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('Owned child did not stop: ' + child.pid)), 10000);
      timer.unref();
    }),
  ]);
}
export async function windowsProcesses(pids) {
  if (pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) throw Error('Invalid process IDs');
  const filter = pids.map((pid) => 'ProcessId = ' + pid).join(' OR ');
  const script = `$p=@(Get-CimInstance Win32_Process -Filter '${filter}');ConvertTo-Json -Compress -InputObject @($p | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine} })`;
  const { stdout } = await execHidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 10000,
  });
  return JSON.parse(stdout.trim() || '[]');
}
// Elsewhere (Linux, the CI) the recorded command line is checked in /proc and the process stopped with SIGTERM; the
// Shell then stops the services it supervises (documentation 2.6).
async function stopVerifiedUnixProcess(record) {
  const { readFile } = await import('node:fs/promises');
  const command = await readFile('/proc/' + record.pid + '/cmdline', 'utf8').catch(() => null);
  if (command === null) return;
  if (!command.replaceAll(String.fromCharCode(0), ' ').includes(record.entry)) throw Error('PID owner changed; refusing to stop ' + record.pid);
  const alive = () => {
    try {
      process.kill(record.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  process.kill(record.pid, 'SIGTERM');
  for (let i = 0; i < 200 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
  if (alive()) process.kill(record.pid, 'SIGKILL');
}
export async function stopVerifiedWindowsProcess(record) {
  if (process.platform !== 'win32') return stopVerifiedUnixProcess(record);
  const rows = await windowsProcesses([record.pid]),
    actual = rows.find((row) => row.pid === record.pid);
  if (!actual) return;
  if (!actual.command?.includes(record.entry)) throw Error('PID owner changed; refusing to stop ' + record.pid);
  if (record.startedAt && Math.abs(Date.parse(actual.created) - Date.parse(record.startedAt)) > 5000)
    throw Error('PID creation time changed; refusing to stop ' + record.pid);
  await execHidden('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], { timeout: 10000 });
}
