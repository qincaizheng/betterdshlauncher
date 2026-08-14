#!/bin/bash
set -e
BASE=/Users/qdd/codex/workspace/betterdshlauncher
T=$(mktemp -d /tmp/bdl-iso-test.XXXXXX)
export BDL_HOME="$T/bdl" DSH_HOME="$T/dsh" BDL_REAL_DSH="$T/stub/bin.js" STUB_LOG="$T/stub.log"
mkdir -p "$T/stub" "$DSH_HOME/profiles/p1" "$BDL_HOME"
cat > "$T/stub/bin.js" <<'EOF'
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, dshHome: process.env.DSH_HOME }));
if (argv[0] === 'plugin') mkdirSync(join(process.env.DSH_HOME, 'profiles', argv[2]), { recursive: true });
if (process.env.STUB_DUMP_FAIL === '1' && argv.includes('--dump-config')) {
  process.stderr.write("cannot resolve profile bundle missing-pkg");
  process.exit(1);
}
process.exit(0);
EOF
printf '{"name":"p1","version":"1.0.0"}' > "$DSH_HOME/profiles/p1/package.json"
printf -- "- id: x
" > "$DSH_HOME/profiles/p1/cordis.patch.yml"
printf '{"version":1,"bundles":{}}' > "$BDL_HOME/bundles.json"
echo "--- isolate create/list/remove ---"
node --input-type=module -e "import('./src/isolate.mjs').then(async m => { const h = await m.createIsolatedEnv('p1'); console.log('created:', h); console.log('envs:', (await m.listIsolatedEnvs()).join(',')); const fsx = await import('node:fs'); console.log('profile-seeded:', fsx.existsSync(h + '/profiles/p1/package.json')); await m.removeIsolatedEnv('p1'); console.log('after-remove:', (await m.listIsolatedEnvs()).length); })"
echo "--- diagnose hints ---"
node --input-type=module -e 'import("./src/diagnose.mjs").then(async m => { const r = { code: 1, out: "", err: "cannot resolve profile bundle missing-pkg" }; console.log(JSON.stringify(m.parseHints(r))); })'
node --input-type=module -e "import('./src/diagnose.mjs').then(async m => { const r = await m.captureDump('p1', process.env.BDL_REAL_DSH); console.log('capture-ok:', r.code === 0, 'code:', r.code, 'err:', JSON.stringify(r.err).slice(0, 300)); })"
STUB_DUMP_FAIL=1 node --input-type=module -e "import('./src/diagnose.mjs').then(async m => { const r = await m.captureDump('p1', process.env.BDL_REAL_DSH); console.log('capture-fail:', r.code, 'hints:', m.parseHints(r).length); })"
echo "--- default/touch/npmrc ---"
node --input-type=module -e "import('./src/registry.mjs').then(async m => { await m.setDefaultProfile('p1'); console.log('default:', m.defaultProfile()); await m.touchUsage('p1'); await m.touchUsage('p1'); const mm = await m.loadMeta(); console.log('useCount:', mm.bundles.p1.useCount, 'lastUsedAt:', !!mm.bundles.p1.lastUsedAt); await m.writeNpmrc('p1', 'https://registry.npmmirror.com'); console.log('npmrc:', await m.readNpmrc('p1')); })"
rm -rf "$T"
echo ALL-DONE
