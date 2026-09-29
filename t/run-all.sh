#!/bin/sh
# Runs every test: the Perl suites (t/*.t) and the SPA render checks (t/web).
# Used by CI (.github/workflows/docker-publish.yml) before an image is built.
cd "$(dirname "$0")/.." || exit 1
fail=0
for t in t/*.t; do
    out=$(perl "$t" 2>&1); rc=$?
    if [ $rc -eq 0 ]; then echo "PASS $t"; else echo "FAIL $t"; echo "$out" | grep -v '^ok '; fail=1; fi
done
if [ -d t/web/node_modules ]; then
    out=$(cd t/web && node rendercheck.mjs 2>&1); rc=$?
    if [ $rc -eq 0 ]; then echo "PASS t/web/rendercheck.mjs"; else echo "FAIL t/web/rendercheck.mjs"; echo "$out" | grep -v '^ok '; fail=1; fi
else
    echo "SKIP t/web (run: cd t/web && npm ci)"
fi
exit $fail
