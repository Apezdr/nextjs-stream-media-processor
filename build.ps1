# build.ps1
# Build the nextjs-stream-media-processor images and push them to Docker Hub.
#
# Variants:
#   cpu    - alpine + CPU whisper           (tagged :<version> and :latest)
#   vulkan - alpine + Vulkan whisper        (tagged :<version>-vulkan and :latest-vulkan)
#                                            Intel ARC/iGPU, AMD, NVIDIA-via-toolkit
#   cuda   - STUB (Dockerfile.cuda is a placeholder; excluded from defaults)
#
# The version is today's date, plus -2, -3, ... when that date is already on
# Docker Hub (2026.10.31, 2026.10.31-2). Every variant built in one run shares
# it, so 2026.10.31-2 and 2026.10.31-2-vulkan are the same commit. Each image
# carries its own tag and the commit as APP_VERSION and GIT_COMMIT; the app
# reports them to OpenTelemetry as service.version and vcs.ref.head.revision.
#
# The images are built from a clean checkout of one commit (a temporary git
# worktree), so uncommitted or untracked files (local whisper models, caches,
# .env.local) never reach them. By default that commit is origin/main, and a
# push is refused when the commit is not on origin/main, or when local main
# has commits origin/main lacks.
#
# Default behavior (no args): builds and pushes ALL ready variants in sequence.
# Currently that's cpu + vulkan. CUDA will be added to the default set when
# Dockerfile.cuda is implemented (just add 'cuda' to $ReadyVariants below).
#
# Usage:
#   .\build.ps1                          # all ready variants (cpu + vulkan)
#   .\build.ps1 -Variant cpu             # cpu only
#   .\build.ps1 -Variant vulkan          # vulkan only
#   .\build.ps1 -Skip vulkan             # default minus vulkan (= cpu only)
#   .\build.ps1 -DryRun                  # print the plan, build nothing
#   .\build.ps1 -NoPush                  # build and tag :<version> locally only
#   .\build.ps1 -Ref my-branch -NoPush   # try another commit (it can't be pushed)
#   .\build.ps1 -Tag 2026.11.01-4        # use this version instead of picking one
#   .\build.ps1 -Variant cuda            # stub error - not implemented yet

param(
    [ValidateSet('cpu', 'vulkan', 'cuda')]
    [string[]]$Variant,

    [ValidateSet('cpu', 'vulkan', 'cuda')]
    [string[]]$Skip = @(),

    [string]$Ref = 'origin/main',
    [string]$Tag,
    [switch]$NoPush,
    [switch]$DryRun
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

$repo = "membersolo/nextjs-stream-media-processor"
$hubTagsUrl = "https://hub.docker.com/v2/namespaces/membersolo/repositories/nextjs-stream-media-processor/tags"

function Fail([string]$message) {
    Write-Host $message -ForegroundColor Red
    exit 1
}

# git runs against this script's repo wherever it is called from. Native
# commands report failure through the exit code, so check that, not the output.
function Invoke-Git {
    $output = & git -C $PSScriptRoot @args
    if ($LASTEXITCODE -ne 0) { Fail "git $($args -join ' ') failed (exit $LASTEXITCODE)" }
    return $output
}

# --- Which commit -------------------------------------------------------------
Write-Host "Fetching origin..." -ForegroundColor Cyan
Invoke-Git fetch origin --quiet | Out-Null
$commit = ([string](Invoke-Git rev-parse --verify "$Ref^{commit}")).Trim()
$short = $commit.Substring(0, 7)

& git -C $PSScriptRoot merge-base --is-ancestor $commit origin/main
$onMain = ($LASTEXITCODE -eq 0)
$unpushed = 0
$hasMain = & git -C $PSScriptRoot rev-parse --verify --quiet main
if ($LASTEXITCODE -eq 0 -and $hasMain) { $unpushed = [int](Invoke-Git rev-list --count origin/main..main) }

if (-not $NoPush) {
    if (-not $onMain) { Fail "$Ref ($short) is not on origin/main. Only main ships; use -NoPush to try it." }
    if ($unpushed -gt 0) { Fail "Local main has $unpushed commit(s) origin/main lacks. Push them first, or the images will miss them." }
}

# --- Which version ------------------------------------------------------------
if (-not $Tag) {
    $date = Get-Date -Format "yyyy.MM.dd"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        $page = Invoke-RestMethod -Uri "${hubTagsUrl}?name=$date&page_size=100" -TimeoutSec 20 -ErrorAction Stop
    } catch {
        Fail "Could not read the existing tags from Docker Hub ($($_.Exception.Message)). Pass -Tag to choose one."
    }
    # 2026.10.31, 2026.10.31-vulkan, 2026.10.31-2, 2026.10.31-2-vulkan, ...
    $pattern = "^$([regex]::Escape($date))(-(\d+))?(-(vulkan|cuda))?$"
    $numbers = @($page.results | ForEach-Object { $_.name } | ForEach-Object {
        if ($_ -match $pattern) { if ($Matches[2]) { [int]$Matches[2] } else { 1 } }
    })
    if ($numbers.Count -eq 0) {
        $Tag = $date
    } else {
        $Tag = "$date-$(($numbers | Measure-Object -Maximum).Maximum + 1)"
    }
}

