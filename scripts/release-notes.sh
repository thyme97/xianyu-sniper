#!/usr/bin/env bash
# 生成 GitHub Release 说明：上个标签 → 新标签之间的提交，按仓库习惯（中文提交）粗分类拼 markdown，
# 末尾叠加与上个标签的自动对比链接。供 .github/workflows/release.yml 的 release job 调用。
# 用法：bash scripts/release-notes.sh <新标签> [owner/repo] > notes.md
#   - 标签须已存在于本地 git（CI 里 checkout fetch-depth: 0 自带全部标签）
#   - repo 缺省从 origin 远端地址解析（兼容 ssh / https 格式）
#   - 首个标签（查不到更早标签）时取全量历史、不输出对比链接
# 分类规则（按提交主题前缀粗分类）：
#   ✨ 功能与优化：新增/增加/支持/添加/落地/实现/优化/升级/专项/完善
#   🐛 修复：修复/修正/解决
#   📝 文档：文档/README
#   🔧 其他：其余全部
set -euo pipefail

TAG="${1:?用法：release-notes.sh <新标签> [owner/repo]}"
REPO="${2:-$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')}"

# 上一个标签：新标签提交的父提交起往回最近的标签；查不到（首个标签）则为空
PREV_TAG=$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)
RANGE="${PREV_TAG:+$PREV_TAG..}${TAG}"

COMMITS=$(mktemp)
trap 'rm -f "$COMMITS"' EXIT

# 逐条取 短哈希|完整哈希|主题，映射为 分类|短哈希|完整哈希|主题（主题含 | 的极少数情况按其他类容忍错列）
# format: 输出末行不带换行符，while read 会丢最后一行，末尾补 echo 兜底
{ git log --pretty=format:"%h|%H|%s" "$RANGE"; echo; } | while IFS='|' read -r h H s; do
  case "$s" in
    新增*|增加*|支持*|添加*|落地*|实现*|优化*|升级*|专项*|完善*) cat=feat ;;
    修复*|修正*|解决*) cat=fix ;;
    文档*|README*|readme*) cat=docs ;;
    *) cat=other ;;
  esac
  printf '%s|%s|%s|%s\n' "$cat" "$h" "$H" "$s"
done > "$COMMITS"

for section in 'feat|✨ 功能与优化' 'fix|🐛 修复' 'docs|📝 文档' 'other|🔧 其他'; do
  key="${section%%|*}" title="${section#*|}"
  # 空分类整节省略
  grep -q "^${key}|" "$COMMITS" || continue
  echo "## $title"
  grep "^${key}|" "$COMMITS" | while IFS='|' read -r _ h H s; do
    printf -- '- [`%s`](https://github.com/%s/commit/%s) %s\n' "$h" "$REPO" "$H" "$s"
  done
  echo
done

if [ -n "$PREV_TAG" ]; then
  echo '---'
  echo "**完整对比**：[${PREV_TAG}...${TAG}](https://github.com/${REPO}/compare/${PREV_TAG}...${TAG})"
fi
