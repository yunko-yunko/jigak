import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Inspect actual OS permissions, not a Windows emulation of POSIX mode bits. */
export function assertPrivateFile(path: string): void {
  if (process.platform !== 'win32') { assert.equal(statSync(path).mode & 0o777, 0o600); return; }
  const command = `
$ErrorActionPreference = 'Stop'
$acl = [System.IO.File]::GetAccessControl($env:JIGAK_PRIVATE_ASSERT_TARGET)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.Access | ForEach-Object { @{ sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; allow=($_.AccessControlType -eq 'Allow'); inherited=$_.IsInherited; full=(($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) } })
@{ protected=$acl.AreAccessRulesProtected; user=$user; rules=$rules } | ConvertTo-Json -Depth 4 -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, JIGAK_PRIVATE_ASSERT_TARGET: resolve(path) }, timeout: 15000 });
  assert.equal(result.status, 0, 'must inspect the file DACL');
  const value = JSON.parse(result.stdout), allowed = new Set([value.user, 'S-1-5-18', 'S-1-5-32-544']);
  assert.equal(value.protected, true, 'private file must stop inheriting broad parent permissions');
  assert.ok(value.rules.every((rule: { sid: string; allow: boolean; inherited: boolean }) => !rule.allow || allowed.has(rule.sid) && !rule.inherited), 'only owner, system, and administrators may receive access');
  assert.ok(value.rules.some((rule: { sid: string; allow: boolean; full: boolean }) => rule.allow && rule.sid === value.user && rule.full), 'owner retains read/write/delete access');
}
