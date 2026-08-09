// Boots FF3 and drives it into a live random encounter, then writes a savestate.
//
// The intro sequence is Joel's: from the name grid, six A presses then DOWN,
// repeated. Each A stamps the letter under the cursor and the grid's own
// wrap-around behaviour walks through all four characters' names; after the
// party is named the game runs on into the Altar Cave and a random encounter
// fires on its own. Four of my own attempts at "type a letter, press START"
// never got past character two.
const { Nes } = require('./nes.cjs');
const { writeFileSync } = require('fs');

const ROM = '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const n = new Nes(ROM);
n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);      // opening crawl
for (let block = 0; block < 10; block++) {                 // name the party
  for (let k = 0; k < 6; k++) n.press('a', 8, 25);
  n.press('down', 8, 40);
}
n.run(900);                                                // walk on into a fight

const pal = n.palette();
writeFileSync(__dirname + '/battle-state.json', JSON.stringify(n.save()));
n.screenshot(__dirname + '/battle-state.png');
console.log('frames:', n.frames);
console.log('BG palettes:');
for (let p = 0; p < 4; p++)
  console.log('  BG' + p, pal.slice(p * 4, p * 4 + 4).map(c => '0x' + c.toString(16).padStart(2, '0')).join(' '));
console.log('attribute table non-zero bytes:', n.attributes().filter(b => b !== 0).length, '/ 64');
