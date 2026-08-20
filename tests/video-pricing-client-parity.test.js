'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { calculateVideoCreditCost } = require('../api/_lib/video-pricing');

function loadClientCalculator() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'flowvid-open-inline.js'), 'utf8');
  const start = source.indexOf("const STANDARD_MODEL='bytedance/seedance-2.0';");
  const assignment = 'window.flowvidComputeCredits=computeCredits;';
  const end = source.indexOf(assignment, start) + assignment.length;
  assert.ok(start >= 0 && end > start, 'client pricing calculator source was not found');

  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(`(function(){${source.slice(start, end)} this.compute=computeCredits;}).call(globalThis);`, context);
  return context.compute;
}

test('browser and server credit estimates stay identical for all enabled models', () => {
  const clientCalculate = loadClientCalculator();
  const models = [
    'bytedance/seedance-2.0',
    'bytedance/seedance-2.0-fast',
    'bytedance/seedance-2.0-lite',
    'bytedance/seedance-2.5'
  ];
  const modes = ['text_to_video', 'image_to_video', 'reference_to_video', 'storyboard'];
  const resolutions = ['480p', '720p', '1080p'];
  const durations = [4, 5, 15, 30];

  for (const model of models) {
    for (const mode of modes) {
      for (const resolution of resolutions) {
        for (const duration of durations) {
          const input = { model, mode, resolution, duration };
          assert.equal(clientCalculate(input), calculateVideoCreditCost(input), JSON.stringify(input));
        }
      }
    }
  }
});
