#!/bin/bash
set -e
BASE=/Users/qdd/codex/workspace/betterdshlauncher
T=$(mktemp -d /tmp/bdl-vendor-test.XXXXXX)
export BDL_HOME="$T/bdl" DSH_HOME="$T/dsh" STUB_LOG="$T/stub.log" BDL_REAL_DSH="$T/stub/bin.js"
mkdir -p "$T/stub" "$DSH_HOME/profiles/p1" "$T/plugin/深" "$T/plugin/node_modules/should-skip" "$T/plugin/.git"
cat > "$T/stub/bin.js" <<'EOF'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify(argv));
if (argv[0] === 'plugin') { const dir = join(process.env.DSH_HOME, 'profiles', argv[2]); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } }, dependencies: {} })); }
if (process.env.STUB_DUMP_FAIL === '1' && argv.includes('--dump-config')) process.exit(1);
process.exit(0);
EOF
printf '{"name":"p1","version":"1.0.0","dependencies":{"linkpkg":"link:%s/plugin"},"dsh":{"profile":{"bundles":["linkpkg"]}}}' "$T" > "$DSH_HOME/profiles/p1/package.json"
printf 'hello' > "$T/plugin/index.js"
printf 'nested' > "$T/plugin/深/文件.txt"
printf 'skip-me' > "$T/plugin/node_modules/should-skip/x.js"
printf 'git-skip' > "$T/plugin/.git/config"
dd if=/dev/zero of="$T/plugin/big.bin" bs=1048576 count=6 2>/dev/null
ln -s index.js "$T/plugin/alias.js"

cd "$BASE"
node --input-type=module -e "import('./src/pack.mjs').then(async m => { const r = await m.exportPack('p1'); const v = r.manifest.vendor; console.log('vendor-entries:', v && v.length, 'files:', v && v[0].files.map(f=>f.p).join(','), 'bytes:', r.vendorBytes); console.log('vendorKey:', r.manifest.bundles[0].vendorKey); const plan = m.buildImportPlan(r.manifest, { profile: 'p2' }); console.log('link-arg:', plan.addArgs[0]); })"
echo "--- import 全流程 + 解包落盘 ---"
node --input-type=module -e "import('./src/pack.mjs').then(async m => { const fs = await import('node:fs/promises'); const r = await m.exportPack('p1'); const imp = await m.importPack(r.path, { profile: 'p2' }); const fsx = await import('node:fs'); console.log('import-ok:', imp.profile, 'vendor-extracted:', fsx.existsSync(process.env.BDL_HOME + '/vendor/p2/linkpkg/index.js'), 'alias-symlink:', fsx.lstatSync(process.env.BDL_HOME + '/vendor/p2/linkpkg/alias.js').isSymbolicLink(), 'excluded-nm:', !fsx.existsSync(process.env.BDL_HOME + '/vendor/p2/linkpkg/node_modules'), 'excluded-git:', !fsx.existsSync(process.env.BDL_HOME + '/vendor/p2/linkpkg/.git'), 'excluded-big:', !fsx.existsSync(process.env.BDL_HOME + '/vendor/p2/linkpkg/big.bin')); })"
echo "--- 回滚清理 vendor ---"
STUB_DUMP_FAIL=1 node --input-type=module -e "import('./src/pack.mjs').then(async m => { const fsx = await import('node:fs'); const r = await m.exportPack('p1'); try { await m.importPack(r.path, { profile: 'p3' }); } catch(e) { console.log('rolled-back:', e.message.includes('已回滚'), 'vendor-cleaned:', !fsx.existsSync(process.env.BDL_HOME + '/vendor/p3')); } })"
echo "--- vendor 路径穿越校验拒绝 ---"
node --input-type=module -e "import('./src/pack.mjs').then(async m => { try { m.validateManifest({ format:'bdl-pack', manifestVersion:1, id:'x', name:'x', version:'1', bundles:[{name:'a'}], vendor:[{ key:'k', files:[{ p:'../evil.js', c:'eA==' }] }] }); console.log('BUG'); } catch(e) { console.log('traversal-rejected:', e.message.includes('越界')); } })"
rm -rf "$T"
echo ALL-DONE
