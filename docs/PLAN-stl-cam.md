# แผน: STL Import → AI Process Planning → Auto Toolpath → Export NC

สถานะ: **เฟส 1–6 ทำงานได้แล้วครบวง** (STL → แผน → NC) · เฟส 7–8 ยังไม่เริ่ม
เขียนเมื่อ 2026-07-19

## สรุปสิ่งที่ใช้งานได้แล้ว

```
.stl → parseSTL/weld → analyzeMesh → planJob → toolpath → post → .nc
                            ↓                                      ↓
                     กัด หรือ กลึง?                    interpreter + simulator เดิม
```

| โมดูล | ไฟล์ | หน้าที่ |
|---|---|---|
| STL reader | `engine/mesh/stl.js` | ASCII + binary, `weld()` |
| วิเคราะห์ | `engine/mesh/analyze.js` | bbox, ปริมาตร, watertight, หาแกนหมุน |
| ตัดระนาบ | `engine/mesh/slice.js` | Z-level + section ผ่านแกน |
| โปรไฟล์กลึง | `engine/mesh/profile.js` | scanline → OD/รู/ร่อง |
| Polygon offset | `engine/cam/offset.js` | clipper-lib |
| ทูล + วัสดุ | `engine/cam/library.js` | 8 วัสดุ, endmill/drill/insert |
| รอบ+ฟีด | `engine/cam/feeds.js` | Vc/fz/fn + clamp ตามเครื่อง |
| Toolpath | `engine/cam/toolpath/{turn,mill}.js` | face/rough/finish/groove/bore/part, drill/pocket/contour |
| Planner | `engine/cam/plan.js` | วัดชิ้นงาน (`planContext`) + เสนอแผน |
| **Recipe** | `engine/cam/recipe.js` | **แผนที่ผู้ใช้แก้ได้** — เลือกทูล/ลำดับ/เปิด-ปิด/เพิ่ม-ลบ op |
| **เครื่องจักร** | `engine/cam/machines.js` | **19 รุ่นจริง** + stroke ต่อแกน + จำนวนแกน (Haas VF-2/ST-20, Brother Speedio, Mazak VCN-410A/**VCS-530C**/QT-200, Doosan, Okuma, DMU 50 5 แกน, Citizen L20…) |
| **Envelope** | `engine/cam/envelope.js` | โปรแกรมใช้แกนไหน · กินระยะวิ่งกี่ % · เกิน stroke ไหม |
| Post | `engine/cam/post/fanuc.js` + `post/dialect.js` | NC ตาม controller ของเครื่อง (7 dialect) |
| Store / UI | `stores/camPlanStore.js`, `components/CamPanel.jsx` | |

ตรวจสอบ: `npm test` 773 tests · `node src/engine/cam/cam_check.mjs` สร้าง NC จริง

### ผู้ใช้ควบคุมเองได้ (เพิ่ม 2026-07-19)

แผนแยกเป็นสองชั้น: **วัด** (`planContext` — slice/profile/หารู ทำครั้งเดียว) และ
**สร้าง** (`buildPlan(ctx, recipe)` — pure, เร็ว) ทำให้เปลี่ยนทูลหนึ่งตัวแล้ว
feed/รอบ/เวลา/คำอธิบาย/NC อัปเดตพร้อมกันทั้งหมด ไม่มีทางไม่ตรงกัน

- **เลือกทูลเอง** ทุก op — ทูลที่ไม่พอดี *ยังแสดงอยู่* แต่ปิดไว้พร้อมเหตุผล
- **เลือก toolpath เอง** — เปิด/ปิด, สลับลำดับ, ลบ, เพิ่ม op ที่ planner ไม่ได้เสนอ
- **เลือกเครื่องตามยี่ห้อ/รุ่น** — กำหนดทั้งกระบวนการ (กัด/กลึง), ลิมิตรอบ+ฟีด,
  ความแข็งแรง (`rigidity` คูณ ap) และ **dialect ของ NC**
- `why` ถูกสร้างใหม่จากทูลที่ใช้จริง ไม่ใช่ทูลที่ planner เลือกไว้ตอนแรก

### Stroke และจำนวนแกน (เพิ่ม 2026-07-19)

