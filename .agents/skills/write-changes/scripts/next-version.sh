#!/usr/bin/env bash
# 计算 changes/ 的下一个版本号，并检查当天是否已有变更说明。
set -u
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "不在 git 仓库内"; exit 2; }
dir="$repo_root/changes"
[ -d "$dir" ] || { echo "找不到 $dir"; exit 2; }

today=$(TZ=Asia/Shanghai date +%F)
max=0
for f in "$dir"/v*-*.md; do
  [ -e "$f" ] || continue
  base=$(basename "$f" .md)
  n=${base#v}
  n=${n%%-*}
  case "$n" in
    ''|*[!0-9]*) continue ;;
  esac
  if [ "$n" -gt "$max" ]; then max=$n; fi
done
next=$((max + 1))

echo "今天（Asia/Shanghai）: $today"
echo "现有最高版本: v$max"
echo "下一个版本号: v$next"
echo "建议文件名: v$next-$today.md"

existing=$(ls "$dir" 2>/dev/null | grep -E "^v[0-9]+-$today\.md$" || true)
echo
if [ -n "$existing" ]; then
  echo "当天已有变更说明 —— 必须先问用户：合并进已有文档，还是新建 v$next"
  printf '%s\n' "$existing" | sed 's/^/  - /'
else
  echo "当天还没有变更说明 —— 可直接新建 v$next-$today.md"
fi
