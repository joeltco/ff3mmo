// World property byte 2 is either an entrance index or an event id.
// FF3 3E/C6DF-C6EB tests its high bit before consulting the entrance table.
// Masking both kinds with $3F sends Bahamut's events into unrelated caves.
export function decodeWorldTrigger(props, entranceTable) {
  if (!props || !(props.byte1 & 0x80)) return null;
  if (props.byte2 & 0x80) return { type: 'event', eventId: props.byte2 & 0x7f };
  const trigId = props.byte2;
  const destMap = entranceTable[trigId];
  if (destMap === undefined || destMap === 0) return null;
  return { type: 'entrance', trigId, destMap };
}

// Verified FB operands in ROM event results $12-$15/$17. These are also
// needed for reverse exit lookup: event 4 opens entrance 5, not entrance 4.
export const EVENT_ENTRANCE_INDEX = new Map([[2, 26], [3, 27], [4, 5], [5, 6], [7, 7], [9, 2]]);

// Event 9 condition result $1a ends FB $02: Lake Dohr. Event 8
// only runs F2 $21 and is not an entrance. Keep them distinct.