ทุกเครื่อง**รู้ระยะวิ่งต่อแกน**แล้ว (`travel: {X, Y, Z}` หรือ `{X, Z}` สำหรับ
lathe — key ตามตัวอักษรแกน ไม่ใช่ array เพราะ lathe ไม่มี Y) และ**รู้จำนวนแกน**
(`linear` / `rotary` / `axisCount`)

`envelope.js` ตอบสองคำถามที่ต่างกัน โดยอ่านจาก **toolpath จริง** ไม่ใช่จากชิ้นงาน:

1. **โปรแกรมสั่งแกนไหนบ้าง** — นับเฉพาะแกนที่*ขยับจริง* ถ้าเจอแกนที่เครื่องไม่มี
   → เตือน (เช่นโปรแกรม 3 แกนบน lathe 2 แกน)
2. **เกิน stroke ไหม** — เทียบเป็น *ช่วงการเคลื่อนที่* ไม่ใช่ตำแหน่งสัมบูรณ์
   (work offset ตั้งที่เครื่อง เราไม่รู้) · **lathe X เทียบเป็นรัศมี** เพราะ
   cross-slide วิ่งเป็นรัศมีแต่โปรแกรมเขียนเป็นเส้นผ่าศูนย์กลาง

UI แสดง `3-axis (XYZ)` + `stroke 762 × 406 × 508 mm` ของเครื่อง และแยกอีกบรรทัด
ว่าโปรแกรมนี้ต้องใช้กี่แกน กินระยะวิ่งแต่ละแกนกี่ %

### แกนที่ 4 แบบ indexed (เพิ่ม 2026-07-20)

**หลักคิด:** rotary แบบ index ไม่ใช่ toolpath ชนิดใหม่ — มันคือ toolpath 3 แกน
*เดิม* ที่รันบนชิ้นงานเมื่อมองจากมุมใหม่ ดังนั้น `mesh/rotate.js` หมุน mesh กลับ
`-A` แล้วโค้ดเดิมทั้งหมด (slice / offset / hole) ทำงานต่อได้ทันที

- `plan.js:indexContext(ctx, angle)` — วัดชิ้นงานใหม่ที่มุมนั้น (memoized)
- recipe entry มี `target.angle` · key เป็น `rough@A180` · A0 ไม่มี suffix
  (งาน 3 แกนยังเป็นไฟล์ 3 แกนเหมือนเดิม รันบนเครื่องทั่วไปได้)
- post เขียน `G00 A180.` **หลัง tool change ก่อนเข้าใกล้งาน** — หมุนโต๊ะตอนมีดจม
  อยู่ในร่องคือทางพังทั้งมีดทั้งโต๊ะ · dialect ที่ไม่มี rotary (GRBL) เขียนคอมเมนต์
  บอกให้ index ด้วยมือแทน
- `envelope.js` นับ A เป็นแกนที่โปรแกรมต้องใช้ → เครื่อง 3 แกนขึ้นเตือนทันที

**ยังไม่ทำ (ส่วนที่ 3):** setup planning — ตัดสินอัตโนมัติว่าชิ้นงานต้องกัดกี่หน้า
หน้าไหนเข้าถึงได้จากมุมไหน · ตอนนี้ผู้ใช้เลือกมุมเอง

### เลือก face / edge จาก STL มาสร้าง toolpath (เพิ่ม 2026-07-20)

STL ไม่มี feature เหลืออยู่ — พื้นกระเป๋าคือสามเหลี่ยม 400 ชิ้นที่บังเอิญอยู่ระนาบ
เดียวกัน `mesh/features.js` ประกอบกลับ:

- **Planar face** — merge สามเหลี่ยมที่ *ต่อกัน* **และ** *อยู่ระนาบเดียวกัน*
  (ต้องครบสองเงื่อนไข: อย่างแรกอย่างเดียวจะเชื่อม fillet เข้ากับผนัง อย่างหลัง
  อย่างเดียวจะเชื่อมผิวบนสองชิ้นที่ความสูงเท่ากันเข้าด้วยกัน) · กล่อง 12 สามเหลี่ยม
  → 6 หน้าพอดี
