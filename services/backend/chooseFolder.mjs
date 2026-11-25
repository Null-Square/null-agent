import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$owner = [System.Windows.Forms.Form]::new()
try {
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Opacity = 0
  $owner.Show()
  $dialog.Description = 'Select the local source folder for this NullSquare scope.'
  $dialog.ShowNewFolderButton = $false
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`;

export async function chooseLocalFolder() {
  const windowsPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const platformPicker = {
    win32: [windowsPowerShell, ['-NoLogo', '-NoProfile', '-STA', '-Command', script]],
    darwin: ['/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Select a local source folder")']],
    linux: ['zenity', ['--file-selection', '--directory', '--title=Select a local source folder']],
  }[process.platform];
  if (!platformPicker) throw Object.assign(new Error('A folder picker is unavailable on this platform.'), { status: 501 });
  const [program, args] = platformPicker;
  try {
    const { stdout } = await run(program, args, {
      windowsHide: true, encoding: 'utf8', maxBuffer: 16_384, timeout: 180_000,
    });
    return stdout.replace(/\r?\n$/, '') || null;
  } catch (error) {
    if ((process.platform === 'darwin' && error.stderr?.includes('(-128)')) ||
        (process.platform === 'linux' && error.code === 1 && !error.stderr?.trim())) return null;
    if (error.code === 'ENOENT' && process.platform === 'linux') {
      throw Object.assign(new Error('Install Zenity to open the local folder picker on Linux.'), { status: 501 });
    }
    throw Object.assign(new Error('The folder picker could not finish. Try again.'), { status: 503 });
  }
}
