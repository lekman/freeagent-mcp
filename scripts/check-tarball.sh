#!/usr/bin/env bash
# Fail if anything privileged would reach npm.
#
# The repository and the npm package are separate boundaries. The repository
# has its own check (check-no-client-content.sh); this one reads the packed
# tarball, because `files` in package.json ships dist, README and LICENSE and
# nothing else, and what ships is what npm keeps. An npm version cannot be
# unpublished after 72 hours.
#
# Terms live in scripts/client-terms.txt, one extended-regex per line, so
# the list changes without touching this script. That file is gitignored: a
# committed list of client names is the leak it exists to prevent. Start from
# scripts/client-terms.example.txt.
#
# Structural rules below (no source, no tests, no ledger) are checked always,
# because they do not depend on knowing anyone's name.
#
# CHANGELOG.md is on that list deliberately. Release Please generates it from
# commit messages, so it carries whatever a message once said. The package
# ships the code and its documentation, not the project history.
#
# --quiet reports the file but not the matching line, for the same reason:
# a build log quoting the line defeats the check that produced it.
set -uo pipefail

QUIET=0
for arg in "$@"; do [ "$arg" = "--quiet" ] && QUIET=1; done

cd "$(git rev-parse --show-toplevel)" || exit 2

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

TARBALL=$(npm pack --pack-destination "$WORK" --silent 2>/dev/null | tail -1)
if [ -z "$TARBALL" ] || [ ! -f "$WORK/$TARBALL" ]; then
	echo "check-tarball: npm pack produced nothing" >&2
	exit 2
fi
tar xzf "$WORK/$TARBALL" -C "$WORK" || exit 2
PKG="$WORK/package"

FAILED=0

# --- Structural: what must never be in the tarball at all ----------------
while IFS= read -r found; do
	echo "check-tarball: FAIL — packaged file must not ship: $found"
	FAILED=1
done < <(
	find "$PKG" \
		\( -path '*/src/*' -o -path '*/tests/*' -o -path '*/skills/*' \
		-o -path '*/commands/*' -o -path '*/.tmp/*' -o -name '*.test.*' \
		-o -name '.env*' -o -name 'token.json' -o -name '*.py' \
		-o -name 'CHANGELOG.md' \) -print 2>/dev/null |
		sed "s|$PKG/||"
)

# --- Content: operator-identifying terms ---------------------------------
TERMS_FILE="scripts/client-terms.txt"
if [ -f "$TERMS_FILE" ]; then
	PATTERN=$(grep -vE '^[[:space:]]*(#|$)' "$TERMS_FILE" | paste -sd'|' -)
	if [ -n "$PATTERN" ]; then
		while IFS= read -r hit; do
			echo "check-tarball: FAIL — privileged term in tarball: $hit"
			FAILED=1
		done < <(grep -rniE "$PATTERN" "$PKG" 2>/dev/null | sed "s|$PKG/||" | cut -c1-160)
	else
		echo "check-tarball: $TERMS_FILE has no terms — content scan skipped."
	fi
else
	echo "check-tarball: no $TERMS_FILE — content scan skipped."
	echo "  cp scripts/client-terms.example.txt $TERMS_FILE and fill it in."
fi

if [ "$FAILED" -eq 0 ]; then
	echo "check-tarball: clean ($(find "$PKG" -type f | wc -l | tr -d ' ') files)"
fi
exit "$FAILED"
