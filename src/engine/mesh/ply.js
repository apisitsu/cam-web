/**
 * Stanford PLY reader — ASCII and binary little-endian.
 *
 * PLY is what comes out of scanners, MeshLab and most mesh-repair tools, which
 * is exactly the route a worn or reverse-engineered part takes on its way to
 * being re-cut. Supporting it is the difference between "remodel this in CAD
 * first" and "machine it".
 *
 * The format is self-describing: the header lists elements and their
 * properties, and the body is those properties in that order. So the reader has
 * to be driven by the header rather than by assumption — a PLY with colours has
 * six properties per vertex, and reading it as three silently shears the model.
 *
 * Big-endian PLY is rejected rather than guessed at. It exists, it is rare, and
 * reading it as little-endian produces coordinates in the 1e38 range that would
 * sail through as "a very large part".
 *
 * Pure functions. No three.js, no store, no DOM.
 */

const TYPE_SIZE = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

/** Read one scalar of `type` at `offset`. */
function readScalar(view, offset, type) {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, true);
    case 'ushort': case 'uint16': return view.getUint16(offset, true);
    case 'int': case 'int32': return view.getInt32(offset, true);
    case 'uint': case 'uint32': return view.getUint32(offset, true);
    case 'float': case 'float32': return view.getFloat32(offset, true);
    case 'double': case 'float64': return view.getFloat64(offset, true);
    default: return 0;
  }
}

/**
 * Split a PLY into its header text and the byte offset the body starts at.
 *
 * The header is always ASCII and always ends with `end_header\n`, even in a
 * binary file — which is what makes one reader able to handle both.
 */
function splitHeader(bytes) {
  const probe = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const marker = probe.indexOf('end_header');
  if (marker < 0) throw new Error('That PLY has no end_header line.');
  const newline = probe.indexOf('\n', marker);
  return {
    header: probe.slice(0, marker),
    bodyStart: newline + 1,
  };
}

/** Parse the header into an ordered element/property description. */
function parseHeader(header) {
  let format = null;
  const elements = [];
  for (const raw of header.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('format ')) {
      format = line.split(/\s+/)[1];
    } else if (line.startsWith('element ')) {
      const [, name, count] = line.split(/\s+/);
      elements.push({ name, count: Number(count), properties: [] });
    } else if (line.startsWith('property ') && elements.length > 0) {
      const parts = line.split(/\s+/);
      if (parts[1] === 'list') {
        elements[elements.length - 1].properties.push({
          list: true, countType: parts[2], type: parts[3], name: parts[4],
        });
      } else {
        elements[elements.length - 1].properties.push({
          list: false, type: parts[1], name: parts[2],
        });
      }
    }
  }
  return { format, elements };
}

/**
 * @param {ArrayBuffer|Uint8Array|string} data
 * @returns {{positions: Float32Array, triangleCount: number}}
 */
export function parsePLY(data) {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : (data instanceof Uint8Array ? data : new Uint8Array(data));

  const { header, bodyStart } = splitHeader(bytes);
  const { format, elements } = parseHeader(header);

  if (format === 'binary_big_endian') {
    throw new Error('Big-endian PLY is not supported — re-export as ASCII or little-endian.');
  }
  const vertexElement = elements.find((e) => e.name === 'vertex');
  const faceElement = elements.find((e) => e.name === 'face');
  if (!vertexElement) throw new Error('That PLY has no vertex element.');

  const { vertices, faces } = format === 'ascii'
    ? readAscii(bytes, bodyStart, elements, vertexElement, faceElement)
    : readBinary(bytes, bodyStart, elements, vertexElement, faceElement);

  // A PLY with vertices and no faces is a point cloud. It is a real thing to be
  // handed, and there is nothing to machine from it, so it is refused by name
  // rather than becoming an empty part.
  if (!faceElement || faces.length === 0) {
    throw new Error('That PLY is a point cloud (no faces) — it has no surface to machine.');
  }

  const out = [];
  for (const face of faces) {
    for (let k = 1; k + 1 < face.length; k++) {
      for (const i of [face[0], face[k], face[k + 1]]) {
        out.push(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]);
      }
    }
  }
  return { positions: new Float32Array(out), triangleCount: out.length / 9 };
}

function readAscii(bytes, bodyStart, elements, vertexElement, faceElement) {
  const text = new TextDecoder().decode(bytes.subarray(bodyStart));
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  const xi = vertexElement.properties.findIndex((p) => p.name === 'x');
  const yi = vertexElement.properties.findIndex((p) => p.name === 'y');
  const zi = vertexElement.properties.findIndex((p) => p.name === 'z');

  const vertices = new Float32Array(vertexElement.count * 3);
  const faces = [];
  let cursor = 0;

  for (const element of elements) {
    for (let i = 0; i < element.count; i++, cursor++) {
      const parts = (lines[cursor] ?? '').split(/\s+/);
      if (element === vertexElement) {
        vertices[i * 3] = Number(parts[xi]);
        vertices[i * 3 + 1] = Number(parts[yi]);
        vertices[i * 3 + 2] = Number(parts[zi]);
      } else if (element === faceElement) {
        const n = Number(parts[0]);
        const face = [];
        for (let k = 0; k < n; k++) face.push(Number(parts[1 + k]));
        faces.push(face);
      }
    }
  }
  return { vertices, faces };
}

function readBinary(bytes, bodyStart, elements, vertexElement, faceElement) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const xi = vertexElement.properties.findIndex((p) => p.name === 'x');
  const yi = vertexElement.properties.findIndex((p) => p.name === 'y');
  const zi = vertexElement.properties.findIndex((p) => p.name === 'z');

  const vertices = new Float32Array(vertexElement.count * 3);
  const faces = [];
  let offset = bodyStart;

  for (const element of elements) {
    for (let i = 0; i < element.count; i++) {
      if (element === vertexElement) {
        // Walked property by property rather than jumped, because a vertex may
        // carry normals and colours between the coordinates and the next one.
        const values = [];
        for (const p of element.properties) {
          values.push(readScalar(view, offset, p.type));
          offset += TYPE_SIZE[p.type] ?? 4;
        }
        vertices[i * 3] = values[xi];
        vertices[i * 3 + 1] = values[yi];
        vertices[i * 3 + 2] = values[zi];
      } else {
        for (const p of element.properties) {
          if (!p.list) { offset += TYPE_SIZE[p.type] ?? 4; continue; }
          const n = readScalar(view, offset, p.countType);
          offset += TYPE_SIZE[p.countType] ?? 1;
          const face = [];
          for (let k = 0; k < n; k++) {
            face.push(readScalar(view, offset, p.type));
            offset += TYPE_SIZE[p.type] ?? 4;
          }
          if (element === faceElement && p.name.includes('ind')) faces.push(face);
        }
      }
    }
  }
  return { vertices, faces };
}

/** True when the bytes start with the PLY magic. */
export function looksLikePLY(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79; // "ply"
}
