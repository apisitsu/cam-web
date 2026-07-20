/**
 * Machine library — real machines, by make and model.
 *
 * A "machine" here is not an abstract envelope, it is the thing standing on the
 * shop floor: a Haas VF-2 and a Brother Speedio are both 3-axis mills and they
 * want completely different programs. Three properties of a real machine change
 * what this app produces, and all three are things geometry cannot tell you:
 *
 * - **Process** (`kind`) — a lathe cannot mill. Picking a machine picks whether
 *   the part gets turned or milled, which is the one routing decision the mesh
 *   analysis can only *suggest*.
 * - **Envelope** — spindle range, feed limit, rapid rate. `feeds.js` clamps
 *   against these and reports which limit bit, so a 8,100 rpm VF-2 and a 16,000
 *   rpm Speedio give visibly different numbers for the same Ø6 cutter.
 * - **Controller** (`controller`) — Haas, Fanuc, Siemens and Okuma do not read
 *   the same file. This selects the post dialect in `post/dialect.js`.
 *
 * `rigidity` scales roughing engagement: a router cannot take the depth of cut
 * a 40-taper boxway machine shrugs off, whatever the material table says. It is
 * a judgement, not a measurement, and it is deliberately coarse.
 *
 * Spindle and feed figures are the published headline specs for each model.
 * They are here to put the numbers in the right neighbourhood, not to stand in
 * for the machine's own manual — the same caveat that governs `library.js`.
 *
 * Pure data + pure lookups: no React, no store, no DOM.
 */

/**
 * @typedef {object} Machine
 * @property {string} id
 * @property {'mill'|'turn'} kind      which process this machine performs
 * @property {string} brand
 * @property {string} model
 * @property {string} label            "Brand · Model"
 * @property {string} controller       key into `post/dialect.js`
 * @property {string} note             one line on what it is for
 * @property {number} maxRpm
 * @property {number} minRpm
 * @property {number} maxFeed          mm/min
 * @property {number} rapidRate        mm/min
 * @property {number} [maxTurnRpm]     lathes: the G50 clamp
 * @property {number} [maxTurnDia]     lathes: largest swing worth planning
 * @property {Record<string, number>} travel  stroke per linear axis, mm —
 *   `{X, Y, Z}` on a mill, `{X, Z}` on a lathe. Keyed by axis letter rather
 *   than positional, because a lathe has no Y and an array would have to lie
 *   about it.
 * @property {string[]} linear         linear axes, in program order
 * @property {string[]} rotary         rotary axes ([] on a 3-axis machine)
 * @property {number} axisCount        linear + rotary — what "5-axis" counts
 * @property {number} rigidity         1.0 = solid industrial machine
 * @property {number} [toolStations]   turret stations / carousel pockets
 */

/**
 * Axis sets, named once so a machine declares what it *is* rather than
 * restating three letters.
 *
 * The distinction that matters downstream is not the headline number but which
 * letters a program may legally contain: a 5-axis machine that swivels on B and
 * rotates on C cannot run a program written for an A axis, and both are "5-axis".
 */
const AXES = {
  mill3: { linear: ['X', 'Y', 'Z'], rotary: [] },
  mill4: { linear: ['X', 'Y', 'Z'], rotary: ['A'] },
  mill5bc: { linear: ['X', 'Y', 'Z'], rotary: ['B', 'C'] },
  turn2: { linear: ['X', 'Z'], rotary: [] },
  turn3c: { linear: ['X', 'Z'], rotary: ['C'] },      // driven tools, no Y
  swiss: { linear: ['X', 'Y', 'Z'], rotary: ['C'] },
};

const withAxes = (m, fallback) => {
  const axes = m.axes ?? fallback;
  return {
    linear: axes.linear,
    rotary: axes.rotary,
    axisCount: axes.linear.length + axes.rotary.length,
  };
};

