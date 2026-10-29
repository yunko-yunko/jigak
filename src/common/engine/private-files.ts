import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** POSIX modes do not protect a Windows file; use a protected NTFS DACL there. */
export function restrictPrivatePathSync(path: string): void {
  const target = resolve(path),
    info = lstatSync(target);

  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new Error('private-path-must-be-regular');
  }

  if (process.platform !== 'win32') {
    chmodSync(target, info.isDirectory() ? 0o700 : 0o600);

    return;
  }

  const command = `
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:JIGAK_PRIVATE_TARGET -Force
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = if ($item.PSIsContainer) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
$acl.SetAccessRuleProtection($true, $false)
$inherit = if ($item.PSIsContainer) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
$identities = @($user, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach ($identity in $identities) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}

if ($item.PSIsContainer) { [System.IO.Directory]::SetAccessControl($item.FullName, $acl) } else { [System.IO.File]::SetAccessControl($item.FullName, $acl) }
`;

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    {
      env: {
        ...process.env,
        JIGAK_PRIVATE_TARGET: target,
      },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    },
  );

  if (result.error || result.status !== 0) {
    throw new Error('private-file-acl-failed');
  }
}

/** Use only for an explicitly dedicated private data directory, never arbitrary parents. */
export function protectPrivateDirectorySync(path: string): void {
  const info = lstatSync(path);

  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('private-directory-must-be-regular');
  }

  restrictPrivatePathSync(path);
}

/** Exclusive creation; the handle contains no private data until access is restricted. */
export async function openPrivateFile(path: string) {
  const file = await open(path, 'wx', 0o600);

  try {
    restrictPrivatePathSync(path);

    return file;
  } catch (error) {
    await file.close();

    await unlink(path);

    throw error;
  }
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  const file = await openPrivateFile(path);

  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

export function writePrivateFileSync(path: string, content: string): void {
  const file = openSync(path, 'wx', 0o600);

  try {
    restrictPrivatePathSync(path);
    writeFileSync(file, content, 'utf8');
    fsyncSync(file);
  } catch (error) {
    closeSync(file);
    unlinkSync(path);

    throw error;
  }

  closeSync(file);
}
