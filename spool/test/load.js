// Loads the extension's plain scripts into Node the same way the browser
// does: as classic scripts that attach to globalThis.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: rel });
}
module.exports = { load, root };
