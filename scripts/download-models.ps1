<#
.SYNOPSIS
  Downloads the model files open-katana's default workflows need into a ComfyUI models folder.

.DESCRIPTION
  Reads docs/models-manifest.json (a local path or its raw GitHub URL), skips files already there at the
  right size, checks the drive has room, then downloads the rest with curl.exe, up to -Parallel at a time.
  Each file lands as <name>.part, is checked byte for byte against the manifest, then renamed, so ComfyUI
  never sees a partial file. Run it again to resume. It never deletes or overwrites a finished file.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File download-models.ps1 -ModelsDir "C:\ComfyUI\models"
#>
param(
  [Parameter(Mandatory = $true)][string]$ModelsDir,
  [ValidateSet("quality", "lite")][string]$Tier = "quality",
  [string]$Manifest = "https://raw.githubusercontent.com/shrimbly/open-katana/main/docs/models-manifest.json",
  [int]$Parallel = 3
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $ModelsDir)) { throw "No folder at $ModelsDir. Point -ModelsDir at the ComfyUI models folder." }
$ModelsDir = (Resolve-Path $ModelsDir).Path
if ($Manifest -match '^https?://') { $data = Invoke-RestMethod -Uri $Manifest } else { $data = Get-Content -Raw -Path $Manifest | ConvertFrom-Json }
$files = @($data.$Tier)
if (-not $files.Count) { throw "The manifest has no '$Tier' list." }

function Find-Existing($f) {
  $dest = Join-Path (Join-Path $ModelsDir $f.folder) $f.name
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -eq [int64]$f.bytes)) { return $dest }
  return $null
}

$todo = @()
foreach ($f in $files) {
  if (Find-Existing $f) { Write-Host ("already there  {0}\{1}" -f $f.folder, $f.name) } else { $todo += $f }
}
$need = [int64](($todo | Measure-Object -Property bytes -Sum).Sum)
$drive = (Get-Item $ModelsDir).PSDrive
$free = [int64](Get-PSDrive $drive.Name).Free
Write-Host ("{0} of {1} files to download: {2:N1} GB. Free on {3}: {4:N1} GB." -f $todo.Count, $files.Count, ($need / 1GB), $drive.Name, ($free / 1GB))
if ($need + 10GB -gt $free) { throw ("Not enough room: {0:N1} GB needed plus 10 GB spare, {1:N1} GB free on {2}:." -f ($need / 1GB), ($free / 1GB), $drive.Name) }

$jobs = @()
foreach ($f in $todo) {
  while (@($jobs | Where-Object { -not $_.Process.HasExited }).Count -ge $Parallel) { Start-Sleep -Seconds 2 }
  $dir = Join-Path $ModelsDir $f.folder
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $part = Join-Path $dir ($f.name + ".part")
  Write-Host ("downloading    {0}\{1} ({2:N2} GB)" -f $f.folder, $f.name, ($f.bytes / 1GB))
  $curlArgs = @("-L", "--fail", "--silent", "--show-error", "--retry", "5", "--retry-delay", "10", "-C", "-", "-o", "`"$part`"", "`"$($f.url)`"")
  $p = Start-Process -FilePath "curl.exe" -ArgumentList $curlArgs -NoNewWindow -PassThru
  $jobs += [pscustomobject]@{ Process = $p; File = $f; Part = $part; Dest = (Join-Path $dir $f.name) }
}
foreach ($j in $jobs) { $j.Process.WaitForExit() }

$failed = @()
foreach ($j in $jobs) {
  $size = 0
  if (Test-Path $j.Part) { $size = (Get-Item $j.Part).Length }
  if ($size -eq [int64]$j.File.bytes) {
    Move-Item -Path $j.Part -Destination $j.Dest -Force
    Write-Host ("done           {0}\{1}" -f $j.File.folder, $j.File.name)
  } else {
    $failed += $j.File
    Write-Host ("INCOMPLETE     {0}\{1}: {2} of {3} bytes (run the script again to resume)" -f $j.File.folder, $j.File.name, $size, $j.File.bytes)
  }
}
$present = @($files | Where-Object { Find-Existing $_ }).Count
Write-Host ("{0} of {1} files in place; {2:N1} GB free on {3}:." -f $present, $files.Count, ((Get-PSDrive $drive.Name).Free / 1GB), $drive.Name)
if ($failed.Count) { exit 1 }
