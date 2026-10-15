import assert from 'node:assert/strict';
import { drawnShard, hiddenIndividuals, progressVariables } from '../src/viewers/world/individuals.ts';
// A room (number 7) whose individuals are stages of its progress and states of each other, as the game draws them.
const shard = {
  room_number: 7,
  individual_conditions: [
    [],                                   // 0: no conditions: always drawn
    [[20, 7, 0, 5, 3, 2]],                // 1: left out unless progress <= 3
    [[20, -1, 0, 2, 3, 2]],               // 2: left out unless progress > 3
    [[20, 7, 0, 2, 1, 20, 7, 0, 5, 2, 1, 2]],   // 3: drawn only while 1 < progress <= 2
    [[5, 1]],                             // 4: left out while individual 1 is
    [[13, -1, 2, 0, 2]],                  // 5: individual 2's condition, negated
    [[11, 7, 12, 75, 195, 1]],            // 6: a wall cut away while the camera faces it: never here
    [[3, 7, 2]],                          // 7: left out unless the player is in room 7: drawn
    [[6, 7, 0, -1]],                      // 8: the player's place: not known, drawn
    [[11, 8, 11, 8, 2, 0]],               // 9: always left out
    [[99]],                               // 10: a program of unknown steps hides nothing
  ],
  occurrences: [[0, 1], [0, 2], [0, 9], [0, -1]],
  placements: { models: [[0], [1], [2], [3]] },
  point_lights: [{ occurrence: 1 }, { occurrence: 3 }],
};
const latest = progressVariables(shard);
assert.deepEqual([...latest.keys()], ['7/0']);
assert.equal(latest.get('7/0')!.latest, 4);
const at = (v?: number) => hiddenIndividuals(shard, { progress: () => v })!.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
assert.deepEqual(at(), [1, 3, 4, 5, 9], 'the latest progress');
assert.deepEqual(at(0), [2, 3, 9], 'progress 0');
assert.deepEqual(at(2), [2, 9], 'progress 2');
assert.deepEqual(at(3), [2, 3, 9], 'progress 3');
assert.equal(hiddenIndividuals({ individual_conditions: [] }), null);
// drawn: the occurrences of left-out individuals named, placements kept as stored, their lights gone
const drawn = drawnShard(shard, hiddenIndividuals(shard), ['x', 'individual']);
assert.deepEqual([...drawn.left_out].sort(), [0, 2]);
assert.equal(drawn.placements, shard.placements);
assert.deepEqual(drawn.point_lights, [{ occurrence: 1 }, { occurrence: 3 }]);
assert.equal(drawnShard(shard, [false], ['x', 'individual']), shard);
console.log('individuals: ok');