Write-Host ""
Write-Host "  commit    $commit ($Ref)" -ForegroundColor Cyan
Write-Host "  version   $Tag" -ForegroundColor Cyan
Write-Host "  variants  $($Variant -join ', ')" -ForegroundColor Cyan
Write-Host "  push      $(if ($NoPush) { 'no' } else { 'yes' })" -ForegroundColor Cyan
if (-not $onMain) { Write-Host "  note      not on origin/main" -ForegroundColor Yellow }
if ($unpushed -gt 0) { Write-Host "  note      local main has $unpushed unpushed commit(s)" -ForegroundColor Yellow }
Write-Host ""

# The build reads TMDB_API_KEY as a BuildKit secret. Load only that from
# .env.local: anything else set here would stay in the caller's session.
if (-not $DryRun) {
    $tmdbLine = Get-Content (Join-Path $PSScriptRoot '.env.local') | Where-Object { $_ -match '^\s*TMDB_API_KEY\s*=' } | Select-Object -First 1
    if (-not $tmdbLine) { Fail "TMDB_API_KEY is missing from .env.local; the build needs it as a secret" }
    $env:TMDB_API_KEY = (($tmdbLine -split '=', 2)[1]).Trim()
}
$env:DOCKER_BUILDKIT = 1

# Results live in a script-scope hashtable (NOT function return values) because
# native commands like `docker build` write to PowerShell's stdout pipeline,
# which would otherwise pollute the function's return and turn the result into
# a truthy array regardless of whether the build actually failed.
$Results = [ordered]@{}

