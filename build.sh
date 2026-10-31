#!/usr/bin/env bash
# build.sh
# Build the nextjs-stream-media-processor images and push them to Docker Hub.
# The bash twin of build.ps1: same variants, versions and checks.
#
#   cpu    -> :<version>          and :latest
#   vulkan -> :<version>-vulkan   and :latest-vulkan
#
# The version is today's date, plus -2, -3, ... when that date is already on
# Docker Hub. Every variant built in one run shares it. Each image carries its
# tag and the commit as APP_VERSION and GIT_COMMIT (service.version and
# vcs.ref.head.revision in OpenTelemetry).
#
# The images are built from a clean checkout of one commit (a temporary git
# worktree). By default that commit is origin/main, and a push is refused when
# the commit is not on origin/main, or when local main has commits origin/main
# lacks.
#
# Usage:
#   ./build.sh                         # cpu + vulkan, push
#   ./build.sh --variant cpu           # one variant (comma-separated list)
#   ./build.sh --skip vulkan           # default minus vulkan
#   ./build.sh --dry-run               # print the plan, build nothing
#   ./build.sh --no-push               # build and tag :<version> locally only
#   ./build.sh --ref my-branch --no-push
#   ./build.sh --tag 2026.11.01-4      # use this version instead of picking one

set -euo pipefail
cd "$(dirname "$0")"

REPO=membersolo/nextjs-stream-media-processor
HUB_TAGS_URL=https://hub.docker.com/v2/namespaces/membersolo/repositories/nextjs-stream-media-processor/tags
READY_VARIANTS=(cpu vulkan)

VARIANTS=()
SKIP=()
REF=origin/main
TAG=
NO_PUSH=0
DRY_RUN=0

fail() { echo -e "\e[31m$*\e[0m" >&2; exit 1; }
info() { echo -e "\e[36m$*\e[0m"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --variant) IFS=, read -ra VARIANTS <<< "$2"; shift 2 ;;
    --skip)    IFS=, read -ra SKIP <<< "$2"; shift 2 ;;
    --ref)     REF=$2; shift 2 ;;
    --tag)     TAG=$2; shift 2 ;;
    --no-push) NO_PUSH=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

[ ${#VARIANTS[@]} -eq 0 ] && VARIANTS=("${READY_VARIANTS[@]}")
SELECTED=()
for v in "${VARIANTS[@]}"; do
  case "$v" in cpu|vulkan|cuda) ;; *) fail "Unknown variant: $v (cpu, vulkan or cuda)" ;; esac
  skip=0
  for s in "${SKIP[@]+"${SKIP[@]}"}"; do [ "$s" = "$v" ] && skip=1; done
  [ $skip -eq 0 ] && SELECTED+=("$v")
