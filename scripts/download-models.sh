#!/usr/bin/env bash
# Downloads the model files open-katana's default workflows need into a ComfyUI models folder.
#
#   scripts/download-models.sh <ComfyUI models folder> [quality|lite] [manifest path or URL]
#
# Skips files already there at the right size, checks there is room, then downloads the rest with curl,
# three at a time. Each file lands as <name>.part, is checked byte for byte against the manifest, then
# renamed, so ComfyUI never sees a partial file. Run it again to resume. It never deletes or overwrites a
# finished file. Needs curl and python3 (to read the manifest).
set -euo pipefail

models=${1:?usage: download-models.sh <ComfyUI models folder> [quality|lite] [manifest]}
tier=${2:-quality}
manifest=${3:-https://raw.githubusercontent.com/shrimbly/open-katana/main/docs/models-manifest.json}
[ -d "$models" ] || { echo "No folder at $models. Point it at the ComfyUI models folder." >&2; exit 1; }

if [[ $manifest =~ ^https?:// ]]; then json=$(curl -fsSL "$manifest"); else json=$(cat "$manifest"); fi
list=$(printf '%s' "$json" | python3 -c '
import json, sys
for f in json.load(sys.stdin)[sys.argv[1]]:
    print(f["folder"], f["name"], f["bytes"], f["url"], sep="\t")
' "$tier")

size_of() { if [ -f "$1" ]; then wc -c <"$1" | tr -d " "; else echo 0; fi; }

todo=()
need=0
while IFS=$'\t' read -r folder name bytes url; do
  if [ "$(size_of "$models/$folder/$name")" = "$bytes" ]; then
    echo "already there  $folder/$name"
  else
    todo+=("$folder"$'\t'"$name"$'\t'"$bytes"$'\t'"$url")
    need=$((need + bytes))
  fi
done <<<"$list"

free=$(($(df -Pk "$models" | awk 'NR==2 {print $4}') * 1024))
echo "${#todo[@]} files to download: $((need / 1000000000)) GB. Free: $((free / 1000000000)) GB."
if [ $((need + 10 * 1024 * 1024 * 1024)) -gt "$free" ]; then
  echo "Not enough room: $((need / 1000000000)) GB needed plus 10 GB spare." >&2
  exit 1
fi

fetch() {
  local folder=$1 name=$2 bytes=$3 url=$4
  mkdir -p "$models/$folder"
  local part="$models/$folder/$name.part"
  curl -L --fail --silent --show-error --retry 5 --retry-delay 10 -C - -o "$part" "$url" || true
  if [ "$(size_of "$part")" = "$bytes" ]; then
    mv "$part" "$models/$folder/$name"
    echo "done           $folder/$name"
  else
    echo "INCOMPLETE     $folder/$name: $(size_of "$part") of $bytes bytes (run the script again to resume)"
  fi
}

for item in ${todo[@]+"${todo[@]}"}; do
  while [ "$(jobs -rp | wc -l | tr -d " ")" -ge 3 ]; do sleep 2; done
  IFS=$'\t' read -r folder name bytes url <<<"$item"
  echo "downloading    $folder/$name"
  fetch "$folder" "$name" "$bytes" "$url" &
done
wait

missing=0
while IFS=$'\t' read -r folder name bytes url; do
  [ "$(size_of "$models/$folder/$name")" = "$bytes" ] || missing=$((missing + 1))
done <<<"$list"
echo "$(($(printf '%s\n' "$list" | wc -l) - missing)) of $(printf '%s\n' "$list" | wc -l | tr -d " ") files in place."
[ "$missing" = 0 ]