const mill = (m) => ({
  kind: 'mill', rigidity: 1, minRpm: 100, ...m,
  ...withAxes(m, AXES.mill3),
  label: `${m.brand} · ${m.model}`,
});
const lathe = (m) => ({
  kind: 'turn', rigidity: 1, minRpm: 50, ...m,
  maxTurnRpm: m.maxTurnRpm ?? m.maxRpm,
  ...withAxes(m, AXES.turn2),
  label: `${m.brand} · ${m.model}`,
});

/** @type {Machine[]} */
export const MACHINES = [
  // ---- Milling ------------------------------------------------------------
  mill({
    id: 'haas-vf2', brand: 'Haas', model: 'VF-2', controller: 'haas',
    note: '40-taper VMC. The most common machine in a small shop.',
    maxRpm: 8100, maxFeed: 12700, rapidRate: 25400,
    travel: { X: 762, Y: 406, Z: 508 }, toolStations: 20,
  }),
  mill({
    id: 'haas-minimill', brand: 'Haas', model: 'Mini Mill', controller: 'haas',
    note: 'Compact 40-taper. Same control, less machine.',
    maxRpm: 6000, maxFeed: 12700, rapidRate: 15200,
    travel: { X: 406, Y: 305, Z: 254 }, toolStations: 10, rigidity: 0.8,
  }),
  mill({
    id: 'brother-s700', brand: 'Brother', model: 'Speedio S700X1', controller: 'brother',
    note: 'BT30 high-speed. Small tools, fast cycles, light cuts.',
    maxRpm: 16000, minRpm: 200, maxFeed: 30000, rapidRate: 50000,
    travel: { X: 700, Y: 400, Z: 300 }, toolStations: 14, rigidity: 0.7,
  }),
  mill({
    id: 'mazak-vcn410', brand: 'Mazak', model: 'VCN-410A', controller: 'mazatrol-eia',
    note: 'CT40 VMC. Mazatrol control, programmed here in EIA/ISO.',
    maxRpm: 12000, maxFeed: 42000, rapidRate: 42000,
    travel: { X: 560, Y: 410, Z: 510 }, toolStations: 30,
  }),
  mill({
    id: 'mazak-vcs530c', brand: 'Mazak', model: 'VCS-530C', controller: 'mazatrol-eia',
    note: 'Vertical Center Smart. Long table, 42 m/min rapids.',
    maxRpm: 12000, maxFeed: 42000, rapidRate: 42000,
    travel: { X: 1050, Y: 510, Z: 510 }, toolStations: 30,
  }),
  mill({
    id: 'mazak-vcn530c', brand: 'Mazak', model: 'VCN-530C', controller: 'mazatrol-eia',
    note: 'Vertical Center Nexus. 20 mm more Y than the Smart of the same number.',
    maxRpm: 12000, maxFeed: 36000, rapidRate: 42000,
    travel: { X: 1050, Y: 530, Z: 510 }, toolStations: 30,
  }),
  mill({
    id: 'mazak-vcn530c-4th', brand: 'Mazak', model: 'VCN-530C + 4th axis', controller: 'mazatrol-eia',
    // A real configuration, not a hypothetical: these are sold with a Kitagawa
    // (or Nikken) rotary table bolted to the table, indexing on A.
    note: 'With a rotary table on A. This post writes 3-axis — index A by hand.',
    maxRpm: 12000, maxFeed: 36000, rapidRate: 42000,
    // The rotary eats into usable Y, and the part sits up on the table centre,
    // so the practical Z is shorter than the bare machine's.
    travel: { X: 1050, Y: 530, Z: 510 }, toolStations: 30,
    axes: AXES.mill4,
  }),
  mill({
    id: 'doosan-dnm5700', brand: 'DN Solutions (Doosan)', model: 'DNM 5700', controller: 'fanuc',
    note: 'Big-table 40-taper on a Fanuc control. Heavy cuts.',
    maxRpm: 8000, maxFeed: 20000, rapidRate: 36000,
    travel: { X: 1300, Y: 570, Z: 625 }, toolStations: 30,
  }),
  mill({
    id: 'dmgmori-dmu50', brand: 'DMG MORI', model: 'DMU 50', controller: 'siemens',
    note: '5-axis: swivel B, rotary C. The post here writes 3-axis ISO only.',
    maxRpm: 12000, maxFeed: 30000, rapidRate: 30000,
    travel: { X: 500, Y: 450, Z: 400 }, toolStations: 30,
    axes: AXES.mill5bc,
  }),
  mill({
    id: 'okuma-genos-m560', brand: 'Okuma', model: 'GENOS M560-V', controller: 'okuma',
    note: 'OSP control. Thermally stable, heavy frame.',
    maxRpm: 15000, maxFeed: 32000, rapidRate: 40000,
    travel: { X: 1050, Y: 560, Z: 460 }, toolStations: 32,
  }),
  mill({
    id: 'fanuc-generic-vmc', brand: 'Generic', model: '3-axis VMC (Fanuc 0i)', controller: 'fanuc',
    note: 'The safe default. Plain Fanuc output, nothing model-specific.',
    maxRpm: 12000, maxFeed: 10000, rapidRate: 15000,
    travel: { X: 800, Y: 500, Z: 500 }, toolStations: 20,
  }),
  mill({
    id: 'generic-vmc-4axis', brand: 'Generic', model: '4-axis VMC (A trunnion)', controller: 'fanuc',
    note: 'A rotary on the table. The post writes 3-axis; A stays parked.',
    maxRpm: 12000, maxFeed: 10000, rapidRate: 15000,
    travel: { X: 800, Y: 500, Z: 500 }, toolStations: 20,
    axes: AXES.mill4,
  }),
  mill({
    id: 'knee-mill-cnc', brand: 'Generic', model: 'Knee mill / retrofit', controller: 'fanuc',
    note: 'Slow spindle, plenty of torque. Big cutters, low rpm.',
    maxRpm: 4000, minRpm: 60, maxFeed: 3000, rapidRate: 4000,
    travel: { X: 700, Y: 300, Z: 400 }, toolStations: 1, rigidity: 0.8,
  }),
  mill({
    id: 'router-grbl', brand: 'Generic', model: 'CNC router (GRBL / Mach3)', controller: 'grbl',
    note: 'High rpm, low stiffness, usually no tool changer.',
    maxRpm: 24000, minRpm: 6000, maxFeed: 6000, rapidRate: 8000,
    travel: { X: 600, Y: 400, Z: 100 }, toolStations: 1, rigidity: 0.35,
  }),

  // ---- Turning ------------------------------------------------------------
  // Lathe X stroke is the cross-slide travel in *radius*; `maxTurnDia` is the
  // capacity the machine is sold on. Both are checked, because a part can clear
  // the swing and still run the slide out of travel.
  lathe({
    id: 'haas-st20', brand: 'Haas', model: 'ST-20', controller: 'haas',
    note: '8-inch chuck turning centre. The common shop lathe.',
    maxRpm: 4000, maxFeed: 12700, rapidRate: 24000,
    travel: { X: 209, Z: 559 }, maxTurnDia: 267, toolStations: 12,
  }),
  lathe({
    id: 'doosan-puma2100', brand: 'DN Solutions (Doosan)', model: 'PUMA 2100', controller: 'fanuc',
    note: 'Fanuc control, heavy box-way lathe.',
    maxRpm: 4500, maxFeed: 10000, rapidRate: 30000,
    travel: { X: 210, Z: 550 }, maxTurnDia: 320, toolStations: 12,
  }),
  lathe({
    id: 'mazak-qt200', brand: 'Mazak', model: 'QUICK TURN 200', controller: 'mazatrol-eia',
    note: 'Mazatrol lathe, programmed here in EIA/ISO.',
    maxRpm: 5000, maxFeed: 10000, rapidRate: 20000,
    travel: { X: 200, Z: 515 }, maxTurnDia: 350, toolStations: 12,
  }),
  lathe({
    id: 'okuma-lb3000', brand: 'Okuma', model: 'LB3000 EX', controller: 'okuma',
    note: 'OSP control, driven tools on C. Large bar capacity.',
    maxRpm: 5000, maxFeed: 10000, rapidRate: 25000,
    travel: { X: 260, Z: 800 }, maxTurnDia: 410, toolStations: 12,
    axes: AXES.turn3c,
  }),
  lathe({
    id: 'citizen-l20', brand: 'Citizen', model: 'Cincom L20 (Swiss)', controller: 'fanuc',
    note: 'Sliding head with Y and C. Small bar, high rpm, light cuts.',
    maxRpm: 10000, minRpm: 200, maxFeed: 5000, rapidRate: 32000,
    travel: { X: 40, Y: 40, Z: 205 }, maxTurnDia: 20, toolStations: 20, rigidity: 0.6,
    axes: AXES.swiss,
  }),
  lathe({
    id: 'fanuc-generic-lathe', brand: 'Generic', model: '2-axis CNC lathe (Fanuc)', controller: 'fanuc',
    note: 'The safe default lathe. Plain Fanuc output.',
    maxRpm: 3000, maxFeed: 5000, rapidRate: 8000,
    travel: { X: 180, Z: 450 }, maxTurnDia: 250, toolStations: 8,
  }),
  lathe({
    id: 'toolroom-lathe', brand: 'Generic', model: 'Toolroom lathe', controller: 'fanuc',
    note: 'Heavy, slow, forgiving. Large diameters.',
    maxRpm: 1500, minRpm: 40, maxFeed: 2000, rapidRate: 3000,
    travel: { X: 250, Z: 700 }, maxTurnDia: 400, toolStations: 4,
  }),
];

