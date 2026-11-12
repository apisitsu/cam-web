/**
 * App — CAM Web shell: G-code editor/loader + backplot & sim viewport + playback.
 *
 * Thin Presentation layer (per cam_web.txt): all parsing/carving lives in the
 * workers/engine, all state in camStore. Playback scrubs the ordered path and
 * (optionally) drives progressive material removal.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Layout, Button, Statistic, Alert, Space, Typography, theme,
  InputNumber, Input, Segmented, Switch, Divider, Slider, Tag, Tooltip, Drawer,
  App as AntdApp,
} from 'antd';
import {
  ThunderboltOutlined,
  PlayCircleFilled, PauseCircleFilled, StepBackwardOutlined,
  StepForwardOutlined, FastBackwardOutlined, RollbackOutlined,
  ExpandOutlined,
  EditOutlined,
} from '@ant-design/icons';
import CommandButton from './components/CommandButton.jsx';
import {
  PartIcon, StockIcon, StockCutIcon, VoxelIcon, TurningIcon, ArborIcon, LatheToolIcon, RotateWorkIcon,
  ToolpathIcon,
} from './components/glyph.jsx';
import { cutterById } from './engine/cam/cutters.js';
import { effectiveTool } from './engine/cam/effectiveTool.js';
import { useCamStore } from './stores/camStore.js';
import { useFeatureStore } from './stores/featureStore.js';
import { useCamPlanStore, getRawMesh } from './stores/camPlanStore.js';
import { boundsOf } from './engine/mesh/analyze.js';
import { boundsOnPlane } from './engine/sketch/plane.js';
import { PART_FORMATS } from './engine/mesh/import.js';
import CamPanel from './components/CamPanel.jsx';
import { useSketchStore } from './stores/sketchStore.js';
import { exportGcode, openProjectFile, openProgramFile } from './lib/projectIO.js';
import { useLibraryStore } from './stores/libraryStore.js';
import LibraryPanel from './components/LibraryPanel.jsx';
import {
  fitBoundsFor, fitBoundsForPart, chuckFromBounds, chuckFitBounds,
} from './engine/view/setup.js';
import { unionBounds } from './engine/view/camera.js';
import { simMethodFor } from './engine/sim/method.js';
import { SPEEDS } from './engine/view/playback.js';
import { sidebarSections } from './engine/view/sidebar.js';
import { formatDuration, programStatRows, timingBreakdown } from './engine/view/programStats';
import { toolSpecSummary } from './engine/view/toolRow.js';
import { offerArborToggle, parkedTip } from './engine/view/millTool.js';
import { offerToolToggle } from './engine/view/latheTool.js';
import { sweptFitBox } from './engine/view/rotaryFrame.js';
import { sketchBounds } from './engine/sketch/edit.js';
import {
  lineAt, timeAt, rotaryAt, toolAt, toolPointAt, blockTargetAt,
  runningAt,
} from './engine/gcode/path.js';
import { effectiveTurnTool } from './engine/sim/turning.js';
import {
  billetBox, billetWarnings, billetExtents, previewSolid, suggestBillet, partBillet, effectiveBillet,
} from './engine/sim/billet.js';
import Viewport from './components/Viewport.jsx';
import PositionReadout from './components/PositionReadout.jsx';
import SketchToolbar from './components/SketchToolbar.jsx';
import StatusBar from './components/StatusBar.jsx';
import SketchContextMenu from './components/SketchContextMenu.jsx';
import SketchConfirmCorner from './components/SketchConfirmCorner.jsx';
import MenuBar from './components/MenuBar.jsx';
import CommandRibbon from './components/CommandRibbon.jsx';
import MeasurePanel from './components/MeasurePanel.jsx';
import WorkspaceTabs from './components/WorkspaceTabs.jsx';
import StdVcDialog from './components/StdVcDialog.jsx';
import CustomTurnToolDialog from './components/CustomTurnToolDialog.jsx';
import StdEditorDialog from './components/StdEditorDialog.jsx';
import { VIEWS } from './components/ViewGlyphs.jsx';
import ToolEditDialog from './components/ToolEditDialog.jsx';
import ToolFallback from './components/ToolFallback.jsx';
import BilletBox from './components/BilletBox.jsx';
import LeftColumn from './components/LeftColumn.jsx';
import { TREE_SIZE } from './components/FeatureTree.jsx';
import { usePlayback } from './hooks/usePlayback.js';
import { useAutoSimulate } from './hooks/useAutoSimulate.js';
import { useRotaryCenterReparse } from './hooks/useRotaryCenterReparse.js';
import { useDraftAutosave } from './hooks/useDraftAutosave.jsx';
import { useTreeResize } from './hooks/useTreeResize.js';
import { getBuf } from './engine/bufferCache.js';
import { CAD } from './theme.js';

const { Sider, Content, Header } = Layout;

/** px the left column opens out to on the Setup pane, which was a 470 px drawer. */
const SETUP_WIDTH = 470;
const { Title, Text } = Typography;

