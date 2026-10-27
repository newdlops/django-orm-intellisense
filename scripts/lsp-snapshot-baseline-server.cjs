'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('node:module');
const filename = path.resolve(__dirname, '../out/server/server.js');
const baseline = new Module(filename, module);
baseline.filename = filename;
baseline.paths = Module._nodeModulePaths(path.dirname(filename));
baseline._compile(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname,
  '../bench/lsp-snapshot-transport-baseline-server.js.gz'))).toString('utf8'), filename);
