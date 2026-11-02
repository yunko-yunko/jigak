"""Exclusive private files on POSIX and Windows, before any data is written."""
from __future__ import annotations
import base64
import os
from pathlib import Path
import stat
import subprocess


def restrict_private_path(path: Path) -> None:
    target = Path(path).absolute()
    info = target.lstat()
    if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
        raise ValueError('private_path_must_be_regular')
    if os.name != 'nt':
        target.chmod(0o700 if stat.S_ISDIR(info.st_mode) else 0o600)
        return
    # New protected DACLs remove broad inherited access. The owner is unchanged;
    # changing ownership requires privileges ordinary Windows users may lack.
    command = r'''
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
'''
    try:
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', base64.b64encode(command.encode('utf-16le')).decode('ascii')],
            env={**os.environ, 'JIGAK_PRIVATE_TARGET': str(target)},
            capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        raise OSError('private_file_acl_failed') from None
    if result.returncode != 0:
        raise OSError('private_file_acl_failed')


def open_private(path: Path, *, binary: bool = False):
    """Refuse existing paths; restrict the empty inode before handing it over."""
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        restrict_private_path(path)
        return os.fdopen(fd, 'wb' if binary else 'w', **({} if binary else {'encoding': 'utf-8'}))
    except Exception:
        os.close(fd)
        path.unlink(missing_ok=True)
        raise
