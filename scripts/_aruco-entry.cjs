
var AR = {};
AR.DICTIONARIES = {};

// Patch: make 'this' in each module point to an object that has .AR
// by pre-seeding the global AR object and exposing it via require chains
global.AR = AR;

require('/home/claude/rom-tracker/node_modules/js-aruco2/src/cv.js');

// aruco.js does: var AR = {}; this.AR = AR;
// We need to capture THAT AR instance, not our stub
var arucoModule = require('/home/claude/rom-tracker/node_modules/js-aruco2/src/aruco.js');

// After require, global.AR should be the real AR set by the library
var realAR = global.AR;

require('/home/claude/rom-tracker/node_modules/js-aruco2/src/dictionaries/aruco_4x4_1000.js');

// Explicitly set on window for browser use
if (typeof window !== 'undefined') {
  window.AR = global.AR;
}
module.exports = { AR: global.AR };
