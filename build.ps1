# build.ps1
# Script to automate Docker build and push for nextjs-stream-media-processor.
#
# Variants:
#   cpu    - alpine + CPU whisper           (tagged :YYYY.MM.DD and :latest)
#   vulkan - alpine + Vulkan whisper        (tagged :YYYY.MM.DD-vulkan and :latest-vulkan)
#                                            Intel ARC/iGPU, AMD, NVIDIA-via-toolkit
#   cuda   - STUB (Dockerfile.cuda is a placeholder; excluded from defaults)
#
# Default behavior (no args): builds and pushes ALL ready variants in sequence.
# Currently that's cpu + vulkan. CUDA will be added to the default set when
# Dockerfile.cuda is implemented (just add 'cuda' to $ReadyVariants below).
#
# Usage:
#   .\build.ps1                          # all ready variants (cpu + vulkan)
#   .\build.ps1 -Variant cpu             # cpu only
#   .\build.ps1 -Variant vulkan          # vulkan only
#   .\build.ps1 -Variant cpu,vulkan      # explicit list (same as default)
#   .\build.ps1 -Skip vulkan             # default minus vulkan (= cpu only)
#   .\build.ps1 -Variant cuda            # stub error - not implemented yet

param(
    [ValidateSet('cpu', 'vulkan', 'cuda')]
    [string[]]$Variant,

    [ValidateSet('cpu', 'vulkan', 'cuda')]
    [string[]]$Skip = @()
)

# Single source of truth for "ready" variants used as the default set.
# Add 'cuda' here when Dockerfile.cuda is built out.
$ReadyVariants = @('cpu', 'vulkan')

# Default: build the full ready set. Caller can override with -Variant or filter with -Skip.
if (-not $Variant) {
    $Variant = $ReadyVariants
}
$Variant = @($Variant | Where-Object { $_ -notin $Skip })

if ($Variant.Count -eq 0) {
    Write-Host "No variants to build after applying -Skip filter." -ForegroundColor Yellow
    exit 0
}

$date = Get-Date -Format "yyyy.MM.dd"
$repo = "membersolo/nextjs-stream-media-processor"

# Load environment variables from .env.local once for all variants
Write-Host "Loading environment variables from .env.local..." -ForegroundColor Cyan
Get-Content .env.local | ForEach-Object {
    if ($_ -notmatch '^#' -and $_ -match '=') {
        $name, $value = $_ -split '=', 2
        Set-Item -Path "Env:$name" -Value ($value.Trim())
    }
}
$env:DOCKER_BUILDKIT = 1

Write-Host ""
Write-Host "Variants to build: $($Variant -join ', ')" -ForegroundColor Cyan
Write-Host ""

# Results live in a script-scope hashtable (NOT function return values) because
# native commands like `docker build` write to PowerShell's stdout pipeline,
# which would otherwise pollute the function's return and turn the result into
# a truthy array regardless of whether the build actually failed.
$Results = [ordered]@{}

function Invoke-VariantBuild {
    param([string]$VariantName)

    # CUDA path is a stub until Dockerfile.cuda is implemented. Surface it as a
    # soft failure so a default 'all' build doesn't lose the cpu+vulkan results.
    if ($VariantName -eq 'cuda') {
        Write-Host "[$VariantName] Dockerfile.cuda is a stub - not yet implemented." -ForegroundColor Yellow
        Write-Host "[$VariantName] See the Dockerfile.cuda header for the implementation plan." -ForegroundColor Yellow
        $script:Results[$VariantName] = $false
        return
    }

    $suffix     = if ($VariantName -eq 'cpu') { '' } else { "-$VariantName" }
    $version    = "${repo}:${date}${suffix}"
    $latest     = "${repo}:latest${suffix}"
    $dockerfile = if ($VariantName -eq 'cuda') { 'Dockerfile.cuda' } else { 'Dockerfile' }
    $whisperGpu = if ($VariantName -eq 'cpu') { 'none' } else { $VariantName }

    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "[$VariantName] dockerfile=$dockerfile  WHISPER_GPU=$whisperGpu" -ForegroundColor Cyan
    Write-Host "[$VariantName] tags=$version, $latest" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan

    # --progress=plain so RUN-step failures show full stderr in the build log
    # instead of being collapsed by BuildKit's default tty progress UI.
    docker build --no-cache --progress=plain `
      -f $dockerfile `
      --build-arg WHISPER_GPU=$whisperGpu `
      --secret id=tmdb_api_key,env=TMDB_API_KEY `
      -t $version -t $latest .

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$VariantName] Docker build failed (exit $LASTEXITCODE)" -ForegroundColor Red
        $script:Results[$VariantName] = $false
        return
    }

    Write-Host "[$VariantName] Pushing $version..." -ForegroundColor Cyan
    docker push $version
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$VariantName] Push of $version failed (exit $LASTEXITCODE)" -ForegroundColor Red
        $script:Results[$VariantName] = $false
        return
    }

    Write-Host "[$VariantName] Pushing $latest..." -ForegroundColor Cyan
    docker push $latest
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$VariantName] Push of $latest failed (exit $LASTEXITCODE)" -ForegroundColor Red
        $script:Results[$VariantName] = $false
        return
    }

    Write-Host "[$VariantName] Done: $version, $latest" -ForegroundColor Green
    $script:Results[$VariantName] = $true
}

foreach ($v in $Variant) {
    Invoke-VariantBuild -VariantName $v
    Write-Host ""
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Summary:" -ForegroundColor Cyan
foreach ($v in $Results.Keys) {
    $ok = $Results[$v]
    $status = if ($ok) { 'OK    ' } else { 'FAILED' }
    $color  = if ($ok) { 'Green' } else { 'Red' }
    Write-Host "  [$status] $v" -ForegroundColor $color
}
Write-Host "============================================================" -ForegroundColor Cyan

# Exit non-zero if any variant failed
if ($Results.Values -contains $false) { exit 1 }
