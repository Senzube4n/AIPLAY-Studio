import assert from 'node:assert/strict';
import {eventAt, scorePosition} from '../../web/score-follow.js';
const events = [0,500,1000,2000].map(milliseconds=>({milliseconds}));
assert.equal(eventAt([], 10), null);
assert.equal(eventAt(events, -1), null);
assert.equal(eventAt(events, .499), events[0]);
assert.equal(eventAt(events, .5), events[1]);
assert.equal(eventAt(events, 999), events[3]);
assert.equal(scorePosition(11, {offset:1,scale:2}),5);
assert.equal(scorePosition(.5,{offset:1,scale:1}),0);
// Seek backwards must select the new note, independent of playback history.
assert.equal(eventAt(events,scorePosition(1.8)),events[2]);
assert.equal(eventAt(events,scorePosition(.2)),events[0]);
console.log('Score playback timing checks passed');