export default function App() {
  const { token } = theme.useToken();
  const { notification } = AntdApp.useApp();
  // Small scalar state from Zustand — large buffers live in bufferCache.
  const gcode = useCamStore((s) => s.gcode);
  const bufVer   = useCamStore((s) => s.bufVer);  // version counter — triggers re-render
  const playhead = useCamStore((s) => s.playhead);
  const playT    = useCamStore((s) => s.playT);
  const playing  = useCamStore((s) => s.playing);
  const simStatus = useCamStore((s) => s.simStatus);
  const mode      = useCamStore((s) => s.mode);
  const page      = useCamStore((s) => s.page);
  const diameterMode = useCamStore((s) => s.diameterMode);
  const rapidRate = useCamStore((s) => s.rapidRate);
  const toolChangeSeconds = useCamStore((s) => s.toolChangeSeconds);
  const rotaryIndexSeconds = useCamStore((s) => s.rotaryIndexSeconds);
  const view      = useCamStore((s) => s.view);
  const viewNonce = useCamStore((s) => s.viewNonce);
  const toolRadius = useCamStore((s) => s.toolRadius);
  const toolType  = useCamStore((s) => s.toolType);
  const toolCutter = useCamStore((s) => s.toolCutter);
  const toolFlutes = useCamStore((s) => s.toolFlutes);
  const toolAngle  = useCamStore((s) => s.toolAngle);
  const toolThickness = useCamStore((s) => s.toolThickness);
  const toolShank = useCamStore((s) => s.toolShank);
  const cellSize  = useCamStore((s) => s.cellSize);
  const cellSizeUsed = useCamStore((s) => s.cellSizeUsed);
  const cellLimited = useCamStore((s) => s.cellLimited);
  const voxelSize = useCamStore((s) => s.voxelSize);
  const voxelSizeUsed = useCamStore((s) => s.voxelSizeUsed);
  const voxelLimited = useCamStore((s) => s.voxelLimited);
  const simMethod = useCamStore((s) => s.simMethod);
  const turnTool  = useCamStore((s) => s.turnTool);
  const customTurnTools = useCamStore((s) => s.customTurnTools);
  const stockOversize = useCamStore((s) => s.stockOversize);
  const toolOverrides = useCamStore((s) => s.toolOverrides);
  const stockMargin = useCamStore((s) => s.stockMargin);
  const stockSize = useCamStore((s) => s.stockSize);
  const stockOrigin = useCamStore((s) => s.stockOrigin);
  const partBox = useCamStore((s) => s.partBox);
  const stockEnabled = useCamStore((s) => s.stockEnabled);
  const showStock = useCamStore((s) => s.showStock);
  const showArbor = useCamStore((s) => s.showArbor);
  const showTool = useCamStore((s) => s.showTool);
  const showToolpath = useCamStore((s) => s.showToolpath);
  const cutFollowsPlayback = useCamStore((s) => s.cutFollowsPlayback);
  const autoSimEnabled = useCamStore((s) => s.autoSimEnabled);
  const toggleAutoSim = useCamStore((s) => s.toggleAutoSim);
  const simReady  = useCamStore((s) => s.simReady);
  const removalNote = useCamStore((s) => s.removalNote);
  const aIndex    = useCamStore((s) => s.aIndex);
  const rotaryFrame = useCamStore((s) => s.rotaryFrame);
  const simFrameA   = useCamStore((s) => s.simFrameA);
  // Actions are stable references defined once in the store.
  const parse    = useCamStore((s) => s.parse);
  const setPlayhead = useCamStore((s) => s.setPlayhead);
  const togglePlay  = useCamStore((s) => s.togglePlay);
  const stepBlock   = useCamStore((s) => s.stepBlock);
  const simulate    = useCamStore((s) => s.simulate);
  const simulateVoxel = useCamStore((s) => s.simulateVoxel);
  const setToolOverride = useCamStore((s) => s.setToolOverride);
  const setToolCutter = useCamStore((s) => s.setToolCutter);
  const setToolThickness = useCamStore((s) => s.setToolThickness);
  const setToolShank = useCamStore((s) => s.setToolShank);
  const clearToolOverride = useCamStore((s) => s.clearToolOverride);
  const openCustomTurnToolDialog = useCamStore((s) => s.openCustomTurnToolDialog);
  const removeCustomTurnTool = useCamStore((s) => s.removeCustomTurnTool);
  const toolEditDialog = useCamStore((s) => s.toolEditDialog);
  const openToolEditDialog = useCamStore((s) => s.openToolEditDialog);
  const closeToolEditDialog = useCamStore((s) => s.closeToolEditDialog);
  const setTool     = useCamStore((s) => s.setTool);
  const setCutter   = useCamStore((s) => s.setCutter);
  const setThickness = useCamStore((s) => s.setThickness);
  const setShank = useCamStore((s) => s.setShank);
  const setFlutes   = useCamStore((s) => s.setFlutes);
  const toggleStock = useCamStore((s) => s.toggleStock);
  const setStockSize = useCamStore((s) => s.setStockSize);
  const setStockOrigin = useCamStore((s) => s.setStockOrigin);
  const setBillet = useCamStore((s) => s.setBillet);
  const toggleStockEnabled = useCamStore((s) => s.toggleStockEnabled);
  const toggleArbor = useCamStore((s) => s.toggleArbor);
  const toggleTool = useCamStore((s) => s.toggleTool);
  const toggleToolpath = useCamStore((s) => s.toggleToolpath);
  const setCutFollows = useCamStore((s) => s.setCutFollows);
  const setViewPreset = useCamStore((s) => s.setViewPreset);
  const setRapidRate = useCamStore((s) => s.setRapidRate);
  const setToolChangeSeconds = useCamStore((s) => s.setToolChangeSeconds);
  const setRotaryIndexSeconds = useCamStore((s) => s.setRotaryIndexSeconds);
  const setDiameterMode = useCamStore((s) => s.setDiameterMode);
  const setRotaryFrame = useCamStore((s) => s.setRotaryFrame);
  // Through the feature tree, so a dropped file becomes the base of a history
  // rather than a part with no record of where it came from.
  const loadPart      = useFeatureStore((s) => s.importPart);
  const partAnalysis  = useCamPlanStore((s) => s.analysis);
  const partVer       = useCamPlanStore((s) => s.meshVer);
  // Where the physical A axis runs, so the work turns about the line it was
  // touched off on rather than the part's own zero. Subscribe to the function,
  // not its result — it builds a fresh array every call.
  const displayedRotaryCenter = useCamPlanStore((s) => s.displayedRotaryCenter);
  const partDatum     = useCamPlanStore((s) => s.datum);
  const [showPart, setShowPart] = useState(true);
  // The sim's fallback cutter is collapsed until asked for — see `ToolFallback`.
  const [toolFallbackOpen, setToolFallbackOpen] = useState(false);

  const [speed, setSpeed] = useState(1);
  const [dragActive, setDragActive] = useState(false);
  // The docked Ribbon's mount point (below the title bar). A state, not a ref, so
  // the toolbar re-renders into it the moment it exists.
  const [ribbonSlot, setRibbonSlot] = useState(null);
  // Which pane the left column shows — model, program or setup — here because the
  // tabs under the viewport and the Ribbon's Setup buttons set it too.
  const [leftTab, setLeftTab] = useState('model');
  // Where the left column mounts the Setup pane; filled from here by a portal, so
  // its controls keep the App state they read.
  const [setupSlot, setSetupSlot] = useState(null);
  // Drives the feature-tree column's width; the tree itself owns the toggle.
  const treeOpen = useFeatureStore((s) => s.treeOpen);
  const treeWidth = useFeatureStore((s) => s.treeWidth);
  const setTreeOpen = useFeatureStore((s) => s.setTreeOpen);
  const { treeResizing, startTreeResize } = useTreeResize();
  const sketching = page === 'sketch';
  const turning = page === 'turn';

  // Running a program collapses the sidebar to the program listing — the setup
  // controls are dead weight mid-run and push the live panel out of sight. The
  // decision lives in engine/view/sidebar.js so it is tested, not buried in JSX.
  const show = sidebarSections({ playing });
  const arborToggle = offerArborToggle({ mode, sketching });
  const toolToggle = offerToolToggle({ mode, sketching });

  // Open on a blank page — no sample program is loaded. The user brings their
  // own via drag-and-drop or Open file.

  usePlayback(playing, speed);

  // Saving / opening work. Errors surface in the store's `error` alert, the same
  // place a parse failure lands, so there is one place to look.
  const [saveMsg, setSaveMsg] = useState(null);
  const report = useCallback(async (fn, done) => {
    try {
      const name = await fn();
      // A null name means the user closed the save dialog — say nothing.
      if (name !== null) setSaveMsg(done(name));
    } catch (err) {
      useCamStore.setState({ error: err?.message || String(err) });
    }
  }, []);
  const onExportGcode = useCallback(
    () => report(exportGcode, (n) => `Downloaded ${n}`), [report],
  );
  // Whether the library drawer is open (File → Library). It is a place to work,
  // not a menu, so it stays put until it is closed again.
  const [libraryOpen, setLibraryOpen] = useState(false);

  /** The left column on one of its panes, opened if it was collapsed. */
  const showPane = (pane) => {
    setLibraryOpen(false);
    setTreeOpen(true);
    setLeftTab(pane);
  };

  /** Open Setup in the left column and bring one of its sections into view. */
  const openSetupAt = (selector) => {
    showPane('setup');
    if (!selector) return;
    setTimeout(() => {
      document.querySelector(selector)?.scrollIntoView?.({ block: 'start' });
    }, 150);
  };

  // Setup holds whole panels of controls, so the column opens out for it.
  const columnWidth = treeOpen
    ? (leftTab === 'setup' ? Math.max(treeWidth, SETUP_WIDTH) : treeWidth)
    : TREE_SIZE.TREE_STRIP + 8;

  useAutoSimulate({
    gcode, stockEnabled, stockSize, stockOrigin, partDatum, aIndex, mode,
    autoSimEnabled, playing, simStatus, sketching, simulate,
  });

  useRotaryCenterReparse({ partDatum, gcode, parse });

  useDraftAutosave(notification);

  // Let a save confirmation fade rather than linger.
  useEffect(() => {
    if (!saveMsg) return undefined;
    const id = setTimeout(() => setSaveMsg(null), 4000);
    return () => clearTimeout(id);
  }, [saveMsg]);

  // Drag-and-drop a real G-code file anywhere on the window.
  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      // A model is a thing to be machined, not a program to be run, so it goes
      // to the planner rather than the interpreter. Routing on the extension
      // keeps one drop target for both — and the planner re-checks the bytes,
      // so a mislabelled file still lands in the right place.
      const name = file.name.toLowerCase();
      if (PART_FORMATS.some((f) => f.extensions.some((e) => name.endsWith(e)))) {
        loadPart(file);
      } else if (name.endsWith('.json')) {
        // A project file. This is the only way in now that the sidebar's Open
        // project button has gone, so it must not be handed to the G-code
        // parser — which would read a JSON document as a program and fail.
        report(async () => {
          await openProjectFile(file);
          // It is no library item, so Save must not write back to one.
          useLibraryStore.getState().setOpenItem(null);
          return file.name;
        }, (n) => `Opened project ${n}`);
      } else {
        // Anything else is taken for a program, unless its contents say otherwise:
        // a project saved under a name of the operator's own still opens as one.
        report(async () => {
          const isProject = await openProgramFile(file);
          if (isProject) useLibraryStore.getState().setOpenItem(null);
          return isProject;
        }, (isProject) => (isProject ? `Opened project ${file.name}` : null));
      }
    },
    [loadPart, report]
  );

  // Read large buffers from cache (not from React state). Viewport slices the
  // drawn sub-path itself; here we only need the small scalar bits.
  // `sim` is read here only for a truthiness gate + the scalar removedVolume —
  // it is never passed down as a prop (that would re-trigger the DataCloneError).
  const { bounds, stats, path, sim } = getBuf();

  const warnings = stats?.warnings ?? [];
  // The viewport's top-left panel. Memoised for the same reason `rotaryIndices` is:
  // this renders on every playback tick, and a fresh array per render would make the
  // panel re-render 25 times a second for numbers that only change on a re-parse.
  const statRows = useMemo(() => programStatRows(stats), [stats]);
  const statBreakdown = useMemo(() => timingBreakdown(stats), [stats]);
  // Memoised because `?? [0]` mints a new array on every render otherwise,
  // which defeats the memo further down that lists it as a dependency.
  const rotaryIndices = useMemo(() => stats?.aIndices ?? [0], [stats]);
  // Live sketch bounds, so "Fit" frames what's drawn on the plane even with no
  // program loaded. Merged into the fit inside CameraRig (kept out of the fit
  // *key* there so drawing doesn't snap the camera — only an explicit Fit does).
  const sketchSk = useSketchStore((s) => s.sk);
  const sketchVersion = useSketchStore((s) => s.version);
  // On the plane it is drawn on, which is not the table once a sketch is on a face.
  const sketchPlane = useSketchStore((s) => (s.sketches.find((x) => x.id === s.activeId) ?? s.sketches[0])?.plane);
  const sketchFit = useMemo(
    () => boundsOnPlane(sketchPlane, sketchBounds(sketchSk)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sketchSk, sketchVersion, sketchPlane],
  );
  // The part as the Sketch page draws it: as built, not laid down for machining.
  const builtPartFit = useMemo(() => {
    const { soup } = getRawMesh();
    return soup?.triangleCount ? boundsOf(soup) : null;
  }, [partVer]); // eslint-disable-line react-hooks/exhaustive-deps
  // The A-axis centre for the viewport's work rotation. `[0,0]` — the frame's
  // own origin — is what indexing assumed before an operator could pick one,
  // and stays the answer when they haven't.
  const picked = displayedRotaryCenter();
  const rotaryCenter = useMemo(
    () => picked ?? [0, 0],
    [picked?.[0], picked?.[1]], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The frame toggle is only meaningful where there is a 4th axis to draw: a
  // milling program that actually indexes. Everything else has one honest view.
  const canRotateWork = !turning && rotaryIndices.length > 1;

  // The billet, measured against the program. All of it comes from
  // `engine/sim/billet.js` — the same function the carver builds its block
  // with — so what the panel reports and what gets cut cannot disagree.
  // With a part loaded, the blank to suggest is the part's own.
  const billetSuggestion = useMemo(
    () => partBillet(partBox) ?? (bounds ? suggestBillet(bounds, { margin: stockMargin }) : null),
    [bounds, stockMargin, partBox],
  );
  // What the simulation will actually start from: the billet typed in, or with
  // nothing typed and a part loaded, the part's own (`effectiveBillet`).
  const { stockSize: blankSize, stockOrigin: blankOrigin, fromPart: blankFromPart } = useMemo(
    () => effectiveBillet({ stockSize, stockOrigin, partBox }),
    [stockSize, stockOrigin, partBox],
  );
  // Deliberately NOT gated on a parsed program: the material is in the vice
  // before the .nc exists, and a blank you cannot describe until one is loaded
  // is a blank you cannot set up against. `previewSolid` owns the whole rule,
  // including when there is nothing worth drawing.
  const billetOpts = useMemo(
    () => ({ margin: stockMargin, origin: blankOrigin }),
    [stockMargin, blankOrigin],
  );
  const billetNow = useMemo(
    () => (turning || !stockEnabled ? null : billetBox(bounds, blankSize, billetOpts)),
    [bounds, blankSize, billetOpts, turning, stockEnabled],
  );
  // The blank as a drawable box, straight to the viewport. No worker, no carve —
  // so it follows the number being typed rather than the last press of Simulate.
  // Yielded to the carved block the moment there is one to show.
  const stockSolid = useMemo(
    () => (sim || turning || !stockEnabled ? null : previewSolid(bounds, blankSize, billetOpts)),
    [bounds, blankSize, billetOpts, sim, turning, stockEnabled],
  );
  // The readout describes what is actually on screen. With neither a program
  // nor a stated size there is no blank, and printing the ±margin box round the
  // origin would be reporting a billet that does not exist.
  const billetExtentsNow = useMemo(
    () => (stockSolid || sim ? billetExtents(billetNow) : null),
    [billetNow, stockSolid, sim],
  );
  const billetProblems = useMemo(
    // Only measurable against a program. With none loaded there is nothing the
    // blank could be too small for yet.
    () => (billetNow && bounds ? billetWarnings(billetNow, bounds) : []),
    [billetNow, bounds],
  );
  // The blank as a fit target, in the same shape the camera framing wants.
  const billetFit = useMemo(() => (stockSolid && billetNow ? {
    min: [billetNow.xMin, billetNow.yMin, billetNow.base],
    max: [billetNow.xMax, billetNow.yMax, billetNow.top],
  } : null), [stockSolid, billetNow]);

  // Frame the camera to the cutting geometry (the part), not the rapid retracts.
  // Deliberately NOT keyed on bufVer: the values don't change as the sim carves,
  // and refitting on every playback tick was resetting the user's zoom.
  // An imported model is framed too, and unioned with the program's bounds when
  // both exist — after "Verify in viewport" the toolpath and the part it came
  // from should be on screen together, not one of them off the edge.
  const fitBounds = useMemo(() => {
    // Machine frame: the cutting moves all sit above the A axis, so their bounds
    // are a plane and fitting to them frames a sliver. What is on screen over
    // the run is that path swept around the axis — see `sweptFitBox`.
    const cut = fitBoundsFor(turning ? 'turn' : 'mill', bounds);
    return unionBounds(
      unionBounds(
        unionBounds(
          rotaryFrame === 'machine' ? sweptFitBox(cut, rotaryCenter) : cut,
          // The blank is framed too. Without it, sizing stock on an empty
          // viewport draws a 50 mm block the camera is nowhere near.
          billetFit,
        ),
        fitBoundsForPart(turning ? 'turn' : 'mill', partAnalysis?.bounds ?? null),
      ),
      // The chuck is far wider than the bar it grips, and would otherwise run off
      // the top of the window and under the view toolbar.
      chuckFitBounds(chuckFromBounds(turning ? 'turn' : 'mill', bounds, stockOversize)),
    );
  }, [bounds, turning, partAnalysis, rotaryFrame, rotaryCenter, billetFit, stockOversize]);

  // Chuck placement uses the *real* cutting bounds (not the padded fit), so the
  // 5 mm clearance to the deepest cut is preserved regardless of framing. The
  // chuck grips the **raw bar** diameter (turned OD + oversize) — the same
  // uniform bar the sim carves — so the whole bar reads as one stock size.
  const turnChuck = useMemo(
    () => chuckFromBounds(turning ? 'turn' : 'mill', bounds, stockOversize),
    [bounds, turning, stockOversize],
  );
  // Tools auto-detected from the program's comments, and the one cutting now.
  const detectedTools = stats?.tools ?? [];
  // The global fallback picker's own spec, in `effectiveTool`'s shape — built
  // once so the Tool table row and `ToolEditDialog` read the exact same
  // fallback rather than two copies that could drift.
  const toolFallback = {
    radius: toolRadius,
    cutter: toolCutter,
    type: toolType,
    angle: toolAngle,
    thickness: toolThickness ?? undefined,
    shank: toolShank ?? undefined,
  };
  // `bufVer` is listed on purpose and eslint is wrong to call it unnecessary:
  // `path` comes from the module-level buffer cache and is **mutated in
  // place**, so its identity never changes and a re-parse would otherwise
  // never re-run this. The version token is the only signal there is.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const currentToolNum = useMemo(() => toolAt(path, playhead), [path, playhead, bufVer]);
  const currentTool = detectedTools.find((t) => t.n === currentToolNum) || null;
  // The tool marker follows the active cutter's real size AND shape, so it
  // visibly shrinks from a Ø32 face mill to a Ø3 reamer as the program runs, and
  // a face mill is a disc where a slot drill is a stick. Which of the three
  // sources wins — the Tool table, the program's comment, the fallback picker —
  // is `cam/effectiveTool.js`, the same decision the carvers make.
  const currentOverride = toolOverrides[currentToolNum] || {};
  const marker = effectiveTool({
    detected: currentTool,
    override: currentOverride,
    fallback: {
      radius: toolRadius,
      cutter: toolCutter,
      type: toolType,
      angle: toolAngle,
      thickness: toolThickness ?? undefined,
      shank: toolShank ?? undefined,
    },
  });
  const markerRadius = marker.radius;
  const markerType = marker.type;
  const markerCutter = marker.cutter;
  const markerAngle = marker.angle;
  const markerThickness = marker.thickness;
  const markerShank = marker.shank;
  // Gauge length (tip to collet) drives how far the milling marker sticks out.
  const markerLength = marker.length;
  // The turning toolholder for the marker — the operator's own pick for this
  // tool number, else what the program's own comment implies (T0909(INTERNAL
  // THREAD BAR) picks the threading bar on its own), else the global default.
  // MVJNR's insert nose angle is adjustable; MVVNN's is fixed.
  const baseTurnTool = effectiveTurnTool({
    detected: currentTool, overrideId: currentOverride.insert, fallbackId: turnTool,
    custom: customTurnTools,
  });
  // Memoised for the same reason as `rotaryIndices`: a fresh object each render
  // makes every memo listing it re-run every render.
  const turnInsert = useMemo(() => (turning
    ? {
      ...baseTurnTool,
      angle: baseTurnTool.adjustable ? (currentOverride.insertAngle ?? baseTurnTool.angle) : baseTurnTool.angle,
      // Only `partingBladeGeometry` reads this (`shape.grooveW`); harmless on
      // every other holder shape, which never looks at it.
      grooveW: currentOverride.grooveW,
      // Only `boringBarGeometry` reads this (`shape.barDiameter`) — the bar's
      // own shank size, picked from `BORING_BAR_DIAMETERS`, not the bore it
      // cuts (the program's own X states that; see `FIXED_RADIUS_TYPES`'s
      // comment on why boring is deliberately excluded there).
      barDiameter: currentOverride.barDiameter,
    }
    : null), [
    turning, baseTurnTool, currentOverride.insertAngle, currentOverride.grooveW,
    currentOverride.barDiameter,
  ]);
  // Feed and spindle speed at the playhead, and what the tool in the spindle
  // is, for the position page's footer. The tool description is the one the
  // marker draws and the carvers cut with (`effectiveTool` above), not the
  // program's comment on its own — the readout must name the tool that is
  // actually making the cut on screen.
  // `bufVer` is listed on purpose and eslint is wrong to call it unnecessary:
  // `path` comes from the module-level buffer cache and is **mutated in
  // place**, so its identity never changes and a re-parse would otherwise
  // never re-run this. The version token is the only signal there is.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const running = useMemo(() => runningAt(path, playhead), [path, playhead, bufVer]);
  const droToolDesc = useMemo(() => ({
    cutter: turning ? null : marker.cutter ?? null,
    radius: turning ? 0 : marker.radius ?? 0,
    desc: currentTool?.desc ?? '',
    holder: turnInsert,
    // The operator's own name for this T number (Tool table), if they set
    // one — `droTool` lets it win outright over the holder/cutter/comment
    // chain below it.
    name: currentOverride.label ?? null,
  }), [turning, marker.cutter, marker.radius, currentTool, turnInsert, currentOverride.label]);

  // The one Tool-table row `ToolEditDialog` is open for, if any — computed
  // once here rather than inside the row loop, since only one row's dialog
  // can be open at a time.
  const editingToolNum = toolEditDialog?.n ?? null;
  const editingTool = editingToolNum != null
    ? detectedTools.find((t) => t.n === editingToolNum) || null
    : null;
  const editingOv = editingToolNum != null ? (toolOverrides[editingToolNum] || {}) : {};
  const editingEff = editingTool
    ? effectiveTool({ detected: editingTool, override: editingOv, fallback: toolFallback })
    : null;
  const editingEffSpec = editingEff ? cutterById(editingEff.cutter) : null;
  const editingHolder = editingTool && turning ? effectiveTurnTool({
    detected: editingTool, overrideId: editingOv.insert, fallbackId: turnTool, custom: customTurnTools,
  }) : null;

  // Which tools cut at each rotary index — so the "pick which" selector can say
  // what you'll actually see carved at 0° / 90° / 270° instead of leaving you to
  // guess. Feeds only; one pass over the path, memoised on the buffer version.
  const toolsByIndex = useMemo(() => {
    const m = new Map();
    if (path?.rotary && path?.tools) {
      for (let i = 0; i < path.count; i++) {
        if (path.types[i] !== 1) continue; // cutting moves only
        const a = path.rotary[i];
        if (!m.has(a)) m.set(a, new Set());
        m.get(a).add(path.tools[i]);
      }
    }
    return m;
  // `bufVer` is listed on purpose and eslint is wrong to call it unnecessary:
  // `path` comes from the module-level buffer cache and is **mutated in
  // place**, so its identity never changes and a re-parse would otherwise
  // never re-run this. The version token is the only signal there is.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, bufVer]);
  const toolsAtIndexLabel = (a) => {
    const set = toolsByIndex.get(a);
    if (!set || set.size === 0) return 'no cutting';
    return [...set].sort((x, y) => x - y).map((n) => `T${n}`).join(', ');
  };
  const count = path?.count ?? 0;
  // `bufVer` is listed on purpose and eslint is wrong to call it unnecessary:
  // `path` comes from the module-level buffer cache and is **mutated in
  // place**, so its identity never changes and a re-parse would otherwise
  // never re-run this. The version token is the only signal there is.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activeLine = useMemo(() => lineAt(path, playhead), [path, playhead, bufVer]);
  // Machine time consumed by the segments executed so far.
  // `bufVer` is listed on purpose and eslint is wrong to call it unnecessary:
  // `path` comes from the module-level buffer cache and is **mutated in
  // place**, so its identity never changes and a re-parse would otherwise
  // never re-run this. The version token is the only signal there is.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const elapsed = useMemo(() => timeAt(path, playhead), [path, playhead, bufVer]);

  // Park the tool at the current tip (end of the last executed segment). Just a
  // 3-number array — safe to pass to Viewport as a React prop.
  const toolPos = useMemo(() => {
    if (!path || playhead <= 0) return null;
    // While playing, ride the continuous machine time so the marker glides along
    // long moves; paused/scrubbing, sit at the playhead's segment boundary.
    const t = playing ? playT : timeAt(path, playhead);
    return toolPointAt(path, t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, playhead, playT, playing, count, bufVer]);

  // Where the block in progress is headed, for the readout's DIST TO GO column.
  // The same clock as toolPos above, so the two numbers are always a matched
  // pair — a position and the distance left on the very move it is making.
  const toolTarget = useMemo(() => {
    if (!path || playhead <= 0) return null;
    const t = playing ? playT : timeAt(path, playhead);
    return blockTargetAt(path, t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, playhead, playT, playing, count, bufVer]);

  // Rotary index (A/B degrees) at the playhead, so the tool marker can stand
  // normal to the face being cut instead of always pointing straight up +Z.
  // Where to draw the tool when the machine is not running. Without this the
  // marker simply did not exist until the playhead moved, so picking a cutter
  // type changed nothing on screen and read as a picker that does not work.
  // Kept separate from `toolPos`: the position readout must go on showing
  // nothing, because the machine is not actually anywhere.
  // Memoised: a fresh array every render would retrigger the demand-mode
  // canvas's invalidate() on every keystroke anywhere in the app.
  const markerPos = useMemo(
    () => toolPos ?? parkedTip({ solid: stockSolid, bounds, radius: markerRadius }),
    [toolPos, stockSolid, bounds, markerRadius],
  );

  // Which simulator this setup needs, and why — the same pure rule the store
  // routes on, so the button says up front what pressing it will do.
  const simPlan = useMemo(
    () => simMethodFor({
      rotaryIndices,
      fallbackTool: { thickness: toolThickness ?? undefined },
      overrides: toolOverrides,
    }),
    [rotaryIndices, toolThickness, toolOverrides],
  );

  const toolRotary = useMemo(() => {
    if (!path || playhead <= 0) return null;
    return rotaryAt(path, playhead);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, playhead, count, bufVer]);

  const addonStyle = (side) => ({
    padding: '0 8px', background: CAD.raised, border: `1px solid ${CAD.border}`,
    [side === 'left' ? 'borderRight' : 'borderLeft']: 0,
    display: 'inline-flex', alignItems: 'center', color: CAD.label,
    fontSize: 12, borderRadius: side === 'left' ? '4px 0 0 4px' : '0 4px 4px 0',
  });

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
      // Standalone cam-web owns the whole viewport. (Vendored into EngineerSystem
      // this is `100%` instead — there it sits under MainLayout's 64px header and
      // a viewport-height app overflows by exactly that much.)
      style={{ height: '100vh' }}
    >
      <Layout style={{ height: '100vh' }}>
        {/* The command bar. A flat fill and a hairline under it, the way a CAD
            application separates its chrome from its workspace — without the
            rule the bar and the sidebar below it are one undifferentiated gray. */}
        <Header style={{
          display: 'flex', flexDirection: 'column', height: 'auto', gap: 0,
          padding: '2px 16px 0', background: CAD.headerBg, borderBottom: `1px solid ${CAD.border}`,
        }}>
          <StdVcDialog />
          <StdEditorDialog />
          <CustomTurnToolDialog />
          <ToolEditDialog
            open={!!editingTool}
            tool={editingTool}
            override={editingOv}
            turning={turning}
            eff={editingEff}
            effSpec={editingEffSpec}
            holder={editingHolder}
            customTurnTools={customTurnTools}
            addonStyle={addonStyle}
            edited={editingToolNum != null && (
              editingOv.diameter != null || editingOv.simType != null
              || editingOv.cutter != null || editingOv.angle != null || editingOv.thickness != null
              || editingOv.shank != null || editingOv.length != null || editingOv.insert != null
              || editingOv.insertAngle != null || editingOv.barDiameter != null || editingOv.grooveW != null
            )}
            onClose={closeToolEditDialog}
            onOverride={(patch) => editingToolNum != null && setToolOverride(editingToolNum, patch)}
            onCutter={(id) => editingToolNum != null && setToolCutter(editingToolNum, id)}
            onThickness={(v) => editingToolNum != null
              && setToolThickness(editingToolNum, v, editingEff?.cutter)}
            onShank={(v) => editingToolNum != null && setToolShank(editingToolNum, v, editingEff?.cutter)}
            onClearOverride={() => editingToolNum != null && clearToolOverride(editingToolNum)}
            onAddCustom={() => openCustomTurnToolDialog(null)}
            onEditCustom={(id) => openCustomTurnToolDialog(id)}
            onRemoveCustom={removeCustomTurnTool}
          />
          <MenuBar
            onExportGcode={onExportGcode}
            libraryOpen={libraryOpen}
            onToggleLibrary={() => setLibraryOpen((v) => !v)}
            onOpenSetup={() => openSetupAt()}
            brand={(
              <>
                <ThunderboltOutlined style={{ color: token.colorPrimary, fontSize: 18 }} />
                <span style={{
                  color: CAD.text, fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', margin: '0 8px 0 4px',
                }}
                >
                  Basic CAM Lite
                </span>
              </>
            )}
          />
        </Header>
        <CommandRibbon
          setRibbonSlot={setRibbonSlot}
          onSetup={() => openSetupAt()}
          onWorkOrigin={() => openSetupAt('[data-cam-origin]')}
          onToolTable={() => openSetupAt('[data-cam-tools]')}
          hasTools={detectedTools.length > 0}
          onExportGcode={onExportGcode}
          // Which run this will be depends on the program and the cutter, and it says
          // so in the button's name, so an undercut is not carved as a height field.
          simulateCommand={turning
            ? { id: 'simulateTurning', icon: <TurningIcon /> }
            : simPlan.method === 'voxel'
              ? { id: rotaryIndices.length > 1 ? 'simulateFaces' : 'simulateUndercut', icon: <VoxelIcon /> }
              : { id: 'simulate', icon: <StockCutIcon /> }}
        />
        <Layout>
          {/* The left column is the **feature tree**, the way a CAD lays a part
              window out: the model's structure is the thing that stays on
              screen. It is a real `Sider`, not an overlay, so the viewport is
              genuinely narrower and the camera fit needs no knowledge of it.

              Setup — files, machine, tooling, stock, removal — is the third pane
              of the same column, beside Model and Program. */}
          <Sider
            width={columnWidth}
            style={{
              background: CAD.panelBg,
              borderRight: `1px solid ${CAD.border}`,
              transition: treeResizing ? 'none' : 'width 120ms ease',
              position: 'relative',
            }}
          >
            <LeftColumn activeLine={activeLine} tab={leftTab} onTab={setLeftTab} setSetupSlot={setSetupSlot} />
            {treeOpen && (
              // Drag the column edge to trade viewport for program/tree width.
              <div
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize"
                data-tree-resize
                onPointerDown={startTreeResize}
                style={{
                  position: 'absolute', top: 0, right: -3, width: 7, height: '100%',
                  cursor: 'col-resize', zIndex: 3, touchAction: 'none',
                }}
              />
            )}
          </Sider>

          <Drawer
            // The library (File → Library). `mask={false}`: it is a side panel
            // to work in, not a dialog — antd's default mask would also cover
            // the menu that closes it again.
            title="Library"
            placement="left"
            width={470}
            open={libraryOpen}
            onClose={() => setLibraryOpen(false)}
            destroyOnHidden={false}
            mask={false}
            styles={{ body: { background: CAD.panelBg, padding: 16 } }}
          >
            {/* The library works *in* this drawer rather than in a popover:
                saving, looking through what is there, opening one and deleting
                two is a session, and a layer that shuts when you click near its
                edge is the wrong container for one. */}
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <LibraryPanel inline open={libraryOpen} onDone={setSaveMsg} />
              <Text style={{ color: CAD.dim, fontSize: 12 }}>
                …or drag &amp; drop a .nc / .gcode / .tap program, a .camweb.json project,
                or an .stl / .obj / .ply to machine
              </Text>
              {saveMsg && <Alert type="success" showIcon message={saveMsg} />}
            </Space>
          </Drawer>

          {/* Setup, drawn into the left column's Setup pane. */}
          {setupSlot && leftTab === 'setup' && createPortal(
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {/* CAM from a model. Sits above the program panel because it is
                  what *produces* a program — the G-code below is its output. */}
              {show.cam && <CamPanel />}

              <Divider style={{ margin: '4px 0' }} />
              <Space align="center" size="small" style={{ justifyContent: 'space-between', width: '100%' }}>
                <Title level={5} style={{ color: CAD.text, margin: 0 }}>Program</Title>
                {/* Say why the rest of the panel went away — a sidebar that loses
                    most of its contents on its own reads as a bug. */}
                {playing && (
                  <Tag color="processing" style={{ marginInlineEnd: 0 }}>
                    running — pause to edit the setup
                  </Tag>
                )}
              </Space>

              {/* ---- Machine ---- */}
              {show.machine && (
              <Space align="center" wrap size="small">
                <Tooltip title="Traverse speed used to time G0 moves">
                  <span style={{ color: CAD.label }}>Rapid</span>
                </Tooltip>
                <Space.Compact>
                  <InputNumber controls={false}
                    min={1}
                    step={500}
                    value={rapidRate}
                    onChange={(v) => setRapidRate(v || 5000)}
                    style={{ width: 96 }}
                  />
                  <span className="ant-input-group-addon" style={addonStyle('right')}>
                    mm/min
                  </span>
                </Space.Compact>
                <Tooltip title="Seconds billed for every tool change — 0 means not counted. Not a published spec like Rapid; set it from your own machine's chip-to-chip time.">
                  <span style={{ color: CAD.label }}>Tool change</span>
                </Tooltip>
                <Space.Compact>
                  <InputNumber controls={false}
                    min={0}
                    step={1}
                    value={toolChangeSeconds}
                    onChange={(v) => setToolChangeSeconds(v || 0)}
                    style={{ width: 72 }}
                  />
                  <span className="ant-input-group-addon" style={addonStyle('right')}>
                    s
                  </span>
                </Space.Compact>
                {!turning && (
                  <>
                    <Tooltip title="Seconds billed every time an A/B word indexes the 4th/5th axis to a new angle — 0 means not counted. Mostly acceleration/settle/clamp time, which varies by machine far more than it varies by angle, so this is a flat cost per index, not a rate.">
                      <span style={{ color: CAD.label }}>Axis index</span>
                    </Tooltip>
                    <Space.Compact>
                      <InputNumber controls={false}
                        min={0}
                        step={1}
                        value={rotaryIndexSeconds}
                        onChange={(v) => setRotaryIndexSeconds(v || 0)}
                        style={{ width: 72 }}
                      />
                      <span className="ant-input-group-addon" style={addonStyle('right')}>
                        s
                      </span>
                    </Space.Compact>
                  </>
                )}
                {turning && (
                  <Tooltip title="Lathe convention: the X word is a diameter, not a radius">
                    <Space>
                      <span style={{ color: CAD.label }}>X = ⌀</span>
                      <Switch checked={diameterMode} onChange={setDiameterMode} size="small" />
                    </Space>
                  </Tooltip>
                )}
              </Space>
              )}

              {/* **Cycle time and the lengths are on the viewport now**, top-left,
                  not here. They are how a run is judged, and this drawer covers the
                  run — reading them meant opening a panel over the thing they
                  describe. See `engine/view/programStats.js`. */}

              {show.warnings && warnings.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message={`${warnings.length} warning(s)`}
                  description={
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  }
                />
              )}

              {show.tools && detectedTools.length > 0 && (
                <>
                  <span data-cam-tools />
                  <Divider style={{ margin: '4px 0', borderColor: CAD.border }}>
                    <Text style={{ color: CAD.muted }}>
                      Tool table{currentTool ? ` — cutting: T${currentTool.n}` : ''}
                    </Text>
                  </Divider>
                  <Text style={{ color: CAD.dim, fontSize: 11 }}>
                    Auto-detected from comments. Name is yours to fix if it looks wrong — it only
                    changes the label, not what simulates. Everything else is behind Edit.
                  </Text>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {detectedTools.map((t) => {
                      const ov = toolOverrides[t.n] || {};
                      const active = t.n === currentToolNum;
                      const edited = ov.diameter != null || ov.simType != null
                        || ov.cutter != null || ov.angle != null || ov.thickness != null
                        || ov.shank != null || ov.length != null || ov.insert != null
                        || ov.insertAngle != null || ov.barDiameter != null || ov.grooveW != null;
                      const effDia = ov.diameter ?? t.diameter;
                      // What this row's tool actually is, by the same rules the
                      // marker and the carvers use — so the summary names the
                      // shape on screen, detected or picked.
                      const eff = effectiveTool({ detected: t, override: ov, fallback: toolFallback });
                      const effSpec = cutterById(eff.cutter);
                      const holder = turning ? effectiveTurnTool({
                        detected: t, overrideId: ov.insert, fallbackId: turnTool, custom: customTurnTools,
                      }) : null;
                      const summary = toolSpecSummary({
                        turning, diameter: effDia, holderLabel: holder?.label, cutterLabel: effSpec?.label,
                      });
                      return (
                        <div
                          key={t.n}
                          title={t.desc}
                          style={{
                            display: 'flex', gap: 6, alignItems: 'center',
                            padding: '3px 6px', borderRadius: 4, fontSize: 12,
                            background: active ? CAD.selected : 'transparent',
                            border: `1px solid ${active ? token.colorPrimary : CAD.borderSoft}`,
                          }}
                        >
                          <b style={{ color: active ? token.colorPrimary : CAD.icon, minWidth: 26 }}>
                            T{t.n}
                          </b>
                          <Input
                            size="small"
                            value={ov.label ?? ''}
                            // Blank, not the detected type as a ghost value — a
                            // placeholder here read as "already named chamfer",
                            // which this row never was; the detected type is
                            // still in the hover tooltip and in Edit's title.
                            placeholder="Name"
                            aria-label={`T${t.n} name`}
                            onChange={(e) => setToolOverride(t.n, { label: e.target.value || undefined })}
                            style={{ width: 118 }}
                          />
                          <span style={{
                            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap', color: CAD.muted,
                          }}
                          >
                            {summary}
                          </span>
                          <span style={{ color: CAD.dim }}>
                            {t.cutLength > 0 ? `${t.cutLength.toFixed(0)} mm` : 'unused'}
                          </span>
                          {edited && (
                            <Tooltip title="Reset this tool's edited values to what was detected">
                              <CommandButton
                                id="resetTool"
                                size="small"
                                type="text"
                                icon={<RollbackOutlined />}
                                onClick={() => clearToolOverride(t.n)}
                                style={{ color: CAD.muted, padding: '0 4px' }}
                              />
                            </Tooltip>
                          )}
                          <Button
                            size="small"
                            type="text"
                            icon={<EditOutlined />}
                            aria-label={`Edit T${t.n}`}
                            onClick={() => openToolEditDialog(t.n)}
                            style={{ color: CAD.icon, padding: '0 4px' }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Playback controls live in the viewport toolbar (bottom bar),
                  next to the view selector — not here in the sidebar. */}

              {/* ---- Phase 1: material removal ---- */}
              {show.removal && <>
              <span data-cam-removal />
              <Divider style={{ margin: '4px 0', borderColor: CAD.border }}>
                <Text style={{ color: CAD.muted }}>Material removal</Text>
              </Divider>

              <Space size={6} align="center">
                <Switch size="small" checked={autoSimEnabled} onChange={toggleAutoSim} />
                <Tooltip title="Carve the program on its own whenever the setup (program, billet, origin) is complete or changes. Off by default — leave it off if you only want the backplot, and press Simulate by hand when you need a cut.">
                  <span style={{ color: CAD.label, fontSize: 12 }}>Auto-simulate</span>
                </Tooltip>
              </Space>

              {turning ? (
                <>
                  <Text style={{ color: CAD.dim, fontSize: 11 }}>
                    Pick each tool's insert in the Tool table above.
                  </Text>
                  <Space align="center" wrap>
                    <Tooltip title="Raw bar diameter over the largest turned diameter in the program">
                      <span style={{ color: CAD.label }}>Stock ⌀ oversize</span>
                    </Tooltip>
                    <Space.Compact>
                      <InputNumber controls={false}
                        min={0}
                        step={0.5}
                        value={stockOversize}
                        onChange={(v) => setTool({ stockOversize: v ?? 0 })}
                        style={{ width: 80 }}
                      />
                      <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
                    </Space.Compact>
                  </Space>
                  {/* **The button is on the viewport rail**, beside the toolpath
                      toggle, exactly where milling's is — same act, same place. It
                      used to be the one Simulate that was still in the drawer, so
                      turning was the mode where carving the bar and then hiding the
                      backplot to look at it crossed the whole screen. */}
                  {sim && (
                    <Space wrap align="center">
                      <Statistic title="Removed (mm³)" value={sim.removedVolume} precision={0} />
                    </Space>
                  )}
                  {sim && (
                    <Space size="large" wrap>
                      {/* Show stock is a view toggle now — on the bottom rail
                          beside Show part / Show toolpath, not here. */}
                      <Space>
                        <Tooltip title="Turn the bar down progressively as the playhead moves">
                          <span style={{ color: CAD.label }}>Cut with playback</span>
                        </Tooltip>
                        <Switch
                          checked={cutFollowsPlayback}
                          onChange={setCutFollows}
                          size="small"
                          disabled={!simReady}
                        />
                      </Space>
                    </Space>
                  )}
                </>
              ) : (
                <>
                  {/* A tool that only cuts near its tip leaves a groove with a
                      roof on it, and the height field cannot hold one — see
                      `engine/sim/method.js`. Saying so is the difference
                      between "the slot cutter did not cut a slot" and knowing
                      which model is running. */}
                  {simPlan.method === 'voxel' && rotaryIndices.length <= 1 && (
                    <Alert
                      type="info"
                      showIcon
                      message="Simulating as voxels — this cutter leaves an undercut"
                      description={
                        <>
                          {simPlan.why}
                          {' '}The voxel block keeps it, and scrubs with playback
                          like the height field does.
                          {voxelSizeUsed && voxelSizeUsed !== voxelSize && (
                            <>
                              {' '}Voxels were
                              {voxelLimited ? ' held at ' : ' cut to '}
                              <b>{voxelSizeUsed.toFixed(3)} mm</b> tall
                              {voxelLimited
                                ? ' — as fine as this part can afford. A groove is rounded out to whole voxels, so it may still read taller than the tool.'
                                : ', so the groove is the height of the tool rather than of the grid. Their footprint stays at the size beside the button.'}
                            </>
                          )}
                        </>
                      }
                    />
                  )}
                  {rotaryIndices.length > 1 && (
                    <Alert
                      type="info"
                      showIcon
                      message={`4-axis program — A at ${rotaryIndices.map((a) => `${a}°`).join(', ')}`}
                      description={
                        <>
                          <b>Simulate all faces</b> carves every tool on every rotary
                          face into one voxel block (undercuts included) — no need to
                          pick a face. What runs where:
                          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                            {rotaryIndices.map((a) => (
                              <li key={a}>
                                <b>A {a}°</b> — {toolsAtIndexLabel(a)}
                              </li>
                            ))}
                          </ul>
                        </>
                      }
                    />
                  )}

                  {/* The cutter the sim carves with is normally read out of the
                      program and edited per tool in the Tool table above. This
                      is the fallback for a program that never says — worth
                      having, not worth a permanent row, so it lives behind a +.
                      It opens on its own when the program declared no tools at
                      all, because then it is the only thing that decides the
                      cut. */}
                  <ToolFallback
                    open={toolFallbackOpen}
                    onOpen={() => setToolFallbackOpen(true)}
                    detected={detectedTools.length}
                    diameter={toolRadius * 2}
                    cutter={toolCutter}
                    flutes={toolFlutes}
                    angle={toolAngle}
                    thickness={toolThickness}
                    shank={toolShank}
                    onDiameter={(v) => setTool({ toolRadius: (v || 0.2) / 2 })}
                    onCutter={setCutter}
                    onFlutes={setFlutes}
                    onAngle={(v) => setTool({ toolAngle: v || 90 })}
                    onThickness={setThickness}
                    onShank={setShank}
                    addonStyle={addonStyle}
                  />

                  {/* The billet, as a piece of material: X × Y × Z, and the
                      corner it sits on. The arithmetic lives in
                      `engine/sim/billet.js`; this only collects the numbers and
                      shows what the engine says about them. */}
                  <BilletBox
                    size={stockSize}
                    origin={stockOrigin}
                    extents={billetExtentsNow}
                    suggestion={billetSuggestion}
                    warnings={billetProblems}
                    onSize={setStockSize}
                    onOrigin={setStockOrigin}
                    onFit={() => setBillet(billetSuggestion)}
                    fromPart={blankFromPart ? { size: blankSize, origin: blankOrigin } : null}
                    enabled={stockEnabled}
                    onToggle={toggleStockEnabled}
                    addonStyle={addonStyle}
                  />

                  <Space wrap>
                    {/* Each sim carries its own resolution, because they are
                        resolutions of different things — the height field's XY
                        cell and the voxel block's edge. Sitting in one column
                        under a shared "Stock" heading, they read as two settings
                        of one simulator, which they have never been. */}
                    {/* **The button is on the viewport rail, not here.** It is
                        pressed with the show/hide toggles it is judged by, and
                        the drawer keeps the number it is judged AT — a grid
                        size is typed once per job, a Simulate is pressed all
                        day. The addon spells out which of the two resolutions
                        this is, now that the glyph beside it has gone. */}
                    <Space.Compact>
                      <span className="ant-input-group-addon" style={addonStyle('left')}>
                        Height field
                      </span>
                      <Tooltip title={cellSizeUsed && cellSizeUsed !== cellSize
                        ? `The coarsest the height field may be. The last run carved at ${cellSizeUsed.toFixed(3)} mm${cellLimited ? ' — as fine as this program can afford' : ', refined to the smallest cutter so its holes come out round'}.`
                        : 'The coarsest the height field may be — a small cutter refines it further, so its holes come out round'}
                      >
                        <InputNumber controls={false}
                          min={0.05}
                          step={0.1}
                          value={cellSize}
                          onChange={(v) => setTool({ cellSize: v || 1 })}
                          style={{ width: 70 }}
                          // A run that carved at something other than this
                          // number says so, rather than leaving the operator to
                          // wonder why a 0.5 mm grid drew a Ø3 hole round.
                          status={cellSizeUsed && cellSizeUsed !== cellSize ? 'warning' : ''}
                        />
                      </Tooltip>
                      <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
                    </Space.Compact>
                    {/* The voxel run keeps its own button here: it is the
                        deliberate second opinion, not the one you reach for
                        mid-job, and the rail has the one that is. */}
                    <Space.Compact>
                      <CommandButton
                        id="simulateVoxel"
                        icon={<VoxelIcon />}
                        loading={simStatus === 'running'}
                        onClick={() => simulateVoxel()}
                      />
                      <Tooltip title="Voxel edge length — smaller mm is finer and slower">
                        <InputNumber controls={false}
                          min={0.5}
                          step={0.5}
                          value={voxelSize}
                          onChange={(v) => setTool({ voxelSize: v || 2 })}
                          style={{ width: 70 }}
                        />
                      </Tooltip>
                      <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
                    </Space.Compact>
                  </Space>
                  {/* A carve that takes nothing off looks exactly like a carve
                      that never ran. Saying which cause it was turns a silent
                      failure into a fixable one — see `engine/sim/removal.js`. */}
                  {removalNote && (
                    <Alert
                      type="warning"
                      showIcon
                      message="Nothing was removed"
                      description={removalNote}
                    />
                  )}
                  <Text style={{ color: CAD.dim, fontSize: 11 }}>
                    Left carves a <b>height field</b> — one Z per cell, so it is fast and
                    scrubs with playback, but cannot show an undercut. Right carves a{' '}
                    <b>voxel block</b> — every rotary face and every undercut, one shot,
                    no scrubbing.
                  </Text>
                  {simMethod === 'voxel' && sim && (
                    <Text style={{ color: CAD.dim, fontSize: 12 }}>
                      Voxel model — all faces &amp; undercuts, {(sim.cells / 1e6).toFixed(2)}M cells removed {sim.removedVolume?.toFixed(0)} mm³
                    </Text>
                  )}

                  {sim && (
                    <Space size="large" align="center" wrap>
                      <Statistic title="Removed (mm³)" value={sim.removedVolume} precision={0} />
                      <Space direction="vertical" size={2}>
                        {/* Show stock moved to the bottom rail, with the other
                            view toggles. */}
                        <Space>
                          <Tooltip title="Carve the stock progressively as the playhead moves">
                            <span style={{ color: CAD.label }}>Cut with playback</span>
                          </Tooltip>
                          <Switch
                            checked={cutFollowsPlayback}
                            onChange={setCutFollows}
                            size="small"
                            disabled={!simReady}
                          />
                        </Space>
                      </Space>
                    </Space>
                  )}
                </>
              )}
              </>}
            </Space>,
            setupSlot,
          )}

          <Content style={{ position: 'relative' }}>
            {/* Sketcher controls float over the viewport — only on the Sketch page,
                so the design workspace is separate from Milling / Turning. */}
            {sketching && <SketchToolbar ribbonSlot={ribbonSlot} />}
            {sketching && <SketchContextMenu />}
            {sketching && <SketchConfirmCorner />}

            {dragActive && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 10,
                // A tint, not a cover — the model has to stay visible under the
                // drop target, so this one colour is spelled out rather than
                // taken from `accentSoft`, which is opaque by design.
                background: 'rgba(22,104,196,0.10)', border: `2px dashed ${CAD.accent}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: CAD.text, fontSize: 20, pointerEvents: 'none',
              }}>
                Drop a G-code program or an .stl / .obj / .ply model
              </div>
            )}

            {/* The control's position page, top-right — reads out where the tool
                is in work coordinates as the simulation runs. `mode` (not `page`)
                because that is what the interpreter used, so a lathe X stored as
                a radius is posted back as the diameter it was programmed as. */}
            <PositionReadout
              point={toolPos}
              target={toolTarget}
              mode={mode}
              diameterMode={diameterMode}
              rotary={toolRotary}
              aIndices={rotaryIndices}
              toolNumber={currentToolNum}
              tool={droToolDesc}
              running={running}
              line={activeLine}
              sketching={sketching}
              count={count}
            />

            {/* The program's headline numbers, top-left — the corner opposite the
                position readout, and the one free corner in mill/turn mode (the
                sketcher's toolbar owns it, hence `!sketching`).

                They read against the simulation, so they sit on it: from the sidebar
                they were behind the Setup drawer, which covers the viewport. Unlike
                the sidebar block they survive playback, because that is what the
                whole rail does and cycle time is the figure the elapsed clock on the
                bottom bar is measured against. */}
            {!sketching && statRows.length > 0 && (
              <div data-cam-overlay="stats" style={{
                position: 'absolute', top: 8, left: 12, zIndex: 5,
                display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap',
                background: CAD.glass, border: `1px solid ${CAD.border}`,
                padding: '6px 12px', borderRadius: 4,
                boxShadow: '0 2px 10px rgba(23,42,66,0.18)',
                backdropFilter: 'blur(2px)',
                pointerEvents: 'auto',
              }}>
                {statRows.map((row) => {
                  const cell = (
                    <div key={row.key} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <span style={{ color: CAD.muted, fontSize: 10, lineHeight: 1.2, whiteSpace: 'nowrap' }}>
                        {row.label}{row.unit ? ` (${row.unit})` : ''}
                      </span>
                      {/* Monospace so the digits do not dance as the numbers change
                          under playback — the panel is read while it updates. */}
                      <span style={{
                        color: row.key === 'cycleTime' ? token.colorPrimary : CAD.text,
                        fontFamily: 'monospace', fontSize: 14, lineHeight: 1.2, whiteSpace: 'nowrap',
                      }}>
                        {row.value}
                      </span>
                    </div>
                  );
                  return row.key === 'cycleTime'
                    ? <Tooltip key={row.key} title={statBreakdown}>{cell}</Tooltip>
                    : cell;
                })}
              </div>
            )}

            {/* The view toolbar across the top of the viewport: how the part is
                framed and what is drawn. */}
            <div data-cam-overlay="top" data-cam-hud style={{
              position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 5,
              display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center',
              maxWidth: 'calc(100% - 24px)',
              background: CAD.glass, border: `1px solid ${CAD.border}`,
              padding: '3px 6px', borderRadius: 4,
              boxShadow: '0 2px 10px rgba(23,42,66,0.18)',
              backdropFilter: 'blur(2px)',
            }}>
              <Segmented size="small" value={view} onChange={setViewPreset} options={VIEWS} />
              <CommandButton
                id="fitView" size="small"
                icon={<ExpandOutlined />}
                title={sketching ? 'Frame the sketch in the window' : undefined}
                onClick={() => setViewPreset(view)}
              />
              {/* What the viewport draws is a set of toolbar toggles, the way a
                  CAD view toolbar does it — a pressed glyph, not a labelled
                  switch. `type` carries the on/off state. Only offered once
                  there is something to hide: a dead toggle is worse than none. */}
              {partAnalysis && (
                <CommandButton
                  id="showPart" size="small"
                  type={showPart ? 'primary' : 'default'}
                  icon={<PartIcon />}
                  onClick={() => setShowPart(!showPart)}
                />
              )}
              {/* Show/hide the billet and the carved block — a view toggle like
                  the part and toolpath ones, so it belongs here beside them
                  rather than as a lone switch in the Setup drawer. Offered only
                  when there is stock on screen: a preview billet, or a sim. */}
              {!sketching && (sim || stockSolid) && (
                <CommandButton
                  id="showStock" size="small"
                  type={showStock ? 'primary' : 'default'}
                  icon={<StockIcon />}
                  onClick={toggleStock}
                />
              )}
              {/* The arbor is the widest part of the marker, so it is what hides
                  the cut. Milling only — the lathe holder is drawn a different
                  way and has nothing to drop. */}
              {arborToggle && (
                <CommandButton
                  id="showArbor" size="small"
                  type={showArbor ? 'primary' : 'default'}
                  icon={<ArborIcon />}
                  onClick={toggleArbor}
                />
              )}
              {/* Turning's equivalent of the arbor toggle — the lathe marker has no
                  collet to drop separately, so this hides the whole holder+insert
                  instead, which is what sits over the cut an operator wants to see. */}
              {toolToggle && (
                <CommandButton
                  id="showTool" size="small"
                  type={showTool ? 'primary' : 'default'}
                  icon={<LatheToolIcon />}
                  onClick={toggleTool}
                />
              )}
              {/* The backplot covers the surface it describes on a dense
                  program, so it drops the same way the holder does. */}
              {!sketching && (
                <CommandButton
                  id="showToolpath" size="small"
                  type={showToolpath ? 'primary' : 'default'}
                  icon={<ToolpathIcon />}
                  onClick={toggleToolpath}
                />
              )}
              {/* 4th axis: which end of the same rigid motion to watch. A rotary
                  table turns the WORK — that is what a 4-axis machine selects by
                  default — but the part frame, which keeps the workpiece still
                  and tilts the tool, is how you inspect every face at once. Both
                  states are real, so the tooltip says which one you are in. */}
              {canRotateWork && (
                <CommandButton
                  id="rotateWork" size="small"
                  type={rotaryFrame === 'machine' ? 'primary' : 'default'}
                  icon={<RotateWorkIcon />}
                  title={rotaryFrame === 'machine'
                    ? 'On: the table turns the work under an upright spindle, as it does on the machine'
                    : 'Off: the workpiece stays put and the tool tilts onto each indexed face'}
                  onClick={() => setRotaryFrame(rotaryFrame === 'machine' ? 'part' : 'machine')}
                />
              )}
            </div>

            <MeasurePanel sketching={sketching} />

            {/* Bottom toolbar: playing the program back. A sketch has nothing to play. */}
            {!sketching && (
            <div data-cam-overlay="bottom" style={{
              position: 'absolute', bottom: 12, left: 12, right: 12, zIndex: 5,
              display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
              background: CAD.glass, border: `1px solid ${CAD.border}`,
              padding: '6px 12px', borderRadius: 4,
              // On the old near-black viewport a pale panel lifted off the
              // background by contrast alone. On a light one it does not, so the
              // rails that float over the model carry a shadow instead.
              boxShadow: '0 2px 10px rgba(23,42,66,0.18)',
              backdropFilter: 'blur(2px)',
            }}>
              <CommandButton
                id="restart"
                size="small" shape="circle"
                icon={<FastBackwardOutlined />}
                onClick={() => setPlayhead(0)}
                disabled={count === 0}
              />
              {/* Single block, either way: one source line per press, so an arc
                  steps as the one move it was written as and not as the hundreds
                  of chords it tessellates into. */}
              <CommandButton
                id="stepBack"
                size="small" shape="circle"
                icon={<StepBackwardOutlined />}
                onClick={() => stepBlock(-1)}
                disabled={count === 0 || playhead === 0}
              />
              <CommandButton
                id={playing ? 'pause' : 'play'}
                type="primary" shape="circle"
                icon={playing ? <PauseCircleFilled /> : <PlayCircleFilled />}
                onClick={togglePlay}
                disabled={count === 0}
              />
              <CommandButton
                id="stepForward"
                size="small" shape="circle"
                icon={<StepForwardOutlined />}
                onClick={() => stepBlock(1)}
                disabled={count === 0}
              />
              <Segmented size="small" value={speed} onChange={setSpeed} options={SPEEDS} />
              <Slider
                style={{ flex: 1, minWidth: 120, margin: 0 }}
                min={0}
                max={count}
                value={playhead}
                onChange={setPlayhead}
                tooltip={{ formatter: (v) => `${v} / ${count}` }}
                disabled={count === 0}
              />
              <Text style={{
                color: CAD.label, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap',
              }}>
                {formatDuration(elapsed)} / {formatDuration(stats?.cycleTime ?? 0)}
              </Text>
            </div>
            )}

            <Viewport
              bounds={bounds}
              // The Sketch page frames the part it is drawn on, not the program.
              fitBounds={sketching ? (showPart ? builtPartFit : null) : fitBounds}
              partVer={partVer}
              showPart={showPart}
              sketchFit={sketchFit}
              turnChuck={turnChuck}
              showStock={showStock}
              toolPos={markerPos}
              toolRotary={toolRotary}
              toolRadius={markerRadius}
              toolType={markerType}
              toolCutter={markerCutter}
              toolAngle={markerAngle}
              toolThickness={markerThickness}
              toolShank={markerShank}
              toolLength={markerLength}
              turnInsert={turnInsert}
              bufVer={bufVer}
              playhead={playhead}
              mode={sketching ? 'mill' : mode}
              sketching={sketching}
              showArbor={showArbor}
              showTool={showTool}
              showToolpath={showToolpath}
              rotaryFrame={rotaryFrame}
              rotaryCenter={rotaryCenter}
              simFrameA={simFrameA}
              stockSolid={stockSolid}
              view={view}
              viewNonce={viewNonce}
            />
          </Content>
        </Layout>
        <WorkspaceTabs
          // Lined up under the viewport rather than the whole window, without
          // moving the viewport into a column of its own that its height depends on.
          indent={columnWidth}
          active={leftTab}
          onSelect={showPane}
        />
        <StatusBar />
      </Layout>
    </div>
  );
}
