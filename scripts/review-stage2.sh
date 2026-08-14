#!/bin/bash
set -e
BASE=/Users/qdd/codex/workspace/betterdshlauncher
T=$(mktemp -d /tmp/bdl-upd-test.XXXXXX)
export BDL_HOME="$T/bdl" DSH_HOME="$T/dsh"
mkdir -p "$DSH_HOME/profiles/p1"
cd "$DSH_HOME/profiles/p1"
printf '{"name":"p1","version":"1.0.0","dependencies":{"ansi-regex":"5.0.0"},"dsh":{"profile":{"bundles":["ansi-regex"]}}}' > package.json
pnpm install --store-dir "$T/store" >/dev/null 2>&1 && echo "install-ok"
cd "$BASE"
node --input-type=module -e "import('./src/update.mjs').then(async m => { const r = await m.checkRegistryUpdates('p1'); console.log('registry-updates:', JSON.stringify(r.items)); })"

echo "--- git link test ---"
mkdir -p "$T/remote" "$T/linkwork"
cd "$T/remote" && git init -q -b main && git config user.email t@t && git config user.name t && echo a > f.txt && git add . && git commit -qm c1
git clone -q "$T/remote" "$T/linkwork/clone"
cd "$T/remote" && echo b >> f.txt && git commit -qam c2
mkdir -p "$DSH_HOME/profiles/p2"
printf '{"name":"p2","version":"1.0.0","dependencies":{"linkpkg":"link:%s/linkwork/clone"},"dsh":{"profile":{"bundles":["linkpkg"]}}}' "$T" > "$DSH_HOME/profiles/p2/package.json"
cd "$BASE"
node --input-type=module -e "import('./src/update.mjs').then(async m => { const r = await m.checkLinkUpdates('p2'); console.log('link-updates:', JSON.stringify(r.items)); const up = await m.updateLinkPkg('p2', 'linkpkg'); console.log('pulled:', up); })"

echo "--- upgrade snapshot/rollback ---"
mkdir -p "$DSH_HOME/profiles/p3"
printf '{"name":"p3","version":"1.0.0"}' > "$DSH_HOME/profiles/p3/package.json"
printf -- "- id: a
" > "$DSH_HOME/profiles/p3/cordis.patch.yml"
cd "$DSH_HOME/profiles/p3" && pnpm install --store-dir "$T/store" >/dev/null 2>&1
cd "$BASE"
node --input-type=module -e "import('./src/upgrade.mjs').then(async m => { const fs = await import('node:fs/promises'); const s = await m.snapshotProfile('p3'); console.log('snap:', s.ts); await fs.writeFile(process.env.DSH_HOME + '/profiles/p3/cordis.patch.yml', '- id: broken\\n'); console.log('tampered:', (await fs.readFile(process.env.DSH_HOME + '/profiles/p3/cordis.patch.yml','utf8')).includes('broken')); await m.rollbackProfile('p3', s.ts); console.log('restored:', (await fs.readFile(process.env.DSH_HOME + '/profiles/p3/cordis.patch.yml','utf8')).includes('- id: a')); console.log('snapshots:', (await m.listSnapshots('p3')).length); })"

echo "--- copy/rename/delete ---"
node --input-type=module -e "import('./src/upgrade.mjs').then(async m => { const fs = await import('node:fs/promises'); const fsx = await import('node:fs'); await m.copyProfile('p3', 'p3-copy'); console.log('copied:', fsx.existsSync(process.env.DSH_HOME + '/profiles/p3-copy/package.json')); await m.renameProfile('p3-copy', 'p3-renamed'); console.log('renamed:', fsx.existsSync(process.env.DSH_HOME + '/profiles/p3-renamed/package.json')); await m.deleteProfile('p3-renamed'); console.log('deleted:', !fsx.existsSync(process.env.DSH_HOME + '/profiles/p3-renamed')); })"

rm -rf "$T"
echo ALL-DONE