done
[ ${#SELECTED[@]} -eq 0 ] && { echo "No variants to build after applying --skip."; exit 0; }

# --- Which commit -------------------------------------------------------------
info "Fetching origin..."
git fetch origin --quiet
COMMIT=$(git rev-parse --verify "$REF^{commit}")
SHORT=${COMMIT:0:7}
ON_MAIN=0
git merge-base --is-ancestor "$COMMIT" origin/main && ON_MAIN=1
UNPUSHED=0
git rev-parse --verify --quiet main > /dev/null && UNPUSHED=$(git rev-list --count origin/main..main)

if [ $NO_PUSH -eq 0 ]; then
  [ $ON_MAIN -eq 1 ] || fail "$REF ($SHORT) is not on origin/main. Only main ships; use --no-push to try it."
  [ "$UNPUSHED" -eq 0 ] || fail "Local main has $UNPUSHED commit(s) origin/main lacks. Push them first, or the images will miss them."
fi

# --- Which version ------------------------------------------------------------
if [ -z "$TAG" ]; then
  DATE=$(date +%Y.%m.%d)
  NAMES=$(curl -fsS --max-time 20 "$HUB_TAGS_URL?name=$DATE&page_size=100") \
    || fail "Could not read the existing tags from Docker Hub. Pass --tag to choose one."
  # 2026.10.31, 2026.10.31-vulkan, 2026.10.31-2, 2026.10.31-2-vulkan, ...
  pattern="^${DATE//./\\.}(-([0-9]+))?(-(vulkan|cuda))?$"
  highest=0
  while read -r name; do
    if [[ $name =~ $pattern ]]; then
      n=${BASH_REMATCH[2]:-1}
      (( n > highest )) && highest=$n
    fi
  done < <(grep -oE '"name": *"[^"]+"' <<< "$NAMES" | sed -E 's/.*"([^"]+)"$/\1/')
  if [ $highest -eq 0 ]; then TAG=$DATE; else TAG="$DATE-$((highest + 1))"; fi
fi

echo
info "  commit    $COMMIT ($REF)"
info "  version   $TAG"
info "  variants  ${SELECTED[*]}"
info "  push      $([ $NO_PUSH -eq 1 ] && echo no || echo yes)"
[ $ON_MAIN -eq 1 ] || echo -e "\e[33m  note      not on origin/main\e[0m"
[ "$UNPUSHED" -eq 0 ] || echo -e "\e[33m  note      local main has $UNPUSHED unpushed commit(s)\e[0m"
echo

# The build reads TMDB_API_KEY as a BuildKit secret; load only that from .env.local
if [ $DRY_RUN -eq 0 ]; then
  TMDB_API_KEY=$(grep -E '^\s*TMDB_API_KEY\s*=' .env.local | head -1 | cut -d= -f2- | sed -E 's/^\s+|\s+$//g') || true
  [ -n "${TMDB_API_KEY:-}" ] || fail "TMDB_API_KEY is missing from .env.local; the build needs it as a secret"
  export TMDB_API_KEY
fi
export DOCKER_BUILDKIT=1

# --- Build from a clean checkout ----------------------------------------------
WORKTREE=
if [ $DRY_RUN -eq 0 ]; then
  WORKTREE="$(mktemp -d)/media-processor-build-$SHORT"
  git worktree prune
  git worktree add --detach --quiet "$WORKTREE" "$COMMIT"
  trap 'git worktree remove --force "$WORKTREE"' EXIT
fi

declare -A RESULTS
build_variant() {
  local variant=$1 suffix= dockerfile=Dockerfile whisper_gpu
  if [ "$variant" = cuda ]; then
    echo -e "\e[33m[cuda] Dockerfile.cuda is a stub - not yet implemented.\e[0m"
    RESULTS[$variant]=FAILED
    return
  fi
  [ "$variant" = cpu ] || suffix="-$variant"
  [ "$variant" = cpu ] && whisper_gpu=none || whisper_gpu=$variant
  local version="$TAG$suffix"
  local image="$REPO:$version" latest="$REPO:latest$suffix"
  # Only a build that ships moves :latest
  local tag_args=(-t "$image")
  [ $NO_PUSH -eq 1 ] || tag_args+=(-t "$latest")

  info "============================================================"
  info "[$variant] dockerfile=$dockerfile  WHISPER_GPU=$whisper_gpu"
  info "[$variant] tags=$image$([ $NO_PUSH -eq 1 ] || echo ", $latest")"
  info "============================================================"

  if [ $DRY_RUN -eq 1 ]; then
    echo -e "\e[33m[$variant] dry run: docker build --no-cache -f $dockerfile --build-arg WHISPER_GPU=$whisper_gpu --build-arg APP_VERSION=$version --build-arg GIT_COMMIT=$COMMIT ${tag_args[*]} <worktree>\e[0m"
    RESULTS[$variant]=OK
    return
  fi

  if ! docker build --no-cache --progress=plain \
      -f "$WORKTREE/$dockerfile" \
      --build-arg "WHISPER_GPU=$whisper_gpu" \
      --build-arg "APP_VERSION=$version" \
      --build-arg "GIT_COMMIT=$COMMIT" \
      --secret id=tmdb_api_key,env=TMDB_API_KEY \
      "${tag_args[@]}" "$WORKTREE"; then
    echo -e "\e[31m[$variant] Docker build failed\e[0m"
    RESULTS[$variant]=FAILED
    return
  fi

  local labelled
  labelled=$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}')
  if [ "$labelled" != "$version" ]; then
    echo -e "\e[31m[$variant] $image is labelled '$labelled', expected '$version'\e[0m"
    RESULTS[$variant]=FAILED
    return
  fi

  if [ $NO_PUSH -eq 1 ]; then
    echo -e "\e[32m[$variant] Built $image ($SHORT). Not pushed.\e[0m"
    RESULTS[$variant]=OK
    return
  fi

  local name
  for name in "$image" "$latest"; do
    info "[$variant] Pushing $name..."
    if ! docker push "$name"; then
      echo -e "\e[31m[$variant] Push of $name failed\e[0m"
      RESULTS[$variant]=FAILED
      return
    fi
  done
  echo -e "\e[32m[$variant] Done: $image, $latest\e[0m"
  RESULTS[$variant]=OK
}

for v in "${SELECTED[@]}"; do
  build_variant "$v"
  echo
done

info "============================================================"
info "Summary ($TAG, $SHORT):"
failed=0
for v in "${SELECTED[@]}"; do
  if [ "${RESULTS[$v]}" = OK ]; then echo -e "\e[32m  [OK    ] $v\e[0m"; else echo -e "\e[31m  [FAILED] $v\e[0m"; failed=1; fi
done
info "============================================================"
exit $failed