- **Sharp edge** — dihedral > 30° เชื่อมเป็น polyline (ทรงกระบอก 48 เหลี่ยม
  = 7.5°/facet จึงไม่ถูกนับ เหลือแค่ขอบบน-ล่างจริง ๆ)

`toolpath/feature.js` → `faceRegionOp` (เคลียร์หน้าที่เลือกด้วย ring ซ้อน) และ
`traceOp` (เดินตามเส้นที่เลือก) · **ปฏิเสธหน้าที่ไม่ได้หันขึ้น** ไม่ยอมกัดเงาของผนัง

เลือกได้สองทาง: **คลิกบนโมเดล** (raycast → `faceOfTriangle` → หน้าทั้งหน้า ไม่ใช่
สามเหลี่ยมเดียว) หรือ **เลือกจากลิสต์ในพาเนล** (เข้าถึงหน้าที่มองไม่เห็นได้ด้วย)

### Workflow: import → look → pick → cut (แก้ 2026-07-20)

เดิมต้องกด "Analyse & plan" ก่อนถึงจะเห็นอะไร — เป็นการบังคับให้ตัดสินใจก่อน
ที่ผู้ใช้จะได้ตัดสินใจอะไรเลย ตอนนี้:

| ขั้น | เกิดอะไร |
|---|---|
| import | `prepare()` **วัดอย่างเดียว ไม่ตัดสินใจอะไร** — วางชิ้นงานนอน + ตรวจ face/edge |
| เลือก | คลิกโมเดลหรือแถวในลิสต์ → sticky selection (hover = preview เฉย ๆ) |
| สร้าง | แถบ action ของสิ่งที่เลือก → "Clear this face" / "Trace this edge" |
| (ทางเลือก) | `Auto-plan` = ปุ่มรอง แทนที่ recipe ทั้งหมดด้วยแผนอัตโนมัติ |

- `prepare()` แยกจาก `makePlan()` — recipe เริ่มต้น**ว่าง** ไม่ใช่ autoRecipe
- เปลี่ยนเครื่อง = `prepare()` + `rebuild()` → **ไม่ทิ้ง op ที่ผู้ใช้เลือกไว้**
  (`reconcile` ตัดเฉพาะอันที่ใช้กับชิ้นงาน/กระบวนการใหม่ไม่ได้)
- ชิ้นงานถูกวางนอนตั้งแต่ import ไม่ใช่ตอน plan — เพราะผู้ใช้เลือกหน้าทันที
  ถ้ารอถึงตอน plan จะเลือกหน้าจาก setup ที่ผิด



## 1. จุดยืนปัจจุบัน — เรามีอะไรอยู่แล้ว

วันนี้ cam-web เป็น **ตัวอ่านและตรวจสอบ (verifier)** ไม่ใช่ตัวสร้าง (generator):

| มีแล้ว | ไฟล์ | ใช้ต่อได้ยังไง |
|---|---|---|
| G-code interpreter (mill + turn, G18/ZX, diameter mode, macro) | `engine/gcode/interpreter.js` | ตรวจ NC ที่เราสร้างเอง |
| Dexel / voxel / turning material-removal sim | `engine/sim/` | เทียบผลลัพธ์กับ STL ต้นฉบับ |
| Tool-table auto-detect จาก comment | `engine/gcode/tools.js` | ต่อยอดเป็น tool library จริง |
| Sketcher 2D + planegcs + DXF export | `engine/sketch/` | ใช้เป็น UI แก้ profile ที่ AI เสนอ |
| Project save/load | `engine/projectFile.js` | เก็บ CAM setup |

**ยังไม่มีเลย:** STL parser, feature recognition, toolpath generation, post-processor
(เขียน G-code ออก), tool/material library, การเรียก LLM ใด ๆ, backend

## 2. ความเป็นไปได้ — ตอบตรง ๆ

**ทำได้ และไม่ต้องแตะ OCCT** ซึ่งต่างจากที่ `cam_web.txt` เดิมวางไว้

เหตุผล: OCCT จำเป็นเมื่อจะ **สร้าง/แก้** B-rep (extrude, fillet, STEP) แต่งานนี้รับ
STL เข้ามา ซึ่งเป็น **mesh อยู่แล้ว** และอัลกอริทึม CAM ที่ต้องใช้ทั้งหมดทำงานบน mesh
ได้โดยตรง — slice, drop-cutter, polygon offset ตัด dependency 30MB ออกไปได้ทั้งก้อน

