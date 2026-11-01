<#
.SYNOPSIS
Build, migrate, and deploy the API using existing GCP resources.
.DESCRIPTION
Run with -PlanOnly to review commands. This script never creates databases, IAM
bindings, or secrets. SecretBindings values are SECRET_NAME:VERSION references,
never secret contents. KAKAO_REST_API_KEY_FALLBACK (the spare Kakao key) is a secret too:
bind it here, never in the environment file. The same holds for DATA_GO_KR_SERVICE_KEY_FALLBACK and
SEOUL_OPEN_API_KEY_FALLBACK, the spare keys used once a daily quota is spent. It stops before service deployment if migration fails.
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
  # -1 = automatic: 1 when the demo simulator is on (its window takes a minute to compute), else 0.
  [ValidateRange(-1, 10)][int]$MinInstances = -1,
  # Cloud Storage bucket (asia-northeast3) mounted at /sim-windows for stored simulator windows.
  [ValidatePattern('^$|^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$')][string]$SimulationWindowBucket = '',
  # Cloud Storage bucket (asia-northeast3) of the model refresh job, mounted read-only at /models. The service then
  # follows /models/manifest.json (MODEL_MANIFEST_PATH) and switches models without a restart (docs/MODEL-REFRESH.md).
  [ValidatePattern('^$|^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$')][string]$ModelBucket = '',
  # Extra gcsfuse mount options for that volume, ';' separated. Empty = Cloud Run defaults (verify options in the Cloud Run docs first).
  [ValidatePattern('^[A-Za-z0-9_=;.:-]*$')][string]$ModelMountOptions = '',
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
$windowDirectory = if ($envText -match '(?m)^\s*MOBILITY_SIMULATION_WINDOW_DIR\s*:\s*[''"]?([^''"\r\n]*)[''"]?\s*$') { $Matches[1].Trim() } else { '' }
if (($SimulationWindowBucket -and $windowDirectory -ne '/sim-windows') -or (-not $SimulationWindowBucket -and $windowDirectory)) {
  throw 'MOBILITY_SIMULATION_WINDOW_DIR must be /sim-windows exactly when -SimulationWindowBucket is given.'
}

$manifestPath = if ($envText -match '(?m)^\s*MODEL_MANIFEST_PATH\s*:\s*[''"]?([^''"\r\n]*)[''"]?\s*$') { $Matches[1].Trim() } else { '' }
if (($ModelBucket -and $manifestPath -ne '/models/manifest.json') -or (-not $ModelBucket -and $manifestPath)) {
  throw 'MODEL_MANIFEST_PATH must be /models/manifest.json exactly when -ModelBucket is given.'
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

# The demo simulator (scooter, ebike or both) computes each day's window in a background worker (at
# startup and from 05:00 KST), outside any request. Request-based CPU would starve it, so CPU
# stays allocated whenever any simulated type is on. Its default is Seoul's registered fleet,
# 14,933 scooters + 52,605 e-bikes (docs/DEPLOYMENT.md): the window worker alone peaks near
# 550 MB and the whole server is estimated at 0.8-1.1 GB, so a simulating service gets 2 CPUs (the
# worker and the requests each keep one) and 2Gi. Cloud Run sizing is not yet measured (미검증).
# Until today's window is ready /api/health/ready answers 503, and the startup probe below keeps
# traffic away from the instance meanwhile. A simulating service keeps one instance warm, and with
# a window bucket (Seoul region) a new instance reads the stored day instead of computing it.
$simulated = $envText -match '(?m)^\s*MOBILITY_SIMULATION\s*:\s*[''"]?[^''"\r\n]*\b(scooter|ebike|e-bike)\b'
$serviceMemory = if ($simulated) { '2Gi' } else { '512Mi' }
$serviceCpu = if ($simulated) { '2' } else { '1' }
$minInstances = if ($MinInstances -ge 0) { $MinInstances } elseif ($simulated) { 1 } else { 0 }
$serviceArguments = @('run', 'deploy', $Service, '--image', $image,
  '--service-account', $ServiceAccount, '--set-cloudsql-instances', $InstanceConnectionName,
  '--execution-environment', 'gen2', '--env-vars-file', $resolvedEnvFile,
  '--set-secrets', $secretArgument, '--port', '8080', '--cpu', $serviceCpu, '--memory', $serviceMemory,
  '--concurrency', '20', '--timeout', '120s', '--min-instances', [string]$minInstances,
  '--max-instances', [string]$MaxInstances) + $commonArguments
# Up to 300 s for the database and today's simulator window (estimated 50-90 s to compute, 미검증).
$serviceArguments += @('--startup-probe', 'httpGet.path=/api/health/ready,httpGet.port=8080,initialDelaySeconds=0,periodSeconds=5,timeoutSeconds=3,failureThreshold=60')
if ($simulated) {
  $serviceArguments += @('--no-cpu-throttling', '--cpu-boost')
  if ($SimulationWindowBucket) {
    $serviceArguments += @('--add-volume', "name=sim-windows,type=cloud-storage,bucket=$SimulationWindowBucket",
      '--add-volume-mount', 'volume=sim-windows,mount-path=/sim-windows')
  }
  elseif ($MaxInstances -gt 2) {
    Write-Warning '창 저장 버킷이 없으면 새 인스턴스마다 창을 직접 계산합니다(실규모 약 50~90초, 미검증). 심사 기간에는 -MaxInstances 2 이하를 권장합니다.'
  }
}
if ($ModelBucket) {
  # Read-only: the service never writes models. The refresh job writes this bucket through its own service account.
  $modelVolume = "name=models,type=cloud-storage,bucket=$ModelBucket,readonly=true"
  if ($ModelMountOptions) { $modelVolume += ",mount-options=$ModelMountOptions" }
  $serviceArguments += @('--add-volume', $modelVolume, '--add-volume-mount', 'volume=models,mount-path=/models')
}
if ($AllowUnauthenticated) { $serviceArguments += '--allow-unauthenticated' }
else { $serviceArguments += '--no-allow-unauthenticated' }
Invoke-Gcloud -CommandArguments $serviceArguments
Invoke-Gcloud -CommandArguments (@('run', 'services', 'describe', $Service,
  '--format', 'value(status.url)') + $commonArguments)
