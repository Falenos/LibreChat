// @ts-check
//
// io.js — atomic writes, interactive prompts, color palette
//
// Color is opt-out per https://no-color.org and opt-in per https://force-color.org.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  // pid + random suffix — collision-free even within one pid.
  const suffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${suffix}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function colorsEnabled() {
  if (process.argv.includes('--no-color')) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return !!process.stdout.isTTY;
}

function makePalette() {
  const on = colorsEnabled();
  return {
    red: on ? '\x1b[31m' : '',
    green: on ? '\x1b[32m' : '',
    yellow: on ? '\x1b[33m' : '',
    cyan: on ? '\x1b[36m' : '',
    dim: on ? '\x1b[2m' : '',
    bold: on ? '\x1b[1m' : '',
    reset: on ? '\x1b[0m' : '',
  };
}

module.exports = { writeAtomic, promptYesNo, colorsEnabled, makePalette };