ระดับความยากแยกเป็นสามชั้น ไม่เท่ากันเลย:

| ส่วน | ความยาก | หมายเหตุ |
|---|---|---|
| STL parser (ASCII + binary) | ง่ายมาก | ~150 บรรทัด pure JS |
| **Turning: STL → profile → toolpath** | **ง่าย–กลาง** | ปัญหา 2 มิติ ทำจบได้จริง |
| Post-processor (เขียน NC) | ง่าย–กลาง | รูปแบบ output เรารู้อยู่แล้วจาก parser |
| Milling 3-axis roughing (Z-level) | กลาง | ต้อง slice + polygon offset |
| Milling finishing (drop-cutter) | กลาง | ตรงไปตรงมาแต่ต้องมี spatial index ไม่งั้นช้า |
| Feature recognition (รู, ระนาบ, กระเป๋า) | **ยาก** | STL ไม่มี semantic เหลืออยู่ ต้อง fit ทรงกลับ |
| Speeds & feeds | ง่าย (สูตร) / ยาก (ให้ถูกจริง) | ต้องมีตารางวัสดุ |
| Collision / holder gouge check | ยาก | **ตัดออกจาก scope แรก** |

**ข้อได้เปรียบใหญ่ที่สุดของ repo นี้:** เรามี simulator อยู่แล้ว ทำให้เกิดลูปปิด

```
STL → toolpath → post → NC → interpreter → sim → mesh ผลลัพธ์
                                                      ↓
                                        เทียบกับ STL ต้นฉบับ → error สูงสุดกี่ mm?
```

นี่คือ **automated test ของ CAM engine** ที่ CAM ส่วนใหญ่ไม่มี และมันตรงกับกฎ
engine-first ใน CLAUDE.md เป๊ะ — เขียน test ก่อนต่อ UI ได้ทั้งหมด

## 3. เรื่อง "AI ประเมินผล" — ต้องแยกให้ชัด

คำว่า AI ตรงนี้ควรเป็น **สองชั้น** ไม่ใช่ชั้นเดียว:

### ชั้น A — Deterministic planner (นี่คือของจริงที่สร้าง toolpath)

โมดูล pure JS ที่วิเคราะห์ mesh แล้วตัดสินใจด้วยกฎวิศวกรรม:

- bbox, ปริมาตร, ทิศที่ควรตั้งชิ้นงาน
- **ทดสอบ rotational symmetry** → ถ้าผ่าน = งานกลึง, ไม่ผ่าน = งานกัด (นี่คือคำตอบว่า
  "ไปทาง Milling หรือ Turning")
- รัศมีเว้าที่เล็กที่สุด → กำหนดขนาด **ทูลจบสูงสุด** ที่เข้าถึงได้
- ความลึกที่ลึกที่สุด → กำหนด reach / stick-out
- ระนาบแนวนอน → งานผิวหน้า, ทรงกระบอกแนวแกน → รูเจาะ
- เลือกทูลจาก library, คำนวณ S/F จากตารางวัสดุ, จัดลำดับ operation

ทำงาน offline, ทดสอบได้ 100%, ผลลัพธ์ซ้ำเดิมทุกครั้ง — **ส่วนนี้ต้องมาก่อน**

### ชั้น B — LLM (Claude API) เป็นชั้นอธิบายและปรับจูน

ส่งเฉพาะ **JSON สรุปผลวิเคราะห์** (ไม่กี่ KB ไม่ใช่ mesh) ไปให้โมเดล แล้วได้กลับมา:

- คำอธิบายแผนงานเป็นภาษาคน ("เจาะนำก่อนเพราะ...")
- ปรับลำดับ operation ตามบริบทที่กฎเขียนไว้ไม่ครบ
- เตือนความเสี่ยง (ผนังบาง, ทูลยื่นยาว, งานหนีบยาก)
- ตอบคำถามผู้ใช้ว่า "ทำไมถึงเลือกทูลตัวนี้"

