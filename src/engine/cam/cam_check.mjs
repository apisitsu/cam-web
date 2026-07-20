/**
 * Node-only end-to-end check: fixture solid -> STL bytes -> plan -> NC.
 *
 * Kept as a `*_check.mjs` script rather than a vitest file because it writes
 * files and prints a report for a human to read — the assertions that matter
 * are already covered by `plan.test.js`. Run it to eyeball a real program:
 *
 *   node src/engine/cam/cam_check.mjs
 *
 * The written .nc files are the ones to load into the viewport's backplot.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseSTL, weld } from '../mesh/stl.js';
import { planJob, planContext, planSummary } from './plan.js';
import { post } from './post/fanuc.js';
import { machineById, MACHINES, axisLabel, travelLabel } from './machines.js';
import { axisSummary, fitWarnings } from './envelope.js';
import { autoRecipe, setStepTool, removeStep, moveStep, addStep } from './recipe.js';
import { describeFace, describeEdge } from '../mesh/features.js';
import { interpret } from '../gcode/interpreter.js';
import { turnedShaft, groovedShaft, box } from '../mesh/fixtures.js';

/** Serialise a triangle soup to binary STL, so the check starts from bytes. */
function toBinarySTL(soup) {
  const buf = Buffer.alloc(84 + soup.triangleCount * 50);
  buf.write('cam-web fixture', 0);
  buf.writeUInt32LE(soup.triangleCount, 80);
  let o = 84;
  for (let t = 0; t < soup.triangleCount; t++) {
    o += 12;
    for (let v = 0; v < 9; v++) { buf.writeFloatLE(soup.positions[t * 9 + v], o); o += 4; }
    o += 2;
  }
  return buf;
}

function run(label, soup, opts = {}) {
  const bytes = toBinarySTL(soup);
  const stl = parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const welded = weld(stl);
  const plan = planJob(stl, welded, opts);
  const machine = opts.machineId ? machineById(opts.machineId) : null;
  const nc = post({
    name: label, mode: plan.mode, material: plan.material,
    machineLabel: machine?.label,
    stock: plan.stock, operations: plan.operations,
  }, { diameterMode: true, controller: machine?.controller });

  const { segments } = interpret(nc, { mode: plan.mode, diameterMode: true });
  const summary = planSummary(plan);

  console.log(`\n=== ${label} ===`);
  console.log(`  ${stl.triangleCount} triangles -> ${plan.mode.toUpperCase()}${machine ? ` on ${machine.label} (${machine.controller})` : ''}`);
  console.log(`  bbox ${summary.boundingBox.join(' x ')} mm, ${summary.volume} mm^3`);
  for (const s of summary.steps) {
    console.log(`  ${s.n}. ${s.title.padEnd(28)} ${s.tool.padEnd(34)} ${String(s.rpm).padStart(5)} rpm  ${String(s.feed).padStart(7)}  ${s.minutes} min`);
  }
  console.log(`  total ~${summary.totalMinutes} min cutting`);
  console.log(`  axes: ${axisSummary(plan.envelope)}`);
  if (plan.envelope.travel.length) {
    console.log(`  stroke: ${plan.envelope.travel
      .map((t) => `${t.axis} ${t.need}/${t.stroke}mm (${t.used}%)${t.over ? ' OVER' : ''}`)
      .join('  ')}`);
  }
  console.log(`  NC: ${nc.split('\n').length} lines -> interpreter produced ${segments.length} segments`);
  for (const w of summary.warnings) console.log(`  ! ${w}`);

  mkdirSync('nc_program', { recursive: true });
  const file = `nc_program/${label.replace(/\s+/g, '-')}.nc`;
  writeFileSync(file, nc);
  writeFileSync(`nc_program/${label.replace(/\s+/g, '-')}.stl`, bytes);
  console.log(`  wrote ${file}`);
  return { plan, nc, segments };
}

run('stl-turned-shaft', turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }), { material: 'mild-steel' });
run('stl-grooved-shaft', groovedShaft({ radius: 15, length: 60, grooveZ: 30, grooveWidth: 4, grooveDepth: 3 }), { material: 'aluminium' });
run('stl-plate', box(60, 40, 15), { material: 'aluminium' });

// The same plate on two different machines. Nothing about the part changed —
// only the machine — and the rpm, the feed and the program header all move.
run('stl-plate-speedio', box(60, 40, 15), { material: 'aluminium', machineId: 'brother-s700' });
run('stl-plate-haas', box(60, 40, 15), { material: 'aluminium', machineId: 'haas-vf2' });

// And the same plate again, with the operator overruling the planner: rough
// with a Ø8 instead of the Ø20 it chose, skip the facing pass, finish first.
{
  const soup = box(60, 40, 15);
  const bytes = toBinarySTL(soup);
  const stl = parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const welded = weld(stl);
  const ctx = planContext(stl, welded, { machineId: 'haas-vf2' });
  let recipe = autoRecipe(ctx);
  recipe = setStepTool(recipe, 'rough', 'em8');
  recipe = removeStep(recipe, 'face');
  recipe = moveStep(recipe, 'finish', -1);
  run('stl-plate-operator', soup, { material: 'aluminium', machineId: 'haas-vf2', recipe });
}

// ---------------------------------------------------------------------------
// The machine list itself: stroke and axes, and which machines could take a
// long plate. This is the table to eyeball when the answer to "will it fit"
// has to be trusted.
// ---------------------------------------------------------------------------
const trial = { size: [500, 200, 40] };
console.log('\n=== machines: stroke and axes ===');
console.log(`  (fit column tests a ${trial.size.join(' x ')} mm part)`);
for (const m of MACHINES) {
  const problems = fitWarnings(m, trial);
  const verdict = m.kind === 'mill'
    ? (problems.length ? 'NO ' : 'yes')
    : ' - ';
  console.log(
    `  ${verdict}  ${m.label.padEnd(36)} ${axisLabel(m).padEnd(16)} ${travelLabel(m).padStart(20)}  ${m.controller}`,
  );
}

// ---------------------------------------------------------------------------
// Indexed 4th axis, and operations built from picked geometry.
// ---------------------------------------------------------------------------
{
  const soup = box(120, 30, 20);
  const bytes = toBinarySTL(soup);
  const stl = parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const welded = weld(stl);
  const ctx = planContext(stl, welded, { mode: 'mill', machineId: 'mazak-vcn530c-4th' });

  // Rough from both sides of the bar.
  let recipe = addStep(autoRecipe(ctx), 'rough', ctx, { angle: 180 });

  // ...then pick the top face and the longest edge off the model itself.
  const { faces, edges } = ctx.features;
  const top = faces.find((f) => f.facing === 'up');
  console.log(`\n  detected ${faces.length} faces, ${edges.length} edge chains`);
  console.log(`  picking face ${top.id}: ${describeFace(top)}`);
  console.log(`  picking edge ${edges[0].id}: ${describeEdge(edges[0])}`);
  recipe = addStep(recipe, 'region', ctx, { target: { faceId: top.id } });
  recipe = addStep(recipe, 'trace', ctx, { target: { edgeId: edges[0].id, depth: 0.4 } });

  run('stl-bar-4axis', soup, { material: 'aluminium', machineId: 'mazak-vcn530c-4th', recipe });
}