function Invoke-VariantBuild {
    param([string]$VariantName, [string]$Context)

    # CUDA path is a stub until Dockerfile.cuda is implemented. Surface it as a
    # soft failure so a default 'all' build doesn't lose the cpu+vulkan results.
    if ($VariantName -eq 'cuda') {
        Write-Host "[$VariantName] Dockerfile.cuda is a stub - not yet implemented." -ForegroundColor Yellow
        Write-Host "[$VariantName] See the Dockerfile.cuda header for the implementation plan." -ForegroundColor Yellow
        $script:Results[$VariantName] = $false
        return
    }

    $suffix     = if ($VariantName -eq 'cpu') { '' } else { "-$VariantName" }
    $version    = "$Tag$suffix"
    $image      = "${repo}:$version"
    $latest     = "${repo}:latest${suffix}"
    $dockerfile = if ($VariantName -eq 'cuda') { 'Dockerfile.cuda' } else { 'Dockerfile' }
    $whisperGpu = if ($VariantName -eq 'cpu') { 'none' } else { $VariantName }
    # Only a build that ships moves :latest, so a -NoPush test can't be pushed
    # by a later `docker push ...:latest`
    $tagArgs = @('-t', $image)
    if (-not $NoPush) { $tagArgs += @('-t', $latest) }

    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "[$VariantName] dockerfile=$dockerfile  WHISPER_GPU=$whisperGpu" -ForegroundColor Cyan
    Write-Host "[$VariantName] tags=$image$(if (-not $NoPush) { ", $latest" })" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan

    if ($DryRun) {
        Write-Host "[$VariantName] dry run: docker build --no-cache -f $dockerfile --build-arg WHISPER_GPU=$whisperGpu --build-arg APP_VERSION=$version --build-arg GIT_COMMIT=$commit $($tagArgs -join ' ') <worktree>" -ForegroundColor Yellow
        $script:Results[$VariantName] = $true
        return
    }

    # --progress=plain so RUN-step failures show full stderr in the build log
    # instead of being collapsed by BuildKit's default tty progress UI.
    docker build --no-cache --progress=plain `
      -f (Join-Path $Context $dockerfile) `
      --build-arg WHISPER_GPU=$whisperGpu `
      --build-arg "APP_VERSION=$version" `
      --build-arg "GIT_COMMIT=$commit" `
      --secret id=tmdb_api_key,env=TMDB_API_KEY `
      @tagArgs $Context

    if ($LASTEXITCODE -ne 0) {
        Write-Host "[$VariantName] Docker build failed (exit $LASTEXITCODE)" -ForegroundColor Red
        $script:Results[$VariantName] = $false
        return
    }

    # Read the labels as JSON: Windows PowerShell 5.1 strips the double quotes
    # a Go template's `index` needs before docker sees them
    $labels = docker image inspect $image --format '{{json .Config.Labels}}' | ConvertFrom-Json
    if ($labels.'org.opencontainers.image.version' -ne $version) {
        Write-Host "[$VariantName] $image is labelled '$($labels.'org.opencontainers.image.version')', expected '$version'" -ForegroundColor Red
        $script:Results[$VariantName] = $false
        return
    }

    if ($NoPush) {
        Write-Host "[$VariantName] Built $image ($short). Not pushed." -ForegroundColor Green
        $script:Results[$VariantName] = $true
        return
    }

    foreach ($name in @($image, $latest)) {
        Write-Host "[$VariantName] Pushing $name..." -ForegroundColor Cyan
        docker push $name
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[$VariantName] Push of $name failed (exit $LASTEXITCODE)" -ForegroundColor Red
            $script:Results[$VariantName] = $false
            return
        }
    }

    Write-Host "[$VariantName] Done: $image, $latest" -ForegroundColor Green
    $script:Results[$VariantName] = $true
}

# --- Build from a clean checkout ----------------------------------------------
$worktree = $null
if (-not $DryRun) {
    $worktree = Join-Path ([IO.Path]::GetTempPath()) "media-processor-build-$short"
    if (Test-Path $worktree) { Remove-Item -Recurse -Force $worktree -ErrorAction SilentlyContinue }
    & git -C $PSScriptRoot worktree prune
    Invoke-Git worktree add --detach --quiet $worktree $commit | Out-Null
}
try {
    foreach ($v in $Variant) {
        Invoke-VariantBuild -VariantName $v -Context $worktree
        Write-Host ""
    }
} finally {
    if ($worktree) { & git -C $PSScriptRoot worktree remove --force $worktree }
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Summary ($Tag, $short):" -ForegroundColor Cyan
foreach ($v in $Results.Keys) {
    $ok = $Results[$v]
    $status = if ($ok) { 'OK    ' } else { 'FAILED' }
    $color  = if ($ok) { 'Green' } else { 'Red' }
    Write-Host "  [$status] $v" -ForegroundColor $color
}
Write-Host "============================================================" -ForegroundColor Cyan

# Exit non-zero if any variant failed
if ($Results.Values -contains $false) { exit 1 }