ข้อจำกัดที่ต้องรู้ล่วงหน้า: **แอปเป็น browser-only ไม่มี backend** จะเรียก Claude API
ตรงจาก browser ไม่ได้ถ้าไม่อยากให้ API key หลุด ทางเลือก:
1. ให้ผู้ใช้ใส่ API key เอง เก็บใน localStorage (ง่ายสุด เหมาะกับใช้ภายใน)
2. เพิ่ม proxy เล็ก ๆ (Fastify/serverless function) — สะอาดกว่า แต่เพิ่ม infra
3. เลื่อนชั้น B ออกไปก่อน ให้ชั้น A ทำงานเต็มที่ก่อน

**ข้อเสนอ: เริ่มที่ (3) แล้วค่อยเลือก (1) หรือ (2)** — เพราะ toolpath ที่ใช้ได้จริง
มาจากชั้น A ทั้งหมด ถ้าให้ LLM "คิด toolpath" เองจะได้ G-code ที่ดูดีแต่พังชิ้นงาน

## 4. โมดูลที่ต้องสร้าง (engine-first ตาม CLAUDE.md)

```
src/engine/mesh/
  stl.js            อ่าน ASCII + binary STL → {positions, indices, count}
  stl.test.js
  analyze.js        bbox, ปริมาตร, watertight?, ทดสอบสมมาตรรอบแกน
  analyze.test.js
  slice.js          ตัด mesh ที่ระนาบ Z → polygon ปิด (สำหรับ Z-level rough)
  slice.test.js
  profile.js        silhouette รอบแกน → โปรไฟล์ (r,z) สำหรับงานกลึง
  profile.test.js

src/engine/cam/
  library.js        tool library + ตารางวัสดุ (Vc, fz, ae/ap)
  feeds.js          S = 1000·Vc/(π·D) · F = S·z·fz · lathe: F เป็น mm/rev, G96
  feeds.test.js
  plan.js           ★ planner ชั้น A: analysis → รายการ operation
  plan.test.js
  toolpath/
    facing.js       ปาดผิว raster
    zlevel.js       roughing แบบ Z-level (ต้องใช้ polygon offset)
    contour.js      finishing รอบข้าง
    dropcutter.js   finishing 3D raster (ball/flat vs triangle)
    drill.js        วงจรเจาะ (G81/G83)
    turn.js         งานกลึง: rough/finish/face/part-off (G71-style หรือคลี่เอง)
  post/
    index.js        toolpath → G-code (fanuc / haas / grbl)
    post.test.js    ★ round-trip: post → interpret → sim → เทียบ STL

src/stores/camPlanStore.js    state: mesh, analysis, plan, ผลลัพธ์ toolpath
src/components/CamPanel.jsx   UI บาง ๆ: dropzone, ตารางแผนงาน, ปุ่ม Export NC
```

Dependency ใหม่ที่ต้องเพิ่ม: **`clipper-lib` หรือ `clipper2-js`** (polygon offset,
pure JS ไม่ใช่ WASM) — ตัวเดียวเท่านั้น

## 5. ลำดับงาน (แต่ละเฟสจบแล้วเห็นผลได้จริง)

| เฟส | ส่ง | สถานะ |
|---|---|---|
| **1** | STL import + `analyze.js` | ✅ เสร็จ |
| **2** | Post-processor + ปุ่ม Export NC | ✅ เสร็จ (Fanuc, mill + turn) |
| **3a** | Turning: profile → rough/finish/face/bore | ✅ เสร็จ |
| **3b** | ร่อง (grooving) | ✅ เสร็จ · **เกลียว G76 ยังไม่ทำ** |
| **4** | Tool library + `feeds.js` | ✅ เสร็จ |
| **5** | Milling: facing + Z-level rough + contour + drill | ✅ เสร็จ |
| **6** | `plan.js` เลือก op/ทูล/ลำดับอัตโนมัติ | ✅ เสร็จ |
| **7** | Drop-cutter finishing (ผิวโค้ง 3D) | ⬜ ยังไม่เริ่ม |
| **8** | ชั้น B — Claude API อธิบาย/ปรับแผน | ⬜ เลื่อนไว้ (`planSummary()` เตรียม payload ไว้แล้ว) |