export const DEFAULT_MILL_ID = 'fanuc-generic-vmc';
export const DEFAULT_LATHE_ID = 'fanuc-generic-lathe';
export const DEFAULT_MACHINE_ID = DEFAULT_MILL_ID;

/** Look a machine up by id, falling back to the default rather than throwing. */
export function machineById(id) {
  return MACHINES.find((m) => m.id === id)
    || MACHINES.find((m) => m.id === DEFAULT_MACHINE_ID);
}

/** The machines that can perform a given process. */
export function machinesFor(kind) {
  return MACHINES.filter((m) => m.kind === kind);
}

/** Machines grouped by brand, for a grouped `<Select>`. */
export function machinesByBrand(kind) {
  const groups = new Map();
  for (const m of machinesFor(kind)) {
    if (!groups.has(m.brand)) groups.set(m.brand, []);
    groups.get(m.brand).push(m);
  }
  return [...groups].map(([brand, machines]) => ({ brand, machines }));
}

/**
 * The machine to switch to when the process changes.
 *
 * Keeps the current machine when it already does that process, so flipping a
 * part from mill to turn and back does not silently forget that the shop's mill
 * is a Speedio. Otherwise it prefers a machine of the *same make* — a shop with
 * a Haas mill most likely has the Haas lathe — before falling back to generic.
 */
export function machineForMode(kind, currentId) {
  const current = MACHINES.find((m) => m.id === currentId);
  if (current && current.kind === kind) return current;
  if (current) {
    const sameBrand = machinesFor(kind).find((m) => m.brand === current.brand);
    if (sameBrand) return sameBrand;
  }
  return machineById(kind === 'turn' ? DEFAULT_LATHE_ID : DEFAULT_MILL_ID);
}

/** How a machine's axes read in one line: "3-axis (XYZ)", "5-axis (XYZ+BC)". */
export function axisLabel(machine) {
  const linear = machine.linear.join('');
  const rotary = machine.rotary.length ? `+${machine.rotary.join('')}` : '';
  return `${machine.axisCount}-axis (${linear}${rotary})`;
}

/** Every axis letter this machine can be commanded on. */
export function axisLetters(machine) {
  return [...machine.linear, ...machine.rotary];
}

/** Stroke as "762 × 406 × 508 mm", in the machine's own axis order. */
export function travelLabel(machine) {
  return `${machine.linear.map((a) => machine.travel?.[a] ?? '?').join(' × ')} mm`;
}
