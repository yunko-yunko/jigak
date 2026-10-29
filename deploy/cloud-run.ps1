<#
.SYNOPSIS
Build, migrate, and deploy the API using existing GCP resources.
.DESCRIPTION
Run with -PlanOnly to review commands. This script never creates databases, IAM
bindings, or secrets. SecretBindings values are SECRET_NAME:VERSION references,
never secret contents. It stops before service deployment if migration fails.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]+$')][string]$ProjectId,
  [string]$Region = 'asia-northeast3',
  [string]$Service = 'jigakmap-api',
  [string]$ArtifactRepository = 'jigakmap',
  [Parameter(Mandatory)][string]$ImageTag,
  [Parameter(Mandatory)][string]$InstanceConnectionName,
  [Parameter(Mandatory)][string]$ServiceAccount,
  [Parameter(Mandatory)][string]$DbPasswordSecret,
  [Parameter(Mandatory)][string]$AuthEncryptionKeySecret,
  [hashtable]$SecretBindings = @{},
  [string]$EnvFile = (Join-Path $PSScriptRoot 'cloud-run.env.yaml'),
  [ValidateRange(1, 100)][int]$MaxInstances = 10,
  [switch]$AllowUnauthenticated,
  [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$workspaceDirectory = Split-Path -Parent $PSScriptRoot
$resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
$envText = Get-Content -LiteralPath $resolvedEnvFile -Raw
$envText = ($envText -split '\r?\n' | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
if ($envText -match 'REPLACE_') {
  throw 'Replace every REPLACE_* value in the deployment environment file.'
}
if ($envText -match '(?m)^\s*PORT\s*:') {
  throw 'Remove PORT from the Cloud Run environment file; --port supplies it.'
}
if ($InstanceConnectionName -notmatch '^[^:\s]+:[^:\s]+:[^:\s]+$') {
  throw 'InstanceConnectionName must be project:region:instance.'
}
if (-not $envText.Contains('/cloudsql/' + $InstanceConnectionName)) {
  throw 'DB_HOST must match /cloudsql/InstanceConnectionName in the environment file.'
}
if (-not $ServiceAccount.EndsWith('.gserviceaccount.com')) {
  throw 'ServiceAccount must be the full runtime service account email.'
}

$bindings = @{
  DB_PASSWORD = $DbPasswordSecret
  AUTH_TOKEN_ENCRYPTION_KEY = $AuthEncryptionKeySecret
}
foreach ($key in $SecretBindings.Keys) {
  if ($key -notmatch '^[A-Z][A-Z0-9_]*$') { throw "Invalid secret environment key: $key" }
  if ($bindings.ContainsKey($key)) { throw "Duplicate secret binding: $key" }
  $bindings[$key] = [string]$SecretBindings[$key]
}
foreach ($entry in $bindings.GetEnumerator()) {
  # Pin numbered secret versions so revisions can be reproduced and rolled back.
  if ($entry.Value -notmatch '^[A-Za-z0-9_-]+:[1-9][0-9]*$') {
    throw "Secret binding $($entry.Key) must be SECRET_NAME:NUMERIC_VERSION."
  }
  if ($envText -match ('(?m)^\s*' + [regex]::Escape($entry.Key) + '\s*:')) {
    throw "Remove secret $($entry.Key) from the non-secret environment file."
  }
}
$secretArgument = ($bindings.Keys | Sort-Object | ForEach-Object { $_ + '=' + $bindings[$_] }) -join ','
$image = "${Region}-docker.pkg.dev/${ProjectId}/${ArtifactRepository}/${Service}:${ImageTag}"
$migrationJob = "${Service}-migrate"
$commonArguments = @('--project', $ProjectId, '--region', $Region, '--quiet')

function Invoke-Gcloud {
  param([string[]]$CommandArguments)
  if ($PlanOnly) {
    # Each displayed argument is quoted for readability only; execution uses an argument array.
    $displayArguments = $CommandArguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
    Write-Output ('gcloud ' + ($displayArguments -join ' '))
    return
  }
  & gcloud @CommandArguments
  if ($LASTEXITCODE -ne 0) { throw "gcloud failed with exit code $LASTEXITCODE" }
}

if (-not $PlanOnly -and -not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw 'Install the Google Cloud CLI and authenticate before running deployment.'
}

# Cloud Build builds Linux containers from Dockerfile and pushes to Artifact Registry.
Invoke-Gcloud -CommandArguments @('builds', 'submit', $workspaceDirectory, '--project', $ProjectId, '--tag', $image, '--quiet')

# A task exits after applying pending migrations; the API does not execute DDL.
$jobArguments = @('run', 'jobs', 'deploy', $migrationJob, '--image', $image,
  '--command', 'node', '--args', 'dist/common/database/migrate.js',
  '--service-account', $ServiceAccount, '--set-cloudsql-instances', $InstanceConnectionName,
  '--env-vars-file', $resolvedEnvFile, '--set-secrets', $secretArgument,
  '--tasks', '1', '--parallelism', '1', '--max-retries', '0', '--task-timeout', '300s',
  '--cpu', '1', '--memory', '512Mi') + $commonArguments
Invoke-Gcloud -CommandArguments $jobArguments
Invoke-Gcloud -CommandArguments (@('run', 'jobs', 'execute', $migrationJob, '--wait') + $commonArguments)

$serviceArguments = @('run', 'deploy', $Service, '--image', $image,
  '--service-account', $ServiceAccount, '--set-cloudsql-instances', $InstanceConnectionName,
  '--execution-environment', 'gen2', '--env-vars-file', $resolvedEnvFile,
  '--set-secrets', $secretArgument, '--port', '8080', '--cpu', '1', '--memory', '512Mi',
  '--concurrency', '20', '--timeout', '120s', '--min-instances', '0',
  '--max-instances', [string]$MaxInstances) + $commonArguments
if ($AllowUnauthenticated) { $serviceArguments += '--allow-unauthenticated' }
else { $serviceArguments += '--no-allow-unauthenticated' }
Invoke-Gcloud -CommandArguments $serviceArguments
Invoke-Gcloud -CommandArguments (@('run', 'services', 'describe', $Service,
  '--format', 'value(status.url)') + $commonArguments)