เฟส 1–3 คือก้อนที่ได้ผลตอบแทนสูงสุดต่อความพยายาม จบสามเฟสนี้จะมี
**STL งานกลึง → NC ที่ตัดได้จริง** พร้อมหลักฐานจาก simulator

## 6. ความเสี่ยงที่ต้องยอมรับตั้งแต่ต้น

1. **STL ไม่มี tolerance และไม่มี feature** — รูขนาด Ø10 จะกลายเป็นทรง 32 เหลี่ยม
   ต้อง fit ทรงกระบอกกลับและปัดเข้าขนาดมาตรฐาน ยังไงก็เดาผิดได้ ต้องให้ผู้ใช้ยืนยัน
2. **STL เสีย** (ไม่ปิดผนึก, normal กลับด้าน) เจอบ่อยมาก — ต้องตรวจและเตือน ไม่ใช่พังเงียบ ๆ
3. **Speeds/feeds ที่แนะนำคือจุดตั้งต้น ไม่ใช่คำตอบสุดท้าย** — ขึ้นกับเครื่อง ความแข็งแรง
   การจับยึด น้ำหล่อเย็น ต้องขึ้น disclaimer ใน UI
4. **ไม่มี collision check ในเฟสแรก** — NC ที่ export ออกไปต้องมีคำเตือนให้ dry-run ก่อน
5. **ประสิทธิภาพ** — mesh 500k triangle + drop-cutter ต้องมี BVH และต้องอยู่ใน worker
6. **Undercut ในงานกลึง** (ร่อง, เกลียวใน) — เฟสแรกให้ตรวจเจอแล้ว *แจ้งว่าทำไม่ได้*
   ดีกว่าสร้าง toolpath ผิด

## 7. ข้อตัดสินใจ (ยืนยันแล้ว 2026-07-19)

- **Post-processor: Fanuc** เป็นเป้าหลัก ตรงกับสไตล์ที่ `interpreter.js` รองรับอยู่แล้ว
  (G18/ZX, diameter mode, canned cycle) โครงสร้าง `post/` ยังแยก dialect ไว้เผื่อ
  Haas/GRBL ทีหลัง แต่ยังไม่เขียน
- **หน่วย: mm อย่างเดียว** ในเฟสแรก
- **ชั้น B (Claude API): เลื่อนออกไป** โฟกัสให้ชั้น A สร้าง toolpath ได้จริงก่อน
  ผลที่ตามมา: แอปยังเป็น browser-only ไม่ต้องมี backend เลยตลอดเฟส 1–7
- **งานกลึง: ครบทั้งร่องและเกลียว** — รวม ID boring, grooving, threading (G76)

ผลของข้อสุดท้ายต่อแผน: เฟส 3 ใหญ่ขึ้นกว่าที่ประเมินไว้ตอนแรก จึงแตกเป็นสองเฟสย่อย

- **3a** — OD/facing/ID boring จาก profile ที่ต่อเนื่อง (ไม่มี undercut)
  ครอบคลุมงานกลึงส่วนใหญ่ และเปิดลูปตรวจสอบกับ `sim/turning.js` ได้ทันที
- **3b** — ร่องและเกลียว ซึ่งเป็น **undercut** จึงต้องแยกออกมาต่างหาก:
  `profile.js` ต้องคืนโปรไฟล์แบบหลายค่าต่อหนึ่ง z ไม่ใช่ฟังก์ชัน r(z) เดี่ยว, ตรวจจับ
  ร่องจากช่วงที่รัศมีตกแล้วกลับขึ้น, และเกลียวต้องรู้ pitch ซึ่ง **อ่านจาก STL ตรง ๆ ไม่ได้**
  ต้อง fit เกลียวจาก mesh แล้วให้ผู้ใช้ยืนยัน pitch/ชนิดเกลียวก่อนออก G76
  ข้อจำกัดที่รับไว้: `sim/turning.js` เก็บรัศมีเดียวต่อ slice จึงจำลองร่องได้แต่ผิว
  ไม่แสดง undercut จริง — ต้องขยาย turning sim หรือยอมรับว่า verify ร่อง/เกลียวทำได้
  แค่ระดับโปรไฟล์
